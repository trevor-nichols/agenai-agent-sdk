import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { lstat, readFile, readlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { extractArchive, inspectArchive } from '../src/node/install/binary/archive.js';
import { prepareBinary } from '../src/node/install/binary/prepare.js';
import { AcpInstallationError } from '../src/node/install/errors.js';
import { binaryContext, binaryLimits, digestBytes, fixturePath, tarFixture, withArchive } from './fixtures/install-binary/index.js';

const installationError = (code: AcpInstallationError['code']) => (error: unknown) => error instanceof AcpInstallationError && error.code === code;

for (const name of ['valid.tar', 'valid.tar.gz', 'valid.tar.bz2', 'valid.zip', 'valid.bin']) {
  test(`binary preparation decodes actual ${name} bytes to the exact retained executable and separates integrity evidence`, async () => {
    const fixture = await binaryContext(name);
    try {
      const result = await prepareBinary(fixture.context);
      assert.equal(await readFile(join(fixture.context.payloadRoot, 'bin/agent'), 'utf8'), "#!/bin/sh\nprintf 'fixture\\n'\n");
      assert.deepEqual(result.launch, { command: { kind: 'payload', path: 'bin/agent' }, args: [
        { kind: 'literal', value: '--acp' }, { kind: 'literal', value: 'literal;$(never-execute)' },
      ], env: {}, shell: false });
      assert.equal(result.artifacts[0]?.measuredSha256, digestBytes(await readFile(fixturePath(name))));
      assert.equal(result.artifacts[0]?.expectedSha256, fixture.context.plan.expectedIntegrity.sha256);
      assert.equal(result.artifacts[0]?.origin, 'local');
      assert.equal('path' in result.artifacts[0]!, false);
      assert.equal(result.verification.reproducibility, 'pinned-binary');
      assert.equal(result.verification.expectedArtifactIntegrity, 'verified');
      assert.equal((await stat(join(fixture.context.payloadRoot, 'bin/agent'))).mode & 0o100, 0o100);
    } finally { await fixture.cleanup(); }
  });
}

test('missing expected integrity remains explicit under permissive policy and a wrong checksum writes no payload', async () => {
  const weak = await binaryContext('valid.tar.gz', { expected: null });
  try {
    const result = await prepareBinary(weak.context);
    assert.equal(result.artifacts[0]?.expectedSha256, undefined);
    assert.equal(result.verification.expectedArtifactIntegrity, 'not-provided');
    assert.equal(result.verification.reproducibility, 'incomplete');
    assert.deepEqual(result.verification.gaps, ['expected-sha256-missing']);
  } finally { await weak.cleanup(); }
  const wrong = await binaryContext('valid.tar.gz', { expected: `sha256:${'0'.repeat(64)}` });
  try {
    await assert.rejects(prepareBinary(wrong.context), installationError('integrity_mismatch'));
    assert.deepEqual(await readdir(wrong.context.payloadRoot), []);
    assert.deepEqual(await readdir(wrong.context.workRoot), []);
  } finally { await wrong.cleanup(); }
});

test('the executable path is exact and never searched or renamed', async () => {
  const fixture = await binaryContext('valid.tar.gz', { command: 'agent' });
  try { await assert.rejects(prepareBinary(fixture.context), installationError('unsafe_archive')); }
  finally { await fixture.cleanup(); }
});

test('contained forward symlinks and tar hardlinks preserve launchability without inode aliases', async () => {
  const bytes = await tarFixture([
    { name: 'links/agent', type: 'symlink', linkname: '../bin/agent' },
    { name: 'copy', type: 'link', linkname: 'bin/agent' },
    { name: 'bin/agent', content: 'executable', mode: 0o755 },
  ]);
  await withArchive(bytes, async (artifactPath, root) => {
    const payloadRoot = join(root, 'payload');
    await extractArchive({ artifactPath, payloadRoot, format: 'tar.gz', limits: binaryLimits });
    assert.equal(await readlink(join(payloadRoot, 'links/agent')), '../bin/agent');
    assert.equal(await readFile(join(payloadRoot, 'links/agent'), 'utf8'), 'executable');
    assert.equal(await readFile(join(payloadRoot, 'copy'), 'utf8'), 'executable');
    const original = await lstat(join(payloadRoot, 'bin/agent'));
    const copy = await lstat(join(payloadRoot, 'copy'));
    assert.notEqual(original.ino, copy.ino);
    assert.equal(copy.nlink, 1);
  });
  await withArchive(await readFile(fixturePath('links.zip')), async (artifactPath, root) => {
    await extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format: 'zip', limits: binaryLimits });
    assert.equal(await readlink(join(root, 'payload/agent')), 'bin/agent');
    assert.equal(await readFile(join(root, 'payload/agent'), 'utf8'), "#!/bin/sh\nprintf 'fixture\\n'\n");
  });
});

