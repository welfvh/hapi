import { Hono } from 'hono'
import { MessagesQuerySchema, QueuedStateRequestSchema, SendMessageRequestSchema } from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession, requireSessionFromParam, requireSyncEngine } from './guards'
import { OriginReceiptError } from '../../store/originReceipts'

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/message-receipts/capability', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        return c.json(engine.getOriginReceiptCapability())
    })

    app.get('/message-receipts', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const originalSessionId = c.req.query('originalSessionId')
        const localId = c.req.query('localId')
        if (!originalSessionId || !localId) return c.json({ error: 'originalSessionId and localId required' }, 400)
        return c.json(engine.lookupOriginReceipt(c.get('namespace'), originalSessionId, localId))
    })

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = MessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const before = parsed.data.beforeAt !== undefined && parsed.data.beforeSeq !== undefined
            ? { at: parsed.data.beforeAt, seq: parsed.data.beforeSeq }
            : null
        const after = parsed.data.afterAt !== undefined && parsed.data.afterSeq !== undefined
            ? { at: parsed.data.afterAt, seq: parsed.data.afterSeq }
            : null
        const until = parsed.data.untilAt !== undefined && parsed.data.untilSeq !== undefined
            ? { at: parsed.data.untilAt, seq: parsed.data.untilSeq }
            : null
        return c.json(engine.getMessagesPage(sessionId, {
            limit,
            before,
            after,
            until,
            epoch: parsed.data.epoch ?? null
        }))
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/steer', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.steerQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/retry', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json(await engine.retryIndeterminateMessage(
            sessionResult.sessionId,
            c.req.param('messageId')
        ))
    })

    app.post('/sessions/:id/messages/queued-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = QueuedStateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const localIds = [...new Set(parsed.data.localIds)]
        if (localIds.length === 0) {
            return c.json({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
        }
        return c.json(engine.getQueuedState(sessionId, localIds))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        try {
            let destination = sessionId
            if (parsed.data.localId) {
                const previous = engine.lookupOriginReceipt(namespace, sessionId, parsed.data.localId)
                if (previous.status === 'accepted') return c.json({ ok: true, receipt: previous })
                destination = engine.resolveOriginSession(namespace, sessionId)
            }
            const sessionResult = requireSession(c, engine, destination, { requireActive: true })
            if (sessionResult instanceof Response) return sessionResult

            const receipt = await engine.sendMessage(sessionId, {
                text: parsed.data.text,
                localId: parsed.data.localId,
                attachments: parsed.data.attachments,
                sentFrom: 'webapp',
                scheduledAt: parsed.data.scheduledAt,
                deliveryMode: parsed.data.deliveryMode,
                originNamespace: namespace,
                originReceiptVersion: parsed.data.originReceiptVersion
            })
            return c.json({ ok: true, ...(receipt ? { receipt } : {}) })
        } catch (error) {
            if (error instanceof OriginReceiptError) return c.json({ error: error.code, code: error.code }, 409)
            throw error
        }
    })

    return app
}
