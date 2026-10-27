// ------------------------------------------------------------------------------------------------
//                peer.mjs - Fixed read-only Linux daemon kernel observations - No argv/environment reads
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, opendir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

const proc = '/observer/proc';
const cgroups = '/observer/cgroup';
const files = ['memory.max', 'memory.current', 'memory.peak', 'memory.swap.max', 'memory.events',
  'pids.max', 'pids.current', 'pids.events', 'cpu.max', 'cgroup.procs', 'cgroup.events'];
const missing = (error) => ['ENOENT', 'ESRCH'].includes(error?.code);
const pid = (value) => Number.isSafeInteger(value) && value > 0;

async function text(path, maximum = 16 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    assert(count <= maximum, 'Kernel observation exceeds its finite read bound.');
    return buffer.subarray(0, count).toString('utf8');
  } finally { await handle.close(); }
}

function relativeCgroup(value, computeId) {
  const rows = value.trim().split('\n');
  assert(rows.length === 1 && rows[0].startsWith('0::/'), 'A unified cgroup-v2 daemon view is required.');
  const relative = rows[0].slice(3);
  assert(relative.length <= 4096 && !relative.split('/').some((part) => part === '.' || part === '..'));
  if (computeId !== undefined) assert(relative !== '/' && relative.includes(computeId), 'Kernel cgroup does not identify the exact compute container.');
  return relative;
}

async function identity(processId) {
  assert(pid(processId));
  const value = await text(join(proc, String(processId), 'stat'));
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
  assert(/^[0-9]+$/u.test(fields[19]), 'Kernel process start identity omitted.');
  return { pid: processId, startClockTicks: fields[19] };
}

function validateScope(scope) {
  assert(scope && typeof scope === 'object' && /^[a-f0-9]{64}$/u.test(scope.computeId));
  assert(typeof scope.relativePath === 'string' && scope.relativePath.startsWith('/') && scope.relativePath.includes(scope.computeId));
  assert(scope.relativePath.length <= 4096 && !scope.relativePath.split('/').some((part) => part === '.' || part === '..'));
  assert(Array.isArray(scope.knownPids) && scope.knownPids.length <= 512);
}

async function capture(query) {
  assert(/^[a-f0-9]{64}$/u.test(query.computeId) && pid(query.keeperPid));
  const procCgroup = await text(join(proc, String(query.keeperPid), 'cgroup'));
  const relativePath = relativeCgroup(procCgroup, query.computeId);
  const directory = join(cgroups, relativePath.slice(1));
  const metadata = await lstat(directory, { bigint: true });
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
  const values = {};
  for (const name of files) values[name] = await text(join(directory, name));
  const members = values['cgroup.procs'].trim().split('\n').filter(Boolean).map(Number);
  assert(members.length > 0 && members.length <= 512 && members.every(pid) && members.includes(query.keeperPid));
  const knownPids = [];
  for (const member of members) {
    try { knownPids.push(await identity(member)); }
    catch (error) { if (!missing(error)) throw error; }
  }
  return { computeId: query.computeId, keeperPid: query.keeperPid, relativePath, procCgroup,
    directoryIdentity: { device: String(metadata.dev), inode: String(metadata.ino) }, files: values, knownPids };
}

async function read(query) {
  assert(typeof query.path === 'string' && query.path.length <= 8192);
  const maxScopes = query.maxScopes === undefined ? 128 : query.maxScopes;
  assert(maxScopes === 128 || maxScopes === 256, 'Kernel scope capacity must select 128 or 256.');
  assert(Array.isArray(query.scopes) && query.scopes.length <= maxScopes, 'Kernel read exceeds its admitted scope capacity.');
  query.scopes.forEach(validateScope);
  const processPath = /^\/proc\/([1-9][0-9]*)\/(status|stat|cgroup)$/u.exec(query.path);
  if (processPath) {
    const processId = Number(processPath[1]); assert(pid(processId));
    const current = relativeCgroup(await text(join(proc, String(processId), 'cgroup')));
    const scope = query.scopes.find((entry) => entry.relativePath === current);
    assert(scope, 'Process read is outside the registered exact compute cgroups.');
    return { text: await text(join(proc, String(processId), processPath[2])), computeId: scope.computeId, identity: await identity(processId) };
  }
  assert(query.path.startsWith('/sys/fs/cgroup/'), 'Only fixed kernel observation paths are accepted.');
  const suffix = query.path.slice('/sys/fs/cgroup'.length);
  const scope = query.scopes.find((entry) => files.some((name) => suffix === `${entry.relativePath}/${name}`));
  assert(scope, 'Cgroup file read is outside registered exact compute paths.');
  return { text: await text(join(cgroups, suffix.slice(1))), computeId: scope.computeId };
}

