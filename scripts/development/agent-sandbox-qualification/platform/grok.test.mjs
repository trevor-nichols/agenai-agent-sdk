// ------------------------------------------------------------------------------------------------
//                grok.test.mjs - Actual ELF input, mutation, bounded streaming and cleanup behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openGrokBinary } from './grok-binary.mjs';

function elf(machine = 62) {
  const bytes = Buffer.alloc(192 * 1024 + 17, 0xa5);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agenai-grok-source-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('exact ELF source streams bounded borrowed chunks twice and closes admission permanently', async () => {
  await fixture(async (directory) => {
    const filename = path.join(directory, 'grok');
    const bytes = elf();
    await writeFile(filename, bytes);
    const owner = await openGrokBinary(filename, digest(bytes));
    try {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const [entry] = owner.source();
        assert.equal(entry.path, 'harness/grok');
        assert.equal(entry.executable, true);
        assert.equal(entry.byteLength, bytes.length);
        const received = [];
        for await (const chunk of entry.open({ signal: new AbortController().signal })) {
          assert(chunk.byteLength <= 64 * 1024);
          received.push(Buffer.from(chunk));
        }
        assert.deepEqual(Buffer.concat(received), bytes);
      }
    } finally { await owner.close(); }
    await owner.close();
    const [entry] = owner.source();
    await assert.rejects(entry.open({ signal: new AbortController().signal })[Symbol.asyncIterator]().next(), /closed/u);
    assert.deepEqual(await readFile(filename), bytes, 'Borrowed binary survives ownership release.');
  });
});

test('wrong machine, host executable format, mismatched digest and symlink inputs fail before native use', async () => {
  await fixture(async (directory) => {
    const filename = path.join(directory, 'grok');
    for (const bytes of [elf(183), Buffer.alloc(128, 0), elf()]) {
      await writeFile(filename, bytes);
      const pin = bytes.readUInt16LE(18) === 62 ? '0'.repeat(64) : digest(bytes);
      await assert.rejects(openGrokBinary(filename, pin), /ELF64|pinned binary/u);
    }
    const link = path.join(directory, 'alias');
    await symlink(filename, link);
    await assert.rejects(openGrokBinary(link, digest(elf())), /regular file/u);
  });
});

test('replacement and same-length mutation between validation and import cannot reuse old identity', async () => {
  for (const replacement of [false, true]) {
    await fixture(async (directory) => {
      const filename = path.join(directory, 'grok');
      const bytes = elf();
      await writeFile(filename, bytes);
      const owner = await openGrokBinary(filename, digest(bytes));
      try {
        if (replacement) {
          const next = path.join(directory, 'replacement');
          await writeFile(next, bytes);
          await rename(next, filename);
        } else {
          bytes[1024] ^= 0xff;
          await writeFile(filename, bytes);
        }
        const [entry] = owner.source();
        await assert.rejects(async () => { for await (const _chunk of entry.open({ signal: new AbortController().signal })) { /* Consume actual source. */ } }, /identity|changed/u);
      } finally { await owner.close(); }
    });
  }
});

test('growth during an entered import rejects and cancellation retires the active reader before close', async () => {
  await fixture(async (directory) => {
    const filename = path.join(directory, 'grok');
    const bytes = elf();
    await writeFile(filename, bytes);
    const owner = await openGrokBinary(filename, digest(bytes));
    try {
      const [entry] = owner.source();
      const reader = entry.open({ signal: new AbortController().signal })[Symbol.asyncIterator]();
      assert.equal((await reader.next()).value.byteLength, 64 * 1024);
      await writeFile(filename, Buffer.concat([bytes, Buffer.from([1])]));
      await assert.rejects(async () => { while (!(await reader.next()).done) { /* Reach real EOF validation. */ } }, /grew|changed/u);
    } finally { await owner.close(); }
    await writeFile(filename, bytes);
    const second = await openGrokBinary(filename, digest(bytes));
    const controller = new AbortController();
    try {
      const [entry] = second.source();
      const reader = entry.open({ signal: controller.signal })[Symbol.asyncIterator]();
      assert.equal((await reader.next()).done, false);
      const reason = new Error('stop this import');
      controller.abort(reason);
      await assert.rejects(reader.next(), (error) => error === reason);
    } finally { await second.close(); }
  });
});
