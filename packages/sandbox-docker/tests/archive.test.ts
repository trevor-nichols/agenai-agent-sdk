// ------------------------------------------------------------------------------------------------
//                archive.test.ts - Strict incremental tar wire contract - Independent codec fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { extract, pack, type Header } from 'tar-stream';
import { SandboxOperationError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import { readTar } from '../src/workspace/tar/decode.js';
import { writeTar } from '../src/workspace/tar/encode.js';
import type { TarOptions, TarOutputEntry } from '../src/workspace/tar/contracts.js';

const owner = { uid: 65534, gid: 65533 };
const options = (change: Partial<TarOptions> = {}): TarOptions => ({ signal: new AbortController().signal, chunkBytes: 65536, limitCode: 'output_limit', ...change });
type FixtureEntry = Partial<Header> & { readonly name: string; readonly bytes?: Uint8Array };

function entryBody(entry: TarOutputEntry): AsyncIterable<Uint8Array> {
  if (entry.kind === 'symlink') assert.fail('Payload fixture unexpectedly returned a symbolic link.');
  return entry.body;
}

async function collect(source: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    assert(chunk instanceof Uint8Array);
    size += chunk.length;
    assert(size <= 1024 * 1024, 'Independent test collection is capped at 1 MiB.');
    chunks.push(Uint8Array.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function* source(bytes: Uint8Array, size = 257) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function tar(entries: readonly FixtureEntry[]): Promise<Uint8Array> {
  const archive = pack();
  const collected = collect(archive);
  for (const { bytes, ...header } of entries) archive.entry({ type: 'file', mode: 0o600, ...header }, bytes ?? new Uint8Array());
  archive.finalize();
  return collected;
}

async function observed(bytes: Uint8Array, limits = options()) {
  const entries: Array<{ path: string; kind: string; size: number; mode: number; target?: string; bytes: number[] }> = [];
  const summary = await readTar(source(bytes), async (entry) => {
    entries.push({ path: entry.path, kind: entry.kind, size: entry.size, mode: entry.mode,
      ...(entry.kind === 'symlink' ? { target: entry.target } : {}), bytes: entry.kind === 'symlink' ? [] : [...await collect(entry.body)] });
  }, limits);
  return { entries, summary };
}

function changedHeader(bytes: Uint8Array, offset: number, mutate: (block: Buffer) => void): Uint8Array {
  const result = Buffer.from(bytes);
  const block = result.subarray(offset, offset + 512);
  mutate(block);
  block.fill(32, 148, 156);
  block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return result;
}

const driverFailure = (error: unknown) => error instanceof SandboxOperationError && error.code === 'driver_failure';

async function paxArchive(records: string, following: readonly FixtureEntry[]): Promise<Uint8Array> {
  return changedHeader(await tar([{ name: 'PaxHeader', bytes: Buffer.from(records) }, ...following]), 0, (block) => { block[156] = 120; });
}

test('preserves exact raw link text through USTAR and combined maximum-size Unicode PAX fields', async () => {
  const relative = [...Array<string>(15).fill('a'.repeat(255)), 'a'.repeat(239)].join('/');
  const path = `workspace/work/${relative}`;
  const target = Array<string>(16).fill('λ'.repeat(127)).join('/');
  const rawTarget = '../old//./target/';
  const encoded = await collect(writeTar([
    { ...owner, kind: 'symlink', path: 'work/aliases/short', target: rawTarget, size: 0, mode: 0o777 },
    { ...owner, kind: 'symlink', path: '\uFEFFlink', target: '\uFEFFpayload', size: 0, mode: 0o777 },
    { ...owner, kind: 'symlink', path, target, size: 0, mode: 0o777 },
  ], options({ limitCode: 'input_limit', symlinks: 'preserve_internal' })));
  const decoder = extract();
  decoder.end(encoded);
  const independent = [];
  const iterator = decoder[Symbol.asyncIterator]();
  for await (const entry of { [Symbol.asyncIterator]: () => iterator }) independent.push({ path: entry.header.name, type: entry.header.type,
    target: entry.header.linkname, bytes: [...await collect(entry)] });
  assert.deepEqual(independent, [
    { path: 'work/aliases/short', type: 'symlink', target: rawTarget, bytes: [] },
    { path: '\uFEFFlink', type: 'symlink', target: '\uFEFFpayload', bytes: [] },
    { path, type: 'symlink', target, bytes: [] },
  ]);
  const result = await observed(encoded, options({ symlinks: 'preserve_internal' }));
  assert.deepEqual(result.entries, [
    { path: 'work/aliases/short', kind: 'symlink', target: rawTarget, size: 0, mode: 0o777, bytes: [] },
    { path: '\uFEFFlink', kind: 'symlink', target: '\uFEFFpayload', size: 0, mode: 0o777, bytes: [] },
    { path, kind: 'symlink', target, size: 0, mode: 0o777, bytes: [] },
  ]);
  assert.deepEqual(result.summary, { files: 0n, directories: 0n, symlinks: 3n, payloadBytes: 0n, archiveBytes: BigInt(encoded.length) });
  await assert.rejects(observed(encoded), driverFailure);
  await assert.rejects(collect(writeTar([{ ...owner, kind: 'symlink', path: 'work/link', target: 'file', size: 0, mode: 0o777 }], options())), SandboxUnsupportedError);
});

test('local PAX path and linkpath are authoritative over inert USTAR fallback text', async () => {
  const archive = await paxArchive('22 path=folder/actual\n19 linkpath=target\n',
    [{ name: 'fallback', type: 'symlink', linkname: 'ignored' }]);
  const result = await observed(archive, options({ symlinks: 'preserve_internal' }));
  assert.deepEqual(result.entries, [{ path: 'folder/actual', kind: 'symlink', size: 0, mode: 0o600, target: 'target', bytes: [] }]);
  assert.equal(result.summary.symlinks, 1n);
  assert.equal(result.summary.files, 0n);
});

test('preservation still rejects conflicting, wrong-kind, truncated and payload-bearing link metadata', async () => {
  const following: FixtureEntry[] = [{ name: 'link', type: 'symlink', linkname: 'file' }];
  const records = [
    '21 linkpath=safe.txt\n21 linkpath=safe.txt\n',
    '21 linkpath=safe.txt',
    '021 linkpath=safe.txt\n',
    '13 size=2048\n',
    '13 linkpath=\n',
  ];
  for (const record of records) await assert.rejects(observed(await paxArchive(record, following), options({ symlinks: 'preserve_internal' })), driverFailure);
  await assert.rejects(observed(await paxArchive('21 linkpath=safe.txt\n', [{ name: 'file', bytes: Uint8Array.of(1) }]), options({ symlinks: 'preserve_internal' })), driverFailure);
  await assert.rejects(observed(await paxArchive('21 linkpath=safe.txt\n', []), options({ symlinks: 'preserve_internal' })), driverFailure);
  const oversized = changedHeader(await tar([{ name: 'PaxHeader', bytes: Buffer.alloc(16385, 97) }, ...following]), 0, (block) => { block[156] = 120; });
  let payloadPulled = false;
  async function* oversizedSource() {
    yield oversized.subarray(0, 512);
    payloadPulled = true;
    throw new Error('Oversized metadata payload must not be pulled.');
  }
  await assert.rejects(readTar(oversizedSource(), async () => assert.fail('Oversized PAX reached an entry consumer.'), options({ symlinks: 'preserve_internal' })), driverFailure);
  assert.equal(payloadPulled, false);
  const payload = changedHeader(await tar(following), 0, (block) => { block.write('00000000001', 124, 11, 'ascii'); });
  await assert.rejects(observed(payload, options({ symlinks: 'preserve_internal' })), driverFailure);
  const consecutive = changedHeader(await paxArchive('21 linkpath=safe.txt\n',
    [{ name: 'PaxHeader2', bytes: Buffer.from('21 linkpath=safe.txt\n') }, ...following]), 1024, (block) => { block[156] = 120; });
  await assert.rejects(observed(consecutive, options({ symlinks: 'preserve_internal' })), driverFailure);
  const late = changedHeader(await tar([{ name: 'safe', bytes: Uint8Array.of(0, 255) },
    { name: 'PaxHeader', bytes: Buffer.from('21 linkpath=safe.txt') }, ...following]), 1024, (block) => { block[156] = 120; });
  const seen: string[] = [];
  await assert.rejects(readTar(source(late), async (entry) => {
    seen.push(entry.path);
    assert.deepEqual(await collect(entryBody(entry)), Buffer.from([0, 255]));
  }, options({ symlinks: 'preserve_internal' })), driverFailure);
  assert.deepEqual(seen, ['safe']);
});

test('decodes more than twenty thousand real entries from an independent streaming archive', async () => {
  const count = 20_017;
  const archive = pack();
  const producing = (async () => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve, reject) => {
        archive.entry({ name: `work/file-${index}.bin`, type: 'file', mode: 0o600, size: 4 },
          Buffer.from([index & 255, (index >>> 8) & 255, 0, 255]),
          (error) => error ? reject(error) : resolve());
      });
    }
    archive.finalize();
  })();
  void producing.catch((error: unknown) => archive.destroy(error instanceof Error ? error : new Error('Archive fixture failed.')));
  async function* wire() {
    for await (const chunk of archive) {
      assert(chunk instanceof Uint8Array);
      yield chunk;
    }
  }
  let seen = 0;
  try {
    const summary = await readTar(wire(), async (entry) => {
      if (entry.kind !== 'file') assert.fail('Independent fixture contains only regular files.');
      assert.equal(entry.path, `work/file-${seen}.bin`);
      assert.equal(entry.size, 4);
      assert.equal(entry.mode, 0o600);
      const expected = [seen & 255, (seen >>> 8) & 255, 0, 255];
      let offset = 0;
      for await (const chunk of entry.body) {
        for (const byte of chunk) {
          assert.equal(byte, expected[offset]);
          offset += 1;
        }
      }
      assert.equal(offset, 4);
      seen += 1;
    }, options());
    await producing;
    assert.equal(seen, count);
    assert.deepEqual(summary, { files: BigInt(count), directories: 0n, symlinks: 0n,
      payloadBytes: BigInt(count * 4), archiveBytes: BigInt(count * 1024 + 1024) });
  } finally {
    archive.destroy();
    await producing.catch(() => undefined);
  }
});

