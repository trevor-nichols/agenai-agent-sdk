import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AcpRegistryValidationError, parseAcpRegistrySnapshot, type AcpRegistryLimits, type AcpRegistrySource } from '../src/index.js';
import { catalogAgent, catalogContent, catalogSource } from './fixtures/catalog/index.js';

const invalid = (code?: string) => (error: unknown): boolean => {
  assert.ok(error instanceof AcpRegistryValidationError);
  assert.ok(error.issues.length > 0);
  if (code) assert.ok(error.issues.some((issue) => issue.code === code), JSON.stringify(error.issues));
  assert.equal(Object.isFrozen(error.issues), true);
  assert.equal(Object.isFrozen(error.issues[0]!.path), true);
  return true;
};

test('the pinned source-backed published shape preserves real releases, distributions and contained binary paths', () => {
  const content = readFileSync(new URL('./fixtures/catalog/pinned-derived.json', import.meta.url));
  const snapshot = parseAcpRegistrySnapshot({ source: catalogSource, content });
  assert.equal(snapshot.rawDigest, `sha256:${createHash('sha256').update(content).digest('hex')}`);
  const cursor = snapshot.entries.find((entry) => entry.id === 'cursor');
  assert.equal(cursor?.version, '2026.10.01');
  const windows = cursor?.distributions.find((distribution) => distribution.kind === 'binary' && distribution.target === 'windows-x86_64');
  assert.ok(windows?.kind === 'binary');
  assert.equal(windows.executable, 'dist-package/cursor-agent.cmd');
  assert.deepEqual(windows.args, ['acp']);
  assert.equal(windows.sha256, undefined);
  const amp = snapshot.entries.find((entry) => entry.id === 'amp-acp')?.distributions.find((distribution) => distribution.kind === 'binary' && distribution.target === 'windows-x86_64');
  assert.ok(amp?.kind === 'binary');
  assert.equal(amp.executable, 'amp-acp.exe');
  assert.equal(amp.sha256, 'af3fe51c6b555f25446cb18cc81218d0cc334227289215cacb5a53feb12ff33f');
  const packages = snapshot.entries.flatMap((entry) => entry.distributions.flatMap((distribution) => distribution.kind === 'binary' ? [] : [distribution.package]));
  assert.ok(packages.includes('@agentclientprotocol/claude-agent-acp@0.88.0'));
  assert.ok(packages.includes('deepagents-acp@0.1.7'));
  assert.ok(packages.includes('fast-agent-acp==0.10.1'));
  assert.ok(packages.includes('minion-code@0.1.44'));
  const vtcode = snapshot.entries.find((entry) => entry.id === 'vtcode')?.distributions[0];
  assert.deepEqual(vtcode?.env, { VT_ACP_ENABLED: '1', VT_ACP_ZED_ENABLED: '1' });
});

test('raw byte provenance differs from canonical entry identity and accepted catalogs are deeply immutable', () => {
  const entry = catalogAgent({ bundled: false, distribution: { npx: { package: 'fixture-agent', args: ['$(not-executed)', '; literal'], env: { LITERAL: '$HOME' } } } });
  const firstContent = catalogContent([entry]);
  const bytes = new TextEncoder().encode(firstContent);
  const first = parseAcpRegistrySnapshot({ source: catalogSource, content: bytes });
  const second = parseAcpRegistrySnapshot({ source: catalogSource, content: `${firstContent}\n` });
  assert.notEqual(first.rawDigest, second.rawDigest);
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.entries[0]!.digest, second.entries[0]!.digest);
  assert.equal(first.entries[0]!.bundled, false);
  const distribution = first.entries[0]!.distributions[0]!;
  assert.deepEqual(distribution.args, ['$(not-executed)', '; literal']);
  assert.equal(Reflect.set(distribution.args, '0', 'altered'), false);
  assert.equal(Reflect.set(distribution.env, 'LITERAL', 'altered'), false);
  assert.equal(Reflect.set(first.source, 'namespace', 'altered'), false);
  bytes.fill(0);
  assert.equal(first.rawDigest, `sha256:${createHash('sha256').update(firstContent).digest('hex')}`);
  assert.deepEqual(distribution.args, ['$(not-executed)', '; literal']);
});

test('explicit namespace, origin, source kind and channel each bind independent source and agent identities', () => {
  const sources: AcpRegistrySource[] = [catalogSource, { ...catalogSource, namespace: 'other' }, { ...catalogSource, location: 'fixture:other' },
    { ...catalogSource, kind: 'remote', location: 'https://example.com/registry.json' }, { ...catalogSource, channel: 'preview' }];
  const snapshots = sources.map((source) => parseAcpRegistrySnapshot({ source, content: catalogContent() }));
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.sourceIdentity)).size, sources.length);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.entries[0]!.identity)).size, sources.length);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.entries[0]!.digest)).size, sources.length);
});

