import assert from 'node:assert/strict';
import { within } from '../../../native/configuration.mjs';
import { captureData, physicalPath } from '../input.mjs';
import { filesystem, network } from '../manifest.mjs';
import { boundedText, imageDigest, integer, keys, resources, sha256, temporaryBytes, user } from '../validation.mjs';
import { concurrencyCase, concurrencyCompositions } from './cases.mjs';
import { concurrencyScenarioBudget } from './budget.mjs';

export function parseConcurrencyManifest(input, { platform, platformInput, consumer, output }) {
  const value = captureData(input);
  keys(value, ['format', 'platformManifestSha256', 'profile', 'row', 'workload', 'limits', 'filesystem', 'network', 'concurrency']);
  assert.equal(value.format, 'agenai.sandbox-platform-capabilities.v1');
  assert.equal(value.row, 'desktop-concurrency');
  assert(platform.profile !== 'linux-x64', 'desktop-concurrency requires an admitted native Darwin Desktop controller.');
  assert.equal(value.profile, platform.profile); sha256(value.platformManifestSha256);
  assert.equal(value.platformManifestSha256, platformInput.sha256, 'Concurrency manifest baseline differs from captured platform bytes.');
  keys(value.workload, ['user', 'resources', 'temporaryBytes']); user(value.workload.user);
  resources(value.workload.resources); temporaryBytes(value.workload.temporaryBytes);
  keys(value.limits, ['startupMs', 'requestMs', 'cleanupMs', 'scenarioMs', 'maxOutputBytes']);
  for (const [field, minimum, maximum] of [['startupMs', 1000, 120_000], ['requestMs', 1000, 30_000],
    ['cleanupMs', 1000, 60_000], ['scenarioMs', 60_000, 900_000], ['maxOutputBytes', 65_536, 4_194_304]]) {
    integer(value.limits[field], minimum, maximum, field);
  }
  assert(value.limits.scenarioMs > value.limits.startupMs + value.limits.requestMs + value.limits.cleanupMs);
  filesystem(value.filesystem, value.limits); network(value.network, platform, value.limits);
  const selected = value.concurrency;
  keys(selected, ['composition', 'members', 'caseId', 'helper', 'vmPreparation', 'evidence', 'machine']);
  assert(Object.hasOwn(concurrencyCompositions, selected.composition), 'An exact two-member Desktop composition is required.');
  concurrencyCase(selected.caseId);
  assert(Array.isArray(selected.members) && selected.members.length === 2, 'Exactly two member image/profile inputs are required.');
  selected.members.forEach((member, index) => {
    keys(member, ['label', 'profile', 'imageDigest', 'positive']);
    assert.equal(member.label, index === 0 ? 'a' : 'b');
    assert.equal(member.profile, concurrencyCompositions[selected.composition][index]); imageDigest(member.imageDigest);
    // The same mature network validator owns endpoint, allowlist and marker syntax for both members.
    network({ ...value.network, positive: member.positive,
      routeAuthority: { ...value.network.routeAuthority, profile: member.profile } }, { ...platform, profile: member.profile }, value.limits);
  });
  assert.equal(selected.members[0].imageDigest, platform.sourceImage, 'Baseline source image must be the selected A image.');
  assert.equal(selected.members[0].profile, platform.profile, 'Baseline profile must be the selected A profile.');
  assert.notEqual(selected.members[0].positive.hostname, selected.members[1].positive.hostname,
    'Separate positive destinations are mandatory; coordinated policies must never union destinations.');
  assert.deepEqual(selected.members[0].positive, value.network.positive);
  keys(selected.helper, ['protocol', 'executable', 'sourceDigest']);
  assert.equal(selected.helper.protocol, 'agenai.desktop-coordinator.v1'); imageDigest(selected.helper.sourceDigest);
  keys(selected.helper.executable, ['path', 'sha256']); physicalPath(selected.helper.executable.path); sha256(selected.helper.executable.sha256);
  keys(selected.vmPreparation, ['path', 'sha256']); physicalPath(selected.vmPreparation.path); sha256(selected.vmPreparation.sha256);
  for (const path of [selected.helper.executable.path, selected.vmPreparation.path, value.network.routeAuthority.hostObserver.executable.path]) {
    for (const root of [consumer, output]) assert(!within(path, root), 'Prepared native authority must exist outside the consumer and attempt output.');
  }
  keys(selected.evidence, ['maxAttemptBytes', 'maxResponseBytes', 'maxEngineNetworks']);
  integer(selected.evidence.maxAttemptBytes, 64 * 1024 ** 2, 128 * 1024 ** 3, 'maxAttemptBytes');
  integer(selected.evidence.maxResponseBytes, value.network.routeAuthority.maxOutputBytes, 4 * 1024 ** 2, 'maxResponseBytes');
  integer(selected.evidence.maxEngineNetworks, 3, 128, 'maxEngineNetworks');
  keys(selected.machine, ['minimumAvailableMemoryBytes', 'maximumLoadAverage']);
  integer(selected.machine.minimumAvailableMemoryBytes, 256 * 1024 ** 2, 32 * 1024 ** 3, 'minimumAvailableMemoryBytes');
  assert(typeof selected.machine.maximumLoadAverage === 'number' && selected.machine.maximumLoadAverage >= 1
    && selected.machine.maximumLoadAverage <= 128, 'Explicit bounded machine load ceiling required.');
  boundedText(selected.caseId, 1, 80, 'caseId');
  concurrencyScenarioBudget(value);
  return value;
}
