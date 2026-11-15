import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { GROK_DOCKER_APPROVAL_MAPPING } from '@agen-ai/provider-grok';
import type { GrokDockerApprovalProfile, GrokDockerApprovalProfilePreparationOptions, GrokDockerBackendOptions, GrokDockerTransferOptions } from '@agen-ai/provider-grok/docker';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { parseSandboxPolicy } from '@agen-ai/sandbox';
import { control, helper, routeAuthority, user } from './routes.js';
import { digest, fields, integer, invalid, literal, path, sha, text, token } from './data.js';

export type ResidualDecision = Readonly<{ kind: 'cancel' | 'approve_once' | 'deny_once' }>;
export interface Reservation { readonly ledgerDirectory: string; readonly campaignId: string; readonly currency: 'USD'; readonly maximumCents: number; readonly amountCents: number }
export interface NativeRunConfiguration {
  readonly format: 'agenai.approval-native-run.v1'; readonly provider: 'grok'; readonly mapping: typeof GROK_DOCKER_APPROVAL_MAPPING;
  readonly runId: string; readonly profile: GrokDockerApprovalProfile; readonly backend: GrokDockerBackendOptions;
  readonly workload: ReturnType<typeof workload>; readonly credential: Readonly<{ kind: 'auth_json'; path: string }>;
  readonly workspace: Readonly<{ importDirectory: string; exportDirectory: string; transferTimeoutMs: number; quotas: GrokDockerTransferOptions['quotas'] }>;
  readonly prompt: string; readonly residual: ResidualDecision;
  readonly limits: Readonly<{ runMs: number; maxOutputEvents: number; maxOutputBytes: number; cleanupAttempts: number; maxToolActions?: number }>;
  readonly reservation: Reservation; readonly artifactsDirectory: string;
}
export interface NativePrepareConfiguration {
  readonly format: 'agenai.approval-native-prepare.v1'; readonly provider: 'grok'; readonly mapping: typeof GROK_DOCKER_APPROVAL_MAPPING;
  readonly profile: GrokDockerApprovalProfile; readonly preparation: Omit<GrokDockerApprovalProfilePreparationOptions, 'profile'>;
}
export type NativeConfiguration = NativeRunConfiguration | NativePrepareConfiguration;

