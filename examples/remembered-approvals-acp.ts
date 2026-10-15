import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import type { AcpPermissionMappingSelection } from '@agen-ai/provider-acp';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { runApprovalWalkthrough, selectDisplayedOption } from './fixtures/approval-walkthrough.js';

// This attestation is valid only for the inspected bundled peer, whose complete menu has no other effects.
// A real integration must independently qualify its initialized identity and every declared menu.
const permissionMapping: AcpPermissionMappingSelection = {
  mapping: 'declared-complete-consequences-v1',
  agentInfo: { name: 'remembered-approvals-example', version: '1.0.0' },
  menus: [{ toolKind: 'edit', options: [
    { optionId: 'native-allow-once', kind: 'allow_once' },
    { optionId: 'native-remember-allow', kind: 'allow_always' },
    { optionId: 'native-deny-once', kind: 'reject_once' },
    { optionId: 'native-remember-deny', kind: 'reject_always' },
  ] }],
};
const workingDirectory = await mkdtemp(join(tmpdir(), 'agent-sdk-remembered-acp-'));
const auditPath = join(workingDirectory, 'native-frames.jsonl');
try {
  const driver = createNodeAcpProviderDriver({
    providerKey: 'example-remembered-acp', permissionMapping,
    launch: { executable: await realpath(process.execPath),
      args: [fileURLToPath(new URL('./fixtures/remembered-approvals-peer.mjs', import.meta.url)), auditPath],
      cwd: workingDirectory, env: {}, shutdownTimeoutMs: 1_000 },
  });
  const instanceId = parseAgentInstanceId('remembered-acp:instance');
  const registry = await createAgentProviderRegistry({ drivers: [driver],
    definitions: [{ providerKey: driver.providerKey, instanceId, driverConfiguration: {} }] });
  const scenarios = [];
  try {
    const instance = registry.requireInstance(instanceId);
    for (const name of ['remember-allow', 'remember-deny', 'cancel']) {
      const session = await instance.adapter.createSession({
        sessionId: parseAgentSessionId(`remembered-acp:${name}`), workingDirectory,
        configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('remembered-acp:configuration') },
        onBindingCreated() {}, signal: AbortSignal.timeout(10_000),
      });
      const walkthrough = await runApprovalWalkthrough(session, name, (request) => name === 'cancel'
        ? { requestKind: 'approval', requestId: request.requestId, disposition: 'canceled' }
        : selectDisplayedOption(request, name === 'remember-allow' ? 'Allow and remember' : 'Deny and remember'));
      scenarios.push({ name, ...walkthrough });
    }
  } finally { await registry.dispose(); }
  // Audit bytes come from the actual controlled stdio peer after all owned connections have closed.
  // They are evidence of frame correlation, not a provider permission database or native persistence.
  const frames: unknown[] = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/u).map((line: string) => JSON.parse(line));
  console.log(JSON.stringify({ example: 'remembered-approvals-acp', evidence: 'synthetic',
    mapping: permissionMapping.mapping, scenarios, nativeFrames: frames, cleanup: 'joined',
    nativePersistence: 'unobserved', effect: 'not_performed' }));
  await rm(workingDirectory, { recursive: true, force: true });
} catch (error) {
  console.error(`Inspect retained synthetic wire evidence at ${workingDirectory}.`);
  throw error;
}
