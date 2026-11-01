import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { lstat, realpath, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundedFile, safeError } from '../native/configuration.mjs';
import { installedIdentity, within } from '../scalability/identity.mjs';
import { hashFile } from '../scalability/manifests.mjs';

const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;
const context = new AsyncLocalStorage();
const profiles = ['desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'];
const scope = {
  exercised: 'Installed public coordinator initialization, exclusion and graceful no-member lifecycle on the exact recorded native Darwin arm64 composition.',
  resourceMutations: 'Every intercepted HTTP request is recorded; only bounded GET requests to the selected Unix Engine endpoint are admitted before dispatch.',
  excluded: ['Sandbox/member startup and Engine resource creation', 'Model/provider calls and credentials',
    'Crash recovery and cleanup reopening (MS005)', 'Workload execution or Rosetta workload qualification',
    'Universal interception of arbitrary network APIs or noncooperating controllers'],
};

function exact(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Exact input fields required.');
}

function absolute(value) {
  assert(typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= 4096
    && isAbsolute(value) && normalize(value) === value && !value.endsWith('/') && !/\p{Cc}/u.test(value),
  'Canonical absolute path required.');
  return value;
}

function facts(value) {
  return Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']
    .map((key) => [key, String(value[key])]));
}

async function fileIdentity(path, ceiling) {
  path = absolute(path);
  assert.equal(await realpath(path), path, 'Identity inputs must be physical files.');
  const before = await lstat(path, { bigint: true });
  assert(before.isFile() && before.size <= BigInt(ceiling), 'Bounded regular identity input required.');
  const hash = await hashFile(path);
  const after = await lstat(path, { bigint: true });
  assert.deepEqual(facts(after), facts(before), 'Identity input changed during capture.');
  return { path, ...facts(after), ...hash, allocatedBytes: String(hash.allocatedBytes) };
}

