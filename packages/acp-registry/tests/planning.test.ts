import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpRegistryValidationError, createAcpInstallPlan, type AcpRegistrySnapshot, type CreateAcpInstallPlanInput } from '../src/index.js';
import { catalogSource } from './fixtures/catalog/index.js';
import { artifactDigest, binaryDistribution, dependencyDigest, digestText, lockedResolution, packagePlanningInput,
  planningInput, planningPolicy, planningSnapshot } from './planning.fixture.js';

const issue = (code: string) => (error: unknown) => error instanceof AcpRegistryValidationError && error.issues.some((item) => item.code === code);

test('a pure binary plan fixes provenance, literal launch and policy in a deterministic detached frozen value', () => {
  const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ env: { ACP_FIXTURE: 'literal$HOME' } }) } });
  const input = planningInput(snapshot, { policy: planningPolicy({ allowedEnvironmentKeys: ['ACP_FIXTURE', 'Z_UNUSED'], allowedOrigins: ['https://fixtures.example.test', 'https://other.example.test'] }) });
  const plan = createAcpInstallPlan(snapshot, input);
  assert.deepEqual(plan.launch, { kind: 'binary', executable: 'bin/agent', args: ['--acp', 'literal;$(never-execute)'], env: { ACP_FIXTURE: 'literal$HOME' }, shell: false });
  assert.equal(plan.snapshotDigest, snapshot.digest);
  assert.equal(plan.rawSnapshotDigest, snapshot.rawDigest);
  assert.equal(plan.entry.version, '2026.10.01');
  assert.deepEqual(plan.expectedIntegrity, { source: 'catalog', sha256: artifactDigest });
  assert.equal(plan.reproducibility.classification, 'pinned-binary');
  assert.equal(plan.reproducibility.verified, false);
  assert.equal(createAcpInstallPlan(JSON.parse(JSON.stringify(snapshot)), JSON.parse(JSON.stringify(input))).digest, plan.digest);
  assert.equal(createAcpInstallPlan(snapshot, { ...input, policy: { ...input.policy,
    allowedOrigins: [...input.policy.allowedOrigins].reverse(), allowedEnvironmentKeys: [...input.policy.allowedEnvironmentKeys].reverse() } }).digest, plan.digest);
  assert.equal(Object.isFrozen(plan.launch.args), true);
  assert.throws(() => { (plan.launch.env as Record<string, string>).ACP_FIXTURE = 'mutated'; }, TypeError);
  (input.policy.allowedEnvironmentKeys as string[]).push('OTHER_KEY');
  assert.deepEqual(plan.policy.allowedEnvironmentKeys, ['ACP_FIXTURE', 'Z_UNUSED']);
  assert.notEqual(createAcpInstallPlan(snapshot, input).digest, plan.digest);
});

test('caller snapshot/entry pins and source-qualified identity prevent stale or cross-source selection', () => {
  const snapshot = planningSnapshot();
  const input = planningInput(snapshot);
  assert.throws(() => createAcpInstallPlan(snapshot, { ...input, expectedSnapshotDigest: dependencyDigest }), issue('acp_registry_snapshot_stale'));
  assert.throws(() => createAcpInstallPlan(snapshot, { ...input, expectedEntryDigest: dependencyDigest }), issue('acp_registry_entry_stale'));
  const anotherSource = planningSnapshot(undefined, { ...catalogSource, location: 'fixture:other-origin' });
  assert.throws(() => createAcpInstallPlan(anotherSource, { ...planningInput(anotherSource), entryIdentity: input.entryIdentity }), issue('acp_registry_entry_not_found'));
  assert.notEqual(createAcpInstallPlan(anotherSource, planningInput(anotherSource)).digest, createAcpInstallPlan(snapshot, input).digest);
});

