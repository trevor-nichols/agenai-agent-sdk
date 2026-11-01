import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encode, sha } from '../../coordinator/evidence.mjs';

export async function originalCut(directory) {
  const sdkOutput = join(directory, 'sdk'), handoffOutput = join(directory, 'handoff');
  await mkdir(sdkOutput); await mkdir(handoffOutput);
  const file = async (path, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(encode(value));
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return { path, bytes: bytes.length, sha256: sha(bytes) };
  };
  const generation = 'ed902f37-52eb-4af9-ae99-7b803ec740de', id = 'b'.repeat(64);
  const record = { format: 'agenai.sandbox-recovery.v3', backendId: 'docker', backendRevision: 'engine-1.52-v6-desktop-native-arm64',
    namespace: 'ms005-exploratory-original-b', operationId: '0546bb39-02df-49aa-ae63-9cf188ed8cc5',
    sandboxId: '3b5b159c-35a7-49e8-bdb7-bb359b4a89cd', imageDigest: `sha256:${'c'.repeat(64)}`,
    policyDigest: `sha256:${'d'.repeat(64)}`, configurationDigest: `sha256:${'e'.repeat(64)}`, phase: 'destroying',
    resources: [{ role: 'compute', name: 'ms005-exploratory-original-b-compute', identity: { kind: 'identified', id } }] };
  const canonicalPath = join(directory, 'canonical.state');
  const payload = Buffer.from(encode({ format: 'agenai.docker-desktop-coordinator.v1', engineKey: `sha256:${'a'.repeat(64)}`,
    daemonId: 'original-daemon', generation: { kind: 'dirty', identity: { generationId: generation },
      members: [{ memberId: record.operationId, checkpoint: { record }, roles: [{ role: 'compute', presence: { kind: 'present', id } }] }], retired: [] } }));
  const canonical = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${'a'.repeat(64)}\n${sha(payload)}\n`), payload]);
  const live = await file(canonicalPath, canonical), preserved = await file(join(sdkOutput, 'cut-canonical-original.bin'), canonical);
  const originalInput = await file(join(directory, 'original-input.json'), { output: sdkOutput,
    platform: { engine: 'unix:///original-owned-proxy.sock', profile: 'desktop-apple-virtualization-native-arm64' },
    capabilities: { network: { routeAuthority: { engine: { id: 'original-daemon' } } } },
    scenario: { kind: 'handoff', at: 'effect-response', canonicalPath, fault: { operation: 'delete', role: 'compute' } } });
  const checkpoint = await file(join(sdkOutput, 'b-record.json'), record), body = await file(join(sdkOutput, 'delete-body.bin'), Buffer.alloc(0));
  const retained = await file(join(sdkOutput, 'cut-report.json'), { format: 'agenai.desktop-coordinator-ms005-exploratory.v1',
    input: originalInput, scenario: { kind: 'handoff', at: 'effect-response', fault: { operation: 'delete', role: 'compute' } },
    coordinator: { generation }, engine: { id: 'original-daemon' }, socket: { endpoint: 'unix:///original-owned-proxy.sock' },
    members: [{ label: 'b', namespace: record.namespace, originalRecord: record }],
    handoff: { phase: 'response-before-delivery', canonical: live, preservedCanonical: preserved,
      members: [{ label: 'b', namespace: record.namespace, record: checkpoint }],
      receipt: { complete: true, failures: [], selected: { method: 'DELETE', target: `/v1.52/containers/${id}?force=true&v=false`, status: 204, body } } } });
  const exited = spawnSync(process.execPath, ['-e', ''], { env: { PATH: '/usr/bin:/bin' } }); assert.equal(exited.status, 0);
  await file(join(handoffOutput, 'report.json'), { format: 'agenai.ms005-owned-controller-crash-handoff.v2',
    status: 'original_controller_killed_exact_pending_cut_preserved', input: { path: originalInput.path, sha256: originalInput.sha256 },
    originalHelperExited: true, pid: exited.pid, originalHelper: { pid: exited.pid },
    barrier: { report: retained, generation, pending: { action: 'delete', role: 'compute' } } });
  return { originalInput, sdkOutput, handoffOutput, canonical, canonicalPath, retained };
}
