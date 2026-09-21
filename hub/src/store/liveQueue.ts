/** Positive, connection-scoped proof of inputs still waiting in the wrapper.
 * Durable dispatch claims remain unchanged and therefore never become replayable.
 */
const liveQueues = new Map<string, { owner: string; localIds: Set<string>; live: () => boolean }>()

export function recordLiveQueue(sessionId: string, owner: string, localIds: string[], live: () => boolean): void {
    if (!live()) return
    liveQueues.set(sessionId, { owner, localIds: new Set(localIds), live })
}

export function forgetLiveQueueOwner(owner: string): Array<{ sessionId: string; localIds: string[] }> {
    const removed: Array<{ sessionId: string; localIds: string[] }> = []
    for (const [sessionId, queue] of liveQueues) {
        if (queue.owner !== owner) continue
        liveQueues.delete(sessionId)
        removed.push({ sessionId, localIds: [...queue.localIds] })
    }
    return removed
}

export function isLiveQueued(sessionId: string, localId: string | null): boolean {
    const queue = liveQueues.get(sessionId)
    return !!localId && !!queue && queue.live() && queue.localIds.has(localId)
}
