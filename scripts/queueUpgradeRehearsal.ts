import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { Store } from '../hub/src/store';

const root = resolve(import.meta.dir, '..');
const output = process.env.REHEARSAL_OUTPUT!;
assert(output?.startsWith('/mnt/build/'));
assert(!existsSync(output), 'Use a fresh output directory; preserve previous receipts');
mkdirSync(output, { recursive: true, mode: 0o700 });
const home = join(output, 'home');
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
const marker = randomUUID();
const token = randomUUID();
const database = join(home, 'rehearsal.sqlite');
const nativeLog = join(output, 'native.jsonl');
const completeFile = join(output, 'complete-fixture');
const bun = process.execPath;
const children: ChildProcess[] = [];
const events: unknown[] = [];
let sessionId = '';
let jwt = '';
let hub!: ChildProcess;
let runner!: ChildProcess;
let sourceHash = '';
const port = await new Promise<number>(resolvePort => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
        const allocated = (server.address() as net.AddressInfo).port;
        server.close(() => resolvePort(allocated));
    });
});
const url = `http://127.0.0.1:${port}`;
const environment = {
    PATH: process.env.PATH!, HOME: home, HAPI_HOME: home, CODEX_HOME: join(home, 'codex'), TMPDIR: home,
    HAPI_TEST_MARKER: marker, CLI_API_TOKEN: token, DB_PATH: database,
    HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: String(port), HAPI_PUBLIC_URL: url, HAPI_API_URL: url,
    TELEGRAM_NOTIFICATION: 'false', SERVERCHAN_NOTIFICATION: 'false',
    HAPI_DISABLE_VERSION_HANDOFF: '1', HAPI_CODEX_APP_SERVER_BIN: join(import.meta.dir, 'fixtures/queueUpgradeNative.cjs'),
    REHEARSAL_NATIVE_LOG: nativeLog, REHEARSAL_COMPLETE_FILE: completeFile,
};

function ownedPids(): number[] {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
        try {
            return readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`HAPI_TEST_MARKER=${marker}`) ? [Number(name)] : [];
        } catch { return []; }
    });
}

async function waitFor<T>(read: () => T | Promise<T>, accepts: (value: T) => boolean, label: string, limit = 25_000): Promise<T> {
    const deadline = Date.now() + limit;
    let last: unknown;
    while (Date.now() < deadline) {
        try { const value = await read(); if (accepts(value)) return value; last = value; } catch (error) { last = String(error); }
        await Bun.sleep(100);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function launch(name: string, args: string[]): ChildProcess {
    const descriptor = openSync(join(output, `${name}.log`), 'a', 0o600);
    const child = spawn(bun, args, { cwd: root, env: environment, stdio: ['ignore', descriptor, descriptor], detached: true });
    closeSync(descriptor);
    children.push(child);
    events.push({ launched: name, pid: child.pid });
    return child;
}

async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    assert(ownedPids().includes(child.pid!));
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, Boolean, 'owned child exit', 10_000);
}

