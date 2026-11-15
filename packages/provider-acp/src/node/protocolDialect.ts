import { parseAgentInstanceId, parseAgentProviderKey, type AgentInstanceId, type AgentProviderKey } from '@agen-ai/agent-protocol';
import { AgentProviderContractError, type AgentApprovalPolicyKind } from '@agen-ai/agent-runtime';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import type { CreateNodeAcpProviderDriverOptions } from './contracts.js';

/** Protocol semantics only. Selecting this dialect does not attest a launch profile or establish approval policy. */
export interface NodeAcpProtocolDialectSelection {
  readonly mapping: 'grok-build-1.0.77-controlled-shell-v1';
  readonly instanceId: AgentInstanceId;
  readonly nativeSessionId: string;
  readonly policy: Extract<AgentApprovalPolicyKind, 'host' | 'provider_auto_review' | 'provider_bypass'>;
}

export interface ResolvedNodeAcpProtocolDialect extends NodeAcpProtocolDialectSelection {
  readonly providerKey: AgentProviderKey;
}

export const GROK_CONTROLLED_CWD = '/workspace/work';
export const GROK_CONTROLLED_CLIENT = 'agenai-sdk-grok';

type ControlledGrokRequestDisposition =
  | Readonly<{ kind: 'request' }>
  | Readonly<{ kind: 'retire'; code: 'approval_policy_unavailable' | 'approval_policy_mismatch' }>;

export function resolveNodeAcpProtocolDialect(options: CreateNodeAcpProviderDriverOptions): ResolvedNodeAcpProtocolDialect | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'protocolDialect');
  if (!descriptor) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('The Node ACP protocol dialect must be plain data.');
  const candidate: unknown = descriptor.value;
  if (!candidate || typeof candidate !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) {
    throw new TypeError('The Node ACP protocol dialect must be an explicit selection.');
  }
  const fields = Object.getOwnPropertyDescriptors(candidate);
  if (Reflect.ownKeys(fields).length !== 4 || !['mapping', 'instanceId', 'nativeSessionId', 'policy'].every((key) => {
    const field = fields[key];
    return field && 'value' in field && field.enumerable;
  })) throw new TypeError('The Node ACP protocol dialect must contain only its declared data fields.');
  const value = { mapping: fields.mapping!.value as unknown, instanceId: fields.instanceId!.value as unknown,
    nativeSessionId: fields.nativeSessionId!.value as unknown, policy: fields.policy!.value as unknown };
  if (
    value.mapping !== 'grok-build-1.0.77-controlled-shell-v1'
    || (value.policy !== 'host' && value.policy !== 'provider_auto_review' && value.policy !== 'provider_bypass')
    || typeof value.nativeSessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.nativeSessionId)) {
    throw new TypeError('The Node ACP protocol dialect must select one exact controlled Grok identity and policy.');
  }
  if (options.launch.cwd !== GROK_CONTROLLED_CWD || (Object.hasOwn(options, 'configuration') && options.configuration !== 'managed')
    || (Object.hasOwn(options, 'permissionMapping') && options.permissionMapping?.mapping !== 'once-only-v1')
    || ['host', 'authentication', 'mcpServers', 'sessionMcpBinding', 'structuredOutputMapping', 'sessionInteractions']
      .some((key) => Object.hasOwn(options, key))) {
    throw new TypeError('The controlled Grok dialect requires its fixed cwd, managed configuration and once-only permissions without optional integrations.');
  }
  return Object.freeze({ mapping: value.mapping, providerKey: parseAgentProviderKey(options.providerKey), instanceId: parseAgentInstanceId(value.instanceId),
    nativeSessionId: value.nativeSessionId, policy: value.policy });
}

function object(value: AcpJsonValue | undefined): AcpJsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function canonical(value: AcpJsonValue): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

export function controlledGrokError(providerKey: AgentProviderKey, code: 'approval_policy_unavailable' | 'approval_policy_unconfirmed'
  | 'approval_policy_mismatch' | 'approval_policy_configuration_forbidden', message: string): AgentProviderContractError {
  return new AgentProviderContractError(providerKey, code, message);
}

export function assertControlledGrokInitialization(providerKey: AgentProviderKey, response: AcpJsonValue): void {
  const meta = object(object(response)?._meta);
  if (meta?.agentVersion !== '1.0.77' || meta.grokShell !== true) throw controlledGrokError(providerKey,
    'approval_policy_unavailable', 'The controlled Grok dialect requires exact native Grok Build 1.0.77 initialization.');
  if (meta.currentWorkingDirectory !== GROK_CONTROLLED_CWD || object(meta.modelState)?.currentModelId !== 'grok-4.6') {
    throw controlledGrokError(providerKey, 'approval_policy_mismatch', 'The controlled Grok initialized cwd or model differs from its fixed profile.');
  }
}

