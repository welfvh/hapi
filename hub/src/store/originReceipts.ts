import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { OriginReceipt, OriginReceiptLookup } from '@hapi/protocol'
export type { OriginReceipt, OriginReceiptLookup } from '@hapi/protocol'

export class OriginReceiptError extends Error {
    constructor(readonly code: 'origin_deleted' | 'origin_unavailable' | 'legacy_unknown' | 'routing_changed') {
        super(code)
    }
}

export function createOriginReceiptSchema(db: Database): void {
    db.transaction(() => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS origin_receipt_capability (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                epoch TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS origin_message_receipts (
                namespace TEXT NOT NULL,
                origin_session_id TEXT NOT NULL,
                local_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                accepted_at INTEGER NOT NULL,
                resolved_session_id TEXT NOT NULL,
                PRIMARY KEY (namespace, origin_session_id, local_id)
            );
            CREATE INDEX IF NOT EXISTS idx_origin_receipts_message ON origin_message_receipts(message_id);
            CREATE TABLE IF NOT EXISTS origin_session_routes (
                namespace TEXT NOT NULL,
                origin_session_id TEXT NOT NULL,
                destination_session_id TEXT,
                PRIMARY KEY (namespace, origin_session_id)
            );
            CREATE TRIGGER IF NOT EXISTS origin_session_deleted AFTER DELETE ON sessions BEGIN
                INSERT OR IGNORE INTO origin_session_routes VALUES (OLD.namespace, OLD.id, NULL);
            END;
            CREATE TRIGGER IF NOT EXISTS origin_message_moved AFTER UPDATE OF session_id ON messages BEGIN
                UPDATE origin_message_receipts SET resolved_session_id = NEW.session_id WHERE message_id = NEW.id;
            END;
        `)
        db.prepare('INSERT OR IGNORE INTO origin_receipt_capability VALUES (1, ?)').run(randomUUID())
        db.exec(`
            INSERT OR IGNORE INTO origin_session_routes
            SELECT source.namespace, source.id, target.id FROM sessions source JOIN sessions target
              ON target.namespace = source.namespace
             AND target.id = json_extract(CASE WHEN json_valid(source.metadata) THEN source.metadata ELSE '{}' END, '$.supersededBySessionId')
            WHERE source.id != target.id;
        `)
    })()
}

export function getOriginReceiptCapability(db: Database): { version: 1; localIdPrefix: string } {
    const row = db.prepare('SELECT epoch FROM origin_receipt_capability WHERE singleton = 1').get() as { epoch: string }
    return { version: 1, localIdPrefix: `or1:${row.epoch}:` }
}

export function lookupOriginReceipt(db: Database, namespace: string, originalSessionId: string, localId: string): OriginReceiptLookup {
    const row = db.prepare(`
        SELECT receipt.message_id AS messageId, receipt.accepted_at AS acceptedAt,
               receipt.resolved_session_id AS resolvedSessionId,
               CASE WHEN message.id IS NULL THEN 'deleted' ELSE 'retained' END AS messageState
        FROM origin_message_receipts receipt LEFT JOIN messages message ON message.id = receipt.message_id
        WHERE receipt.namespace = ? AND receipt.origin_session_id = ? AND receipt.local_id = ?
    `).get(namespace, originalSessionId, localId) as Omit<OriginReceipt, 'version' | 'status' | 'originalSessionId' | 'localId'> | undefined
    if (row) return { version: 1, status: 'accepted', originalSessionId, localId, ...row }
    const prefix = getOriginReceiptCapability(db).localIdPrefix
    const suffix = localId.startsWith(prefix) ? localId.slice(prefix.length) : ''
    const covered = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix)
    return { version: 1, status: covered ? 'absent' : 'legacy-unknown', originalSessionId, localId }
}

export function resolveOriginSession(db: Database, namespace: string, originalSessionId: string): string {
    let current = originalSessionId
    const visited = new Set<string>()
    while (!visited.has(current)) {
        visited.add(current)
        const route = db.prepare('SELECT destination_session_id FROM origin_session_routes WHERE namespace = ? AND origin_session_id = ?')
            .get(namespace, current) as { destination_session_id: string | null } | undefined
        if (route) {
            if (route.destination_session_id === null) throw new OriginReceiptError('origin_deleted')
            current = route.destination_session_id
            continue
        }
        const session = db.prepare('SELECT metadata FROM sessions WHERE id = ? AND namespace = ?')
            .get(current, namespace) as { metadata: string | null } | undefined
        if (!session) throw new OriginReceiptError('origin_unavailable')
        const metadata = session.metadata ? JSON.parse(session.metadata) as {
            supersededBySessionId?: string
            opencodeClearOperation?: { state?: string; replacementSessionId?: string }
        } : null
        const next = metadata?.supersededBySessionId
            ?? (metadata?.opencodeClearOperation?.state !== 'aborted' ? metadata?.opencodeClearOperation?.replacementSessionId : undefined)
        if (!next) return current
        current = next
    }
    throw new OriginReceiptError('routing_changed')
}

export function recordOriginReplacement(db: Database, fromSessionId: string, toSessionId: string): void {
    const source = db.prepare('SELECT namespace FROM sessions WHERE id = ?').get(fromSessionId) as { namespace: string } | undefined
    const target = source && db.prepare('SELECT 1 FROM sessions WHERE id = ? AND namespace = ?').get(toSessionId, source.namespace)
    if (!source || !target) throw new OriginReceiptError('origin_unavailable')
    const existing = db.prepare('SELECT destination_session_id FROM origin_session_routes WHERE namespace = ? AND origin_session_id = ?')
        .get(source.namespace, fromSessionId) as { destination_session_id: string | null } | undefined
    if (existing && existing.destination_session_id !== toSessionId) throw new OriginReceiptError('routing_changed')
    if (resolveOriginSession(db, source.namespace, toSessionId) === fromSessionId) throw new OriginReceiptError('routing_changed')
    db.prepare('INSERT OR IGNORE INTO origin_session_routes VALUES (?, ?, ?)').run(source.namespace, fromSessionId, toSessionId)
}