async function cleanup(): Promise<void> {
    for (const pid of ownedPids()) { try { process.kill(pid, 'SIGSTOP'); } catch {} }
    for (const pid of ownedPids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitFor(ownedPids, pids => pids.length === 0, 'owned process cleanup', 5000);
}

async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
    const response = await fetch(`${url}${path}`, {
        method, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    assert(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
}

async function startServices(label: string): Promise<void> {
    hub = launch(`hub-${label}`, ['run', join(root, 'hub/src/index.ts')]);
    await waitFor(() => fetch(`${url}/health`).then(response => response.ok), Boolean, 'hub ready');
    jwt = (await request('/api/auth', { accessToken: token })).token;
    runner = launch(`runner-${label}`, ['--cwd', join(root, 'cli'), join(root, 'cli/src/index.ts'), 'runner', 'start-sync', '--workspace-root', workspace]);
    await waitFor(() => JSON.parse(readFileSync(join(home, 'runner.state.json'), 'utf8')), state => state.pid === runner.pid, 'runner ready');
    await waitFor(() => request('/api/machines'), result => result.machines?.some((machine: any) => machine.active), 'machine routing ready');
    const state = JSON.parse(readFileSync(join(home, 'runner.state.json'), 'utf8'));
    await waitFor(() => request(`/api/machines/${state.startedWithMachineId}/list-directory`, { path: workspace }), () => true, 'machine RPC registration');
    for (const child of [hub, runner]) {
        events.push({ pid: child.pid, executableSha256: createHash('sha256').update(readFileSync(`/proc/${child.pid}/exe`)).digest('hex') });
    }
}

function nativeEvents(): any[] {
    return existsSync(nativeLog) ? readFileSync(nativeLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function assertNativeQueueOnly(): void {
    const entries = nativeEvents();
    assert(!entries.some(entry => entry.method === 'turn/steer'), 'Queue rehearsal must never steer');
    assert(!entries.some(entry => entry.method === 'turn/interrupt'), 'Queue rehearsal must never send native interrupt');
    assert(!entries.some(entry => entry.rejected), 'Native fixture rejected an unexpected method');
}

function snapshot(): any {
    const store = new Store(database);
    try {
        const session = store.sessions.getSession(sessionId)!;
        return {
            sessionId, metadata: session.metadata, model: session.model, effort: session.effort,
            modelReasoningEffort: session.modelReasoningEffort,
            agentState: session.agentState, serviceTier: session.serviceTier,
            pending: store.messages.getUninvokedLocalMessages(sessionId),
        };
    } finally { store.close(); }
}

async function send(localId: string, text = localId, scheduledAt?: number) {
    await request(`/api/sessions/${sessionId}/messages`, { localId, text, deliveryMode: 'queue', ...(scheduledAt ? { scheduledAt } : {}) });
}

let passed = false;
let failure: string | undefined;
const watchdog = setTimeout(() => { void cleanup().finally(() => process.exit(124)); }, 150_000);
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });
try {
    sourceHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['merge-base', '--is-ancestor', '9276d355', 'HEAD'], { cwd: root });
    await startServices('before');
    const machines = await request('/api/machines');
    const machineId = machines.machines.find((machine: any) => machine.active).id;
    const spawned = await request(`/api/machines/${machineId}/spawn`, { directory: workspace, agent: 'codex', model: 'gpt-6-astra', modelReasoningEffort: 'medium', startingMode: 'remote' });
    sessionId = spawned.sessionId;
    assert(sessionId, JSON.stringify(spawned));
    await waitFor(() => request(`/api/sessions/${sessionId}`), result => result.session?.active, 'wrapper active');
    await send('fixture-active', 'INTERRUPTED ACTIVE FIXTURE; no provider turn');
    await waitFor(nativeEvents, entries => entries.some(entry => entry.method === 'turn/start'), 'native fixture active');
    for (const localId of ['keep-first', 'edit-old', 'remove-me', 'keep-second']) await send(localId);
    await send('scheduled-kept', 'future scheduled fixture', Date.now() + 86_400_000);
    for (const localId of ['edit-old', 'remove-me']) {
        const message = snapshot().pending.find((item: any) => item.localId === localId);
        assert(message);
        const cancelled = await request(`/api/sessions/${sessionId}/messages/${message.id}`, undefined, 'DELETE');
        assert.equal(cancelled.status, 'cancelled');
    }
    await send('edit-new', 'EDITED text retained');
    await send('unknown-kept', 'UNRESOLVED; never replay automatically');
    const fixtureStore = new Store(database);
    fixtureStore.messages.setMessagesDeliveryState(sessionId, ['unknown-kept'], 'indeterminate');
    fixtureStore.close();
    const before = snapshot();
    assert.deepEqual(before.pending.map((item: any) => item.localId), ['keep-first', 'keep-second', 'scheduled-kept', 'edit-new', 'unknown-kept']);
    assert.equal(nativeEvents().filter(entry => entry.method === 'turn/start').length, 1);
    assertNativeQueueOnly();
    writeFileSync(join(output, 'before.json'), JSON.stringify(before, null, 2));
    const interrupted = ownedPids().filter(pid => pid !== hub.pid);
    events.push({ interruptedExecutables: interrupted.map(pid => ({ pid, executableSha256: createHash('sha256').update(readFileSync(`/proc/${pid}/exe`)).digest('hex') })) });
    for (const pid of interrupted) process.kill(pid, 'SIGSTOP');
    events.push({ boundary: 'freeze test-owned generation, stop hub, kill frozen fixture; explicit interruption', interrupted, pendingIds: before.pending.map((item: any) => item.localId) });
    await stop(hub);
    const checkpoint = snapshot();
    await cleanup();
    assert.deepEqual(ownedPids(), []);
    await startServices('after');
    const after = snapshot();
    assert.deepEqual(after, checkpoint);
    const state = await request(`/api/sessions/${sessionId}/messages/queued-state`, { localIds: checkpoint.pending.map((item: any) => item.localId) });
    assert.deepEqual([...state.queuedLocalIds, ...state.indeterminateLocalIds].sort(), checkpoint.pending.map((item: any) => item.localId).sort());
    events.push({ queuedStateReadback: state });
    writeFileSync(join(output, 'after.json'), JSON.stringify(after, null, 2));
    writeFileSync(completeFile, 'complete synthetic turns only');
    const resumed = await request(`/api/sessions/${sessionId}/resume`, {});
    events.push({ resumed });
    await waitFor(() => request(`/api/sessions/${sessionId}`), result => result.session?.active, 'replacement wrapper active');
    for (const localId of ['keep-first', 'keep-second', 'edit-new']) {
        const message = checkpoint.pending.find((item: any) => item.localId === localId);
        events.push({ explicitlyRetryingSyntheticKnownUndelivered: localId, result: await request(`/api/sessions/${sessionId}/messages/${message.id}/retry`, {}) });
    }
    await waitFor(nativeEvents, entries => entries.some(entry => entry.method === 'thread/resume' && entry.threadId === 'synthetic-upgrade-native'), 'same native routing restored');
    await waitFor(() => request(`/api/sessions/${sessionId}/messages/queued-state`, { localIds: ['keep-first', 'keep-second', 'edit-new'] }), result => result.invokedLocalMessages.length === 3, 'pending delivered after readback');
    const final = snapshot();
    assert.deepEqual(final.pending.map((item: any) => item.localId), ['scheduled-kept', 'unknown-kept']);
    const delivered = nativeEvents().filter(entry => entry.method === 'turn/start').slice(1).flatMap(entry => entry.input ?? []).map(item => item.text ?? '').join('\n');
    assert.equal(delivered, ['keep-first', 'keep-second', 'EDITED text retained'].join('\n'));
    assertNativeQueueOnly();
    assert.equal(final.model, before.model);
    assert.equal(final.modelReasoningEffort, before.modelReasoningEffort);
    assert.equal(final.serviceTier, before.serviceTier);
    const replacementTurns = nativeEvents().filter(entry => entry.method === 'turn/start').slice(1);
    assert(replacementTurns.every(entry => entry.effort === 'medium'));
    assert(replacementTurns.every(entry => entry.threadId === 'synthetic-upgrade-native' && entry.input.every((item: any) => item.type === 'text')));
    for (const text of ['keep-first', 'keep-second', 'EDITED text retained']) assert.equal(delivered.split(text).length - 1, 1);
    assert(nativeEvents().some(entry => entry.method === 'thread/resume' && entry.model === 'gpt-6-astra'));
    events.push({ nativeSafety: {
        steerCalls: nativeEvents().filter(entry => entry.method === 'turn/steer').length,
        interruptCalls: nativeEvents().filter(entry => entry.method === 'turn/interrupt').length,
        rejectedCalls: nativeEvents().filter(entry => entry.rejected).length,
    }, replacementDeliveryText: delivered });
    events.push({ finalPendingIds: final.pending.map((item: any) => item.localId), finalNativeId: final.metadata.codexSessionId });
    passed = true;
} catch (error) {
    failure = String(error);
} finally {
    await cleanup();
    clearTimeout(watchdog);
    const receipt = { passed, failure, sourceHash, sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(), harnessSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'), nativeFixtureSha256: createHash('sha256').update(readFileSync(environment.HAPI_CODEX_APP_SERVER_BIN)).digest('hex'), bun, bunSha256: createHash('sha256').update(readFileSync(bun)).digest('hex'), port, providerTurns: 0, compiledCandidate: false, events, survivors: ownedPids() };
    writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
}
if (!passed) process.exitCode = 1;
