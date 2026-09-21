import { describe, expect, it } from 'vitest'
import { MessageQueue2 } from './MessageQueue2'

function queue() {
    const result = new MessageQueue2<string>(mode => mode)
    result.push('A', 'same', 'a')
    result.push('B', 'same', 'b')
    return result
}

describe('reserved queue reorder', () => {
    it('holds consumption and cancellation until the durable commit decision', async () => {
        const q = queue()
        expect(q.prepareReorder('move', 'a', 'b')).toBe(true)
        const consumed: string[][] = []
        q.onBatchConsumed = ids => consumed.push(ids)
        const pending = q.waitForMessagesAndGetAsString()
        await Promise.resolve()
        expect(consumed).toEqual([])
        expect(q.cancelByLocalId('a')).toBe('in-flight')
        expect(q.takeByLocalId('b')).toBeNull()
        expect(q.settleReorder('move', true)).toBe(true)
        expect((await pending)?.items.map(item => item.localId)).toEqual(['b', 'a'])
        expect(consumed).toEqual([['b', 'a']])
        expect(q.settleReorder('move', true)).toBe(true)
    })

    it('aborts without moving or dropping an input', async () => {
        const q = queue()
        q.prepareReorder('move', 'a', 'b')
        q.push('C', 'same', 'c')
        expect(q.settleReorder('move', false)).toBe(true)
        expect((await q.waitForMessagesAndGetAsString())?.items.map(item => item.localId)).toEqual(['a', 'b', 'c'])
    })

    it('refuses consumed, nonadjacent, or reserved input without touching the queue', () => {
        const q = queue()
        q.push('C', 'same', 'c')
        expect(q.prepareReorder('move', 'a', 'c')).toBe(false)
        const reserved = q.takeByLocalId('a')!
        expect(q.prepareReorder('move', 'b', 'c')).toBe(false)
        q.commitReservation(reserved)
        expect(q.prepareReorder('move', 'a', 'b')).toBe(false)
        expect(q.pendingLocalIds()).toEqual(['b', 'c'])
    })
    it('defers reset across the reservation without discarding newer input', async () => {
        const q = queue()
        q.prepareReorder('move', 'a', 'b')
        q.reset()
        q.push('C', 'same', 'c')
        expect(q.settleReorder('move', true)).toBe(true)
        expect((await q.waitForMessagesAndGetAsString())?.items.map(item => item.localId)).toEqual(['c'])
    })

})
