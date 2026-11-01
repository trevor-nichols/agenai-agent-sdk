// Original controller killed by the parent after the gateway owns its sole entered request.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activateBound } from './endpoint-binding.mjs';
import * as controller from './controller.mjs';
import { requestJson, sha256, writeReceipt } from './late-engine-transport.mjs';

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (manifest.mode !== 'explicit-run') throw new Error('requires_explicit_parent_fixture');
const { parseSandboxRecoveryRecord } = await import(new URL('../../../../../../../packages/ai/sandbox/dist/index.js', import.meta.url));
const identityReceipts = [];
const { owner, before } = await activateBound(controller, manifest.binary, manifest.endpoint, manifest.expected,
  { namespace: 'ms001-late-create-original', attemptId: manifest.attemptId, name: manifest.name, subnet: manifest.subnet }, identityReceipts);
const generation = owner.record.generation;
const original = parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'docker-engine',
  backendRevision: 'engine-1.52-v7-research-network-only', namespace: 'ms001-late-create',
  operationId: manifest.attemptId, sandboxId: `docker-${manifest.attemptId}`,
  imageDigest: `sha256:${'0'.repeat(64)}`, policyDigest: `sha256:${controller.digest({ networkOnly: true, internal: true })}`,
  configurationDigest: `sha256:${controller.digest({ generation, engine: manifest.expected.id, name: manifest.name, subnet: manifest.subnet })}`,
  phase: 'starting', authority: { kind: 'verified', backendIdentity: manifest.expected.id },
  resources: [{ role: 'network', name: manifest.name, identity: { kind: 'creating' } }] });
const body = { Name: manifest.name, CheckDuplicate: true, Driver: 'bridge', Internal: true,
  Attachable: false, EnableIPv4: true, EnableIPv6: false,
  IPAM: { Driver: 'default', Config: [{ Subnet: manifest.subnet, Gateway: manifest.gatewayAddress, IPRange: '' }] },
  Options: { 'com.docker.network.bridge.name': manifest.bridgeName },
  Labels: { 'ai.agen.research.attempt': manifest.attemptId, 'ai.agen.research.request': manifest.requestId,
    'ai.agen.research.generation': generation, 'ai.agen.research.member': controller.immutableMemberBinding(original) } };
const intent = { format: 'agenai.ms001-late-engine-intent.v1', requestId: manifest.requestId,
  generation, engineId: manifest.expected.id, endpointBinding: before, original, body,
  requestBodySha256: sha256(Buffer.from(JSON.stringify(body))),
  notice: 'Network-only research fixture; the zero image digest is not a workload image or SDK resource claim.' };
await owner.register(original);
await owner.begin(original, async (record) => {
  await writeReceipt(join(manifest.attempt, 'original-member-creating.json'), record);
  await writeReceipt(join(manifest.attempt, 'original-create-intent.json'), intent);
});
process.stdout.write(`${JSON.stringify({ generation, helperPid: owner.holder.child.pid, memberBinding: controller.immutableMemberBinding(original) })}\n`);
await owner.dispatch(async () => requestJson(manifest.gateway, 'POST', '/v1.52/networks/create', body, [],
  { 'X-AgenAI-Research-Request-Id': manifest.requestId }));
throw new Error('original_controller_unexpectedly_survived');
