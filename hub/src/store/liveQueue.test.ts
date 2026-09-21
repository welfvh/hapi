import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { recordLiveQueue, forgetLiveQueueOwner } from './liveQueue'

function fixture() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('buffered', { path: '/tmp/buffered' }, null, 'default')
    store.messages.addMessage(session.id, { text: 'waiting' }, 'a')
    store.messages.claimMessagesForDispatch(session.id, ['a'])
    return { store, id: session.id }
}

describe('live buffered queue proof', () => {
    it('shows positive live proof as queued without releasing the durable dispatch claim', () => {
        const { store, id } = fixture()
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBe('indeterminate')
        recordLiveQueue(id, 'socket-one', ['a'], () => true)
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBeUndefined()
        expect(store.messages.getLocalMessageStates(id, ['a'])[0].deliveryState).toBe('buffered')
        expect(store.messages.claimMessagesForDispatch(id, ['a'])).toBe(0)
        expect(store.messages.getUninvokedLocalMessages(id, { deliverableOnly: true })).toEqual([])
        forgetLiveQueueOwner('socket-one')
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBe('indeterminate')
    })

    it('invalidates proof when ownership is lost and does not mask true indeterminate delivery', () => {
        const { store, id } = fixture()
        let live = true
        recordLiveQueue(id, 'socket-two', ['a'], () => live)
        live = false
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBe('indeterminate')
        live = true
        store.messages.setMessagesDeliveryState(id, ['a'], 'indeterminate')
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBe('indeterminate')
        forgetLiveQueueOwner('socket-two')
    })

    it('replaces snapshots and prevents an old socket disconnect from removing new ownership', () => {
        const { store, id } = fixture()
        recordLiveQueue(id, 'old', ['a'], () => true)
        recordLiveQueue(id, 'new', ['a'], () => true)
        forgetLiveQueueOwner('old')
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBeUndefined()
        recordLiveQueue(id, 'new', [], () => true)
        expect(store.messages.getUninvokedLocalMessages(id)[0].deliveryState).toBe('indeterminate')
        forgetLiveQueueOwner('new')
    })
})