test('expected artifact integrity is distinct from permissive later measurement and conflicting expectations fail', () => {
  const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ sha256: undefined }) } });
  assert.throws(() => createAcpInstallPlan(snapshot, planningInput(snapshot)), issue('acp_registry_integrity_required'));
  const weaker = createAcpInstallPlan(snapshot, planningInput(snapshot, { policy: planningPolicy({ integrity: 'allow-missing-expected-sha256', reproducibility: 'best-effort' }) }));
  assert.deepEqual(weaker.expectedIntegrity, { source: 'none' });
  assert.deepEqual(weaker.reproducibility.gaps, ['expected-sha256-missing']);
  assert.equal(weaker.reproducibility.verified, false);
  assert.throws(() => createAcpInstallPlan(snapshot, planningInput(snapshot, { policy: planningPolicy({ integrity: 'allow-missing-expected-sha256' }) })), issue('acp_registry_reproducibility_incomplete'));
  const supplied = createAcpInstallPlan(snapshot, planningInput(snapshot, { binaryIntegrity: { sha256: artifactDigest, evidence: { kind: 'artifact-inspection', digest: dependencyDigest } } }));
  assert.equal(supplied.expectedIntegrity.source, 'caller');
  const pinned = planningSnapshot();
  assert.throws(() => createAcpInstallPlan(pinned, planningInput(pinned, { binaryIntegrity: { sha256: dependencyDigest, evidence: { kind: 'artifact-inspection', digest: dependencyDigest } } })), issue('acp_registry_integrity_conflict'));
});

for (const kind of ['npx', 'uvx'] as const) {
  test(`${kind} exact top-level resolution never infers an agent release or proves the dependency closure`, () => {
    const snapshot = planningSnapshot({ [kind]: { package: kind === 'npx' ? 'fixture-agent@1.2.3' : 'fixture-agent==1.2.3' } });
    const input = packagePlanningInput(snapshot, kind);
    const plan = createAcpInstallPlan(snapshot, input);
    assert.equal(plan.entry.version, '2026.10.01');
    assert.equal(plan.packageResolution?.version, '1.2.3');
    assert.equal(plan.launch.executable, 'fixture-agent');
    assert.deepEqual(plan.reproducibility.gaps, ['dependency-closure-missing']);
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, policy: planningPolicy() }), issue('acp_registry_reproducibility_incomplete'));
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, packageResolution: { ...input.packageResolution!, version: '2.0.0' } }), issue('acp_registry_package_resolution_invalid'));
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, toolchains: [] }), issue('acp_registry_toolchain_required'));
  });

  for (const selector of ['fixture-agent', 'fixture-agent@latest']) {
    test(`${kind} mutable selector ${selector} needs independent exact resolution evidence`, () => {
      const snapshot = planningSnapshot({ [kind]: { package: selector } });
      const input = packagePlanningInput(snapshot, kind);
      assert.throws(() => createAcpInstallPlan(snapshot, input), issue('acp_registry_package_resolution_required'));
      const plan = createAcpInstallPlan(snapshot, { ...input, packageResolution: { ...input.packageResolution!, evidence: { kind: 'registry-metadata', digest: dependencyDigest } } });
      assert.equal(plan.packageResolution?.version, '1.2.3');
      assert.equal(plan.distribution.kind === 'binary' ? undefined : plan.distribution.package, selector);
    });
  }

  test(`${kind} strict locked inputs bind exact lock bytes and declared dependencies with verification pending`, () => {
    const snapshot = planningSnapshot({ [kind]: { package: kind === 'npx' ? 'fixture-agent@1.2.3' : 'fixture-agent==1.2.3' } });
    const resolution = lockedResolution(kind);
    const input = packagePlanningInput(snapshot, kind, { packageResolution: resolution, policy: planningPolicy() });
    const plan = createAcpInstallPlan(snapshot, input);
    assert.equal(plan.reproducibility.classification, 'locked-package-inputs');
    assert.equal(plan.reproducibility.verified, false);
    assert.deepEqual(plan.reproducibility.gaps, []);
    assert.ok(plan.verificationObligations.includes('dependency-closure'));
    assert.ok(plan.verificationObligations.includes('lock-artifact-integrity'));
    assert.equal(plan.packageResolution?.dependencyLock?.content, resolution.dependencyLock?.content);
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, policy: planningPolicy({ packageScripts: 'allow' }) }), issue('acp_registry_reproducibility_incomplete'));
    const lock = resolution.dependencyLock!;
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, packageResolution: { ...resolution, dependencyLock: { ...lock, digest: dependencyDigest } } }), issue('acp_registry_package_lock_invalid'));
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, packageResolution: { ...resolution, dependencyLock: { ...lock, packages: lock.packages.slice(0, 1) } } }), issue('acp_registry_package_lock_invalid'));
  });
}