const unsafeTarEntries = [
  ['parent traversal', [{ name: '../outside', content: 'forbidden' }]],
  ['absolute path', [{ name: '/outside', content: 'forbidden' }]],
  ['Windows drive path', [{ name: 'C:/outside', content: 'forbidden' }]],
  ['backslash ambiguity', [{ name: 'bin\\agent', content: 'forbidden' }]],
  ['duplicate normalized paths', [{ name: './agent', content: 'first' }, { name: 'agent', content: 'second' }]],
  ['escaping symlink', [{ name: 'agent', type: 'symlink' as const, linkname: '../outside' }]],
  ['absolute symlink', [{ name: 'agent', type: 'symlink' as const, linkname: '/outside' }]],
  ['dangling symlink', [{ name: 'agent', type: 'symlink' as const, linkname: 'missing' }]],
  ['cyclic symlinks', [{ name: 'one', type: 'symlink' as const, linkname: 'two' }, { name: 'two', type: 'symlink' as const, linkname: 'one' }]],
  ['write through symlink', [{ name: 'dir', type: 'symlink' as const, linkname: '.' }, { name: 'dir/file', content: 'forbidden' }]],
  ['escaping hardlink', [{ name: 'copy', type: 'link' as const, linkname: '../outside' }]],
  ['device', [{ name: 'device', type: 'character-device' as const, devmajor: 1, devminor: 3 }]],
  ['FIFO', [{ name: 'pipe', type: 'fifo' as const }]],
] as const;

for (const [label, entries] of unsafeTarEntries) {
  test(`tar extraction rejects ${label} without creating an outside file`, async () => {
    await withArchive(await tarFixture(entries), async (artifactPath, root) => {
      await assert.rejects(extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format: 'tar.gz', limits: binaryLimits }), installationError('unsafe_archive'));
      await assert.rejects(lstat(join(root, 'outside')), { code: 'ENOENT' });
    });
  });
}

for (const name of ['traversal.zip', 'escape.zip', 'device.zip', 'duplicate.zip', 'backslash.zip', 'wrong-crc.zip', 'incomplete.zip']) {
  test(`ZIP extraction rejects actual ${name} metadata or data`, async () => {
    await withArchive(await readFile(fixturePath(name)), async (artifactPath, root) => {
      await assert.rejects(extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format: 'zip', limits: binaryLimits }), installationError('unsafe_archive'));
      await assert.rejects(lstat(join(root, 'outside')), { code: 'ENOENT' });
    });
  });
}

for (const [label, overrides] of [
  ['compressed bytes', { maxArtifactBytes: 16 }], ['decompressed framing', { maxDecompressedBytes: 512 }],
  ['payload bytes', { maxPayloadBytes: 16 }], ['entry count', { maxEntries: 1 }],
  ['path depth', { maxPathDepth: 1 }], ['path bytes', { maxPathBytes: 4 }],
] as const) {
  test(`real tar extraction enforces ${label} bounds`, async () => {
    await assert.rejects(inspectArchive({ artifactPath: fixturePath('valid.tar.gz'), format: 'tar.gz', limits: { ...binaryLimits, ...overrides } }), installationError('limit_exceeded'));
  });
}