test('published preview channels accept ordinary replacement entries and stable channels reject preview releases', () => {
  const content = catalogContent([catalogAgent({ version: '1.2.3-preview.4' })]);
  const preview = parseAcpRegistrySnapshot({ source: { ...catalogSource, channel: 'preview' }, content });
  assert.equal(preview.entries[0]!.version, '1.2.3-preview.4');
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content }), invalid('channel_mismatch'));
});

test('only dimcode may omit the pinned license URL requirement', () => {
  const entry = catalogAgent({ id: 'dimcode' });
  delete entry.license_url;
  assert.equal(parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([entry]) }).entries[0]!.licenseUrl, undefined);
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([{ ...entry, id: 'another-agent' }]) }), invalid('license_required'));
});

for (const [kind, specifiers] of Object.entries({ npx: ['fixture-agent', '@scope/agent', 'fixture-agent@latest', '@scope/agent@^1.2.3', 'fixture-agent@~1.2.3', 'fixture-agent@*'],
  uvx: ['fixture-agent', 'fixture-agent==1.2.3', 'fixture-agent@1.2.3', 'fixture-agent>=1.0,<2.0'] })) {
  test(`${kind} preserves supported unresolved selectors as inert metadata`, () => {
    for (const packageName of specifiers) {
      const snapshot = parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent({ distribution: { [kind]: { package: packageName } } })]) });
      const distribution = snapshot.entries[0]!.distributions[0]!;
      assert.ok(distribution.kind !== 'binary');
      assert.equal(distribution.package, packageName);
    }
  });
}

const incompatible: Readonly<Record<string, unknown>> = {
  source_preview: catalogAgent({ preview: { version: '1.2.4-preview.1', distribution: { npx: { package: 'fixture-agent@1.2.4-preview.1' } } } }),
  unknown_distribution: catalogAgent({ distribution: { docker: { image: 'agent:latest' } } }),
  unknown_package_field: catalogAgent({ distribution: { npx: { package: 'fixture-agent', command: 'shell' } } }),
  unknown_binary_field: catalogAgent({ distribution: { binary: { 'linux-x86_64': { archive: 'https://example.com/agent.zip', cmd: 'agent', cwd: '/outside' } } } }),
  empty_distributions: catalogAgent({ distribution: {} }),
  unsupported_target: catalogAgent({ distribution: { binary: { 'linux-riscv64': { archive: 'https://example.com/agent.zip', cmd: 'agent' } } } }),
  empty_binary: catalogAgent({ distribution: { binary: {} } }),
  wrong_bundled_type: catalogAgent({ bundled: 'yes' }),
  wrong_agent_version: catalogAgent({ version: '1.2.3-rc.1' }),
  malformed_checksum: catalogAgent({ distribution: { binary: { 'linux-x86_64': { archive: 'https://example.com/agent.zip', cmd: 'agent', sha256: '1234' } } } }),
};
for (const [name, entry] of Object.entries(incompatible)) {
  test(`published profile rejects ${name} before returning any accepted catalog`, () => {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([entry]) }), invalid());
  });
}

test('duplicate agent identities and duplicate decoded JSON keys reject instead of choosing one value', () => {
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent(), catalogAgent({ name: 'Conflicting agent' })]) }), invalid('duplicate_identity'));
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: String.raw`{"version":"1.0.0","agents":[],"a\u0067ents":[]}` }), invalid('duplicate_key'));
});

for (const [name, content] of Object.entries({ nonempty_extensions: JSON.stringify({ version: '1.0.0', agents: [], extensions: [{}] }),
  unknown_envelope: JSON.stringify({ version: '1.0.0', agents: [], lastUpdated: 'untrusted' }), wrong_format: JSON.stringify({ version: '2.0.0', agents: [] }),
  trailing_comma: '{"version":"1.0.0","agents":[],}', extra_token: '{"version":"1.0.0","agents":[]}true', nonfinite_number: '{"version":"1.0.0","agents":[],"unknown":1e999}' })) {
  test(`catalog envelope rejects ${name}`, () => {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content }), invalid());
  });
}

const budgets: readonly Readonly<{ name: string; content: string; limits: Partial<AcpRegistryLimits>; code?: string }>[] = [
  { name: 'bytes', content: catalogContent(), limits: { maxSnapshotBytes: 10 }, code: 'byte_limit' },
  { name: 'utf8_bytes', content: catalogContent([catalogAgent({ description: '😀'.repeat(100) })]), limits: { maxSnapshotBytes: 500 }, code: 'byte_limit' },
  { name: 'entries', content: catalogContent([catalogAgent(), catalogAgent({ id: 'second' })]), limits: { maxEntries: 1 } },
  { name: 'depth', content: catalogContent(), limits: { maxDepth: 2 }, code: 'depth_limit' },
  { name: 'values', content: catalogContent(), limits: { maxValues: 2 }, code: 'value_limit' },
  { name: 'strings', content: catalogContent([catalogAgent({ description: 'x'.repeat(65) })]), limits: { maxStringBytes: 64 }, code: 'string_limit' },
  { name: 'args', content: catalogContent([catalogAgent({ distribution: { npx: { package: 'fixture-agent', args: ['first', 'second'] } } })]), limits: { maxArgs: 1 } },
  { name: 'environment', content: catalogContent([catalogAgent({ distribution: { npx: { package: 'fixture-agent', env: { FIRST: '1', SECOND: '2' } } } })]), limits: { maxEnvEntries: 1 } },
];
for (const budget of budgets) test(`catalog ${budget.name} budget fails explicitly`, () => {
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: budget.content, limits: budget.limits }), invalid(budget.code));
});

