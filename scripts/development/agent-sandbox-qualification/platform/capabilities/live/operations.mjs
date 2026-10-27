import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { entered } from './evidence.mjs';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import { backend, guest, request, send } from './installed.mjs';
import { sentinel } from './sentinel.mjs';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readObserved(files, path, onChunk) {
  const hash = createHash('sha256'); let bytes = 0n; let chunks = 0; let largestChunk = 0;
  const result = await files.readFile(path, async ({ entry, chunks: source }) => {
    assert.equal(entry.kind, 'file'); assert.equal(entry.path, path);
    for await (const chunk of source) {
      assert(chunk instanceof Uint8Array && chunk.byteLength <= 65536);
      hash.update(chunk); bytes += BigInt(chunk.byteLength); largestChunk = Math.max(largestChunk, chunk.byteLength); chunks++;
      await onChunk?.({ chunks, bytes, chunk });
    }
  });
  assert.equal(result.bytes, bytes);
  return { result, bytes, chunks, largestChunk, sha256: hash.digest('hex') };
}

export function operationCases(context) {
  return [
    ['grant-disabled-and-missing-helper', async (run) => {
      const selected = await backend(context.config, { namespace: `${context.config.namespacePrefix}missing-helper`,
        directory: run.directory, filesystem: false });
      assert.throws(() => selected.reserve(request(context.config), { kind: 'in_process' }), SandboxUnsupportedError);
      const { owner, files, session } = await guest(run, context, { access: 'disabled' });
      assert.deepEqual(files, { kind: 'disabled' });
      assert.equal(owner.recoveryRecord.resources.some(({ role }) => role === 'filesystem'), false);
      const native = await send(session, { kind: 'write', path: 'guest.bin', base64: 'AP8J' });
      assert.equal(native.sha256, sha(Uint8Array.of(0, 255, 9)));
      run.evidence.observations.push({ kind: 'disabled-grant-has-no-helper-or-live-port', native, record: owner.recoveryRecord });
    }],
    ['grant-read-only-observes-changing-live-bytes', async (run) => {
      const { owner, files, session } = await guest(run, context, { access: 'read_only' });
      assert.equal(files.kind, 'read_only'); assert.equal(Object.hasOwn(files, 'writeFile'), false);
      const first = await send(session, { kind: 'write', path: 'live.bin', base64: 'AP8J' });
      const observed = await readObserved(files, 'live.bin'); assert.equal(observed.result.kind, 'completed'); assert.equal(observed.sha256, first.sha256);
      const second = await send(session, { kind: 'write', path: 'live.bin', base64: 'CQgHBg==' });
      const changed = await readObserved(files, 'live.bin'); assert.equal(changed.result.kind, 'completed'); assert.equal(changed.sha256, second.sha256);
      const helper = owner.recoveryRecord.resources.find(({ role }) => role === 'filesystem');
      assert.equal(helper.identity.kind, 'identified');
      const actual = (await context.engine.request('GET', `/containers/${helper.identity.id}/json`)).data;
      assert(actual.Mounts.some(({ Destination, RW }) => Destination === '/store' && RW === false));
      assert.equal(actual.HostConfig.NetworkMode, 'none'); assert.equal(actual.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']); assert.deepEqual(actual.HostConfig.Binds ?? [], []);
      run.evidence.observations.push({ kind: 'read-only-live-bytes-and-denied-write-authority', observed, changed,
        writeAvailable: Object.hasOwn(files, 'writeFile'), helper: actual });
    }],
    ['binary-empty-executable-metadata-create-and-replace', async (run) => {
      const { files, session } = await guest(run, context);
      const payloads = [['binary.bin', Uint8Array.of(0, 255, 9, 0, 128), 0o644],
        ['empty.bin', new Uint8Array(), 0o644], ['executable.sh', Buffer.from('#!/bin/sh\nexit 0\n'), 0o755]];
      const observations = [];
      for (const [path, bytes, permissions] of payloads) {
        await send(session, { kind: 'write', path, base64: Buffer.from(bytes).toString('base64'), permissions });
        const stat = await files.stat(path); assert.equal(stat.kind, 'completed');
        assert.equal(stat.entry.byteLength, bytes.byteLength); assert.equal(stat.entry.permissions, permissions);
        const read = await readObserved(files, path); assert.equal(read.result.kind, 'completed'); assert.equal(read.sha256, sha(bytes));
        observations.push({ path, stat, read });
      }
      const root = await files.stat('.'); assert.equal(root.kind, 'completed'); assert.equal(root.entry.kind, 'directory');
      const paths = [];
      const listing = await files.list('.', async (entry) => { paths.push(entry.path); });
      assert.equal(listing.kind, 'completed');
      assert(payloads.every(([path]) => paths.includes(path)));
      const publication = await files.writeFile('created.bin', [Uint8Array.of(0, 255, 9)], { mode: 'create' });
      assert.deepEqual(publication, { kind: 'completed', effect: 'published', bytes: 3n, permissions: 0o644 });
      const collision = await files.writeFile('created.bin', [Uint8Array.of(99)], { mode: 'create' });
      assert.deepEqual(collision, { kind: 'rejected', reason: 'already_exists', effect: 'none', bytes: 0n });
      assert.equal((await send(session, { kind: 'digest', path: 'created.bin' })).sha256, sha(Uint8Array.of(0, 255, 9)));
      await send(session, { kind: 'chmod', path: 'created.bin', permissions: 0o751 });
      const replacement = await files.writeFile('created.bin', [Uint8Array.of(8, 7)], { mode: 'replace' });
      assert.deepEqual(replacement, { kind: 'completed', effect: 'published', bytes: 2n, permissions: 0o751 });
      const final = await send(session, { kind: 'stat', path: 'created.bin' }); assert.equal(final.permissions, 0o751);
      assert.equal((await send(session, { kind: 'digest', path: 'created.bin' })).sha256, sha(Uint8Array.of(8, 7)));
      run.evidence.observations.push({ kind: 'exact-metadata-and-mutation-receipts', observations, root, listing, paths, publication, collision, replacement, final });
    }],
    ['bounded-streams-backpressure-and-private-staging', async (run) => {
      const { owner, files, session } = await guest(run, context);
      const outside = await sentinel(run, context, owner);
      const layout = await send(session, { kind: 'layout' });
      assert(['ENOENT', 'EACCES'].includes(layout.privateStage)); assert.notEqual(layout.rootRename, 'renamed');
      const expected = await send(session, { kind: 'write', path: 'large.bin', length: 1024 * 1024 + 13, fill: 61 });
      const ready = Promise.withResolvers(); const release = Promise.withResolvers(); let settled = false;
      const reading = readObserved(files, 'large.bin', async ({ chunks }) => { if (chunks === 1) { ready.resolve(); await release.promise; } });
      void reading.then(() => { settled = true; }, () => { settled = true; });
      try {
        await entered(ready, reading, context.config.capabilities.limits.requestMs);
        await delay(100); assert.equal(settled, false); assert.equal(owner.state.kind, 'ready');
      } finally { release.resolve(); }
      const read = await reading; assert.equal(read.result.kind, 'completed'); assert.equal(read.sha256, expected.sha256); assert(read.chunks > 1);
      const sourceReady = Promise.withResolvers(); const sourceRelease = Promise.withResolvers(); let sourceReturns = 0;
      const writing = files.writeFile('staged.bin', { async *[Symbol.asyncIterator]() {
        try { yield Uint8Array.of(5); sourceReady.resolve(); await sourceRelease.promise; yield Uint8Array.of(6); }
        finally { sourceReturns++; }
      } }, { mode: 'create' });
      void writing.catch(() => {});
      let staged;
      try {
        await entered(sourceReady, writing, context.config.capabilities.limits.requestMs);
        staged = await outside.inspect(); assert.equal(staged.stage.length, 1); assert(!staged.root.includes('staged.bin'));
        assert.equal((await session.request({ kind: 'stat', path: 'staged.bin' })).ok, false);
      } finally { sourceRelease.resolve(); }
      const write = await writing; assert.deepEqual(write, { kind: 'completed', effect: 'published', bytes: 2n, permissions: 0o644 });
      assert.equal(sourceReturns, 1); assert.deepEqual((await outside.inspect()).stage, []);
      await send(session, { kind: 'listing', path: 'many', entries: 1025 });
      let entries = 0n; let metadataBytes = 0;
      const listed = await files.list('many', async (entry) => { entries++; metadataBytes += Buffer.byteLength(JSON.stringify(entry)); });
      assert.deepEqual(listed, { kind: 'completed', entries: 1025n }); assert.equal(entries, 1025n); assert(metadataBytes > 65536);
      run.evidence.observations.push({ kind: 'bounded-stream-backpressure', layout, read, staged, write, sourceReturns, listed, metadataBytes });
    }],
    ['partial-read-retires-stream-with-exact-delivered-bytes', async (run) => {
      const { owner, files, session } = await guest(run, context);
      await send(session, { kind: 'write', path: 'partial.bin', length: 131085, fill: 37 });
      let bytes;
      const result = await files.readFile('partial.bin', async ({ chunks }) => {
        for await (const chunk of chunks) { bytes = chunk.slice(); break; }
      });
      assert.deepEqual(bytes, new Uint8Array(65536).fill(37));
      assert.deepEqual(result, { kind: 'cancelled', reason: 'callback_closed', bytes: 65536n });
      const after = await files.stat('partial.bin'); assert.equal(after.kind, 'completed'); assert.equal(after.entry.byteLength, 131085);
      assert.equal(owner.state.kind, 'ready');
      await owner.stop();
      run.evidence.observations.push({ kind: 'actual-partial-read-callback-exit', result, after, bytes: bytes.byteLength, sha256: sha(bytes) });
    }],
  ];
}