test('truncated compressed streams and missing tar terminators never qualify as complete archives', async () => {
  for (const [name, format] of [['valid.tar.gz', 'tar.gz'], ['valid.tar.bz2', 'tar.bz2']] as const) {
    const bytes = await readFile(fixturePath(name));
    await withArchive(bytes.subarray(0, bytes.length - 6), async (artifactPath) => {
      await assert.rejects(inspectArchive({ artifactPath, format, limits: binaryLimits }), installationError('unsafe_archive'));
    });
  }
  const tar = await tarFixture([{ name: 'agent', content: 'data' }], false);
  await withArchive(tar.subarray(0, tar.length - 1024), async (artifactPath) => {
    await assert.rejects(inspectArchive({ artifactPath, format: 'tar', limits: binaryLimits }), installationError('unsafe_archive'));
  });
});

test('archive inspection captures bounded exact package metadata and rejects links before package tools run', async () => {
  const content = '{"name":"fixture-agent","version":"1.0.0"}';
  await withArchive(await tarFixture([{ name: 'package/package.json', content }, { name: 'package/agent.js', content: 'code' }]), async (artifactPath) => {
    const result = await inspectArchive({ artifactPath, format: 'tar.gz', limits: binaryLimits, readFiles: ['package/package.json'] });
    assert.equal(Buffer.from(result.files['package/package.json']!).toString('utf8'), content);
    assert.equal(result.files['package/agent.js'], undefined);
    await assert.rejects(inspectArchive({ artifactPath, format: 'tar.gz', limits: { ...binaryLimits, maxReceiptBytes: 8 }, readFiles: ['package/package.json'] }), installationError('limit_exceeded'));
  });
  await assert.rejects(inspectArchive({ artifactPath: fixturePath('links.zip'), format: 'zip', limits: binaryLimits }), installationError('unsafe_archive'));
});

test('hardlink expansion and case-insensitive target collisions have independent payload bounds', async () => {
  await withArchive(await tarFixture([{ name: 'agent', content: '12345' }, { name: 'copy', type: 'link', linkname: 'agent' }]), async (artifactPath, root) => {
    await assert.rejects(extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format: 'tar.gz', limits: { ...binaryLimits, maxPayloadBytes: 9 } }), installationError('limit_exceeded'));
  });
  await withArchive(await tarFixture([{ name: 'Agent', content: 'one' }, { name: 'agent', content: 'two' }]), async (artifactPath, root) => {
    await assert.rejects(extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format: 'tar.gz', limits: binaryLimits, caseInsensitive: true }), installationError('unsafe_archive'));
  });
});

test('implicit parent directories consume the extracted entry budget before filesystem creation', async () => {
  await withArchive(await tarFixture([{ name: 'one/two/three/agent', content: 'data' }]), async (artifactPath, root) => {
    await assert.rejects(extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format: 'tar.gz',
      limits: { ...binaryLimits, maxEntries: 3 } }), installationError('limit_exceeded'));
    assert.deepEqual(await readdir(join(root, 'payload')), []);
  });
});

test('bzip2 and ZIP decoders enforce their independent decompressed-byte limits', async () => {
  for (const [name, format] of [['valid.tar.bz2', 'tar.bz2'], ['valid.zip', 'zip']] as const) {
    await assert.rejects(inspectArchive({ artifactPath: fixturePath(name), format,
      limits: { ...binaryLimits, maxDecompressedBytes: 16 } }), installationError('limit_exceeded'));
  }
});

for (const [name, format] of [['valid.tar.gz', 'tar.gz'], ['valid.tar.bz2', 'tar.bz2'], ['valid.zip', 'zip']] as const) {
  test(`cancellation during actual ${format} extraction releases decoder and file waiters`, async () => {
    await withArchive(await readFile(fixturePath(name)), async (artifactPath, root) => {
      const controller = new AbortController();
      let admitted = false;
      const watcher = watch(join(root, 'payload'), () => { admitted = true; controller.abort(); });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const extraction = extractArchive({ artifactPath, payloadRoot: join(root, 'payload'), format, limits: binaryLimits, signal: controller.signal });
        const bounded = Promise.race([extraction, new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Archive cancellation left pending waiters.')), 2000);
        })]);
        await assert.rejects(bounded, installationError('aborted'));
        assert.equal(admitted, true);
      } finally { watcher.close(); if (deadline) clearTimeout(deadline); }
    });
  });
}
