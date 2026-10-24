// ------------------------------------------------------------------------------------------------
//                parse.ts - Strict policy, support, identity and effective-fact admission
// ------------------------------------------------------------------------------------------------

import { SandboxUnsupportedError } from '../errors.js';
import { parseData } from '../internal/parse.js';
import { effectiveSchema, namespaceSchema, policySchema, processIdSchema, requestSchema, sandboxIdSchema, supportSchema } from './schemas.js';
import type { SandboxEffectivePolicy, SandboxId, SandboxNamespace, SandboxPolicy, SandboxProcessId, SandboxRequest, SandboxSupport } from './types.js';

export function parseSandboxNamespace(input: unknown): SandboxNamespace { return parseData(namespaceSchema, input); }
export function parseSandboxId(input: unknown): SandboxId { return parseData(sandboxIdSchema, input); }
export function parseSandboxProcessId(input: unknown): SandboxProcessId { return parseData(processIdSchema, input); }
export function parseSandboxPolicy(input: unknown): SandboxPolicy { return parseData(policySchema, input); }
export function parseSandboxRequest(input: unknown): SandboxRequest { return parseData(requestSchema, input); }
export function parseSandboxSupport(input: unknown): SandboxSupport { return parseData(supportSchema, input); }
export function parseSandboxEffectivePolicy(input: unknown): SandboxEffectivePolicy { return parseData(effectiveSchema, input); }

export function assertSandboxRequestSupported(request: SandboxRequest, support: SandboxSupport): void {
  if (!support.networkModes.includes(request.policy.network.kind)) throw new SandboxUnsupportedError(`Backend does not support ${request.policy.network.kind} networking`);
  if (request.policy.workspaceDiskQuota.kind === 'required' && !support.workspaceDiskQuota) {
    throw new SandboxUnsupportedError('Backend does not support a required allocated-block workspace disk quota');
  }
}

export function assertSandboxEffectivePolicy(request: SandboxRequest, effective: SandboxEffectivePolicy): void {
  const desired = request.policy;
  if (effective.resources.cpus !== desired.resources.cpus
    || effective.resources.memoryBytes !== desired.resources.memoryBytes
    || effective.resources.pids !== desired.resources.pids
    || effective.temporaryStorage.homeBytes !== desired.temporaryStorage.homeBytes
    || effective.temporaryStorage.tempBytes !== desired.temporaryStorage.tempBytes
    || effective.network.kind !== desired.network.kind
    || effective.workspaceDiskQuota.kind !== desired.workspaceDiskQuota.kind) {
    throw new SandboxUnsupportedError('Backend effective policy does not match the requested policy');
  }
}
