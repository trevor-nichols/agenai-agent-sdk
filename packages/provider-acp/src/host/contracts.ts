import type { AcpJsonObject } from '@agen-ai/acp-transport';
import type { AgentAuthenticationFlow, AgentInstanceId, AgentSessionId } from '@agen-ai/agent-protocol';
import type { MaybePromise } from '@agen-ai/agent-runtime';

export type AcpHostInteractionScope =
  | Readonly<{ kind: 'authentication'; attemptId: string; flow: AgentAuthenticationFlow }>
  | Readonly<{ kind: 'session'; sessionId: AgentSessionId; workingDirectory: string }>;

export interface AcpHostInteractionInput {
  readonly instanceId: AgentInstanceId;
  readonly scope: AcpHostInteractionScope;
  readonly signal: AbortSignal;
}

export type AcpHostFormResponse =
  | Readonly<{ action: 'accept'; content: AcpJsonObject }>
  | Readonly<{ action: 'decline' | 'cancel' }>;

export interface AcpHostFormInput extends AcpHostInteractionInput {
  readonly message: string;
  readonly requestedSchema: AcpJsonObject;
}

export type AcpHostUrlDecision = 'accept' | 'decline' | 'cancel';

/** The host presents consent before opening the URL and never prefetches it. */
export interface AcpHostUrlInteractionLease {
  readonly decision: Promise<AcpHostUrlDecision>;
  readonly complete?: () => MaybePromise<void>;
  /** Idempotent; closes the interaction's owned UI resources. */
  readonly release: () => MaybePromise<void>;
}

export interface AcpHostUrlInput extends AcpHostInteractionInput {
  readonly message: string;
  readonly url: string;
  readonly elicitationId: string;
}

export interface AcpHostSessionInput {
  readonly instanceId: AgentInstanceId;
  readonly sessionId: AgentSessionId;
  readonly workingDirectory: string;
  readonly signal: AbortSignal;
}

export interface AcpHostFileReadInput extends AcpHostSessionInput {
  readonly path: string;
  /** Reject reads that cannot be returned within this serialized response budget. */
  readonly maxBytes: number;
  readonly line?: number;
  readonly limit?: number;
}

export interface AcpHostFileWriteInput extends AcpHostSessionInput {
  readonly path: string;
  readonly content: string;
}

export interface AcpHostTerminalExitStatus {
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface AcpHostTerminalOutput {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus?: AcpHostTerminalExitStatus;
}

/** A complete terminal facility; kill retains the handle, release invalidates it. */
export interface AcpHostTerminalLease {
  readonly output: (signal: AbortSignal) => MaybePromise<AcpHostTerminalOutput>;
  readonly waitForExit: (signal: AbortSignal) => MaybePromise<AcpHostTerminalExitStatus>;
  readonly kill: (signal: AbortSignal) => MaybePromise<void>;
  /** Idempotent, kills a running process and releases all owned resources. */
  readonly release: () => MaybePromise<void>;
}

export interface AcpHostTerminalCreateInput extends AcpHostSessionInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly outputByteLimit: number;
}

export interface AcpHostAuthenticationTerminalLease {
  readonly exited: Promise<AcpHostTerminalExitStatus>;
  /** Idempotent; terminates a running login process and releases its terminal. */
  readonly release: () => MaybePromise<void>;
}

export interface AcpHostAuthenticationTerminalInput extends AcpHostInteractionInput {
  readonly scope: Extract<AcpHostInteractionScope, { kind: 'authentication' }>;
  readonly methodId: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Every callback runs under host policy; providing it grants only that explicit facility. */
export interface AcpHostFacilities {
  readonly form?: (input: AcpHostFormInput) => MaybePromise<AcpHostFormResponse>;
  readonly url?: (input: AcpHostUrlInput) => MaybePromise<AcpHostUrlInteractionLease>;
  readonly readTextFile?: (input: AcpHostFileReadInput) => MaybePromise<string>;
  readonly writeTextFile?: (input: AcpHostFileWriteInput) => MaybePromise<void>;
  readonly createTerminal?: (input: AcpHostTerminalCreateInput) => MaybePromise<AcpHostTerminalLease>;
  /** Reproduces the host-configured agent invocation, appending args and overriding env. */
  readonly authenticateInTerminal?: (input: AcpHostAuthenticationTerminalInput) => MaybePromise<AcpHostAuthenticationTerminalLease>;
}

export type AcpAuthenticationMethods = Readonly<Partial<Record<AgentAuthenticationFlow, Readonly<{ methodId: string }>>>>;