test('UTF-8 bytes reject invalid encoding while a BOM is retained in raw provenance', () => {
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: new Uint8Array([0xC0, 0xAF]) }), invalid('invalid_utf8'));
  const content = `\uFEFF${catalogContent()}`;
  const snapshot = parseAcpRegistrySnapshot({ source: catalogSource, content: new TextEncoder().encode(content) });
  assert.equal(snapshot.rawDigest, `sha256:${createHash('sha256').update(content).digest('hex')}`);
});

for (const url of ['javascript:alert(1)', 'file:///tmp/agent', 'https://user:secret@example.com/agent', 'https://@example.com/agent',
  'https://example.com/agent#fragment', 'https://example.com/agent#', 'https:example.com/agent', 'https://example.com/agent%00', 'https://example.com\\agent', 'https://example.com/bad%escape']) {
  test(`unsafe catalog URL ${JSON.stringify(url)} rejects without interpreting it`, () => {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent({ distribution: {
      binary: { 'linux-x86_64': { archive: url, cmd: './agent' } },
    } })]) }), invalid('unsafe_url'));
  });
}

for (const executable of ['../agent', 'bin/../agent', '/agent', 'C:\\agent.exe', 'C:agent.exe', '\\\\server\\agent.exe', 'bin//agent', 'bin/agent.', 'agent\0']) {
  test(`unsafe binary payload path ${JSON.stringify(executable)} rejects`, () => {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent({ distribution: {
      binary: { 'windows-x86_64': { archive: 'https://example.com/agent.zip', cmd: executable } },
    } })]) }), invalid());
  });
}

test('malformed package, argv and environment data cannot become literal launch metadata', () => {
  for (const packageName of ['https://example.com/agent.tgz', '../agent', '--install', 'git+https://example.com/agent', 'agent;touch']) {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent({ distribution: { npx: { package: packageName } } })]) }), invalid('unsafe_package'));
  }
  for (const launch of [{ args: ['safe', 'unsafe\0'] }, { env: { 'BAD=NAME': 'value' } }, { env: { SAFE: 'unsafe\0' } }]) {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent({ distribution: { npx: { package: 'agent', ...launch } } })]) }), invalid());
  }
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent([catalogAgent({ distribution: {
    binary: { 'windows-x86_64': { archive: 'https://example.com/agent.zip', cmd: 'agent.exe', env: { PATH: 'first', Path: 'second' } } },
  } })]) }), invalid('ambiguous_environment'));
});

test('parser source and limit descriptors reject unsupported profiles and accessors before reading caller code', () => {
  for (const source of [{ ...catalogSource, profile: 'unpublished' }, { ...catalogSource, namespace: '../outside' },
    { ...catalogSource, kind: 'remote', location: 'https://user:secret@example.com/registry.json' }, { ...catalogSource, extra: 'authority' }]) {
    assert.throws(() => parseAcpRegistrySnapshot({ source: source as AcpRegistrySource, content: catalogContent() }), invalid());
  }
  let invoked = false;
  const source = { ...catalogSource };
  Object.defineProperty(source, 'location', { enumerable: true, get() { invoked = true; return 'fixture:unsafe'; } });
  assert.throws(() => parseAcpRegistrySnapshot({ source, content: catalogContent() }), invalid('invalid_json_value'));
  assert.equal(invoked, false);
  const switchingSource = new Proxy({ ...catalogSource }, { get(target, key, receiver) {
    return key === 'location' ? 'fixture:replaced-after-validation' : Reflect.get(target, key, receiver);
  } });
  assert.equal(parseAcpRegistrySnapshot({ source: switchingSource, content: catalogContent() }).source.location, catalogSource.location);
  for (const limits of [{ maxDepth: Number.POSITIVE_INFINITY }, { maxArgs: -1 }, { unknown: 1 }]) {
    assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent(), limits: limits as Partial<AcpRegistryLimits> }), invalid('invalid_limits'));
  }
});

test('a caller limit cannot change between validation and enforcement', () => {
  const limits = new Proxy({ maxSnapshotBytes: 10 }, { get(target, key, receiver) {
    return key === 'maxSnapshotBytes' ? Number.POSITIVE_INFINITY : Reflect.get(target, key, receiver);
  } });
  assert.throws(() => parseAcpRegistrySnapshot({ source: catalogSource, content: catalogContent(), limits }), invalid('byte_limit'));
});
