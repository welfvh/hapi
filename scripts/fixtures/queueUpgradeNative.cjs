#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const readline = require('node:readline');
const threadId = 'synthetic-upgrade-native';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    const params = request.params || {};
    const probe = ['thread/fork', 'thread/rollback'].includes(request.method) && params.threadId === '__hapi_capability_probe__';
    const allowed = ['initialize', 'initialized', 'model/list', 'skills/list', 'collaborationMode/list', 'experimentalFeature/enablement/set', 'thread/start', 'thread/resume', 'thread/read', 'thread/goal/get', 'turn/start'];
    const rejected = (!allowed.includes(request.method) && !probe) || (request.id === undefined && request.method !== 'initialized');
    appendFileSync(process.env.REHEARSAL_NATIVE_LOG, `${JSON.stringify({ pid: process.pid, method: request.method, threadId: params.threadId, input: params.input, model: params.model, effort: params.effort, rejected })}\n`);
    if (rejected || probe) {
        if (request.id !== undefined) send({ id: request.id, error: { code: rejected ? -32601 : -32602, message: rejected ? 'Forbidden or unsupported rehearsal method' : 'Unknown synthetic probe thread' } });
        return;
    }
    if (request.id === undefined) return;
    let result = {};
    if (request.method === 'initialize') result = { userAgent: 'isolated-synthetic-native' };
    else if (request.method === 'model/list') result = { data: [], nextCursor: null };
    else if (request.method === 'skills/list' || request.method === 'collaborationMode/list') result = { data: [] };
    else if (request.method === 'thread/start' || request.method === 'thread/resume') {
        result = { thread: { id: threadId, turns: [], status: { type: 'idle' } }, model: 'gpt-6-astra', modelProvider: 'openai', cwd: params.cwd, approvalPolicy: 'on-request', sandbox: { type: 'read-only' }, reasoningEffort: 'medium' };
    } else if (request.method === 'thread/read') result = { thread: { id: threadId, turns: [] } };
    else if (request.method === 'thread/goal/get') result = { goal: null };
    else if (request.method === 'turn/start') {
        const turn = { id: `synthetic-turn-${request.id}`, status: 'inProgress', items: [] };
        send({ id: request.id, result: { turn } });
        send({ method: 'turn/started', params: { threadId, turn } });
        if (existsSync(process.env.REHEARSAL_COMPLETE_FILE)) {
            send({ method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } } });
        }
        return;
    }
    send({ id: request.id, result });
});
