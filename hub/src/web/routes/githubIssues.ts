import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { Store } from '../../store'
import { GitHubIssueRequestConflict } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

// 25 MiB of binary data expands to roughly 33.4 MiB as base64. Keeping the
// bytes in the request lets Radiant persist a self-contained local outbox and
// retry after the original runner upload/session has disappeared.
const MAX_BODY_BYTES = 36 * 1024 * 1024
const MAX_ISSUE_TEXT = 60_000
const MAX_ATTACHMENTS = 6
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const CREATE_TIMEOUT_MS = 120_000

const issueRequestSchema = z.object({
    localId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    text: z.string().trim().min(1).max(MAX_ISSUE_TEXT),
    attachments: z.array(z.object({
        filename: z.string().min(1).max(180),
        mimeType: z.string().regex(/^(image|video)\/[A-Za-z0-9.+-]+$/),
        size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
        content: z.string().min(4).max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4)
    })).max(MAX_ATTACHMENTS).default([])
})

export type IssueAttachment = {
    filename: string
    mimeType: string
    bytes: Uint8Array
}

export type IssueCreateInput = {
    repository: string
    title: string
    body: string
    marker: string
    attachments: IssueAttachment[]
}

export type CreatedIssue = { number: number; url: string }

export interface GitHubIssueCreator {
    findExisting(repository: string, marker: string): Promise<CreatedIssue | null>
    create(input: IssueCreateInput): Promise<CreatedIssue>
}

/** GitHub CLI 2.99+ owns the authenticated media-upload flow (`--attach`). */
export class GhCliIssueCreator implements GitHubIssueCreator {
    constructor(private readonly ghPath = process.env.HAPI_GH_PATH ?? 'gh') {}

    async findExisting(repository: string, marker: string): Promise<CreatedIssue | null> {
        const result = await runProcess([
            this.ghPath,
            'api',
            `repos/${repository}/issues?state=all&per_page=100`,
        ], 30_000)
        const issues = JSON.parse(result.stdout) as Array<{ number?: unknown; html_url?: unknown; body?: unknown }>
        const found = issues.find((issue) => typeof issue.body === 'string' && issue.body.includes(marker))
        return found && typeof found.number === 'number' && typeof found.html_url === 'string'
            ? { number: found.number, url: found.html_url }
            : null
    }