test('lock profiles reject ambiguous or unsupported installer semantics before creating an install plan', () => {
  for (const kind of ['npx', 'uvx'] as const) {
    const snapshot = planningSnapshot({ [kind]: { package: kind === 'npx' ? 'fixture-agent@1.2.3' : 'fixture-agent==1.2.3' } });
    const resolution = lockedResolution(kind);
    const lock = resolution.dependencyLock!;
    const content = kind === 'npx' ? lock.content.replace('"lockfileVersion":3', '"lockfileVersion":2,"lockfileVersion":3')
      : lock.content.replace('fixture-agent==1.2.3', 'fixture-agent[unapproved-extra]==1.2.3');
    const input = packagePlanningInput(snapshot, kind, { packageResolution: { ...resolution, dependencyLock: { ...lock, content, digest: digestText(content) } }, policy: planningPolicy() });
    assert.throws(() => createAcpInstallPlan(snapshot, input), kind === 'npx' ? issue('duplicate_key') : issue('acp_registry_package_lock_invalid'));
  }
});

test('range metadata is searchable but planning never mistakes an evidence digest for qualified range resolution', () => {
  for (const [kind, selector] of [['npx', 'fixture-agent@^2.0.0'], ['npx', 'fixture-agent@2'], ['uvx', 'fixture-agent>=2.0,<3.0']] as const) {
    const snapshot = planningSnapshot({ [kind]: { package: selector } });
    const input = packagePlanningInput(snapshot, kind);
    assert.throws(() => createAcpInstallPlan(snapshot, { ...input, packageResolution: { ...input.packageResolution!, evidence: { kind: 'registry-metadata', digest: dependencyDigest } } }), issue('acp_registry_package_selector_unsupported'));
  }
});

test('network and launch environment require explicit policy without granting runtime or installer plumbing', () => {
  for (const env of [{ ACP_UNAPPROVED: 'value' }, { NODE_OPTIONS: '--import=/unapproved.js' }, { PATH: '/unapproved' }, { npm_config_registry: 'https://other.example.test' }]) {
    const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ env }) } });
    assert.throws(() => createAcpInstallPlan(snapshot, planningInput(snapshot)), issue('acp_registry_plan_environment_denied'));
  }
  const snapshot = planningSnapshot();
  assert.throws(() => createAcpInstallPlan(snapshot, planningInput(snapshot, { policy: planningPolicy({ allowedOrigins: ['https://other.example.test'] }) })), issue('acp_registry_plan_network_denied'));
  const insecure = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ archive: 'http://127.0.0.1:8080/fixture.tar.gz' }) } });
  assert.throws(() => createAcpInstallPlan(insecure, planningInput(insecure)), issue('acp_registry_plan_network_denied'));
  assert.equal(createAcpInstallPlan(insecure, planningInput(insecure, { policy: planningPolicy({ allowInsecureHttp: true, allowedOrigins: ['http://127.0.0.1:8080'] }) })).launch.shell, false);
});

