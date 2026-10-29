import type { Sandbox } from '@agen-ai/sandbox';
import { createSandboxClaudeRun } from '../index.js';
import type { ClaudeSandboxRequest, ClaudeSandboxRun, ClaudeSdk } from '../index.js';

/** Existing wrappers use the exported request annotation and consume their run synchronously. */
export function existingKeyCaller(sdk: ClaudeSdk, sandbox: Sandbox, request: ClaudeSandboxRequest): ClaudeSandboxRun {
  const run = createSandboxClaudeRun(sdk, sandbox, request);
  return { ...run, messages: run.messages };
}