test('writer produces independently readable exact binary entries and bounded Unicode PAX names', async () => {
  const name = `work/${'λ'.repeat(120)}/result.bin`;
  const encoded = await collect(writeTar([
    { ...owner, path: 'work', kind: 'directory', size: 0, mode: 0o700 },
    { ...owner, path: name, kind: 'file', size: 4, mode: 0o700, body: [Uint8Array.of(0, 255), Uint8Array.of(127, 10)] },
  ], options({ limitCode: 'input_limit' })));
  const decoder = extract();
  const iterator = decoder[Symbol.asyncIterator]();
  decoder.end(encoded);
  const entries: unknown[] = [];
  for await (const entry of { [Symbol.asyncIterator]: () => iterator }) entries.push({ name: entry.header.name, type: entry.header.type,
    uid: entry.header.uid, gid: entry.header.gid, mode: entry.header.mode, bytes: [...await collect(entry)] });
  assert.deepEqual(entries, [
    { name: 'work/', type: 'directory', uid: 65534, gid: 65533, mode: 0o700, bytes: [] },
    { name, type: 'file', uid: 65534, gid: 65533, mode: 0o700, bytes: [0, 255, 127, 10] },
  ]);
  const result = await observed(encoded);
  assert.deepEqual(result.summary, { files: 1n, directories: 1n, symlinks: 0n, payloadBytes: 4n, archiveBytes: BigInt(encoded.length) });
  assert.equal(result.entries[1].path, name);
});