async function empty(query) {
  validateScope(query.scope);
  const scope = query.scope;
  const directory = join(cgroups, scope.relativePath.slice(1));
  let cgroup;
  try {
    const metadata = await lstat(directory, { bigint: true });
    assert(metadata.isDirectory() && String(metadata.dev) === scope.directoryIdentity.device && String(metadata.ino) === scope.directoryIdentity.inode,
      'Captured cgroup directory identity changed.');
    const processes = await text(join(directory, 'cgroup.procs'));
    const events = await text(join(directory, 'cgroup.events'));
    assert.equal(processes.trim(), '', 'The exact captured cgroup remains populated.');
    assert(/^populated 0$/mu.test(events), 'The captured cgroup still has populated descendants.');
    cgroup = { kind: 'empty', processes, events };
  } catch (error) { if (!missing(error)) throw error; cgroup = { kind: 'absent', code: error.code }; }
  const members = [];
  let inspectedPids = 0;
  const entries = await opendir(proc, { bufferSize: 32 });
  for await (const entry of entries) {
    if (!/^[1-9][0-9]*$/u.test(entry.name)) continue;
    inspectedPids += 1; assert(inspectedPids <= 16_384, 'Daemon process census exceeds the selected qualification budget.');
    try {
      if (relativeCgroup(await text(join(proc, entry.name, 'cgroup'))) === scope.relativePath) members.push(Number(entry.name));
    } catch (error) { if (!missing(error)) throw error; }
  }
  assert.equal(members.length, 0, 'Daemon /proc still contains members of the exact workload cgroup.');
  const retired = [];
  for (const known of scope.knownPids) {
    assert(pid(known.pid) && /^[0-9]+$/u.test(known.startClockTicks));
    try {
      const actual = await identity(known.pid);
      assert.notEqual(actual.startClockTicks, known.startClockTicks, 'An independently captured workload process is still alive.');
      retired.push({ ...known, disposition: 'pid-reused', currentStartClockTicks: actual.startClockTicks });
    } catch (error) { if (!missing(error)) throw error; retired.push({ ...known, disposition: 'absent' }); }
  }
  return { computeId: scope.computeId, cgroup, inspectedPids, members, retired, kernelEmpty: true };
}

try {
  const encoded = process.argv.at(-1);
  assert(Buffer.byteLength(encoded) <= 64 * 1024);
  const query = JSON.parse(encoded);
  assert(query && typeof query === 'object' && ['probe', 'capture', 'read', 'empty'].includes(query.operation), 'Unknown kernel observation operation.');
  let value;
  if (query.operation === 'probe') {
    const [procFs, cgroupFs] = await Promise.all([statfs(proc), statfs(cgroups)]);
    assert.equal(procFs.type, 0x9fa0); assert.equal(cgroupFs.type, 0x63677270);
    const status = await text(join(proc, 'self', 'status'));
    assert(/^CapEff:\s+0+$/mu.test(status)); assert(/^NoNewPrivs:\s+1$/mu.test(status)); assert(/^Seccomp:\s+2$/mu.test(status));
    value = { node: process.version, architecture: process.arch, pid: process.pid, uid: process.getuid(), procFilesystemType: procFs.type,
      cgroupFilesystemType: cgroupFs.type, status, selfCgroup: await text(join(proc, 'self', 'cgroup')) };
  } else if (query.operation === 'capture') value = await capture(query);
  else if (query.operation === 'read') value = await read(query);
  else value = await empty(query);
  const result = JSON.stringify({ ok: true, value }); assert(Buffer.byteLength(result) <= 1024 * 1024); process.stdout.write(`${result}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { name: error instanceof Error ? error.name : 'ThrownValue',
    message: String(error instanceof Error ? error.message : error).slice(0, 2048), code: error?.code ?? null } })}\n`);
}
