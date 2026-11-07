// ------------------------------------------------------------------------------------------------
//                evidence.mjs - Durable qualification observations and exact independent resource census
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export async function atomicJson(path, value) {
  const pending = `${path}.next`;
  await writeFile(pending, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, path);
}

export function safeError(error, depth = 0) {
  if (!(error instanceof Error)) return { name: 'ThrownValue', value: String(error).slice(0, 512) };
  return { name: error.name, message: error.message.slice(0, 2048),
    ...(depth < 4 && error.cause !== undefined && error.cause !== error ? { cause: safeError(error.cause, depth + 1) } : {}) };
}

export function resourcePath(resource) {
  const id = resource.identity.kind === 'identified' ? resource.identity.id : resource.name;
  if (resource.role === 'storage' || resource.role === 'egress_socket') return `/volumes/${encodeURIComponent(id)}`;
  if (resource.role === 'network') return `/networks/${encodeURIComponent(id)}`;
  assert(['compute', 'export', 'egress_broker', 'egress_relay', 'filesystem'].includes(resource.role));
  return `/containers/${encodeURIComponent(id)}/json`;
}

export async function census(engine, record, checkpoint, absent = false, roles) {
  const result = [];
  for (const resource of record.resources) {
    if (roles && !roles.includes(resource.role)) continue;
    const response = await engine.request('GET', resourcePath(resource), undefined, { allowed: absent ? [404] : [200, 404] });
    result.push({ checkpoint, role: resource.role, name: resource.name,
      id: resource.identity.kind === 'identified' ? resource.identity.id : null,
      httpStatus: response.status, ...(response.status === 200 ? { state: response.data.State?.Status,
        actualId: response.data.Id ?? response.data.Name, labels: response.data.Config?.Labels ?? response.data.Labels } : {}) });
  }
  return result;
}

export async function openCase(output, name) {
  const directory = join(output, name);
  await mkdir(directory, { mode: 0o700 });
  const evidence = { name, status: 'running', checkpoints: [], observations: [], cleanupErrors: [], census: [] };
  const save = () => atomicJson(join(directory, 'case-report.json'), evidence);
  await save();
  return { directory, evidence, save };
}

async function pidIdentity(pid) {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const end = text.lastIndexOf(')');
  assert(end > 0); const fields = text.slice(end + 2).trim().split(/\s+/u);
  return { startTime: fields[19], command: text.slice(text.indexOf('(') + 1, end) };
}

export async function captureWriters(engine, record) {
  const observations = [];
  for (const resource of record.resources) {
    if (!['compute', 'egress_broker', 'egress_relay', 'filesystem'].includes(resource.role) || resource.identity.kind !== 'identified') continue;
    const id = resource.identity.id;
    const inspected = await engine.request('GET', `/containers/${id}/json`, undefined, { allowed: [200, 404] });
    if (inspected.status === 404 || !inspected.data.State.Running) continue;
    const top = await engine.request('GET', `/containers/${id}/top?ps_args=${encodeURIComponent('-eo pid,ppid,comm')}`, undefined, { allowed: [200, 404] });
    const pids = new Set([inspected.data.State.Pid]);
    if (top.status === 200) {
      assert(top.data.Processes === null || Array.isArray(top.data.Processes), 'Docker top returned invalid process data');
      for (const process of top.data.Processes ?? []) pids.add(Number(process[0]));
    }
    for (const pid of pids) {
      assert(Number.isSafeInteger(pid) && pid > 0);
      try { observations.push({ role: resource.role, containerId: id, pid, ...await pidIdentity(pid) }); }
      catch (error) { observations.push({ role: resource.role, containerId: id, pid, unavailable: error.code ?? error.message }); }
    }
  }
  return observations;
}

export async function assertWritersGone(observations) {
  const result = [];
  for (const observation of observations) {
    if (observation.unavailable) { result.push({ ...observation, proof: 'unavailable' }); continue; }
    try {
      const actual = await pidIdentity(observation.pid);
      assert.notEqual(actual.startTime, observation.startTime, `Owned writer PID ${observation.pid} survived resource cleanup`);
      result.push({ ...observation, gone: true, reason: 'pid_reused' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      result.push({ ...observation, gone: true, reason: 'absent' });
    }
  }
  return result;
}
