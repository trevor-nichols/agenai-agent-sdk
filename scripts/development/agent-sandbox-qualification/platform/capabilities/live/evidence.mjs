import assert from 'node:assert/strict';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export function json(value) {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n';
}

export async function appendObservation(evidence, value, save) {
  const observation = JSON.parse(json({ observedAt: new Date().toISOString(), ...value }));
  evidence.observations.push(observation);
  await save();
}

export function failure(error) {
  const budget = { nodes: 12, bytes: 12 * 1024 };
  const seen = new Set();
  const text = (value, maximum) => {
    let result = ''; let bytes = 0;
    for (const character of value) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bytes + size > Math.min(maximum, budget.bytes)) break;
      result += character; bytes += size;
    }
    budget.bytes -= bytes;
    return result;
  };
  const visit = (value, depth) => {
    budget.nodes--; budget.bytes -= 128;
    if (!(value instanceof Error)) return { name: 'ThrownValue',
      message: text(value === null || typeof value !== 'object' ? String(value) : `[${typeof value}]`, 512) };
    if (seen.has(value)) return { name: 'RepeatedError' };
    seen.add(value);
    const result = { name: text(value.name, 128), message: text(value.message, 2048) };
    if (typeof value.code === 'string' || typeof value.code === 'number') result.code = text(String(value.code), 128);
    if (depth < 4 && budget.nodes > 0 && budget.bytes > 128) {
      if (value.cause !== undefined) result.cause = visit(value.cause, depth + 1);
      if (Array.isArray(value.errors)) {
        result.errors = [];
        for (const nested of value.errors.slice(0, 4)) {
          if (budget.nodes === 0 || budget.bytes <= 128) break;
          result.errors.push(visit(nested, depth + 1));
        }
        if (result.errors.length < value.errors.length) result.errorsTruncated = true;
      }
    } else if (value.cause !== undefined || Array.isArray(value.errors) && value.errors.length) result.nestingTruncated = true;
    return result;
  };
  return visit(error, 0);
}

export function jsonWriter(path) {
  let pending = Promise.resolve();
  return (value) => {
    const bytes = json(value);
    const actual = pending.then(async () => {
      const next = `${path}.next`;
      const file = await open(next, 'w', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(next, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    });
    pending = actual.catch(() => {});
    return actual;
  };
}

export function resourcePath(resource) {
  const id = encodeURIComponent(resource.identity.kind === 'identified' ? resource.identity.id : resource.name);
  if (resource.role === 'storage') return `/volumes/${id}`;
  assert(['compute', 'filesystem', 'export'].includes(resource.role), 'Live isolated records have a closed resource census.');
  return `/containers/${id}/json`;
}

export async function census(engine, record, checkpoint, absent = false) {
  const observations = [];
  for (const resource of record.resources) {
    const response = await engine.request('GET', resourcePath(resource), undefined, { allowed: absent ? [404] : [200, 404] });
    observations.push({ checkpoint, role: resource.role, name: resource.name, identity: resource.identity,
      httpStatus: response.status, ...(response.status === 200 ? {
        actualId: response.data.Id ?? response.data.Name, state: response.data.State,
        image: response.data.Image, mounts: response.data.Mounts,
        labels: response.data.Config?.Labels ?? response.data.Labels } : {}) });
  }
  return observations;
}

export async function entered(ready, actual, timeoutMs) {
  let timer;
  try {
    await Promise.race([ready.promise, actual.then(() => { throw new Error('Operation settled before its required native callback/source entry.'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Required native entry deadline.')), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
