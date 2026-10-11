import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCaptureBrowser } from './captureVehicle3d.mjs';

function child() {
  const result = new EventEmitter();
  Object.assign(result, { pid: 12345, exitCode: null, signalCode: null, stderr: new EventEmitter(), kills: [] });
  result.kill = signal => { result.kills.push(signal); result.signalCode = signal; result.emit('exit', null, signal); return true; };
  return result;
}
const OWN = 'http://127.0.0.1:41234';
const target = { type: 'page', url: 'about:blank', id: 'own-page', webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/page/own-page' };

// An already occupied endpoint responds with a navigable foreign page: never discover it.
test('discovers only the new child profile endpoint while an existing endpoint responds', async () => {
  const output = await mkdtemp(join(tmpdir(), 'task9-owner-test-'));
  let foreignPolls = 0; const ownChild = child();
  try {
    const owner = await launchCaptureBrowser(output, {
      attempts: 3, pollMs: 1,
      spawnChild: (_exe, args) => {
        const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice(16);
        writeFileSync(join(profile, 'DevToolsActivePort'), '41234\n/devtools/browser/own-browser\n');
        return ownChild;
      },
      fetchEndpoint: async url => {
        if (!url.startsWith(OWN)) { foreignPolls++; return { ok: true, json: async () => [{ ...target, id: 'foreign-page', webSocketDebuggerUrl: 'ws://127.0.0.1:9339/devtools/page/foreign-page' }] }; }
        return { ok: true, json: async () => url.endsWith('/json/version') ? { webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/browser/own-browser' } : [target] };
      },
    });
    assert.equal(owner.target.id, 'own-page'); assert.equal(foreignPolls, 0);
    await owner.close();
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('child startup exit fails closed without polling the occupied endpoint', async () => {
  const output = await mkdtemp(join(tmpdir(), 'task9-owner-test-')); let polls = 0; const ownChild = child();
  try {
    await assert.rejects(launchCaptureBrowser(output, {
      attempts: 3, pollMs: 1,
      spawnChild: () => { queueMicrotask(() => { ownChild.exitCode = 7; ownChild.emit('exit', 7, null); }); return ownChild; },
      fetchEndpoint: async () => { polls++; return { ok: true, json: async () => [target] }; },
    }), /exit|startup/i);
    assert.equal(polls, 0); assert.deepEqual(ownChild.kills, []);
  } finally { await rm(output, { recursive: true, force: true }); }
});


async function fixture() {
  const output = await mkdtemp(join(tmpdir(), 'task9-owner-test-'));
  const unrelated = join(output, 'headless-profile'); await mkdir(unrelated); await writeFile(join(unrelated, 'keep'), 'unrelated profile');
  const ownChild = child(); let profile; const requests = [];
  const spawnChild = (_exe, args) => {
    assert.ok(args.includes('--remote-debugging-port=0'));
    profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice(16);
    assert.notEqual(profile, unrelated);
    writeFileSync(join(profile, 'DevToolsActivePort'), '41234\n/devtools/browser/own-browser\n'); return ownChild;
  };
  const fetchEndpoint = async url => {
    requests.push(url); assert.ok(url.startsWith(OWN));
    return { ok: true, json: async () => url.endsWith('/json/version') ? { webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/browser/own-browser' } : [target] };
  };
  const cleanupCheck = async () => {
    await assert.rejects(access(profile), { code: 'ENOENT' });
    assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'unrelated profile');
  };
  return { output, ownChild, requests, spawnChild, fetchEndpoint, cleanupCheck, profile: () => profile };
}

test('startup timeout polls no endpoint and cleans only its child and fresh profile', async () => {
  const f = await fixture();
  try {
    await assert.rejects(launchCaptureBrowser(f.output, { attempts: 2, pollMs: 1,
      spawnChild: (_exe, args) => { const c = f.spawnChild(_exe, args); writeFileSync(join(f.profile(), 'DevToolsActivePort'), ''); return c; },
      fetchEndpoint: f.fetchEndpoint }), /startup timed out/);
    assert.deepEqual(f.requests, []); assert.deepEqual(f.ownChild.kills, ['SIGTERM']); await f.cleanupCheck();
  } finally { await rm(f.output, { recursive: true, force: true }); }
});

test('spawn error fails closed and removes only the newly allocated profile', async () => {
  const f = await fixture();
  try {
    await assert.rejects(launchCaptureBrowser(f.output, { pollMs: 1,
      spawnChild: (_exe, args) => { const c = f.spawnChild(_exe, args); c.pid = undefined; queueMicrotask(() => c.emit('error', new Error('fixture ENOENT'))); return c; },
      fetchEndpoint: f.fetchEndpoint }), /startup/);
    assert.deepEqual(f.requests, []); assert.deepEqual(f.ownChild.kills, []); await f.cleanupCheck();
  } finally { await rm(f.output, { recursive: true, force: true }); }
});

test('malformed profile endpoint fails before any endpoint request', async () => {
  const f = await fixture();
  try {
    await assert.rejects(launchCaptureBrowser(f.output, {
      spawnChild: (_exe, args) => { const c = f.spawnChild(_exe, args); writeFileSync(join(f.profile(), 'DevToolsActivePort'), '9339\nhttp://foreign-page\n'); return c; },
      fetchEndpoint: f.fetchEndpoint }), /invalid owned Chrome endpoint/);
    assert.deepEqual(f.requests, []); await f.cleanupCheck();
  } finally { await rm(f.output, { recursive: true, force: true }); }
});

test('browser UUID must match the child profile before selecting a page', async () => {
  const f = await fixture(); let lists = 0;
  try {
    await assert.rejects(launchCaptureBrowser(f.output, { spawnChild: f.spawnChild,
      fetchEndpoint: async url => { if (url.endsWith('/json/list')) lists++; return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/browser/foreign-browser' }) }; } }), /browser endpoint identity mismatch/);
    assert.equal(lists, 0); await f.cleanupCheck();
  } finally { await rm(f.output, { recursive: true, force: true }); }
});

test('foreign page socket is never returned for navigation even under a matching browser', async () => {
  const f = await fixture();
  try {
    await assert.rejects(launchCaptureBrowser(f.output, { spawnChild: f.spawnChild,
      fetchEndpoint: async url => url.endsWith('/json/version') ? f.fetchEndpoint(url) : { ok: true, json: async () => [{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:9339/devtools/page/foreign-page' }] } }), /page endpoint identity mismatch/);
    await f.cleanupCheck();
  } finally { await rm(f.output, { recursive: true, force: true }); }
});

test('child exit during identity request fails closed before page selection', async () => {
  const f = await fixture(); let lists = 0;
  try {
    await assert.rejects(launchCaptureBrowser(f.output, { spawnChild: f.spawnChild,
      fetchEndpoint: async url => { if (url.endsWith('/json/list')) lists++; f.ownChild.exitCode = 9; f.ownChild.emit('exit', 9, null); return f.fetchEndpoint(url); } }), /owned Chrome exited/);
    assert.equal(lists, 0); assert.deepEqual(f.ownChild.kills, []); await f.cleanupCheck();
  } finally { await rm(f.output, { recursive: true, force: true }); }
});

// Mini-only actual startup discriminator. The occupied port fixture is ours; an existing
// listener causes a bind failure, never a connection or a change to that listener.
test('actual headless child uses its ephemeral endpoint with an occupied legacy port', { skip: !process.env.TASK9_REAL_CHROME }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'task9-owner-real-')); let foreignRequests = 0, owner;
  const foreign = createServer((_request, response) => { foreignRequests++; response.end(JSON.stringify([target])); });
  try {
    await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(9339, '127.0.0.1', resolve); });
    owner = await launchCaptureBrowser(output);
    assert.notEqual(new URL(owner.browserEndpoint).port, '9339'); assert.equal(foreignRequests, 0); owner.assertAlive();
    const proof = { pid: owner.chrome.pid, browserEndpoint: owner.browserEndpoint, profile: owner.profile, pageId: owner.target.id, foreignRequests };
    await owner.close(); await assert.rejects(access(owner.profile), { code: 'ENOENT' });
    assert.ok(owner.chrome.exitCode != null || owner.chrome.signalCode != null);
    proof.childStopped = true; proof.freshProfileRemoved = true;
    if (process.env.TASK9_OWNER_PROOF_PATH) await writeFile(process.env.TASK9_OWNER_PROOF_PATH, JSON.stringify(proof, null, 1));
  } finally {
    await owner?.close(); await new Promise(resolve => foreign.close(resolve)); await rm(output, { recursive: true, force: true });
  }
});
