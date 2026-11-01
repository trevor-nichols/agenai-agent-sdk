import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha } from '../coordinator/evidence.mjs';
import { loadOriginalMembers } from './multi-input.mjs';

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-mi-'))); const engineKey = 'a'.repeat(64); const returnedId = 'b'.repeat(64);
  async function save(name, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); const path = join(directory, name);
    await writeFile(path, bytes); return { path, bytes: bytes.length, sha256: sha(bytes) };
  }
  const members = ['a', 'b'].map((label) => {
    const record = { format: 'agenai.sandbox-recovery.v3', backendId: 'agenai-docker', backendRevision: 'original-controller',
      namespace: `original-${label}`, operationId: `original-operation-${label}`, sandboxId: `original-sandbox-${label}`,
      imageDigest: `sha256:${'c'.repeat(64)}`, policyDigest: `sha256:${'d'.repeat(64)}`, configurationDigest: `sha256:${'e'.repeat(64)}`,
      phase: 'starting', authority: { kind: 'unverified' }, resources: [{ role: 'compute', name: `original-${label}-compute`, identity: { kind: 'creating' } }] };
    return { label, namespace: record.namespace, originalRecord: { ...record, phase: 'reserved',
      resources: record.resources.map((resource) => ({ ...resource, identity: { kind: 'planned' } })) }, record };
  });
  const config = { output: directory, platform: { profile: 'desktop-apple-virtualization-native-arm64', engine: 'unix:///original/socket' },
    capabilities: { network: { routeAuthority: { engine: { id: 'original-daemon' } } } } };
  const input = await save('native-input.json', config);
  const payload = Buffer.from(JSON.stringify({ format: 'agenai.docker-desktop-coordinator.v1', engineKey: `sha256:${engineKey}`,
    daemonId: 'original-daemon', generation: { kind: 'dirty', identity: { generationId: 'original-generation' }, retired: [],
      members: members.map((member) => ({ memberId: member.record.operationId, checkpoint: { record: member.record },
        roles: [{ role: 'compute', presence: { kind: 'possibly_present', returnedId: null } }] })) } }));
  const canonical = await save('canonical.bin', Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${engineKey}\n${sha(payload)}\n`), payload]));
  const selected = await save('original-response.bin', Buffer.from(` { "Id": "${returnedId}" }\n`));
  const handoffMembers = [];
  for (const member of members) handoffMembers.push({ label: member.label, namespace: member.namespace, record: await save(`${member.label}-record.json`, member.record) });
  const report = { format: 'agenai.desktop-coordinator-ms005-exploratory.v1', input,
    scenario: { kind: 'lost-ack', fault: { operation: 'create', role: 'compute' } },
    engine: { id: 'original-daemon' }, socket: { endpoint: config.platform.engine }, coordinator: { generation: 'original-generation' },
    members: members.map(({ record: _, ...member }) => member), handoff: { phase: 'lost-ack-delivered',
      canonical, preservedCanonical: canonical, members: handoffMembers,
      receipt: { complete: true, failures: [], transportErrorIssued: true, transportErrorBeforeOriginalClose: true, selected: { status: 201, body: selected,
        target: '/v1.52/containers/create?name=original-b-compute' } } } };
  const originalReport = await save('handoff-report.json', report);
  return { directory, config, report, canonical, returnedId, nativeInput: input,
    input: { originalInput: input.path, originalReport: originalReport.path, canonical: canonical.path }, save };
}

test('multi-member recovery retains original creating checkpoints while independently bounding the actual lost create ID', async () => {
  const owned = await fixture();
  try {
    const loaded = await loadOriginalMembers(owned.input);
    assert.equal(loaded.members.length, 2); assert.equal(loaded.members[1].record.resources[0].identity.kind, 'creating');
    assert.equal(loaded.observed[1].resources[0].identity.id, owned.returnedId);
    assert.notEqual(loaded.members[1].record.resources[0], loaded.observed[1].resources[0]);
    const original = JSON.parse(await readFile(loaded.members[1].checkpoint.identity.path, 'utf8'));
    assert.deepEqual(loaded.members[1].record, original);
    assert.equal(sha(await readFile(owned.canonical.path)), owned.canonical.sha256);
  } finally { await rm(owned.directory, { recursive: true }); }
});

test('substituting a member checkpoint or complete original mutation response conflicts before a cleanup inventory is returned', async () => {
  const owned = await fixture();
  try {
    const selected = owned.report.handoff.receipt.selected.body;
    await writeFile(selected.path, JSON.stringify({ Id: 'f'.repeat(64) }));
    await assert.rejects(loadOriginalMembers(owned.input));
    assert.equal(sha(await readFile(owned.canonical.path)), owned.canonical.sha256);
  } finally { await rm(owned.directory, { recursive: true }); }
});
