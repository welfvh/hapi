import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'

export type GitHubIssueRequestInput = {
    namespace: string
    localId: string
    repository: string
    title: string
    body: string
    attachmentFingerprint: string
}

export type StoredGitHubIssueRequest = {
    namespace: string
    localId: string
    repository: string
    status: 'pending' | 'created'
    issueNumber: number | null
    issueUrl: string | null
    lastError: string | null
    createdAt: number
    updatedAt: number
}

type RawGitHubIssueRequest = StoredGitHubIssueRequest & {
    payloadFingerprint: string
}

export class GitHubIssueRequestConflict extends Error {
    constructor() {
        super('local_id_reused')
    }
}

/** Durable idempotency ledger for Radiant's queue-first issue capture. */
export class GitHubIssueStore {
    constructor(private readonly db: Database) {}

    begin(input: GitHubIssueRequestInput): { request: StoredGitHubIssueRequest; inserted: boolean } {
        const now = Date.now()
        const payloadFingerprint = issuePayloadFingerprint(input)
        const inserted = this.db.prepare(`
            INSERT OR IGNORE INTO github_issue_requests (
                namespace, local_id, repository, payload_fingerprint, status,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).run(
            input.namespace,
            input.localId,
            input.repository,
            payloadFingerprint,
            now,
            now
        ).changes === 1
        const stored = this.raw(input.namespace, input.localId)
        if (!stored) throw new Error('github issue request was not persisted')
        if (stored.payloadFingerprint !== payloadFingerprint) throw new GitHubIssueRequestConflict()
        return { request: publicRequest(stored), inserted }
    }

    get(namespace: string, localId: string): StoredGitHubIssueRequest | null {
        const row = this.raw(namespace, localId)
        return row ? publicRequest(row) : null
    }

    complete(namespace: string, localId: string, issueNumber: number, issueUrl: string): StoredGitHubIssueRequest {
        this.db.prepare(`
            UPDATE github_issue_requests
            SET status = 'created', issue_number = ?, issue_url = ?, last_error = NULL, updated_at = ?
            WHERE namespace = ? AND local_id = ?
        `).run(issueNumber, issueUrl, Date.now(), namespace, localId)
        const request = this.get(namespace, localId)
        if (!request) throw new Error('github issue request disappeared')
        return request
    }

    recordFailure(namespace: string, localId: string, message: string): void {
        this.db.prepare(`
            UPDATE github_issue_requests SET last_error = ?, updated_at = ?
            WHERE namespace = ? AND local_id = ? AND status = 'pending'
        `).run(message.slice(0, 2_000), Date.now(), namespace, localId)
    }

    private raw(namespace: string, localId: string): RawGitHubIssueRequest | null {
        return this.db.prepare(`
            SELECT namespace, local_id AS localId, repository,
                   payload_fingerprint AS payloadFingerprint, status,
                   issue_number AS issueNumber, issue_url AS issueUrl,
                   last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
            FROM github_issue_requests
            WHERE namespace = ? AND local_id = ?
        `).get(namespace, localId) as RawGitHubIssueRequest | null
    }
}

function issuePayloadFingerprint(input: GitHubIssueRequestInput): string {
    return createHash('sha256')
        .update(input.repository)
        .update('\0')
        .update(input.title)
        .update('\0')
        .update(input.body)
        .update('\0')
        .update(input.attachmentFingerprint)
        .digest('hex')
}

function publicRequest(row: RawGitHubIssueRequest): StoredGitHubIssueRequest {
    const { payloadFingerprint: _, ...request } = row
    return request
}