    async create(input: IssueCreateInput): Promise<CreatedIssue> {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-radiant-issue-'))
        try {
            const bodyPath = join(directory, 'body.md')
            await writeFile(bodyPath, `${input.body.trim()}\n\n${input.marker}\n`, { mode: 0o600 })
            const attachmentPaths: string[] = []
            for (const [index, attachment] of input.attachments.entries()) {
                const filename = safeFilename(attachment.filename, `attachment-${index + 1}`)
                const path = join(directory, `${index + 1}-${filename}`)
                await writeFile(path, attachment.bytes, { mode: 0o600 })
                attachmentPaths.push(`${path}#${filename}`)
            }
            const args = [
                this.ghPath,
                'issue',
                'create',
                '--repo', input.repository,
                '--title', input.title,
                '--body-file', bodyPath,
            ]
            for (const path of attachmentPaths) args.push('--attach', path)
            const result = await runProcess(args, CREATE_TIMEOUT_MS)
            const url = result.stdout.trim().split(/\s+/).reverse()
                .find((value) => /^https:\/\/github\.com\//.test(value))
            const number = url?.match(/\/issues\/(\d+)(?:$|[?#])/)?.[1]
            if (!url || !number) throw new Error('GitHub CLI did not return the created issue URL')
            return { number: Number(number), url }
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }
}

export function createGitHubIssueRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
    creator?: GitHubIssueCreator
    allowedRepositories?: string[]
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const creator = options.creator ?? new GhCliIssueCreator()
    const allowed = new Set(
        options.allowedRepositories ?? (process.env.HAPI_GITHUB_ISSUE_REPOS ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
    )

    app.post('/sessions/:id/github-issues', bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: 'Request body too large' }, 413)
    }), async (c) => {
        const parsed = issueRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        if (!allowed.has(parsed.data.repository)) return c.json({ error: 'Repository is not enabled for issue capture' }, 403)

        const engine = requireSyncEngine(c, options.getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: false })
        if (sessionResult instanceof Response) return sessionResult

        const namespace = c.get('namespace')
        const key = `${namespace}:${parsed.data.localId}`
        return withIssueLock(key, async () => {
            const title = deriveGitHubIssueTitle(parsed.data.text)
            let attachments: IssueAttachment[]
            let attachmentFingerprint: string
            try {
                const decoded = decodeIssueAttachments(parsed.data.attachments)
                attachments = decoded.attachments
                attachmentFingerprint = decoded.fingerprint
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Invalid attachment'
                return c.json({ error: message }, 400)
            }
            let begun
            try {
                begun = options.store.githubIssues.begin({
                    namespace,
                    localId: parsed.data.localId,
                    repository: parsed.data.repository,
                    title,
                    body: parsed.data.text,
                    attachmentFingerprint
                })
            } catch (error) {
                if (error instanceof GitHubIssueRequestConflict) {
                    return c.json({ error: error.message }, 409)
                }
                throw error
            }
            if (begun.request.status === 'created') {
                return c.json(issueResponse(begun.request.issueNumber!, begun.request.issueUrl!), 200)
            }

            const marker = `<!-- radiant-issue:${namespace}:${parsed.data.localId} -->`
            try {
                if (!begun.inserted) {
                    const recovered = await creator.findExisting(parsed.data.repository, marker)
                    if (recovered) {
                        options.store.githubIssues.complete(namespace, parsed.data.localId, recovered.number, recovered.url)
                        return c.json(issueResponse(recovered.number, recovered.url), 200)
                    }
                }

                const source = `Captured from Radiant session \`${sessionResult.sessionId}\`.`
                const created = await creator.create({
                    repository: parsed.data.repository,
                    title,
                    body: `${parsed.data.text.trim()}\n\n---\n${source}`,
                    marker,
                    attachments
                })
                options.store.githubIssues.complete(namespace, parsed.data.localId, created.number, created.url)
                return c.json(issueResponse(created.number, created.url), 201)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'GitHub issue creation failed'
                options.store.githubIssues.recordFailure(namespace, parsed.data.localId, message)
                // The client keeps this idempotent request in its local outbox
                // and retries on the next online/resume drain.
                return c.json({ error: 'github_issue_queued', message }, 503)
            }
        })
    })

    return app
}

function decodeIssueAttachments(input: Array<{
    filename: string
    mimeType: string
    size: number
    content: string
}>): { attachments: IssueAttachment[]; fingerprint: string } {
    const fingerprint = createHash('sha256')
    const attachments: IssueAttachment[] = []
    let totalBytes = 0
    for (const attachment of input) {
        if (attachment.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)) {
            throw new Error(`Invalid base64 attachment: ${attachment.filename}`)
        }
        const bytes = Uint8Array.from(Buffer.from(attachment.content, 'base64'))
        if (bytes.byteLength !== attachment.size) throw new Error(`Attachment size mismatch: ${attachment.filename}`)
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error('Issue attachments exceed 25 MB')
        fingerprint
            .update(attachment.filename)
            .update('\0')
            .update(attachment.mimeType)
            .update('\0')
            .update(bytes)
            .update('\0')
        attachments.push({ filename: attachment.filename, mimeType: attachment.mimeType, bytes })
    }
    return { attachments, fingerprint: fingerprint.digest('hex') }
}

export function deriveGitHubIssueTitle(text: string): string {
    const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'DC-1 feedback'
    const cleaned = first.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim()
    return cleaned.length <= 96 ? cleaned : `${cleaned.slice(0, 93).trimEnd()}…`
}

function issueResponse(number: number, url: string): { issue: { number: number; url: string } } {
    return { issue: { number, url } }
}

function safeFilename(value: string, fallback: string): string {
    const cleaned = basename(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 140)
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

const issueLocks = new Map<string, Promise<void>>()

async function withIssueLock(key: string, operation: () => Promise<Response>): Promise<Response> {
    const predecessor = issueLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const ticket = new Promise<void>((resolve) => { release = resolve })
    const tail = predecessor.then(() => ticket)
    issueLocks.set(key, tail)
    await predecessor
    try {
        return await operation()
    } finally {
        release()
        if (issueLocks.get(key) === tail) issueLocks.delete(key)
    }
}

async function runProcess(command: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => child.kill(), timeoutMs)
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text()
        ])
        if (exitCode !== 0) throw new Error(stderr.trim() || `GitHub CLI exited with ${exitCode}`)
        return { stdout, stderr }
    } finally {
        clearTimeout(timeout)
    }
}
