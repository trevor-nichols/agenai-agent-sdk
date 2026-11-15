import type { AgentProviderDriver, AgentProviderRegistry, AgentProviderSession } from '@agen-ai/agent-runtime';
import type { NodeProviderFileRestrictions, NodeProviderToolOptions, NodeProviderWorkspace } from '@agen-ai/provider-tools';
import type { AcceptEditsRunConfig } from './config.js';

/**
 * Builds the driver through the public factory. Factories are inert: binaries, the workspace lease
 * and the helper are verified and acquired only when the registry materializes the instance.
 * Provider modules load on demand so an OpenCode-only installation needs no Claude package.
 */
export async function createDriver(config: AcceptEditsRunConfig, workspace: NodeProviderWorkspace, apiKey: string): Promise<AgentProviderDriver> {
  const restrictions: NodeProviderFileRestrictions = Object.fromEntries(
    Object.entries(config.restrictions ?? {}).filter((entry): entry is [string, string[]] => entry[1] !== undefined));
  const tools: NodeProviderToolOptions = {
    workspace,
    stateParentDirectory: config.workspace.stateParentDirectory,
    bubblewrapPath: config.native.bubblewrapPath,
    filesystemHelperPath: config.native.filesystemHelperPath,
    ...(config.restrictions ? { restrictions } : {}),
    ...(config.limits.commandTimeoutMs ? { limits: { commandTimeoutMs: config.limits.commandTimeoutMs } } : {}),
  };
  const credential = { kind: 'api_key' as const, value: apiKey };
  const endpoint = config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {};
  const limits = config.nativeLimits;
  if (config.provider === 'claude') {
    const { createNodeClaudeProviderDriver } = await import('@agen-ai/provider-claude/node');
    const usageLimits = limits?.provider === 'claude' && limits.maxBudgetUsdPerSession !== undefined
      ? { usageLimits: { maxBudgetUsdPerSession: limits.maxBudgetUsdPerSession } } : {};
    return createNodeClaudeProviderDriver({ executablePath: config.native.executablePath, credential, tools, ...endpoint, ...usageLimits });
  }
  const { createNodeOpenCodeProviderDriver } = await import('@agen-ai/provider-opencode/node');
  const usageLimits = limits?.provider === 'opencode' ? { usageLimits: {
    ...(limits.maxOutputTokensPerRequest === undefined ? {} : { maxOutputTokensPerRequest: limits.maxOutputTokensPerRequest }),
    ...(limits.maxModelStepsPerTurn === undefined ? {} : { maxModelStepsPerTurn: limits.maxModelStepsPerTurn }),
  } } : {};
  return createNodeOpenCodeProviderDriver({ executablePath: config.native.executablePath, provider: config.route, credential, tools, ...endpoint,
    ...usageLimits });
}

function retainedRetry(error: unknown): (() => Promise<void>) | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    const retry = (current as { retryCleanup?: unknown }).retryCleanup;
    if (typeof retry === 'function') return () => Promise.resolve(retry.call(current));
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The original owners of everything this run acquired. Settlement is proven only by these owners
 * resolving; a failed owner stays retained for an explicit retry by the same process.
 */
export class OriginalOwners {
  registry: AgentProviderRegistry | undefined;
  session: AgentProviderSession | undefined;
  private sessionClosed = false;
  private registryDisposed = false;
  private readonly partial: Array<() => Promise<void>> = [];

  /** Keeps the retry handle of a partially acquired operation that failed after acquiring resources. */
  retainFailure(error: unknown): void {
    const retry = retainedRetry(error);
    if (retry) this.partial.push(retry);
  }

  async settle(): Promise<unknown[]> {
    const failures: unknown[] = [];
    if (this.session && !this.sessionClosed) {
      try { await this.session.close({ reason: 'shutdown' }); this.sessionClosed = true; }
      catch (error) { failures.push(error); }
    }
    if (this.registry && !this.registryDisposed) {
      try { await this.registry.dispose(); this.registryDisposed = true; }
      catch (error) { failures.push(error); }
    }
    for (const retry of [...this.partial]) {
      try { await retry(); this.partial.splice(this.partial.indexOf(retry), 1); }
      catch (error) { failures.push(error); }
    }
    return failures;
  }
}
