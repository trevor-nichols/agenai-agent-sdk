import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendObservation, jsonWriter } from './live/evidence.mjs';

test('observation reports retain append-time JSON values across caller mutations and later saves', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-observation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'case-report.json'); const write = jsonWriter(path);
  const evidence = { observations: [], cleanup: { status: 'entered' } };
  const save = () => write(evidence);
  const requests = [];
  const bytes = Buffer.from([0, 255]);
  const frames = [{ kind: 'closed', sequence: 7n, bytes, detail: { labels: ['original'] } }];
  const first = appendObservation(evidence, { kind: 'lease-expired', requests, attachment: { frames }, omitted: undefined }, save);

  requests.push({ method: 'DELETE', target: '/containers/after-resume' });
  frames[0].kind = 'later'; frames[0].sequence = 8n;
  frames[0].detail.labels.push('after-entry'); bytes[0] = 99;
  await first;

  const original = { kind: 'lease-expired', requests: [], attachment: { frames: [
    { kind: 'closed', sequence: '7', bytes: { type: 'Buffer', data: [0, 255] }, detail: { labels: ['original'] } },
  ] } };
  const initial = JSON.parse(await readFile(path, 'utf8'));
  assert.match(initial.observations[0].observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const { observedAt, ...initialValue } = initial.observations[0];
  assert.deepEqual(initialValue, original);

  requests[0].target = '/containers/cleanup-finished';
  frames[0].detail.labels.push('after-save'); bytes[1] = 17;
  frames.push({ kind: 'cleanup-finished', sequence: 9n });
  evidence.cleanup.status = 'fulfilled';
  await save();
  await appendObservation(evidence, { kind: 'after-cleanup', requests, attachment: { frames } }, save);

  const final = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(final.observations.length, 2);
  assert.deepEqual(final.observations[0], { observedAt, ...original }, 'Later report saves must not rewrite an earlier observation.');
  const { observedAt: laterAt, ...later } = final.observations[1];
  assert.match(laterAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.deepEqual(later, { kind: 'after-cleanup', requests: [{ method: 'DELETE', target: '/containers/cleanup-finished' }], attachment: { frames: [
    { kind: 'later', sequence: '8', bytes: { type: 'Buffer', data: [99, 17] }, detail: { labels: ['original', 'after-entry', 'after-save'] } },
    { kind: 'cleanup-finished', sequence: '9' },
  ] } });
  assert.deepEqual(final.cleanup, { status: 'fulfilled' });
});