test('reader admits independent ustar and inert bounded PAX timestamps', async () => {
  const relative = `reports/${'λ'.repeat(120)}/result.bin`;
  const archive = await tar([{ name: relative, bytes: Uint8Array.of(0, 255, 127, 10), mode: 0o751,
    pax: { mtime: '1792790400.123456789', atime: '-1.5', ctime: '1792790400' } }]);
  const result = await observed(archive);
  assert.deepEqual(result.entries, [{ path: relative, kind: 'file', size: 4, mode: 0o751, bytes: [0, 255, 127, 10] }]);
});

test('reader rejects links, special entries, path traversal and unsupported sparse/PAX metadata', async (context) => {
  for (const type of ['symlink', 'link', 'fifo', 'character-device', 'block-device', 'contiguous-file'] as const) {
    await context.test(type, async () => {
      const archive = await tar([{ name: 'unsafe', type, ...((type === 'symlink' || type === 'link') ? { linkname: '/host/secret' } : {}) }]);
      await assert.rejects(observed(archive, options(type === 'symlink' ? {} : { symlinks: 'preserve_internal' })), driverFailure);
    });
  }
  for (const name of ['/absolute', '../escape', 'a/./dot', 'a//b', 'back\\slash', 'control\u0085name', 'a\nb', `${'a'.repeat(256)}`]) {
    await assert.rejects(observed(await tar([{ name }])), driverFailure, name);
  }
  for (const pax of [{ 'GNU.sparse.map': '0,4' }, { 'SCHILY.realsize': '4' }, { size: '1' }, { linkpath: '/host' }, { mtime: '1\n2' }, { unknown: 'value' }]) {
    await assert.rejects(observed(await tar([{ name: 'result.bin', bytes: Uint8Array.of(1), pax }])), driverFailure);
  }
  const ordinary = await tar([{ name: 'result.bin', bytes: Uint8Array.of(1) }]);
  await assert.rejects(observed(changedHeader(ordinary, 0, (block) => { block[156] = 83; })), driverFailure);
  await assert.rejects(observed(changedHeader(ordinary, 0, (block) => { block.write('hidden', 157); })), driverFailure);
});

