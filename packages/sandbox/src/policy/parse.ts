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
  if (request.policy.files.kind !== 'disabled' && (!support.files
    || (request.policy.files.kind === 'read_write' && !support.files.write))) {
    throw new SandboxUnsupportedError('Backend does not support the requested live filesystem authority');
  }
  if (!support.networkModes.includes(request.policy.network.kind)) throw new SandboxUnsupportedError(`Backend does not support ${request.policy.network.kind} networking`);
  if (request.policy.network.kind === 'restricted_https' && (support.networkAllowlist === false
    || request.policy.network.destinations.length > support.networkAllowlist.maxDestinations)) {
    throw new SandboxUnsupportedError('Backend does not support the requested exact HTTPS destination catalog');
  }
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
    || !sameNetworkPolicy(desired.network, effective.network)
    || desired.files.kind !== (effective.files?.kind ?? 'disabled')
    || effective.workspaceDiskQuota.kind !== desired.workspaceDiskQuota.kind) {
    throw new SandboxUnsupportedError('Backend effective policy does not match the requested policy');
  }
}

function sameNetworkPolicy(desired: SandboxRequest['policy']['network'], effective: SandboxEffectivePolicy['network']): boolean {
  if (desired.kind !== effective.kind) return false;
  if (desired.kind !== 'restricted_https') return true;
  if (effective.kind !== 'restricted_https' || desired.destinations.length !== effective.destinations.length) return false;
  return desired.destinations.every((destination, index) => destination.hostname === effective.destinations[index]?.hostname
    && destination.port === effective.destinations[index]?.port);
}
