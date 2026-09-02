import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import {
    createGitHubIssueRoutes,
    type CreatedIssue,
    type GitHubIssueCreator,
    type IssueCreateInput
} from './githubIssues'

class FakeCreator implements GitHubIssueCreator {
    creates: IssueCreateInput[] = []
    existing: CreatedIssue | null = null
    failure: Error | null = null

    async findExisting(): Promise<CreatedIssue | null> {
        return this.existing
    }

    async create(input: IssueCreateInput): Promise<CreatedIssue> {
        this.creates.push(input)
        if (this.failure) throw this.failure
        return { number: 91, url: 'https://github.com/welfvh/daylight-os/issues/91' }
    }
}

function buildApp(store: Store, creator: GitHubIssueCreator): Hono<WebAppEnv> {
    const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
    const engine = {
        resolveSessionAccess: () => ({ ok: true as const, sessionId: session.id, session })
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createGitHubIssueRoutes({
        store,
        getSyncEngine: () => engine,
        creator,
        allowedRepositories: ['welfvh/daylight-os']
    }))
    return app
}

const requestBody = {
    localId: 'radiant-issue-0001',
    repository: 'welfvh/daylight-os',
    text: 'Keyboard stays open\n\nIt should close when I scroll.',
    attachments: [{
        filename: 'shot.png',
        mimeType: 'image/png',
        size: 3,
        content: Buffer.from('png').toString('base64')
    }]
}

describe('Radiant GitHub issue route', () => {
    it('creates once with a durable inline attachment, then replays the canonical issue', async () => {
        const store = new Store(':memory:')
        const creator = new FakeCreator()
        const app = buildApp(store, creator)

        const create = await app.request('/api/sessions/session-1/github-issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody)
        })
        expect(create.status).toBe(201)
        expect(await create.json()).toEqual({ issue: { number: 91, url: 'https://github.com/welfvh/daylight-os/issues/91' } })
        expect(creator.creates).toHaveLength(1)
        expect(creator.creates[0]?.attachments[0]?.bytes).toEqual(Uint8Array.from(Buffer.from('png')))
        expect(creator.creates[0]?.body).toContain('Captured from Radiant session `session-1`.')

        const replay = await app.request('/api/sessions/session-1/github-issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody)
        })
        expect(replay.status).toBe(200)
        expect(creator.creates).toHaveLength(1)

        const conflict = await app.request('/api/sessions/session-1/github-issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...requestBody, text: 'Changed payload' })
        })
        expect(conflict.status).toBe(409)
        store.close()
    })

    it('rejects malformed and mismatched attachment bytes', async () => {
        const store = new Store(':memory:')
        const creator = new FakeCreator()
        const app = buildApp(store, creator)
        const submit = (content: string, size: number) => app.request('/api/sessions/session-1/github-issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ...requestBody,
                localId: `radiant-bad-${content.length}-${size}`,
                attachments: [{ ...requestBody.attachments[0], content, size }]
            })
        })

        expect((await submit('not/base64!', 4)).status).toBe(400)
        expect((await submit(Buffer.from('png').toString('base64'), 99)).status).toBe(400)
        expect(creator.creates).toHaveLength(0)
        store.close()
    })

    it('keeps a failed request pending so the same local id can drain later', async () => {
        const store = new Store(':memory:')
        const creator = new FakeCreator()
        creator.failure = new Error('offline')
        const app = buildApp(store, creator)
        const submit = () => app.request('/api/sessions/session-1/github-issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...requestBody, attachments: [] })
        })

        expect((await submit()).status).toBe(503)
        creator.failure = null
        expect((await submit()).status).toBe(201)
        expect(store.githubIssues.get('default', requestBody.localId)?.status).toBe('created')
        store.close()
    })
})