async function readInput(path, fields) {
  const identity = await fileIdentity(path, 1024 ** 2);
  const bytes = await boundedFile(path, 1024 ** 2);
  assert.deepEqual(await fileIdentity(path, 1024 ** 2), identity, 'Input changed after identity capture.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text); exact(value, fields);
  return { identity, text, value };
}

async function sourceIdentity() {
  return Promise.all([import.meta.url, new URL('./coordinator-lifecycle.mjs', import.meta.url),
    new URL('./coordinator-crash.mjs', import.meta.url), new URL('./coordinator-crash-process.mjs', import.meta.url), new URL('../command.mjs', import.meta.url), new URL('../ci-profile.mjs', import.meta.url),
    new URL('../native/configuration.mjs', import.meta.url), new URL('../scalability/identity.mjs', import.meta.url),
    new URL('../scalability/configuration.mjs', import.meta.url), new URL('../scalability/manifests.mjs', import.meta.url)]
    .map((url) => fileIdentity(fileURLToPath(url), 1024 ** 2)));
}

async function runtimeIdentity() {
  return { executable: await fileIdentity(await realpath(process.execPath), 256 * 1024 ** 2),
    invocationExecutable: process.execPath, node: process.versions.node, versions: process.versions,
    platform: process.platform, architecture: process.arch, release: process.release, pid: process.pid };
}

async function preparedIdentity(routeAuthority, helper) {
  assert(routeAuthority && profiles.includes(routeAuthority.profile));
  assert(helper && helper.protocol === 'agenai.desktop-coordinator.v1');
  const coordinator = await fileIdentity(helper.executable.path, 32 * 1024 ** 2);
  const hostObserver = await fileIdentity(routeAuthority.hostObserver.executable.path, 32 * 1024 ** 2);
  assert.equal(coordinator.sha256, helper.executable.sha256);
  assert.equal(hostObserver.sha256, routeAuthority.hostObserver.executable.sha256);
  const socketPath = await realpath(enginePath(routeAuthority));
  const socket = await lstat(socketPath, { bigint: true });
  assert(socket.isSocket(), 'Prepared route authority must select an existing local Engine socket.');
  return { coordinator, hostObserver, coordinatorSourceDigest: helper.sourceDigest,
    hostSourceDigest: routeAuthority.hostObserver.sourceDigest, vmObserver: routeAuthority.vmObserver,
    engine: { selectedEndpoint: routeAuthority.engine.endpoint, daemonId: routeAuthority.engine.id,
      socketPath, socketIdentity: facts(socket) } };
}

function enginePath(routeAuthority) {
  assert(typeof routeAuthority.engine?.endpoint === 'string' && routeAuthority.engine.endpoint.startsWith('unix:///'));
  return absolute(routeAuthority.engine.endpoint.slice(7));
}

function installRequestGuard(paths, tracePath) {
  const originalRequest = http.request;
  const originalGet = http.get;
  const requests = [];
  let bytes = 0;
  http.request = function guardedRequest(options, ...rest) {
    const validOptions = options && typeof options === 'object' && !Array.isArray(options);
    const method = validOptions && typeof options.method === 'string' ? options.method : 'GET';
    const path = validOptions && typeof options.path === 'string' ? options.path : '';
    const socketPath = validOptions && typeof options.socketPath === 'string' ? options.socketPath : '';
    const admitted = validOptions && method === 'GET' && paths.has(socketPath) && options.agent === false
      && /^\/(?:version|info|v1\.52\/networks(?:\/[a-f0-9]{64})?)$/u.test(path);
    const entry = { sequence: requests.length + 1, process: process.pid, ...context.getStore(),
      method: method.slice(0, 32), path: path.slice(0, 4096), socketPath: socketPath.slice(0, 4096),
      dispatch: admitted ? 'admitted' : 'blocked' };
    const line = `${JSON.stringify(entry)}\n`;
    assert(requests.length < 4096 && bytes + Buffer.byteLength(line) <= 4 * 1024 ** 2, 'Engine request evidence exceeded its bound.');
    requests.push(entry); bytes += Buffer.byteLength(line);
    appendFileSync(tracePath, line, { mode: 0o600 });
    assert(admitted, 'Engine request guard rejected a non-GET, unselected endpoint or unsupported request before dispatch.');
    return Reflect.apply(originalRequest, this, [options, ...rest]);
  };
  http.get = function guardedGet(...args) { const request = http.request(...args); request.end(); return request; };
  syncBuiltinESMExports();
  return { requests,
    summarize(caseId) {
      const selected = requests.filter((entry) => caseId === undefined || entry.case === caseId);
      return { requests: selected.length, admittedGets: selected.filter((entry) => entry.dispatch === 'admitted').length,
        blocked: selected.filter((entry) => entry.dispatch === 'blocked').length,
        mutationAttempts: selected.filter((entry) => entry.method !== 'GET').length,
        dispatchedMutations: selected.filter((entry) => entry.dispatch === 'admitted' && entry.method !== 'GET').length };
    },
    restore() { http.request = originalRequest; http.get = originalGet; syncBuiltinESMExports(); },
  };
}

async function installed(consumer) {
  absolute(consumer); assert.equal(await realpath(consumer), consumer);
  const require = createRequire(join(consumer, 'package.json'));
  const manifestPath = await realpath(require.resolve('@agen-ai/sandbox-docker/package.json'));
  assert(within(join(consumer, 'node_modules'), manifestPath), 'Public SDK must resolve inside the selected consumer.');
  const manifest = JSON.parse((await boundedFile(manifestPath, 1024 ** 2)).toString('utf8'));
  assert.equal(manifest.name, '@agen-ai/sandbox-docker');
  const entry = manifest.exports?.['./node']?.import;
  assert(typeof entry === 'string' && entry.startsWith('./') && !entry.includes('..'), 'Explicit public /node import export required.');
  const entryPath = await realpath(join(dirname(manifestPath), entry));
  assert(within(dirname(manifestPath), entryPath));
  const identity = { consumer, packages: await installedIdentity(consumer),
    manifest: await fileIdentity(manifestPath, 1024 ** 2), entrypoint: await fileIdentity(entryPath, 1024 ** 2) };
  return { identity, api: await import(pathToFileURL(entryPath).href) };
}

function errorEvidence(error) {
  return { ...safeError(error, 0), ...(error?.failure ? { failure: error.failure } : {}),
    ...(error?.owner?.state ? { ownerState: error.owner.state } : {}) };
}

function ownerEntry(api, input, consumer, entries, role, routeAuthority = input.routeAuthority) {
  const owner = api.createDockerDesktopCoordinator({ routeAuthority: api.createDockerDesktopRouteAuthority(routeAuthority), helper: input.helper });
  const entry = { owner, consumer, role, evidence: { role, consumer, states: [owner.state], closeFailures: [] } };
  entries.push(entry);
  return entry;
}

async function closeEntry(entry) {
  try { await entry.owner.close({ timeoutMs: 60_000 }); entry.evidence.states.push(entry.owner.state); }
  catch (error) { entry.evidence.states.push(entry.owner.state); entry.evidence.closeFailures.push(errorEvidence(error)); throw error; }
}

async function expectBusy(entry) {
  let rejected;
  try { await entry.owner.activate({ timeoutMs: 60_000 }); }
  catch (error) { rejected = error; }
  assert(rejected, 'Contending installed owner unexpectedly activated.');
  assert.equal(rejected.owner, entry.owner, 'Failure must retain the exact original contender owner.');
  assert.deepEqual(rejected.failure, { kind: 'busy' });
  entry.evidence.states.push(entry.owner.state);
  await closeEntry(entry);
  return { failure: rejected.failure, retainedOriginalOwner: true };
}

async function writeReport(path, report) {
  const pending = `${path}.next`;
  await writeFile(pending, encode(report), { flag: 'wx', mode: 0o600 });
  await rename(pending, path);
}

export { absolute, closeEntry, context, encode, enginePath, errorEvidence, exact, expectBusy, facts, fileIdentity, installed, installRequestGuard, ownerEntry, preparedIdentity, profiles, readInput, runtimeIdentity, scope, sourceIdentity, writeReport };
