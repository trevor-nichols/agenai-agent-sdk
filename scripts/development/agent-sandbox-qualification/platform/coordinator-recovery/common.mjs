import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolute, sha } from '../coordinator/evidence.mjs';
import { parseCanonicalEnvelope } from './canonical.mjs';

export async function originalBytes(path, maximum) {
  absolute(path); assert.equal(await realpath(path), path, 'Original evidence must select a physical file.');
  const before = await lstat(path, { bigint: true }); assert(before.isFile() && before.size <= BigInt(maximum));
  const bytes = await readFile(path); assert(bytes.length <= maximum);
  const after = await lstat(path, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], 'Original evidence changed during its bounded read.');
  return { bytes, identity: { path, bytes: bytes.length, sha256: sha(bytes) } };
}

export async function originalFile(path, maximum) {
  const selected = await originalBytes(path, maximum);
  return { ...selected, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(selected.bytes)) };
}

export async function originalCanonical(path) {
  const selected = await originalBytes(path, 4 * 1024 ** 2);
  return { ...selected, ...parseCanonicalEnvelope(selected.bytes) };
}

export async function loadOriginal(input) {
  const originalInput = await originalFile(input.originalInput, 1024 ** 2);
  const retained = await originalFile(input.retainedReport, 4 * 1024 ** 2);
  const checkpoint = await originalFile(input.checkpoint, 65_536);
  const config = originalInput.value; const report = retained.value; const record = checkpoint.value;
  assert.equal(report.format, 'agenai.desktop-coordinator-ms004-exploratory.v1');
  assert.equal(report.input.path, input.originalInput); assert.equal(report.input.sha256, originalInput.identity.sha256);
  assert.equal(report.input.bytes, originalInput.identity.bytes); assert.equal(dirname(input.retainedReport), config.output);
  assert.equal(report.status, 'retained_cleanup');
  assert.equal(report.members.length, 1, 'This prerequisite qualifies the single original r1 member only.');
  const member = report.members[0];
  assert.equal(member.label, 'a'); assert.equal(member.namespace, record.namespace);
  const stored = member.checkpoints.find((entry) => entry.path === input.checkpoint); assert(stored);
  assert.equal(stored.sha256, checkpoint.identity.sha256); assert.equal(stored.bytes, checkpoint.identity.bytes);
  assert.equal(record.operationId, member.originalRecord.operationId); assert.equal(record.sandboxId, member.originalRecord.sandboxId);
  assert(record.resources.some((entry) => entry.identity.kind === 'identified'));
  assert.equal(config.platform.engine, report.socket.endpoint);
  assert.equal(config.capabilities.network.routeAuthority.engine.id, report.engine.id);
  assert.equal(config.platform.profile, 'desktop-apple-virtualization-native-arm64');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, config.platform.expected.controller.nodeVersion);
  assert.match(report.coordinator.generation, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  return { originalInput, retained, checkpoint, config, report, record, member, generation: report.coordinator.generation };
}

export function compareMemberInventory(canonical, original) {
  for (const key of ['format', 'backendId', 'backendRevision', 'namespace', 'operationId', 'sandboxId', 'imageDigest', 'policyDigest', 'configurationDigest']) {
    assert.deepEqual(canonical[key], original[key], `Canonical member differs from original ${key}.`);
  }
  assert.deepEqual(canonical.resources.map(({ role, name }) => ({ role, name })), original.resources.map(({ role, name }) => ({ role, name })));
  for (const resource of canonical.resources) {
    const captured = original.resources.find((entry) => entry.role === resource.role);
    if (resource.identity.kind === 'identified' && captured.identity.kind === 'identified') {
      assert.deepEqual(resource.identity, captured.identity, 'Canonical acquired identity conflicts with the exact original checkpoint.');
    }
  }
}

export function memberConfiguration(original, node, selected = original) {
  const routeAuthority = node.createDockerDesktopRouteAuthority(original.config.capabilities.network.routeAuthority);
  return { endpoint: original.config.platform.engine, profile: original.config.platform.profile, namespace: selected.record.namespace,
    spillDirectory: join(original.config.output, selected.member.label, 'spill'), imageDigest: original.config.platform.sourceImage,
    user: original.config.capabilities.workload.user, filesystem: original.config.capabilities.filesystem.configuration,
    egress: { ...original.config.capabilities.network.egress.configuration, routeAuthority } };
}

export async function exactAbsence(engine, records) {
  const result = []; const seen = new Set();
  for (const record of records) for (const resource of record.resources) {
    const references = resource.identity.kind === 'identified' ? [resource.name, resource.identity.id] : [resource.name];
    for (const reference of references) {
      const kind = resource.role === 'network' ? 'networks' : resource.role === 'storage' || resource.role === 'egress_socket' ? 'volumes' : 'containers';
      const path = `/${kind}/${encodeURIComponent(reference)}${kind === 'containers' ? '/json' : ''}`;
      if (seen.has(path)) continue; seen.add(path);
      const observed = await engine.request('GET', path, undefined, { allowed: [404] });
      result.push({ role: resource.role, originalName: resource.name, reference, status: observed.status });
    }
  }
  return result;
}

export async function engineInventory(engine) {
  const info = (await engine.request('GET', '/info')).data;
  const containers = (await engine.request('GET', '/containers/json?all=1')).data;
  const volumes = (await engine.request('GET', '/volumes')).data.Volumes ?? [];
  const networks = (await engine.request('GET', '/networks')).data;
  assert(containers.length <= 4096 && volumes.length <= 4096 && networks.length <= 128);
  return { daemonId: info.ID, containers: containers.map(({ Id }) => Id).sort(), volumes: volumes.map(({ Name }) => Name).sort(),
    networks: networks.map(({ Id }) => Id).sort() };
}

export function compareEngineInventory(before, after, original) {
  assert.equal(after.daemonId, before.daemonId);
  const records = Array.isArray(original) ? original : [original];
  for (const [key, roles] of [['containers', ['compute', 'export', 'filesystem', 'route_observer', 'egress_broker', 'egress_relay']],
    ['volumes', ['storage', 'egress_socket']], ['networks', ['network']]]) {
    const owned = new Set(records.flatMap((record) => record.resources.filter((entry) => roles.includes(entry.role) && entry.identity.kind === 'identified').map((entry) => entry.identity.id)));
    assert(after[key].every((id) => before[key].includes(id)), 'Cleanup introduced a new Engine resource identity.');
    assert.deepEqual(after[key], before[key].filter((id) => !owned.has(id)), 'Cleanup changed an unrelated original Engine identity.');
  }
}

export async function freezeSources(evidence) {
  const files = ['controller.mjs', 'common.mjs', 'canonical.mjs', 'trace.mjs', 'process.mjs', 'multi-controller.mjs', 'multi-input.mjs', '../coordinator/evidence.mjs', '../coordinator/engine-capture.mjs',
    '../research/desktop-concurrency/native/installed.mjs', '../../engine.mjs', '../../scalability/identity.mjs',
    '../../scalability/configuration.mjs', '../../scalability/manifests.mjs', '../../native/configuration.mjs'];
  const result = [];
  for (const [index, name] of files.entries()) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert(bytes.length <= 1024 ** 2);
    result.push({ original: path, ...await evidence.file(`sources/${String(index).padStart(2, '0')}-${name.split('/').at(-1)}`, bytes, 1024 ** 2) });
  }
  return result;
}