test('late malformed framing rejects after provisional bytes and never reports successful export', async () => {
  const valid = await tar([{ name: 'result.bin', bytes: Uint8Array.of(0, 255, 127, 10) }]);
  const checksum = Uint8Array.from(valid); checksum[0] = 88;
  const padding = Uint8Array.from(valid); padding[516] = 1;
  const late = Buffer.concat([valid, Buffer.alloc(512)]); late[valid.length] = 1;
  const invalid = [checksum, padding, late, valid.subarray(0, 514), valid.subarray(0, valid.length - 512),
    changedHeader(valid, 0, (block) => { block[40] = 1; }),
    changedHeader(valid, 0, (block) => { block[124] = 128; }),
    changedHeader(valid, 0, (block) => { block[0] = 255; })];
  for (const bytes of invalid) await assert.rejects(observed(bytes), driverFailure);
  let provisional: Buffer | undefined;
  let committed = false;
  await assert.rejects((async () => {
    await readTar(source(late), async (entry) => { provisional = await collect(entryBody(entry)); }, options());
    committed = true;
  })(), driverFailure);
  assert.deepEqual(provisional, Buffer.from([0, 255, 127, 10]));
  assert.equal(committed, false);
});

test('wire quotas, exact declared lengths and unsigned-octal representation are independent', async () => {
  const entry = { ...owner, path: 'file', kind: 'file' as const, size: 4, mode: 0o600, body: [Uint8Array.of(1, 2, 3, 4)] };
  await assert.rejects(collect(writeTar([entry], options({ limitCode: 'input_limit', maxArchiveBytes: 1024n }))), (error) => error instanceof SandboxOperationError && error.code === 'input_limit');
  const valid = await tar([{ name: 'file', bytes: Uint8Array.of(1, 2, 3, 4) }]);
  await assert.rejects(observed(valid, options({ maxArchiveBytes: BigInt(valid.length - 1) })), (error) => error instanceof SandboxOperationError && error.code === 'output_limit');
  for (const size of [3, 5]) await assert.rejects(collect(writeTar([{ ...entry, size }], options({ limitCode: 'input_limit' }))), /declared size/);
  await assert.rejects(collect(writeTar([{ ...entry, size: 8 * 1024 ** 3 }], options())), SandboxUnsupportedError);
  const iterator = writeTar([{ ...entry, size: 5 * 1024 ** 3 }], options());
  const header = await iterator.next();
  assert(!header.done);
  assert.equal(Number.parseInt(Buffer.from(header.value).subarray(124, 135).toString(), 8), 5 * 1024 ** 3);
  await iterator.return(undefined);
});

