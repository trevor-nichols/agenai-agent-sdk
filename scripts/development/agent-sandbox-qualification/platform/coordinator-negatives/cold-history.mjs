import assert from 'node:assert/strict';
import { originalFile } from '../coordinator-recovery/common.mjs';

export async function assertNeverStarted(report, history) {
  const requests = history.filter(({ kind }) => kind === 'request');
  const terminal = history.at(-1);
  assert.equal(terminal.kind, 'closed'); assert.equal(terminal.complete, true); assert.deepEqual(terminal.active, []);
  assert.deepEqual(terminal.activeChildren, []);
  const holders = history.filter(({ kind, args }) => kind === 'child_spawn' && args?.[0] === 'open' && /^[a-f0-9]{64}$/u.test(args[1]));
  assert.equal(holders.length, 1, 'Exactly one original native coordinator holder must open.');
  const holder = history.find(({ kind, pid }) => kind === 'child_close' && pid === holders[0].pid);
  assert(holder, 'Original native coordinator holder exit was not observed.');
  assert.equal(holder.code, 0); assert.equal(holder.signal, null);
  assert.equal(terminal.requests, requests.length);
  assert(!requests.some(({ method, target }) => method === 'POST' && /\/containers\/[^/?]+\/start(?:\?|$)/u.test(target)),
    'A helper/container start was dispatched; cold proof requires independent native process absence instead.');
  const responses = history.filter(({ kind }) => kind === 'response');
  assert.equal(responses.length, requests.length); assert(responses.every(({ complete }) => complete));
  const creates = responses.filter(({ method, target, status }) => method === 'POST' && target.startsWith('/v1.52/containers/create?') && status === 201);
  assert(creates.length > 0);
  const index = await originalFile(report.engineCapture.index.path, 4 * 1024 ** 2);
  assert.deepEqual(index.identity, report.engineCapture.index); assert.equal(index.value.completeness, 'complete');
  const observed = [];
  for (const created of creates) {
    const id = JSON.parse(Buffer.from(created.bodyBase64, 'base64').toString('utf8')).Id; assert.match(id, /^[a-f0-9]{64}$/u);
    const inspections = index.value.entries.filter((entry) => entry.status === 200 && entry.target === `/v1.52/containers/${id}/json`);
    assert(inspections.length > 0, 'Every actual create must have an original identified inspection.');
    let name;
    for (const entry of inspections) {
      assert(entry.complete); const body = await originalFile(entry.body.path, 4 * 1024 ** 2); assert.deepEqual(body.identity, entry.body);
      const actual = body.value; assert.equal(actual.Id, id); name = actual.Name.slice(1);
      assert.equal(actual.State.Running, false); assert.equal(actual.State.Pid, 0);
      assert.match(actual.State.StartedAt, /^0001-01-01T00:00:00(?:\.0+)?Z$/u);
    }
    const last = inspections.at(-1).sequence;
    for (const reference of [id, name]) assert(index.value.entries.some((entry) => entry.sequence > last && entry.complete
      && entry.status === 404 && entry.target === `/v1.52/containers/${reference}/json`), 'Original name/ID absence after inspection is required.');
    observed.push({ id, name, running: false, pid: 0, startedAt: 'zero', absence: 'original_complete_get_404_by_id_and_name' });
  }
  return { containers: observed, holder: { pid: holder.pid, code: 0, signal: null, joined: true },
    scope: 'No container start dispatch; identified never-started Engine inspections and exact name/ID absence, plus original native coordinator-holder close. No independent live PID/start/cgroup emptiness claim.' };
}