test('retained metadata and planner options reject forged digests, non-data values and unknown properties without invoking getters', () => {
  const snapshot = planningSnapshot();
  const input = planningInput(snapshot);
  const changed = JSON.parse(JSON.stringify(snapshot));
  changed.entries[0].name = 'Unpinned changed metadata';
  const unknown = { ...snapshot, unknown: true };
  const cycle: Record<string, unknown> = { ...snapshot }; cycle.self = cycle;
  let getterCalls = 0;
  const accessor = { ...snapshot };
  Object.defineProperty(accessor, 'entries', { enumerable: true, get() { getterCalls += 1; return snapshot.entries; } });
  const symbol = { ...snapshot, [Symbol('authority')]: true };
  for (const invalid of [changed, unknown, cycle, accessor, symbol, { ...snapshot, source: new Date() }]) {
    assert.throws(() => createAcpInstallPlan(invalid as AcpRegistrySnapshot, input), AcpRegistryValidationError);
  }
  for (const invalid of [{ ...input, install: () => {} }, { ...input, toolchains: new Date() }, { ...input, unknown: true }]) {
    assert.throws(() => createAcpInstallPlan(snapshot, invalid as CreateAcpInstallPlanInput), AcpRegistryValidationError);
  }
  const options = { ...input };
  Object.defineProperty(options, 'target', { enumerable: true, get() { getterCalls += 1; return 'linux-x86_64'; } });
  assert.throws(() => createAcpInstallPlan(snapshot, options), AcpRegistryValidationError);
  assert.equal(getterCalls, 0);
});

test('planning derives launch values from the same detached metadata whose digests were validated', () => {
  const snapshot = planningSnapshot();
  const retained = JSON.parse(JSON.stringify(snapshot));
  let reads = 0;
  retained.entries[0] = new Proxy(retained.entries[0], { get(target, key, receiver) {
    if (key === 'distributions' && ++reads >= 3) return [{ ...target.distributions[0], args: ['--unpinned-replacement'] }];
    return Reflect.get(target, key, receiver);
  } });
  const plan = createAcpInstallPlan(retained, planningInput(snapshot));
  assert.deepEqual(plan.launch.args, ['--acp', 'literal;$(never-execute)']);
  assert.equal(plan.entry.digest, snapshot.entries[0]!.digest);
  assert.equal(plan.snapshotDigest, snapshot.digest);
});

test('an npm lock cannot contradict an exact dependency requirement while retaining otherwise valid declared artifacts', () => {
  const snapshot = planningSnapshot({ npx: { package: 'fixture-agent@1.2.3' } });
  const resolution = lockedResolution('npx');
  const lock = resolution.dependencyLock!;
  const content = lock.content.replace('"dependency":"^4.0.0"', '"dependency":"9.9.9"');
  const input = packagePlanningInput(snapshot, 'npx', { policy: planningPolicy(),
    packageResolution: { ...resolution, dependencyLock: { ...lock, content, digest: digestText(content) } } });
  assert.throws(() => createAcpInstallPlan(snapshot, input), issue('acp_registry_package_lock_invalid'));
});

test('binary decoding format is explicit for ambiguous sources and bound into the immutable plan', () => {
  const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ archive: 'https://fixtures.example.test/agent' }) } });
  const input = planningInput(snapshot);
  assert.throws(() => createAcpInstallPlan(snapshot, input), issue('acp_registry_binary_format_required'));
  const raw = createAcpInstallPlan(snapshot, { ...input, binaryFormat: 'raw' });
  const zip = createAcpInstallPlan(snapshot, { ...input, binaryFormat: 'zip' });
  assert.notEqual(raw.digest, zip.digest);
  const knownArchive = planningSnapshot();
  assert.throws(() => createAcpInstallPlan(knownArchive, { ...planningInput(knownArchive), binaryFormat: 'raw' }), issue('acp_registry_binary_format_unsupported'));
  const systemPackage = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ archive: 'https://fixtures.example.test/agent.deb' }) } });
  assert.throws(() => createAcpInstallPlan(systemPackage, { ...planningInput(systemPackage), binaryFormat: 'raw' }), issue('acp_registry_binary_format_unsupported'));
});
