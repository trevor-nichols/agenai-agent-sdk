import { AGENT_PROVIDER_CONTRACT_ERROR_CODES, AGENT_PROVIDER_REGISTRY_ERROR_CODES, AgentProviderContractError, AgentProviderRegistryError } from '@agen-ai/agent-runtime';
import { SandboxOperationError } from '@agen-ai/sandbox';
import { NativeExampleError } from './data.js';

/** Closed codes only; bounded cause traversal never copies error text or arbitrary properties. */
export function safeFailureCode(error: unknown): string {
  const pending: unknown[] = [error]; const visited = new Set<unknown>(); let registry: string | undefined;
  for (let count = 0; pending.length > 0 && count < 16; count += 1) {
    const current = pending.shift(); if (visited.has(current)) continue; visited.add(current);
    if (current instanceof NativeExampleError) return current.code;
    if (current instanceof AgentProviderContractError && AGENT_PROVIDER_CONTRACT_ERROR_CODES.includes(current.code)) return current.code;
    if (current instanceof AgentProviderRegistryError && AGENT_PROVIDER_REGISTRY_ERROR_CODES.includes(current.code)) registry ??= current.code;
    if (current instanceof SandboxOperationError && ['cancelled', 'deadline_exceeded', 'output_limit', 'input_limit', 'stream_failure', 'persistence_failure', 'driver_failure'].includes(current.code)) registry ??= current.code;
    if (!(current instanceof Error)) continue;
    const cause = Object.getOwnPropertyDescriptor(current, 'cause'); if (cause && 'value' in cause) pending.push(cause.value);
    const errors = Object.getOwnPropertyDescriptor(current, 'errors');
    if (errors && 'value' in errors && Array.isArray(errors.value)) pending.push(...errors.value.slice(0, 16));
  }
  return registry ?? 'run_failed';
}