/** One session owns the baseline, including updates received before session/new settles. */
export class ControlledGrokSessionDialect {
  private catalog: Readonly<{ kind: 'opening'; observed?: string }> | Readonly<{ kind: 'opened'; signature: string }> = { kind: 'opening' };

  constructor(readonly selection: NodeAcpProtocolDialectSelection, private readonly providerKey: AgentProviderKey) {}

  private mismatch(message: string): never { throw controlledGrokError(this.providerKey, 'approval_policy_mismatch', message); }

  observeOpening(result: AcpJsonObject): void {
    const meta = object(result._meta);
    const detail = object(meta?.['x.ai/sessionDetail']);
    const models = object(result.models);
    if (!meta || !detail || !models || result.sessionId === undefined || !Array.isArray(result.configOptions)) {
      throw controlledGrokError(this.providerKey, 'approval_policy_unconfirmed', 'The controlled Grok opening did not confirm its native session, cwd and model.');
    }
    if (result.sessionId !== this.selection.nativeSessionId || detail.sessionId !== this.selection.nativeSessionId
      || meta.currentWorkingDirectory !== GROK_CONTROLLED_CWD || detail.cwd !== GROK_CONTROLLED_CWD
      || models.currentModelId !== 'grok-4.6' || detail.currentModelId !== 'grok-4.6') {
      this.mismatch('The controlled Grok opening returned a different native session, cwd or model.');
    }
    const signature = this.configurationSignature(result.configOptions);
    if (this.catalog.kind === 'opening' && this.catalog.observed !== undefined && this.catalog.observed !== signature) {
      this.mismatch('Grok configuration changed while the controlled session was opening.');
    }
    this.catalog = { kind: 'opened', signature };
    if (result.modes !== undefined) this.mismatch('The controlled Grok opening exposed an unqualified native mode.');
  }

  observeUpdate(update: AcpJsonObject): void {
    if (update.sessionUpdate === 'current_mode_update') this.mismatch('A native mode observation retired the controlled Grok session.');
    if (update.sessionUpdate !== 'config_option_update') return;
    const observed = this.configurationSignature(update.configOptions);
    if (this.catalog.kind === 'opening') {
      if (this.catalog.observed !== undefined && this.catalog.observed !== observed) this.mismatch('Grok configuration changed during opening.');
      this.catalog = { kind: 'opening', observed };
    } else if (observed !== this.catalog.signature) this.mismatch('The native configuration catalog changed after controlled opening.');
  }

  private configurationSignature(value: AcpJsonValue | undefined): string {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2) this.mismatch('The native configuration catalog is unqualified.');
    const ids = new Set<string>();
    for (const entry of value) {
      const field = object(entry);
      if (!field || typeof field.id !== 'string' || ids.has(field.id) || field.type !== 'select'
        || (field.id === 'model' ? field.category !== 'model' || field.currentValue !== 'grok-4.6'
          : field.id === 'reasoning_effort' ? field.category !== 'thought_level' || field.currentValue !== 'high' : true)
        || !Array.isArray(field.options) || !field.options.some((option) => object(option)?.value === field.currentValue)) {
        this.mismatch('A native model or policy-affecting configuration field is unqualified.');
      }
      ids.add(field.id);
    }
    if (!ids.has('model')) this.mismatch('The native configuration catalog omitted the pinned model.');
    return canonical(value);
  }

  requestDisposition(kind: 'permission' | 'form', params: AcpJsonObject): ControlledGrokRequestDisposition {
    const mismatch = { kind: 'retire', code: 'approval_policy_mismatch' } as const;
    if (kind !== 'permission') return mismatch;
    const meta = object(params._meta);
    const hasReview = !!meta && Object.hasOwn(meta, 'autoReview');
    if (this.selection.policy === 'host') return hasReview ? mismatch : { kind: 'request' };
    if (hasReview) {
      const review = object(meta?.autoReview);
      if (this.selection.policy !== 'provider_auto_review' || !review
        || !Object.keys(review).every((key) => key === 'outcome' || key === 'explanation')
        || (review.explanation !== undefined && typeof review.explanation !== 'string')) return mismatch;
      switch (review.outcome) {
        case 'blocked': return { kind: 'request' };
        case 'failed': return { kind: 'retire', code: 'approval_policy_unavailable' };
        default: return mismatch;
      }
    }
    // Only the separately observed native mandatory configuration confirmation is an exception.
    const tool = object(params.toolCall);
    const toolMeta = object(object(tool?._meta)?.['x.ai/tool']);
    const mandatory = meta?.kind === 'grok_config' && typeof meta.description === 'string'
      && Object.keys(meta).every((key) => key === 'kind' || key === 'description')
      && tool?.kind === 'execute' && toolMeta?.version === 1 && toolMeta.name === 'run_terminal_command'
      && toolMeta.kind === 'execute' && toolMeta.namespace === 'grok_build';
    return mandatory ? { kind: 'request' } : mismatch;
  }
}
