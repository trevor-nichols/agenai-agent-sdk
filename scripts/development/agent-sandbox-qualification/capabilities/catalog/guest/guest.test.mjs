import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseGuestResult } from '../protocol.mjs';

const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const peer = new URL('./fixtures/peer.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

async function fixture(t, scenario) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'catalog-guest-')));
  t.after(async () => {
    try { const pid = Number(await readFile(join(root, 'native', 'retained-producer.pid'), 'utf8')); process.kill(pid, 'SIGKILL'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, 'scripted-peer');
  const source = `#!${process.execPath}\nimport {scriptedPeer} from ${JSON.stringify(peer)}; await scriptedPeer(${JSON.stringify(scenario)});\n`;
  await writeFile(executable, source, { mode: 0o700 }); await mkdir(join(root, 'project'));
  const authFile = join(root, 'synthetic-auth.json');
  await writeFile(authFile, JSON.stringify({ [scope]: { auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', key: 'SYNTHETIC-INVALID-PRIVATE-KEY',
    user_id: 'PRIVATE-UNRETAINED-USER', email: 'private@example.invalid', create_time: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString() } }), { mode: 0o600 });
  const config = { format: 'agenai.native-catalog-guest-config.v1', observation: 'scripted',
    native: { executable, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') },
    profile: join(root, 'native'), project: join(root, 'project'), authFile };
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o644 });
  const child = spawn(process.execPath, [runner, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const consume = async (stream) => { let result = ''; for await (const bytes of stream) { result += bytes; assert(Buffer.byteLength(result) <= 256 * 1024); } return result; };
  const stdout = consume(child.stdout); const stderr = consume(child.stderr);
  t.after(async () => { child.kill('SIGKILL'); await exit; });
  return { root, child, async finish() {
    const [raw, errors, ended] = await Promise.all([stdout, stderr, exit]); assert.equal(errors, '');
    assert.equal(raw.trim().split('\n').length, 1); assert(!/PRIVATE-|private@example|SYNTHETIC-INVALID/u.test(raw));
    const result = parseGuestResult(JSON.parse(raw));
    let methods = [];
    try { methods = (await readFile(join(root, 'native', 'methods.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(methods.every(({ method }) => ['initialize', 'authenticate', '_x.ai/auth/info', '_x.ai/models/list'].includes(method)));
    assert.equal(result.modelTasks, 0); return { result, ended, methods };
  } };
}

for (const scenario of ['success', 'no-cache', 'graceful-delay']) test(`actual scripted child qualifies ordered HTTP/prefetch and private account acknowledgement (${scenario})`, { timeout: 10_000 }, async (t) => {
  const { result, ended, methods } = await (await fixture(t, scenario)).finish();
  assert.deepEqual(ended, { code: 0, signal: null }); assert.equal(result.status, 'passed'); assert.equal(result.observation, 'scripted');
  assert.equal(result.refresh.status, 'confirmed'); assert.deepEqual(result.refresh.events.map(({ kind }) => kind),
    ['http_fetch_started', 'http_fetch_completed', 'prefetch_completed', 'catalog_requested', 'catalog_observed']);
  assert.equal(result.refresh.events[1].count, 300); assert.equal(result.refresh.events[2].count, 280);
  assert.equal(result.catalog.grok47Advertised, true); assert.equal(result.catalog.availableModels[0]._meta.totalContextTokens, 500000);
  assert.deepEqual(result.catalog.availableModels[0]._meta.reasoningEfforts, [{ id: 'high', value: 'high', default: true, label: 'High' }]);
  assert.equal(result.authentication.acknowledged, true); assert.equal(result.authentication.cachedTokenRequested, scenario !== 'no-cache');
  assert.deepEqual(result.termination, { code: 0, signal: null, forced: false });
  assert.deepEqual(result.cleanup, { nativeJoined: true, stdoutJoined: true, stderrJoined: true });
  const impossible = structuredClone(result);
  impossible.refresh.events.push({ sequence: impossible.refresh.events.length + 1, kind: 'remote_fetch_failed', count: null });
  assert.throws(() => parseGuestResult(impossible), { code: 'protocol' });
  for (const termination of [{ code: null, signal: null, forced: false }, { code: 1, signal: null, forced: false },
    { code: null, signal: 'other', forced: false }, { code: 0, signal: null, forced: true }]) {
    assert.throws(() => parseGuestResult({ ...result, termination }), { code: 'protocol' });
  }
  assert.deepEqual(methods[0].params.clientCapabilities, { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false, plan: {} });
  if (scenario !== 'no-cache') assert.deepEqual(methods[1].params, { methodId: 'cached_token', _meta: { headless: true } });
});

for (const [scenario, status, failure] of [
  ['fallback', 'failed', 'remote_fetch_failed'], ['unproven', 'unproven', 'remote_unproven'], ['wrong-account', 'failed', 'authentication'],
  ['malformed', 'failed', 'protocol'], ['oversized', 'failed', 'frame_limit'], ['log-limit', 'failed', 'debug_limit'],
  ['catalog-invalid', 'failed', 'catalog_invalid'], ['terminal-request', 'failed', 'native_request'], ['inbound-limit', 'failed', 'inbound_limit'],
  ['late-failure', 'unproven', 'remote_unproven'], ['forced-stop', 'failed', 'native_exit'],
]) test(`guest fails closed for actual ${scenario} peer and joins its producer`, { timeout: scenario === 'forced-stop' ? 15_000 : 10_000 }, async (t) => {
  const { result, ended } = await (await fixture(t, scenario)).finish();
  assert.deepEqual(ended, { code: 1, signal: null }); assert.equal(result.status, status); assert.equal(result.failure, failure);
  assert.deepEqual(result.cleanup, { nativeJoined: true, stdoutJoined: true, stderrJoined: true });
  if (scenario === 'forced-stop') {
    assert.equal(result.catalog.grok47Advertised, true); assert.equal(result.refresh.status, 'unproven');
    assert.equal(result.refresh.events.at(-1).kind, 'catalog_requested');
    assert.deepEqual(result.termination, { code: null, signal: 'SIGTERM', forced: true });
  }
  if (['fallback', 'unproven', 'wrong-account'].includes(scenario)) { assert.equal(result.catalog, null); assert(!result.requests.includes('_x.ai/models/list')); }
});

test('SIGTERM cancels the entered metadata request and joins the actual child without a prompt', { timeout: 10_000 }, async (t) => {
  const opened = await fixture(t, 'cancel');
  for (let index = 0; index < 100; index++) {
    try { if ((await readFile(join(opened.root, 'native', 'methods.jsonl'), 'utf8')).includes('initialize')) break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  opened.child.kill('SIGTERM'); const { result } = await opened.finish();
  assert.equal(result.status, 'failed'); assert.equal(result.failure, 'cancelled'); assert.deepEqual(result.requests, ['initialize']);
  assert.deepEqual(result.cleanup, { nativeJoined: true, stdoutJoined: true, stderrJoined: true });
});

test('a retained descendant pipe cannot be reported as joined cleanup', { timeout: 40_000 }, async (t) => {
  const { result, ended } = await (await fixture(t, 'cleanup-failure')).finish();
  assert.deepEqual(ended, { code: 1, signal: null }); assert.equal(result.status, 'failed'); assert.equal(result.failure, 'cleanup_incomplete');
  assert.deepEqual(result.cleanup, { nativeJoined: false, stdoutJoined: false, stderrJoined: false });
});
