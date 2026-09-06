import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const directories: string[] = []
const stores: Store[] = []
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'origin-receipts-'))
    directories.push(directory)
    const path = join(directory, 'test.db')
    const store = new Store(path)
    stores.push(store)
    const session = store.sessions.getOrCreateSession('origin', {}, null, 'owner')
    const localId = store.getOriginReceiptCapability().localIdPrefix + randomUUID()
    return { store, path, session, localId }
}
const content = { role: 'user', content: { type: 'text', text: 'synthetic private payload' } }
function insert(store: Store, origin: string, localId: string, destination = origin) {
    return store.addOriginMessage('owner', origin, localId, destination, content, null, true)
}

describe('permanent origin receipts', () => {
    it('first acceptance wins after lost ACK, mutation of retry, deletion, and restart', () => {
        const { store, path, session, localId } = fixture()
        const first = insert(store, session.id, localId)
        expect(first.delivery?.inserted).toBe(true)
        expect(insert(store, session.id, localId).delivery).toBeNull()
        store.messages.cancelQueuedMessage(session.id, first.receipt.messageId)
        store.sessions.deleteSession(session.id, 'owner')
        store.close()
        const reopened = new Store(path)
        stores.push(reopened)
        const retry = reopened.addOriginMessage('owner', session.id, localId, 'nonexistent', { secret: 'different' }, Date.now() + 10000, true)
        expect(retry.delivery).toBeNull()
        expect(retry.receipt).toEqual({ ...first.receipt, messageState: 'deleted' })
        expect(() => insert(reopened, session.id, reopened.getOriginReceiptCapability().localIdPrefix + randomUUID())).toThrow('origin_deleted')
        const db = new Database(path, { readonly: true })
        expect(db.query('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
        const columns = db.query('PRAGMA table_info(origin_message_receipts)').all() as Array<{ name: string }>
        expect(columns.map(column => column.name)).toEqual(['namespace', 'origin_session_id', 'local_id', 'message_id', 'accepted_at', 'resolved_session_id'])
        expect(db.query('PRAGMA foreign_key_list(origin_message_receipts)').all()).toEqual([])
        db.close()
    })

    it('namespace scopes lookups and blocks cross-namespace routing', () => {
        const { store, session, localId } = fixture()
        insert(store, session.id, localId)
        expect(store.lookupOriginReceipt('other', session.id, localId).status).toBe('absent')
        expect(() => store.addOriginMessage('other', session.id, localId, session.id, content)).toThrow('origin_unavailable')
        const other = store.sessions.getOrCreateSession('other', {}, null, 'other')
        expect(() => store.messages.mergeSessionMessages(session.id, other.id)).toThrow('origin_unavailable')
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
    })

    it('replacement move and origin deletion preserve receipts, routing, and new delivery destination', () => {
        const { store, session, localId } = fixture()
        const first = insert(store, session.id, localId)
        const replacement = store.sessions.getOrCreateSession('replacement', {}, null, 'owner')
        store.messages.mergeSessionMessages(session.id, replacement.id)
        store.sessions.deleteSession(session.id, 'owner')
        const receipt = store.lookupOriginReceipt('owner', session.id, localId)
        expect(receipt).toEqual({ ...first.receipt, resolvedSessionId: replacement.id })
        expect(insert(store, session.id, localId, replacement.id).delivery).toBeNull()
        const nextId = store.getOriginReceiptCapability().localIdPrefix + randomUUID()
        expect(insert(store, session.id, nextId, replacement.id).receipt.resolvedSessionId).toBe(replacement.id)
        expect(store.messages.getMessages(replacement.id)).toHaveLength(2)
        store.sessions.deleteSession(replacement.id, 'owner')
        expect(insert(store, session.id, localId, replacement.id).receipt.messageState).toBe('deleted')
        expect(() => insert(store, session.id, store.getOriginReceiptCapability().localIdPrefix + randomUUID(), replacement.id)).toThrow('origin_deleted')
    })

    it('verifies metadata replacement at insertion and refuses changed destination or cycles', () => {
        const { store, session, localId } = fixture()
        const replacement = store.sessions.getOrCreateSession('replacement', {}, null, 'owner')
        store.sessions.updateSessionMetadata(session.id, { supersededBySessionId: replacement.id }, session.metadataVersion, 'owner')
        expect(() => insert(store, session.id, localId)).toThrow('routing_changed')
        expect(insert(store, session.id, localId, replacement.id).receipt.resolvedSessionId).toBe(replacement.id)
        store.sessions.updateSessionMetadata(replacement.id, { supersededBySessionId: session.id }, replacement.metadataVersion, 'owner')
        expect(() => store.resolveOriginSession('owner', session.id)).toThrow('routing_changed')
    })

    it('migration never fabricates legacy absence or backfills guessed origins', () => {
        const { store, path, session } = fixture()
        store.messages.addMessage(session.id, content, 'existing-legacy')
        store.close()
        const db = new Database(path)
        db.exec('DROP TRIGGER origin_session_deleted; DROP TRIGGER origin_message_moved; DROP TABLE origin_message_receipts; DROP TABLE origin_session_routes; DROP TABLE origin_receipt_capability; PRAGMA user_version=26')
        db.close()
        const upgraded = new Store(path)
        stores.push(upgraded)
        expect(upgraded.lookupOriginReceipt('owner', session.id, 'missing-legacy').status).toBe('legacy-unknown')
        expect(() => insert(upgraded, session.id, 'missing-legacy')).toThrow('legacy_unknown')
        expect(insert(upgraded, session.id, 'existing-legacy').delivery?.inserted).toBe(false)
        expect(upgraded.lookupOriginReceipt('owner', session.id, 'existing-legacy').status).toBe('accepted')
        const prefix = upgraded.getOriginReceiptCapability().localIdPrefix
        expect(upgraded.lookupOriginReceipt('owner', session.id, prefix + randomUUID()).status).toBe('absent')
        expect(upgraded.lookupOriginReceipt('owner', session.id, prefix + 'invalid').status).toBe('legacy-unknown')
    })

    it('scheduled indeterminate rows retain state and schedule through replacement and duplicate', () => {
        const { store, session, localId } = fixture()
        const scheduledAt = Date.now() + 60000
        const accepted = store.addOriginMessage('owner', session.id, localId, session.id, content, scheduledAt, true)
        store.messages.markMessagesIndeterminate(session.id, [localId])
        const replacement = store.sessions.getOrCreateSession('replacement', {}, null, 'owner')
        store.messages.mergeSessionMessages(session.id, replacement.id)
        const duplicate = store.addOriginMessage('owner', session.id, localId, replacement.id, { meta: { deliveryMode: 'steer' } }, null, true)
        expect(duplicate.delivery).toBeNull()
        expect(duplicate.receipt.messageId).toBe(accepted.receipt.messageId)
        const messages = store.messages.getMessages(replacement.id)
        expect(messages).toHaveLength(1)
        expect(messages[0].deliveryState).toBe('indeterminate')
        expect(messages[0].scheduledAt).toBe(scheduledAt)
        expect(messages[0].localId).toBe(localId)
        expect(messages[0].content).toEqual(content)
    })

    it('failed replacement link rolls back metadata and never records a route', () => {
        const { store, session } = fixture()
        expect(() => store.linkOriginReplacement(session.id, 'missing', { supersededBySessionId: 'missing' }, session.metadataVersion, 'owner')).toThrow('origin_unavailable')
        expect(store.resolveOriginSession('owner', session.id)).toBe(session.id)
        const replacement = store.sessions.getOrCreateSession('replacement', {}, null, 'owner')
        expect(store.linkOriginReplacement(session.id, replacement.id, { supersededBySessionId: replacement.id }, session.metadataVersion + 1, 'owner').result).toBe('version-mismatch')
        expect(store.resolveOriginSession('owner', session.id)).toBe(session.id)
    })

    it('receipt failure rolls back the message insert', () => {
        const { store, path, session, localId } = fixture()
        const db = new Database(path)
        db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON origin_message_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END")
        expect(() => insert(store, session.id, localId)).toThrow('synthetic receipt failure')
        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(store.lookupOriginReceipt('owner', session.id, localId).status).toBe('absent')
        db.exec('DROP TRIGGER reject_receipt')
        db.close()
        expect(insert(store, session.id, localId).delivery?.inserted).toBe(true)
    })

    it('simultaneous independent SQLite writers insert exactly once', async () => {
        const { store, path, session, localId } = fixture()
        const script = `import { Store } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};
            const store = new Store(process.argv[1]);
            const result = store.addOriginMessage('owner', process.argv[2], process.argv[3], process.argv[2], { synthetic: true }, null, true);
            process.stdout.write(JSON.stringify({ inserted: result.delivery?.inserted ?? false, id: result.receipt.messageId }));
            store.close();`
        const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e', script, path, session.id, localId], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdout: 'pipe', stderr: 'pipe', timeout: 10000
        }))
        try {
            const results = await Promise.all(children.map(async child => {
                const output = await new Response(child.stdout).text()
                const error = await new Response(child.stderr).text()
                expect(await child.exited, error).toBe(0)
                return JSON.parse(output) as { inserted: boolean; id: string }
            }))
            expect(results.filter(result => result.inserted)).toHaveLength(1)
            expect(new Set(results.map(result => result.id)).size).toBe(1)
            expect(store.messages.getMessages(session.id)).toHaveLength(1)
        } finally {
            for (const child of children) if (child.exitCode === null) child.kill()
            await Promise.all(children.map(child => child.exited))
        }
    }, 15000)

    it.each(['before', 'after'] as const)('process exit %s commit leaves coherent receipt/message state', async phase => {
        const { store, path, session, localId } = fixture()
        const script = `import { Store } from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};
            import { Database } from 'bun:sqlite';
            const store = new Store(process.argv[1]);
            const phase = process.argv[4];
            const db = store.db;
            if (phase === 'before') db.exec('BEGIN IMMEDIATE');
            store.addOriginMessage('owner', process.argv[2], process.argv[3], process.argv[2], { synthetic: true }, null, true);
            process.kill(process.pid, 'SIGKILL');`
        const child = Bun.spawn([process.execPath, '-e', script, path, session.id, localId, phase], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdout: 'pipe', stderr: 'pipe', timeout: 10000
        })
        try {
            await child.exited
            expect(child.signalCode).toBe('SIGKILL')
            expect(store.lookupOriginReceipt('owner', session.id, localId).status).toBe(phase === 'before' ? 'absent' : 'accepted')
            expect(store.messages.getMessages(session.id)).toHaveLength(phase === 'before' ? 0 : 1)
            expect(insert(store, session.id, localId).delivery === null).toBe(phase === 'after')
            expect(store.messages.getMessages(session.id)).toHaveLength(1)
        } finally {
            if (child.exitCode === null) child.kill()
            await child.exited
        }
    }, 15000)
})
