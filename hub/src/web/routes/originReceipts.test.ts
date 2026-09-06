import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { Hono } from 'hono'
import type { Server } from 'socket.io'
import { OriginReceiptSchema, OriginReceiptLookupSchema, OriginReceiptCapabilitySchema } from '@hapi/protocol'
import { z } from 'zod'
import { Store } from '../../store'
import { MessageService } from '../../sync/messageService'
import type { SyncEngine } from '../../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const stores: Store[] = []
const AcceptedResponseSchema = z.object({ ok: z.literal(true), receipt: OriginReceiptSchema })
afterEach(() => { for (const store of stores.splice(0)) store.close() })

async function fixture() {
    const store = new Store(':memory:')
    stores.push(store)
    const session = store.sessions.getOrCreateSession('origin', { flavor: 'codex' }, null, 'owner')
    const emitted: unknown[] = []
    const published: unknown[] = []
    const io = { of: () => ({
        adapter: { rooms: { get: () => new Set(['synthetic-owner']) } },
        to: () => ({ emit: (_event: string, value: unknown) => emitted.push(value) })
    }) } as unknown as Server
    const publisher = { emit: (event: unknown) => { published.push(event) } } as unknown as ConstructorParameters<typeof MessageService>[2]
    const service = new MessageService(store, io, publisher)
    let active = true
    const engine = {
        getOriginReceiptCapability: () => store.getOriginReceiptCapability(),
        lookupOriginReceipt: store.lookupOriginReceipt.bind(store),
        resolveOriginSession: store.resolveOriginSession.bind(store),
        resolveSessionAccess: (id: string, namespace: string) => {
            const target = store.sessions.getSessionByNamespace(id, namespace)
            return target ? { ok: true, sessionId: id, session: { ...target, active } } : { ok: false, reason: 'not-found' }
        },
        sendMessage: async (id: string, payload: Parameters<MessageService['sendMessage']>[1]) => (await service.sendMessage(id, payload)).receipt
    } as unknown as SyncEngine
    const secret = new TextEncoder().encode('synthetic-test-secret-never-production')
    const token = async (namespace: string) => new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).sign(secret)
    const owner = await token('owner')
    const other = await token('other')
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(secret))
    app.route('/api', createMessagesRoutes(() => engine))
    const localId = store.getOriginReceiptCapability().localIdPrefix + randomUUID()
    const post = (body: Record<string, unknown>, bearer = owner) => app.request(`/api/sessions/${session.id}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'synthetic', localId, originReceiptVersion: 1, ...body })
    })
    const lookup = (bearer = owner) => app.request(`/api/message-receipts?originalSessionId=${session.id}&localId=${encodeURIComponent(localId)}`, {
        headers: { authorization: `Bearer ${bearer}` }
    })
    return { store, session, service, app, owner, other, localId, post, lookup, emitted, published, setInactive: () => { active = false } }
}

describe('authenticated origin receipt contract', () => {
    it('requires authentication for capability and lookup; absence is scoped, not history pagination', async () => {
        const { app, owner, lookup } = await fixture()
        expect((await app.request('/api/message-receipts/capability')).status).toBe(401)
        expect((await app.request('/api/message-receipts?originalSessionId=x&localId=y')).status).toBe(401)
        const response = await app.request('/api/message-receipts/capability', { headers: { authorization: `Bearer ${owner}` } })
        expect(OriginReceiptCapabilitySchema.parse(await response.json()).version).toBe(1)
        expect(OriginReceiptLookupSchema.parse(await (await lookup()).json()).status).toBe('absent')
    })

    it.each(['queue', 'steer', 'scheduled'] as const)('lost ACK duplicate %s never emits again, reschedules, or recreates deleted origin', async mode => {
        const fixtureValue = await fixture()
        const { store, session, post, lookup, emitted, published, other, setInactive } = fixtureValue
        const scheduledAt = mode === 'scheduled' ? Date.now() + 60000 : undefined
        const first = await post({ scheduledAt, deliveryMode: mode === 'scheduled' ? 'queue' : mode })
        expect(first.status).toBe(200)
        const accepted = AcceptedResponseSchema.parse(await first.json())
        expect(accepted.ok).toBe(true)
        expect(accepted.receipt.status).toBe('accepted')
        expect(emitted).toHaveLength(mode === 'scheduled' ? 0 : 1)
        const count = emitted.length
        const sseCount = published.length
        const duplicate = await post({ text: 'different synthetic', deliveryMode: 'steer' })
        expect(await duplicate.json()).toEqual(accepted)
        expect(store.messages.getMessages(session.id)[0].scheduledAt).toBe(scheduledAt ?? null)
        expect(emitted).toHaveLength(count)
        expect(published).toHaveLength(sseCount)
        expect(OriginReceiptLookupSchema.parse(await (await lookup(other)).json()).status).toBe('absent')
        expect((await post({}, other)).status).toBe(409)
        setInactive()
        expect((await post({})).status).toBe(200)
        store.sessions.deleteSession(session.id, 'owner')
        const deleted = { ...accepted, receipt: { ...accepted.receipt, messageState: 'deleted' } }
        expect(await (await lookup()).json()).toEqual(deleted.receipt)
        expect(await (await post({})).json()).toEqual(deleted)
        expect(emitted).toHaveLength(count)
        expect(published).toHaveLength(sseCount)
        expect((await post({ localId: store.getOriginReceiptCapability().localIdPrefix + randomUUID() })).status).toBe(409)
    })

    it('legacy unknown never blind-inserts on versioned POST; old unversioned POST stays compatible', async () => {
        const { store, session, post } = await fixture()
        const unknown = await post({ localId: 'legacy-attempt' })
        expect(unknown.status).toBe(409)
        expect(await unknown.json()).toEqual({ error: 'legacy_unknown', code: 'legacy_unknown' })
        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        const legacy = await post({ localId: 'legacy-new', originReceiptVersion: undefined })
        expect(legacy.status).toBe(200)
        expect(AcceptedResponseSchema.parse(await legacy.json()).receipt.status).toBe('accepted')
    })

    it('deleted merged origin routes new intent to verified replacement and duplicate remains at origin key', async () => {
        const { store, session, post, lookup } = await fixture()
        const replacement = store.sessions.getOrCreateSession('replacement', { flavor: 'codex' }, null, 'owner')
        store.messages.mergeSessionMessages(session.id, replacement.id)
        store.sessions.deleteSession(session.id, 'owner')
        const accepted = AcceptedResponseSchema.parse(await (await post({})).json())
        expect(accepted.receipt.resolvedSessionId).toBe(replacement.id)
        expect(accepted.receipt.originalSessionId).toBe(session.id)
        expect(await (await lookup()).json()).toEqual(accepted.receipt)
        expect(await (await post({})).json()).toEqual(accepted)
        expect(store.messages.getMessages(replacement.id)).toHaveLength(1)
    })
})
