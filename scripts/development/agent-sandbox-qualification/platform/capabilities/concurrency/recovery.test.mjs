import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha } from '../../coordinator/evidence.mjs';
import { acknowledgedBody } from './recovery.mjs';

async function receipt(t, bytes) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'concurrency-acknowledged-body-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'lost-ack-original-body.bin');
  await writeFile(path, bytes);
  return { status: bytes.length ? 201 : 204, body: { path, bytes: bytes.length, sha256: sha(bytes) } };
}

test('an empty start or delete acknowledgement is retained as its exact original bytes', async (t) => {
  for (const operation of ['start', 'delete']) {
    const selected = await receipt(t, Buffer.alloc(0));
    const body = await acknowledgedBody(selected, operation);
    assert.deepEqual(body.identity, selected.body);
    assert.equal(body.bytes.length, 0);
    assert.equal(Object.hasOwn(body, 'value'), false);
  }
});

test('a create acknowledgement yields its Engine-returned identity', async (t) => {
  const id = 'a'.repeat(64);
  const selected = await receipt(t, Buffer.from(JSON.stringify({ Id: id, Warnings: [] })));
  const body = await acknowledgedBody(selected, 'create');
  assert.deepEqual(body.identity, selected.body);
  assert.equal(body.value.Id, id);
});

test('a create acknowledgement without its JSON identity is refused', async (t) => {
  await assert.rejects(acknowledgedBody(await receipt(t, Buffer.alloc(0)), 'create'), SyntaxError);
  await assert.rejects(acknowledgedBody(await receipt(t, Buffer.from('{"Id":"short"}')), 'create'), /did not match/u);
});

test('acknowledgement bytes that differ from the cut receipt are refused', async (t) => {
  const selected = await receipt(t, Buffer.alloc(0));
  await writeFile(selected.body.path, Buffer.from('late'));
  await assert.rejects(acknowledgedBody(selected, 'start'), assert.AssertionError);
});
