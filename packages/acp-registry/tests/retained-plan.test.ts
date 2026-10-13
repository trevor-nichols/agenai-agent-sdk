import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcpInstallPlan, parseAcpInstallPlan, AcpRegistryValidationError } from '../src/index.js';
import { canonicalDigest } from '../src/shared/digest.js';
import { binaryDistribution, lockedResolution, packagePlanningInput, planningInput, planningSnapshot } from './planning.fixture.js';

test('retained binary and locked package plans survive detached JSON storage without granting verified installation status', () => {
  const binary = planningSnapshot();
  const plans = [createAcpInstallPlan(binary, planningInput(binary))];
  for (const kind of ['npx', 'uvx'] as const) {
    const snapshot = planningSnapshot({ [kind]: { package: kind === 'npx' ? 'fixture-agent@1.2.3' : 'fixture-agent==1.2.3' } });
    plans.push(createAcpInstallPlan(snapshot, { ...packagePlanningInput(snapshot, kind), packageResolution: lockedResolution(kind) }));
  }
  for (const plan of plans) {
    const retained = parseAcpInstallPlan(JSON.parse(JSON.stringify(plan)), plan.digest);
    assert.deepEqual(retained, plan);
    assert.equal(Object.isFrozen(retained.distribution), true);
    assert.equal(retained.reproducibility.verified, false);
  }
});

test('a caller pin and recomputed semantics reject retained launch, policy and evidence forgery even with a matching self-computed digest', () => {
  const snapshot = planningSnapshot();
  const plan = createAcpInstallPlan(snapshot, planningInput(snapshot));
  for (const mutate of [
    (value: any) => { value.launch.executable = '../escaped'; },
    (value: any) => { value.launch.shell = true; },
    (value: any) => { value.reproducibility.verified = true; },
    (value: any) => { value.verificationObligations = []; },
    (value: any) => { value.distribution.executable = '../escaped'; },
    (value: any) => { value.entry.identity = 'another-source/agent'; },
  ]) {
    const value = JSON.parse(JSON.stringify(plan));
    mutate(value);
    const { digest: _digest, ...body } = value;
    value.digest = canonicalDigest(body);
    assert.throws(() => parseAcpInstallPlan(value, plan.digest), AcpRegistryValidationError);
    assert.throws(() => parseAcpInstallPlan(value, value.digest), AcpRegistryValidationError);
  }
});

test('retained caller-supplied artifact integrity remains independently evidenced', () => {
  const snapshot = planningSnapshot({ binary: { 'linux-x86_64': binaryDistribution({ sha256: undefined }) } });
  const plan = createAcpInstallPlan(snapshot, planningInput(snapshot, { binaryIntegrity: { sha256: `sha256:${'a'.repeat(64)}`,
    evidence: { kind: 'artifact-inspection', digest: `sha256:${'b'.repeat(64)}` } } }));
  assert.deepEqual(parseAcpInstallPlan(plan, plan.digest), plan);
});