test('entry retirement joins actual pulls, preserves falsy callback errors and rejects concurrent reads', async () => {
  const raw = await tar([{ name: 'a', bytes: Buffer.from('abc') }]);
  for (const marker of [undefined, null, false, 0, '']) {
    const release = Promise.withResolvers<void>();
    const pulling = Promise.withResolvers<void>();
    let joined = false;
    let settled = false;
    async function* delayed() {
      try { yield raw.subarray(0, 512); pulling.resolve(); await release.promise; yield raw.subarray(512); }
      finally { await turn(); joined = true; }
    }
    const work = readTar(delayed(), (entry) => { void entryBody(entry)[Symbol.asyncIterator]().next(); return Promise.reject(marker); }, options());
    void work.finally(() => { settled = true; }).catch(() => {});
    await pulling.promise;
    await turn();
    assert.equal(settled, false);
    release.resolve();
    await assert.rejects(work, (error) => error === marker);
    assert.equal(joined, true);
  }
  let first: IteratorResult<Uint8Array> | undefined;
  await assert.rejects(readTar(source(raw, 512), async (entry) => {
    const iterator = entryBody(entry)[Symbol.asyncIterator]();
    const entered = iterator.next();
    await assert.rejects(iterator.next(), /concurrent/);
    first = await entered;
  }, options()), /concurrent/);
  assert.deepEqual(first, { done: false, value: Buffer.from('abc') });
});

test('empty files and the last bounded payload chunk retire without an EOF-only entry pull', async () => {
  const raw = await tar([{ name: 'empty' }, { name: 'last', bytes: Buffer.from('abc') }]);
  const captured: unknown[] = [];
  const summary = await readTar(source(raw, 512), async (entry: TarOutputEntry) => {
    if (entry.kind === 'symlink') assert.fail('Independent fixture contains no symbolic links.');
    captured.push([entry.path, entry.size ? Buffer.from((await entry.body[Symbol.asyncIterator]().next()).value).toString() : '']);
  }, options());
  assert.deepEqual(captured, [['empty', ''], ['last', 'abc']]);
  assert.equal(summary.files, 2n);
  assert.equal(summary.payloadBytes, 3n);
});

test('archive failure retains independently rejected producer cleanup, including a falsy callback failure', async () => {
  const cleanup = new Error('producer cleanup failed');
  async function* input() { try { yield Buffer.from('abc'); } finally { throw cleanup; } }
  await assert.rejects(collect(writeTar([{ ...owner, path: 'a', kind: 'file', size: 1, mode: 0o600, body: input() }], options({ limitCode: 'input_limit' }))),
    (error) => error instanceof AggregateError && error.errors[0] instanceof SandboxOperationError && error.errors[0].code === 'input_limit' && error.errors[1] === cleanup);
  const valid = await tar([{ name: 'a', bytes: Buffer.from('abc') }]);
  async function* output() { try { yield valid; } finally { throw cleanup; } }
  await assert.rejects(readTar(output(), () => Promise.reject(false), options()),
    (error) => error instanceof AggregateError && error.errors[0] === false && error.errors[1] === cleanup);
});
