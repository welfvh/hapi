import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function fixture() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('queue-order', { path: '/tmp/order' }, null, 'default')
    const a = store.messages.addMessage(session.id, { text: 'a' }, 'a')
    const b = store.messages.addMessage(session.id, { text: 'b' }, 'b')
    const c = store.messages.addMessage(session.id, { text: 'c' }, 'c')
    return { store, session, a, b, c }
}

describe('durable adjacent queue moves', () => {
    it('persists a swap without changing message IDs, seqs or delivery state', () => {
        const { store, session, a, b } = fixture()
        store.messages.claimMessagesForDispatch(session.id, ['a', 'b'])
        expect(store.messages.beginQueueMove(session.id, 'move', 'a', 'b')?.state).toBe('pending')
        expect(store.messages.settleQueueMove(session.id, 'move', 'commit')?.state).toBe('committed')
        const rows = store.messages.getUninvokedLocalMessages(session.id)
        expect(rows.map(row => row.localId)).toEqual(['b', 'a', 'c'])
        expect(rows.find(row => row.id === a.id)?.seq).toBe(a.seq)
        expect(rows.find(row => row.id === b.id)?.seq).toBe(b.seq)
        expect(rows.find(row => row.id === a.id)?.invokedAt).toBeNull()
        expect(store.messages.beginQueueMove(session.id, 'another', 'b', 'a')).toBeNull()
        expect(store.messages.settleQueueMove(session.id, 'move', 'applied')?.state).toBe('applied')
        expect(store.messages.beginQueueMove(session.id, 'another', 'b', 'a')?.state).toBe('pending')
    })

    it('rejects nonadjacent and consumed rows and never commits after abort', () => {
        const { store, session } = fixture()
        expect(store.messages.beginQueueMove(session.id, 'skip', 'a', 'c')).toBeNull()
        store.messages.beginQueueMove(session.id, 'move', 'a', 'b')
        store.messages.markMessagesInvoked(session.id, ['a'], Date.now())
        expect(store.messages.settleQueueMove(session.id, 'move', 'commit')?.state).toBe('aborted')
        expect(store.messages.settleQueueMove(session.id, 'move', 'commit')?.state).toBe('aborted')
        expect(store.messages.getUninvokedLocalMessages(session.id).map(row => row.localId)).toEqual(['b', 'c'])
    })

    it('keeps the original order on declined preparation and makes retries idempotent', () => {
        const { store, session } = fixture()
        store.messages.beginQueueMove(session.id, 'move', 'a', 'b')
        store.messages.settleQueueMove(session.id, 'move', 'abort')
        expect(store.messages.beginQueueMove(session.id, 'move', 'a', 'b')?.state).toBe('aborted')
        expect(store.messages.getUninvokedLocalMessages(session.id).map(row => row.localId)).toEqual(['a', 'b', 'c'])
    })
})
