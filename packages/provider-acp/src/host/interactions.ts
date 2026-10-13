import type { AcpJsonValue, AcpReverseRequestContext } from '@agen-ai/acp-transport';
import type { AgentInstanceId } from '@agen-ai/agent-protocol';
import type { AcpProviderLimits } from '../limits.js';
import { validateAcpFormContent, validateAcpFormSchema } from '../session/requests/forms.js';
import type { AcpHostFacilities, AcpHostInteractionScope, AcpHostUrlInteractionLease } from './contracts.js';
import { awaitHost, hostDeadline } from './lifecycle.js';
import { AcpHostLeases } from './leases.js';
import { freezeHostData, hostObject, hostText, invalidHostRequest, unsupportedHostRequest } from './validation.js';

interface UrlInteraction {
  readonly release: () => Promise<void>;
  readonly detach: () => void;
  readonly lease: AcpHostUrlInteractionLease;
  readonly scopeSignal: AbortSignal;
  accepted: boolean;
  completed: boolean;
  completion: Promise<void> | undefined;
}

export class AcpHostInteractions {
  private readonly urls = new Map<string, UrlInteraction>();
  private readonly pendingUrls = new Map<string, boolean>();
  private readonly leases: AcpHostLeases;

  constructor(private readonly input: {
    readonly instanceId: AgentInstanceId;
    readonly host: AcpHostFacilities;
    readonly limits: AcpProviderLimits;
    readonly stopped: AbortSignal;
  }) { this.leases = new AcpHostLeases(input.limits.hostOperationTimeoutMs); }

  async request(context: AcpReverseRequestContext, scope: AcpHostInteractionScope, scopeSignal: AbortSignal): Promise<AcpJsonValue> {
    const params = hostObject(context.params);
    const message = hostText(params.message, 4_000);
    const signal = AbortSignal.any([context.signal, scopeSignal, this.input.stopped]);
    if (params.mode === 'form') {
      if (!this.input.host.form) throw unsupportedHostRequest();
      const schema = freezeHostData(structuredClone(hostObject(params.requestedSchema)));
      validateAcpFormSchema(schema);
      const deadline = hostDeadline(signal, this.input.limits.authenticationTimeoutMs);
      try {
        const result = await awaitHost(this.input.host.form({
          instanceId: this.input.instanceId, scope, signal: deadline.signal, message, requestedSchema: schema,
        }), deadline.signal);
        if (result.action === 'accept') {
          const content = hostObject(result.content);
          validateAcpFormContent(schema, content);
          return { action: 'accept', content: freezeHostData(structuredClone(content)) };
        }
        if (result.action !== 'decline' && result.action !== 'cancel') throw invalidHostRequest();
        return { action: result.action };
      } finally { deadline.close(); }
    }
    if (params.mode !== 'url' || !this.input.host.url) throw unsupportedHostRequest();
    const id = hostText(params.elicitationId, 256);
    if (this.urls.has(id) || this.pendingUrls.has(id)) throw invalidHostRequest();
    if (this.leases.size >= this.input.limits.maxPendingRequests) throw invalidHostRequest();
    const url = hostText(params.url, 2_048);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw invalidHostRequest(); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw invalidHostRequest();
    this.pendingUrls.set(id, false);
    const deadline = hostDeadline(signal, this.input.limits.authenticationTimeoutMs);
    let interaction: UrlInteraction | undefined;
    try {
      const { lease, release } = await this.leases.acquire((signal) => this.input.host.url!({
        instanceId: this.input.instanceId, scope, signal, message, url, elicitationId: id,
      }), deadline.signal, scopeSignal, (lease) => { if (lease?.decision) void Promise.resolve(lease.decision).catch(() => undefined); });
      if (!lease || typeof lease.release !== 'function' || !lease.decision || typeof lease.decision.then !== 'function'
        || (lease.complete !== undefined && typeof lease.complete !== 'function')) {
        await release();
        throw invalidHostRequest();
      }
      const abort = () => { void this.releaseUrl(id).catch(() => undefined); };
      interaction = { lease, release, scopeSignal, accepted: false, completed: this.pendingUrls.get(id) === true, completion: undefined,
        detach: () => { deadline.signal.removeEventListener('abort', abort); deadline.close(); } };
      this.urls.set(id, interaction);
      this.pendingUrls.delete(id);
      deadline.signal.addEventListener('abort', abort, { once: true });
      if (deadline.signal.aborted) abort();
      const action = await awaitHost(lease.decision, deadline.signal);
      if (action !== 'accept' && action !== 'decline' && action !== 'cancel') throw invalidHostRequest();
      interaction.accepted = action === 'accept';
      if (action !== 'accept') await this.releaseUrl(id);
      else if (interaction.completed) await this.complete(id);
      return { action };
    } catch (error) {
      if (interaction) await this.releaseUrl(id);
      throw error;
    } finally {
      this.pendingUrls.delete(id);
      if (!this.urls.has(id)) deadline.close();
    }
  }

  async complete(id: string): Promise<void> {
    const interaction = this.urls.get(id);
    if (!interaction) {
      if (this.pendingUrls.has(id)) this.pendingUrls.set(id, true);
      return;
    }
    interaction.completed = true;
    if (!interaction.accepted) return;
    interaction.completion ??= Promise.resolve().then(async () => {
      const deadline = hostDeadline(new AbortController().signal, this.input.limits.hostOperationTimeoutMs);
      try { await awaitHost(Promise.resolve().then(() => interaction.lease.complete?.()), deadline.signal); }
      finally { deadline.close(); await this.releaseUrl(id); }
    });
    await interaction.completion;
  }

  private async releaseUrl(id: string): Promise<void> {
    const interaction = this.urls.get(id);
    if (!interaction) return;
    await interaction.release();
    interaction.detach();
    this.urls.delete(id);
  }

  async close(): Promise<void> {
    await this.leases.close();
    for (const interaction of this.urls.values()) interaction.detach();
    this.urls.clear();
  }

  async closeScope(signal: AbortSignal): Promise<void> {
    await this.leases.close(signal);
    for (const [id, interaction] of this.urls) if (interaction.scopeSignal === signal) {
      interaction.detach(); this.urls.delete(id);
    }
  }
}