function profile(value: unknown): GrokDockerApprovalProfile {
  const data = fields(value, ['instanceId', 'nativeSessionId', 'policy', 'credentialBootstrap'], ['deniedBashPatterns']);
  const bootstrap = fields(data.credentialBootstrap, ['sha256']);
  const nativeSessionId = text(data.nativeSessionId, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(nativeSessionId)) invalid();
  const policy = data.policy;
  if (policy !== 'host' && policy !== 'provider_auto_review' && policy !== 'provider_bypass') invalid();
  return { instanceId: parseAgentInstanceId(data.instanceId), nativeSessionId, policy, credentialBootstrap: { sha256: sha(bootstrap.sha256) },
    ...(Object.hasOwn(data, 'deniedBashPatterns') ? { deniedBashPatterns: deniedBashPatterns(data.deniedBashPatterns) } : {}) };
}
function deniedBashPatterns(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const entries = Object.getOwnPropertyDescriptors<object>(value);
  const length: unknown = entries.length?.value;
  if (typeof length !== 'number' || length > 32 || Reflect.ownKeys(entries).length !== length + 1) invalid();
  const patterns: string[] = [];
  let bytes = 0;
  for (let index = 0; index < length; index += 1) {
    const entry = entries[String(index)];
    if (!entry?.enumerable || !('value' in entry)) invalid();
    const pattern = text(entry.value, 4096);
    bytes += Buffer.byteLength(pattern);
    if (bytes > 16384) invalid();
    patterns.push(pattern);
  }
  return Object.freeze(patterns);
}
function dockerProfile(value: unknown) {
  if (value !== 'linux-x64' && value !== 'desktop-apple-virtualization-native-arm64') invalid(); return value;
}
function backend(value: unknown): GrokDockerBackendOptions {
  const data = fields(value, ['profile', 'endpoint', 'imageDigest', 'namespace', 'spillDirectory', 'user', 'egress']);
  const egress = fields(data.egress, ['imageDigest', 'protocol', 'user', 'broker', 'relay', 'routeAuthority', 'control']);
  const selected: GrokDockerBackendOptions = { profile: dockerProfile(data.profile), endpoint: text(data.endpoint, 512), imageDigest: digest(data.imageDigest),
    namespace: text(data.namespace, 63), spillDirectory: path(data.spillDirectory), user: user(data.user),
    egress: { imageDigest: digest(egress.imageDigest), protocol: literal(egress.protocol, 'agenai.sandbox.egress-connect.v1'), user: user(egress.user),
      broker: helper(egress.broker), relay: helper(egress.relay), routeAuthority: routeAuthority(egress.routeAuthority), control: control(egress.control) } };
  createDockerSandboxBackend(selected); // Inert public validation; no Engine request or route observation.
  return selected;
}
function workload(value: unknown) {
  const data = fields(value, ['resources', 'temporaryStorage', 'execution', 'deadlines', 'transfers', 'streams']);
  const parsed = parseSandboxPolicy({ ...data, network: { kind: 'restricted_https', destinations: [{ hostname: 'cli-chat-proxy.grok.com', port: 443 }] } });
  if (parsed.execution.kind !== 'deadline' || parsed.streams.maxStdinBytes === undefined || parsed.streams.maxOutputBytes === undefined) invalid();
  return { resources: parsed.resources, temporaryStorage: parsed.temporaryStorage, execution: parsed.execution,
    deadlines: parsed.deadlines, transfers: parsed.transfers, streams: parsed.streams };
}
function quotas(value: unknown): GrokDockerTransferOptions['quotas'] {
  const data = fields(value, ['maxFiles', 'maxFileBytes', 'maxTotalBytes', 'maxArchiveBytes', 'maxPaths']);
  return { maxFiles: integer(data.maxFiles), maxFileBytes: integer(data.maxFileBytes), maxTotalBytes: integer(data.maxTotalBytes),
    maxArchiveBytes: integer(data.maxArchiveBytes), maxPaths: integer(data.maxPaths) };
}
export function parseNativeConfiguration(value: unknown): NativeConfiguration {
  if (!value || typeof value !== 'object' || !('format' in value)) invalid();
  if (value.format === 'agenai.approval-native-prepare.v1') {
    const data = fields(value, ['format', 'provider', 'mapping', 'profile', 'preparation']);
    const preparation = fields(data.preparation, ['directory', 'dockerProfile', 'baseImageDigest']);
    const base = text(preparation.baseImageDigest, 512);
    if (!/^(?:sha256:[a-f0-9]{64}|[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/u.test(base)) invalid();
    return { format: 'agenai.approval-native-prepare.v1', provider: literal(data.provider, 'grok'), mapping: literal(data.mapping, GROK_DOCKER_APPROVAL_MAPPING),
      profile: profile(data.profile), preparation: { directory: path(preparation.directory), dockerProfile: dockerProfile(preparation.dockerProfile), baseImageDigest: base } };
  }
  const data = fields(value, ['format', 'provider', 'mapping', 'runId', 'profile', 'backend', 'workload', 'credential', 'workspace', 'prompt', 'residual', 'limits', 'reservation', 'artifactsDirectory']);
  const credential = fields(data.credential, ['kind', 'path']);
  const workspace = fields(data.workspace, ['importDirectory', 'exportDirectory', 'transferTimeoutMs', 'quotas']);
  const limits = fields(data.limits, ['runMs', 'maxOutputEvents', 'maxOutputBytes', 'cleanupAttempts'], ['maxToolActions']);
  const residual = fields(data.residual, ['kind']);
  if (residual.kind !== 'cancel' && residual.kind !== 'approve_once' && residual.kind !== 'deny_once') invalid();
  const reservation = fields(data.reservation, ['ledgerDirectory', 'campaignId', 'currency', 'maximumCents', 'amountCents']);
  const prompt = data.prompt;
  if (typeof prompt !== 'string' || !prompt.isWellFormed() || prompt.length < 1 || Buffer.byteLength(prompt) > 16384
    || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(prompt) || prompt.trimStart().startsWith('/')) invalid();
  const selected: NativeRunConfiguration = { format: literal(data.format, 'agenai.approval-native-run.v1'), provider: literal(data.provider, 'grok'),
    mapping: literal(data.mapping, GROK_DOCKER_APPROVAL_MAPPING), runId: token(data.runId), profile: profile(data.profile), backend: backend(data.backend),
    workload: workload(data.workload), credential: { kind: literal(credential.kind, 'auth_json'), path: path(credential.path) },
    workspace: { importDirectory: path(workspace.importDirectory), exportDirectory: path(workspace.exportDirectory),
      transferTimeoutMs: integer(workspace.transferTimeoutMs, 1, 900000), quotas: quotas(workspace.quotas) }, prompt, residual: { kind: residual.kind },
    limits: { runMs: integer(limits.runMs, 1, 900000), maxOutputEvents: integer(limits.maxOutputEvents, 1, 100000),
      maxOutputBytes: integer(limits.maxOutputBytes, 1, 64 * 1024 ** 2), cleanupAttempts: integer(limits.cleanupAttempts, 1, 3),
      ...(Object.hasOwn(limits, 'maxToolActions') ? { maxToolActions: integer(limits.maxToolActions, 1, 100000) } : {}) },
    reservation: { ledgerDirectory: path(reservation.ledgerDirectory), campaignId: token(reservation.campaignId), currency: literal(reservation.currency, 'USD'),
      maximumCents: integer(reservation.maximumCents, 1, 1000000), amountCents: integer(reservation.amountCents, 1, 1000000) }, artifactsDirectory: path(data.artifactsDirectory) };
  const roots = [selected.workspace.importDirectory, selected.workspace.exportDirectory, selected.artifactsDirectory, selected.reservation.ledgerDirectory, selected.backend.spillDirectory];
  if (roots.some((left, index) => roots.some((right, other) => index !== other && (left === right || left.startsWith(`${right}/`))))
    || roots.some((root) => selected.credential.path === root || selected.credential.path.startsWith(`${root}/`))
    || selected.reservation.amountCents > selected.reservation.maximumCents) invalid();
  return selected;
}
