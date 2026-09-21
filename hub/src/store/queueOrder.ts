import type { Database } from 'bun:sqlite'

export type QueueMove = {
    id: string; session_id: string; left_id: string; right_id: string;
    left_rank: number; right_rank: number; expires_at: number;
    state: 'pending' | 'committed' | 'applied' | 'aborted';
}

export function createQueueOrderSchema(db: Database): void {
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'queue_order')) db.exec('ALTER TABLE messages ADD COLUMN queue_order INTEGER')
    db.exec(`CREATE TABLE IF NOT EXISTS queue_moves (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, left_id TEXT NOT NULL, right_id TEXT NOT NULL,
        left_rank INTEGER NOT NULL, right_rank INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )`)
}

export function getQueueMove(db: Database, sessionId: string, id: string): QueueMove | null {
    db.prepare("UPDATE queue_moves SET state = 'aborted' WHERE id = ? AND session_id = ? AND state = 'pending' AND expires_at <= ?")
        .run(id, sessionId, Date.now())
    return db.prepare('SELECT * FROM queue_moves WHERE id = ? AND session_id = ?').get(id, sessionId) as QueueMove | null
}

export function beginQueueMove(db: Database, sessionId: string, id: string, leftId: string, rightId: string): QueueMove | null {
    return db.transaction(() => {
        const previous = getQueueMove(db, sessionId, id)
        if (previous) return previous.left_id === leftId && previous.right_id === rightId ? previous : null
        db.prepare("UPDATE queue_moves SET state = 'aborted' WHERE session_id = ? AND state = 'pending' AND expires_at <= ?")
            .run(sessionId, Date.now())
        if (db.prepare("SELECT 1 FROM queue_moves WHERE session_id = ? AND state IN ('pending', 'committed')").get(sessionId)) return null
        const rows = db.prepare(`SELECT local_id, COALESCE(queue_order, seq) AS rank FROM messages
            WHERE session_id = ? AND invoked_at IS NULL AND scheduled_at IS NULL AND local_id IS NOT NULL
            ORDER BY COALESCE(queue_order, seq), seq`).all(sessionId) as Array<{ local_id: string; rank: number }>
        const index = rows.findIndex(row => row.local_id === leftId)
        if (index < 0 || rows[index + 1]?.local_id !== rightId) return null
        db.prepare(`INSERT INTO queue_moves VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
            .run(id, sessionId, leftId, rightId, rows[index].rank, rows[index + 1].rank, Date.now() + 30_000)
        return getQueueMove(db, sessionId, id)
    })()
}

export function settleQueueMove(db: Database, sessionId: string, id: string, action: 'commit' | 'abort' | 'applied'): QueueMove | null {
    return db.transaction(() => {
        const move = getQueueMove(db, sessionId, id)
        if (!move) return null
        if (action === 'abort' && move.state === 'pending') {
            db.prepare("UPDATE queue_moves SET state = 'aborted' WHERE id = ?").run(id)
        } else if (action === 'applied' && move.state === 'committed') {
            db.prepare("UPDATE queue_moves SET state = 'applied' WHERE id = ?").run(id)
        } else if (action === 'commit' && move.state === 'pending') {
            // The runner has reserved these rows. Never rewrite consumed inputs,
            // scheduled inputs, message seqs or durable origin receipts.
            const eligible = db.prepare(`SELECT local_id FROM messages WHERE session_id = ?
                AND local_id IN (?, ?) AND invoked_at IS NULL AND scheduled_at IS NULL
                AND delivery_state IN ('queued', 'dispatching')`).all(sessionId, move.left_id, move.right_id)
            if (eligible.length !== 2) {
                db.prepare("UPDATE queue_moves SET state = 'aborted' WHERE id = ?").run(id)
            } else {
                const update = db.prepare('UPDATE messages SET queue_order = ? WHERE session_id = ? AND local_id = ?')
                update.run(move.right_rank, sessionId, move.left_id)
                update.run(move.left_rank, sessionId, move.right_id)
                db.prepare("UPDATE queue_moves SET state = 'committed' WHERE id = ?").run(id)
            }
        }
        return getQueueMove(db, sessionId, id)
    })()
}
