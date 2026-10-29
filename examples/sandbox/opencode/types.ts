import type { SandboxApiKeyCredential } from '../credentials/index.js';

/** Existing callers retain the synchronous Anthropic API-key recipe. */
export interface SandboxOpenCodeInput {
  readonly credential: SandboxApiKeyCredential;
  readonly guestExecutable: '/opt/agenai/native/opencode';
  readonly task: string;
  readonly selection?: never;
  readonly preparation?: never;
  readonly signal?: never;
}

export interface SandboxOpenCodeSelection {
  /** Native provider/integration identity, for example `openai` or `github-copilot`. */
  readonly provider: string;
  /** Full native provider/model identity. */
  readonly model: string;
  /** Explicit HTTPS origins used by this native integration, including refresh. */
  readonly httpsDestinations: readonly string[];
}

export type SandboxOpenCodeAccount = Readonly<{
  kind: 'auth_export';
  path: string;
  credentialId: string;
  /** Access-token-only reuse is supported for the native OpenAI browser/headless OAuth methods. */
  lineage: 'caller_quiescent' | 'access_token_only';
}>;

/** Native credential import into a fresh database, for an explicitly selected provider/model. */
export interface SandboxOpenCodeConfiguredInput {
  readonly credential: SandboxApiKeyCredential | SandboxOpenCodeAccount;
  readonly selection: SandboxOpenCodeSelection;
  readonly preparation: Readonly<{ bootstrapExecutable: string; preparationTimeoutMs: number }>;
  readonly guestExecutable: '/opt/agenai/native/opencode';
  readonly task: string;
  readonly signal?: AbortSignal;
}
