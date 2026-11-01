import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { outstandingAtCut, suspendWithOutstanding } from './cut-requests.mjs';

const outstanding = [{ id: 7, kind: 'observation' }, { id: 9, kind: 'checkpoint' }];

test('a written cut report carries the outstanding requests the supervisor binds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'concurrency-cut-requests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = { format: 'agenai.sandbox-platform-concurrency-worker.v1' }, path = join(directory, 'cut-report.json');
  let written;
  assert.throws(() => suspendWithOutstanding(report, outstanding, () => {
    report.handoff = { pid: 41 }; written = writeFile(path, JSON.stringify(report));
    throw new Error('Original synchronous workflow cut resumed.');
  }), /cut resumed/u);
  await written;
  assert.deepEqual(report.outstandingAtCut, outstanding);
  assert.deepEqual(outstandingAtCut({ kind: 'crash' }, JSON.parse(await readFile(path, 'utf8'))), outstanding);
});

test('a cut refused before its handoff keeps no outstanding record', () => {
  const report = {};
  assert.throws(() => suspendWithOutstanding(report, outstanding, () => { throw new Error('Pending cut validation failed.'); }), /validation failed/u);
  assert.equal(Object.hasOwn(report, 'outstandingAtCut'), false);
});

test('only a selected cut row may bind outstanding observations', () => {
  for (const kind of ['crash', 'lost_ack', 'lease_expiry']) assert.deepEqual(outstandingAtCut({ kind }, { outstandingAtCut: outstanding }), outstanding);
  assert.throws(() => outstandingAtCut({ kind: 'workflow' }, { outstandingAtCut: outstanding }), /Only a selected cut row/u);
});
