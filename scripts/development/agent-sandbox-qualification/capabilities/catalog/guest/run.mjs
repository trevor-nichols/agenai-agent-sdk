import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogGuestError, endpoint, failureCodes, limits, nativeLaunch, parseCatalog, parseGuestConfig, parseGuestResult, reject } from '../protocol.mjs';
import { acknowledgeAccount, prepareIdentity, privateJson } from './identity.mjs';
import { logProjection } from './log.mjs';
import { metadataWire } from './wire.mjs';

const runtime = { node: process.version, platform: process.platform, architecture: process.arch,
  uid: process.getuid(), gid: process.getgid() };
const result = { format: 'agenai.native-catalog-guest.v1', observation: 'scripted', status: 'failed', runtime,
  transport: { status: 'not_started', protocolVersion: null }, refresh: { status: 'unproven', endpoint, events: [] },
  authentication: { status: 'not_attempted', method: null, cachedTokenAdvertised: false, cachedTokenRequested: false, acknowledged: false },
  catalog: null, requests: [], modelTasks: 0, termination: { code: null, signal: null, forced: false },
  cleanup: { nativeJoined: true, stdoutJoined: true, stderrJoined: true }, failure: null };
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new CatalogGuestError('cancelled'));
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
const timer = setTimeout(() => cancellation.abort(new CatalogGuestError('observation_timeout')), limits.overallMs);
let child; let wire; let projection; let childClosed = false; let spawnedError = false; let catalogReceived = false; let nativeExit; let phase = 'prepare';
let forcedTermination = false;
const closed = Promise.withResolvers();
const codeOf = (error) => failureCodes.includes(error?.code) ? error.code : 'protocol';
const check = () => {
  if (cancellation.signal.aborted) reject(codeOf(cancellation.signal.reason));
  if (wire?.failure) reject(wire.failure);
};
async function waitClosed(milliseconds) {
  let waiting;
  try { return await Promise.race([closed.promise.then(() => true), new Promise((resolve) => { waiting = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(waiting); }
}

try {
  if (process.argv.length !== 3) reject('configuration');
  const config = parseGuestConfig(await privateJson(process.argv[2], limits.configBytes, false));
  result.observation = config.observation;
  const expectedAccount = await prepareIdentity(config, cancellation.signal); check();
  const launch = nativeLaunch(config);
  projection = logProjection(join(config.profile, 'catalog-diagnostic.log')); result.refresh.events = projection.events;
  child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
  result.cleanup = { nativeJoined: false, stdoutJoined: false, stderrJoined: false };
  child.once('exit', (code, signal) => { nativeExit = { code, signal }; });
  child.once('close', (code, signal) => { nativeExit ??= { code, signal }; childClosed = true; closed.resolve(); });
  child.once('error', () => { spawnedError = true; wire?.fail('spawn'); });
  wire = metadataWire(child, cancellation.signal); result.requests = wire.requests;
  phase = 'initialize'; result.transport.status = 'failed';
  const initialized = await wire.request('initialize', { protocolVersion: 1,
    clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: false, writeTextFile: false }, terminal: false, plan: {} },
    clientInfo: { name: 'agenai-native-catalog-qualification', version: '1.0.0' } });
  const version = initialized?.agentInfo?.version ?? initialized?._meta?.agentVersion;
  if (initialized?.protocolVersion !== 1 || version !== '1.0.70'
    || (initialized.agentInfo?.version != null && initialized._meta?.agentVersion != null
      && initialized.agentInfo.version !== initialized._meta.agentVersion)) reject('protocol');
  result.transport = { status: 'initialized', protocolVersion: 1 };
  phase = 'authentication';
  const methods = initialized.authMethods ?? []; if (!Array.isArray(methods) || methods.length > 32) reject('authentication');
  const cached = methods.filter((method) => method?.id === 'cached_token');
  if (cached.length > 1) reject('authentication');
  result.authentication.cachedTokenAdvertised = cached.length === 1;
  if (cached.length) {
    if (cached[0].type === 'terminal') reject('authentication');
    result.authentication.cachedTokenRequested = true;
    await wire.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } });
  }
  const account = await wire.request('_x.ai/auth/info', {});
  result.authentication.method = acknowledgeAccount(account, expectedAccount);
  result.authentication.status = 'acknowledged'; result.authentication.acknowledged = true;
  for (const key of Object.keys(expectedAccount)) expectedAccount[key] = null;
  phase = 'refresh';
  for (;;) {
    check(); await projection.poll(); if (projection.confirmed()) break;
    if (childClosed || child.exitCode !== null || child.signalCode !== null) reject('remote_unproven');
    await Promise.race([delay(25), wire.lost]);
  }
  check(); phase = 'catalog'; projection.append({ kind: 'catalog_requested', count: null });
  result.catalog = parseCatalog(await wire.request('_x.ai/models/list', {}));
  check(); catalogReceived = true;
} catch (error) {
  let code = spawnedError ? 'spawn' : codeOf(error);
  if (phase === 'authentication') result.authentication.status = 'failed';
  if (phase === 'refresh' && ['observation_timeout', 'native_exit', 'remote_unproven'].includes(code)) {
    code = result.refresh.events.some((event) => event.kind === 'remote_fetch_failed' || event.kind === 'fallback') ? 'remote_fetch_failed' : 'remote_unproven';
  }
  result.status = code === 'remote_unproven' ? 'unproven' : 'failed'; result.failure = code;
  if (code === 'remote_fetch_failed') result.refresh.status = 'failed';
} finally {
  clearTimeout(timer);
  if (child) {
    const deadline = Date.now() + limits.cleanupMs;
    wire.closeInput();
    if (!await waitClosed(limits.eofGraceMs)) {
      forcedTermination = true; child.kill('SIGTERM');
      if (!await waitClosed(limits.termGraceMs)) { child.kill('SIGKILL'); await waitClosed(Math.max(0, deadline - Date.now())); }
    }
    if (childClosed) await wire.readers;
    const joined = wire.cleanup;
    result.termination = { code: nativeExit?.code ?? null,
      signal: nativeExit?.signal == null ? null : ['SIGTERM', 'SIGKILL'].includes(nativeExit.signal) ? nativeExit.signal : 'other', forced: forcedTermination };
    result.cleanup = { nativeJoined: childClosed && joined.writesJoined, stdoutJoined: joined.stdoutJoined, stderrJoined: joined.stderrJoined };
    if (Object.values(result.cleanup).some((value) => !value)) {
      result.status = 'failed'; result.failure = 'cleanup_incomplete'; child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
    if (wire.failure && !result.failure) { result.status = 'failed'; result.failure = wire.failure; }
    if ((forcedTermination || nativeExit?.code !== 0 || nativeExit?.signal !== null) && !result.failure) {
      result.status = 'failed'; result.failure = 'native_exit';
    }
    try {
      await projection.poll(true);
      if (catalogReceived && !result.failure) {
        projection.append({ kind: 'catalog_observed', count: null });
        if (projection.confirmed()) { result.refresh.status = 'confirmed'; result.status = 'passed'; }
        else { result.status = 'unproven'; result.failure = 'remote_unproven'; }
      }
    } catch (error) {
      if (!result.failure) { result.status = codeOf(error) === 'remote_unproven' ? 'unproven' : 'failed'; result.failure = codeOf(error); }
      result.refresh.status = 'unproven';
    }
  }
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
}
if (Buffer.byteLength(JSON.stringify(result)) > limits.resultBytes) { result.status = 'failed'; result.failure = 'frame_limit'; result.catalog = null; }
process.stdout.write(JSON.stringify(parseGuestResult(result)) + '\n');
if (result.status !== 'passed') process.exitCode = 1;
