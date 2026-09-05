import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('rejects steer, interrupt and unknown requests in the actual native fixture process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'queue-native-negative-'));
    const methods = ['turn/steer', 'turn/interrupt', 'unexpected/mutation'];
    const requests = methods.map((method, index) => JSON.stringify({ id: index + 1, method, params: { threadId: 'synthetic' } }));
    const child = Bun.spawn(['node', join(import.meta.dir, 'fixtures/queueUpgradeNative.cjs')], {
        env: { PATH: process.env.PATH, HOME: directory, REHEARSAL_NATIVE_LOG: join(directory, 'requests.jsonl') },
        stdin: new Blob([requests.join('\n') + '\n']), stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
        const output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        expect(output.trim().split('\n').map(line => JSON.parse(line).error.code)).toEqual([-32601, -32601, -32601]);
        const observations = readFileSync(join(directory, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(observations.map(entry => entry.method)).toEqual(methods);
        expect(observations.every(entry => entry.rejected === true)).toBe(true);
    } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
        rmSync(directory, { recursive: true, force: true });
    }
});
