import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir, hostname, tmpdir } from 'node:os'
import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Session } from '@hapi/protocol/types'
import type { SyncEngine, RpcGeneratedImageResponse, RpcReadFileResponse } from '../sync/syncEngine'

const MAX_BYTES = 50 * 1024 * 1024
const home = () => process.env.HAPI_HOME?.replace(/^~/, homedir()) ?? join(homedir(), '.hapi')

/** Same-host recovery only: never interpret a remote machine's path on the hub. */
async function ownsLocalMachine(session: Session): Promise<boolean> {
    if (session.metadata?.host !== hostname() || !session.metadata.machineId) return false
    try {
        const settings: unknown = JSON.parse(await readFile(join(home(), 'settings.json'), 'utf8'))
        return isObject(settings) && settings.machineId === session.metadata.machineId
    } catch { return false }
}

async function boundedFile(path: string, maxBytes = MAX_BYTES): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid media file')
        const bytes = Buffer.alloc(info.size)
        for (let offset = 0; offset < bytes.length;) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!result.bytesRead) throw new Error('Media changed while reading')
            offset += result.bytesRead
        }
        if ((await handle.stat()).size !== info.size) throw new Error('Media changed while reading')
        return bytes
    } finally { await handle.close() }
}

/** Proof is a typed agent media event or user attachment, in this authorized session. */
function references(engine: SyncEngine, sessionId: string, kind: 'generated' | 'attachment', key: string): boolean {
    let before: { at: number; seq: number } | undefined
    while (true) {
        const page = engine.getMessagesPage(sessionId, { limit: 200, before })
        for (const message of page.messages) {
            const record = unwrapRoleWrappedRecordEnvelope(message.content)
            if (!record || !isObject(record.content)) continue
            if (kind === 'generated' && record.role === 'agent') {
                const data = record.content.data
                if (isObject(data) && data.type === 'generated-image' && (data.imageId ?? data.image_id) === key) return true
            }
            if (kind === 'attachment' && record.role === 'user' && Array.isArray(record.content.attachments)) {
                if (record.content.attachments.some((attachment: unknown) => isObject(attachment)
                    && attachment.path === key && typeof attachment.mimeType === 'string'
                    && attachment.mimeType.startsWith('image/'))) return true
            }
        }
        const { nextBeforeAt: at, nextBeforeSeq: seq } = page.page
        if (!page.page.hasMore || at == null || seq == null || (before?.at === at && before.seq === seq)) return false
        before = { at, seq }
    }
}

export async function historicalGeneratedImage(engine: SyncEngine, session: Session, imageId: string): Promise<RpcGeneratedImageResponse | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(imageId) || !await ownsLocalMachine(session)) return null
    if (!references(engine, session.id, 'generated', imageId)) return null
    try {
        const root = await realpath(join(home(), 'generated-media'))
        const stem = join(root, imageId)
        // Reject symlink directories and files; only this fixed registry is addressable.
        if (await realpath(`${stem}.bin`) !== `${stem}.bin` || await realpath(`${stem}.json`) !== `${stem}.json`) return null
        const metadata: unknown = JSON.parse((await boundedFile(`${stem}.json`, 64 * 1024)).toString())
        if (!isObject(metadata) || metadata.id !== imageId || typeof metadata.mimeType !== 'string'
            || typeof metadata.fileName !== 'string') return null
        return { success: true as const, content: (await boundedFile(`${stem}.bin`)).toString('base64'),
            mimeType: metadata.mimeType, fileName: metadata.fileName }
    } catch { return null }
}

export async function historicalAttachment(engine: SyncEngine, session: Session, path: string): Promise<RpcReadFileResponse | null> {
    if (!await ownsLocalMachine(session) || !references(engine, session.id, 'attachment', path)) return null
    try {
        const root = await realpath(join(tmpdir(), 'hapi-blobs'))
        const target = await realpath(path)
        const folder = dirname(target)
        if (resolve(path) !== target || dirname(folder) !== root
            || !basename(folder).startsWith(`${session.id}-`) || !target.startsWith(`${root}${sep}`)) return null
        const bytes = await boundedFile(target)
        return { success: true as const, content: bytes.toString('base64'), size: bytes.length }
    } catch { return null }
}
