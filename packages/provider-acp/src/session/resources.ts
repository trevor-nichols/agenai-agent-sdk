// ------------------------------------------------------------------------------------------------
//                resources.ts - Ordered native connection and session MCP ownership
// ------------------------------------------------------------------------------------------------

import type { AcpStandardMcpServer } from '@agen-ai/acp-transport';
import {
  throwIfAgentOperationAborted,
  validateAgentSessionHostBinding,
  type AgentProviderSessionContext,
} from '@agen-ai/agent-runtime';
import type { AgentInstanceId } from '@agen-ai/agent-protocol';
import type { AcpInitializedConnection } from '../connection/contracts.js';
import type { AcpSessionMcpBindingLease, AcpSessionMcpBindingOptions } from '../contracts.js';
import { awaitHost, hostDeadline } from '../host/lifecycle.js';
import type { AcpProviderLimits } from '../limits.js';
import { resolveAcpMcpServers } from '../mcp.js';

export class AcpSessionResources {
  private readonly lifetime = new AbortController();
  private acquisition: Promise<AcpSessionMcpBindingLease> | undefined;
  private releaseMcp: AcpSessionMcpBindingLease['release'] | undefined;
  private nativeClosed = false;
  private mcpReleased = false;
  private closed = false;
  private cleanup: Promise<void> | undefined;

  constructor(private readonly input: {
    readonly instanceId: AgentInstanceId;
    readonly context: AgentProviderSessionContext;
    readonly operation: 'create' | 'resume';
    readonly connection: AcpInitializedConnection;
    readonly staticServers: readonly AcpStandardMcpServer[];
    readonly binding?: AcpSessionMcpBindingOptions;
    readonly limits: AcpProviderLimits;
    readonly onReleased: () => void;
  }) {}

  get cleanupPending(): boolean { return this.lifetime.signal.aborted && !this.closed; }

  async mcpServers(): Promise<readonly AcpStandardMcpServer[]> {
    const { binding, context } = this.input;
    if (context.hostBinding === undefined) return this.input.staticServers;
    if (!binding) throw new TypeError('ACP session host bindings are unsupported.');
    const hostBinding = validateAgentSessionHostBinding({ binding: context.hostBinding, support: {
      kind: 'supported', toolTransport: 'mcp', instructionPlacements: ['tool_context'],
    } });
    const parent = context.signal ? AbortSignal.any([context.signal, this.lifetime.signal]) : this.lifetime.signal;
    const deadline = hostDeadline(parent, this.input.limits.hostOperationTimeoutMs);
    this.acquisition = Promise.resolve().then(() => {
      throwIfAgentOperationAborted(deadline.signal);
      return binding.create(Object.freeze({ instanceId: this.input.instanceId, sessionId: context.sessionId,
        workingDirectory: context.workingDirectory, operation: this.input.operation, hostBinding, signal: deadline.signal }));
    }).then((lease) => {
      let release: AcpSessionMcpBindingLease['release'] | undefined;
      // Own cleanup before inspecting any property supplied by the factory.
      this.releaseMcp = () => {
        release ??= resolveMcpRelease(lease);
        return Reflect.apply(release, lease, []);
      };
      release = resolveMcpRelease(lease);
      return lease;
    });
    try {
      const lease = await awaitHost(this.acquisition, deadline.signal);
      throwIfAgentOperationAborted(deadline.signal);
      const servers = lease.mcpServers;
      if (!Array.isArray(servers) || servers.length === 0 || servers.length > 32
        || servers.some((server) => server?.type !== binding.transport)) {
        throw new TypeError('ACP session MCP servers must use the certified transport.');
      }
      return resolveAcpMcpServers([...this.input.staticServers, ...resolveAcpMcpServers(servers)]);
    } finally { deadline.close(); }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.lifetime.abort(new DOMException('ACP session resources were closed.', 'AbortError'));
    const nativeCleanup = this.nativeClosed ? Promise.resolve() : this.input.connection.close();
    void nativeCleanup.catch(() => {});
    // A deadline never abandons the actual acquisition/release attempt or permits an overlapping retry.
    this.cleanup ??= Promise.resolve().then(async () => {
      if (!this.nativeClosed) {
        await (this.input.connection.execution?.joinCleanup() ?? nativeCleanup);
        this.nativeClosed = true;
      }
      if (this.acquisition) {
        await this.acquisition.catch(() => undefined);
        if (this.releaseMcp && !this.mcpReleased) {
          await this.releaseMcp();
          this.mcpReleased = true;
        }
      }
      this.closed = true;
      this.input.onReleased();
    }).finally(() => { this.cleanup = undefined; });
    const deadline = hostDeadline(new AbortController().signal, this.input.limits.hostOperationTimeoutMs);
    return awaitHost(Promise.all([nativeCleanup, this.cleanup]).then(() => undefined), deadline.signal)
      .finally(() => { deadline.close(); });
  }
}

function resolveMcpRelease(lease: AcpSessionMcpBindingLease): AcpSessionMcpBindingLease['release'] {
  const release = lease && typeof lease === 'object' ? lease.release : undefined;
  if (typeof release !== 'function') {
    throw new TypeError('ACP session MCP factories must return an owned cleanup lease.');
  }
  return release;
}
