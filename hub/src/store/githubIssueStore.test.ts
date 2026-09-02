import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubIssueRequestConflict, Store } from '.'
import { deriveGitHubIssueTitle } from '../web/routes/githubIssues'

const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitHubIssueStore', () => {
    test('deduplicates a request, rejects changed payload, and records the canonical issue', () => {
        const store = new Store(':memory:')
        const input = {
            namespace: 'owner',
            localId: 'issue-local-0001',
            repository: 'welfvh/daylight-os',
            title: 'Keyboard stays open',
            body: 'Keyboard stays open after scrolling.',
            attachmentFingerprint: 'a'.repeat(64)
        }

        expect(store.githubIssues.begin(input).inserted).toBe(true)
        expect(store.githubIssues.begin(input).inserted).toBe(false)
        expect(() => store.githubIssues.begin({ ...input, body: 'different' }))
            .toThrow(GitHubIssueRequestConflict)

        expect(store.githubIssues.complete('owner', input.localId, 123, 'https://github.com/welfvh/daylight-os/issues/123'))
            .toMatchObject({ status: 'created', issueNumber: 123 })
        expect(store.githubIssues.get('other-owner', input.localId)).toBeNull()
        store.close()
    })

    test('migrates an existing v25 database without touching its other tables', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-github-issue-migration-'))
        roots.push(root)
        const path = join(root, 'hapi.db')
        new Store(path).close()
        const legacy = new Database(path)
        legacy.exec('DROP TABLE github_issue_requests; PRAGMA user_version = 25;')
        legacy.close()

        const migrated = new Store(path)
        expect(migrated.githubIssues.begin({
            namespace: 'default',
            localId: 'issue-local-0002',
            repository: 'welfvh/daylight-os',
            title: 'Migrated',
            body: 'Still here',
            attachmentFingerprint: 'b'.repeat(64)
        }).request.status).toBe('pending')
        migrated.close()
    })
})

describe('deriveGitHubIssueTitle', () => {
    test('uses the first meaningful line and bounds it', () => {
        expect(deriveGitHubIssueTitle('\n## Keyboard stays open\nMore context')).toBe('Keyboard stays open')
        expect(deriveGitHubIssueTitle('x'.repeat(120))).toBe(`${'x'.repeat(93)}…`)
    })
})
