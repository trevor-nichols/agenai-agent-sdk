import { posix } from 'node:path';
import {
  parseAgentProviderConversationId,
  parseAgentSessionDecisionRequest,
  type AgentProviderConversationId,
  type AgentSessionDecisionRequest,
  type AgentSessionId,
} from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from '../session/errors.js';

export const GROK_FOLDER_TRUST_METHOD = '_x.ai/folder_trust/request';
export const GROK_FOLDER_TRUST_CAPABILITY_META = Object.freeze({
  'x.ai/folderTrust': Object.freeze({ interactive: true }),
});

const CONFIGURATION_EXPLANATIONS = Object.freeze({
  mcp: 'Project tool servers',
  plugins: 'Project plugins',
  permission: 'Project tool-permission rules',
  lsp: 'Project language servers',
  envrc: 'Project shell environment scripts',
  claude: 'Imported compatibility settings',
  hooks: 'Project hooks',
  agents: 'Project agent definitions',
  roles: 'Project role definitions',
  personas: 'Project persona definitions',
  workflows: 'Project workflows',
  instructions: 'Project instructions',
  skills: 'Project skills',
});

type ConfigurationKind = keyof typeof CONFIGURATION_EXPLANATIONS;

function configurationKind(input: unknown): input is ConfigurationKind {
  return typeof input === 'string' && Object.hasOwn(CONFIGURATION_EXPLANATIONS, input);
}

export interface NativeFolderTrustRequest {
  readonly sessionId: AgentProviderConversationId;
  readonly cwd: string;
  readonly workspace: string;
  readonly configKinds: readonly ConfigurationKind[];
}

export type NativeFolderTrustResult = Readonly<{ outcome: 'trust' | 'reject' }>;

function exactObject(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const own = Reflect.ownKeys(input);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(input, key));
}

function invalidRequest(): AcpProviderSessionError {
  return new AcpProviderSessionError('acp_session_interaction_invalid', 'The native workspace decision violates the selected mapping.');
}

function workspacePath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input, 'utf8') > 4_096
    || /[\p{Cc}\p{Cf}]/u.test(input) || !posix.isAbsolute(input) || posix.normalize(input) !== input) {
    throw invalidRequest();
  }
  return input;
}

export function parseNativeFolderTrustRequest(input: unknown): NativeFolderTrustRequest {
  if (!exactObject(input, ['sessionId', 'cwd', 'workspace', 'configKinds'])
    || Buffer.byteLength(JSON.stringify(input), 'utf8') > 65_536
    || typeof input.sessionId !== 'string' || Buffer.byteLength(input.sessionId, 'utf8') > 512
    || !Array.isArray(input.configKinds) || input.configKinds.length < 1 || input.configKinds.length > 13) {
    throw invalidRequest();
  }
  const kinds: ConfigurationKind[] = [];
  for (const kind of input.configKinds) {
    if (!configurationKind(kind) || kinds.includes(kind)) throw invalidRequest();
    kinds.push(kind);
  }
  return Object.freeze({
    sessionId: parseAgentProviderConversationId(input.sessionId),
    cwd: workspacePath(input.cwd),
    workspace: workspacePath(input.workspace),
    configKinds: Object.freeze(kinds),
  });
}

export function validateNativeFolderTrustRequest(input: unknown): boolean {
  try { parseNativeFolderTrustRequest(input); return true; } catch { return false; }
}

export function validateNativeFolderTrustResult(input: unknown): boolean {
  return exactObject(input, ['outcome']) && (input.outcome === 'trust' || input.outcome === 'reject');
}

export function folderTrustDecision(input: Readonly<{
  native: NativeFolderTrustRequest;
  sessionId: AgentSessionId;
  requestNumber: number;
}>): AgentSessionDecisionRequest {
  const detected = input.native.configKinds.map((kind) => CONFIGURATION_EXPLANATIONS[kind]).join('; ');
  return parseAgentSessionDecisionRequest({
    kind: 'decision',
    requestId: `session-interaction:${input.requestNumber}`,
    sessionId: input.sessionId,
    title: 'Allow workspace configuration?',
    description: `Detected configuration: ${detected}. Workspace configuration can start tools or hooks and affect provider behavior. These detected categories do not restrict the scope of an authorization.`,
    target: { kind: 'workspace', path: input.native.workspace },
    choices: [
      {
        choiceId: 'grant',
        label: 'Allow workspace configuration',
        description: 'Authorize configuration for the target workspace, including future configuration. The provider manages persistent trust, which may affect later or sibling sessions using the same profile. This choice does not confirm immediate loading or successful persistence.',
        consequence: {
          kind: 'grant', scope: 'workspace',
          persistence: { kind: 'provider_managed', duration: 'persistent', mayAffectOtherSessions: true },
        },
      },
      {
        choiceId: 'decline',
        label: 'Keep configuration gated',
        description: 'Keep workspace configuration gated. Repeat questions may be suppressed for this workspace while this native agent lives. This choice does not revoke an existing grant or promise a persisted denial.',
        consequence: { kind: 'decline', configuration: 'remains_gated' },
      },
    ],
  });
}
