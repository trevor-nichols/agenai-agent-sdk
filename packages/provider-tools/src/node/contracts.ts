// ------------------------------------------------------------------------------------------------
//                contracts.ts - Plain broker call, approval and receipt contracts for provider drivers
// ------------------------------------------------------------------------------------------------

import type { NodeProviderToolName } from '../types.js';

/** `automatic` applies unrestricted structured edits (provider_accept_edits); `host` asks for every edit. */
export type NodeProviderEditApproval = 'automatic' | 'host';

export type NodeProviderToolApprovalRequest =
  | Readonly<{ kind: 'command'; command: string }>
  | Readonly<{ kind: 'edit'; paths: readonly string[]; reason: 'host_policy' | 'restricted' }>
  | Readonly<{ kind: 'read'; path: string }>;

export type NodeProviderToolStart =
  | Readonly<{ kind: 'command'; command: string }>
  | Readonly<{ kind: 'edit'; paths: readonly string[] }>
  | Readonly<{ kind: 'read'; path: string }>
  | Readonly<{ kind: 'search'; path: string; pattern: string }>;

export interface NodeProviderToolObserver {
  /** Called once after the complete input validated and before any approval or effect. */
  started(start: NodeProviderToolStart): void;
  /**
   * The exact once-only host decision for this request. The signal aborts on cancellation or the
   * fixed approval expiry; the observer must then withdraw its request without an effect.
   */
  approve(request: NodeProviderToolApprovalRequest, signal: AbortSignal): Promise<'approved' | 'denied'>;
}

export interface NodeProviderToolCallInput {
  readonly tool: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly observer: NodeProviderToolObserver;
}

export type NodeProviderToolStatus = 'completed' | 'denied' | 'expired' | 'refused' | 'failed' | 'canceled';

export interface NodeProviderToolFileChange {
  readonly path: string;
  readonly change: 'created' | 'modified';
}

export interface NodeProviderToolCommandReceipt {
  readonly reason: 'exited' | 'timeout' | 'canceled' | 'spawn_failed';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
  readonly joined: boolean;
}

/**
 * Why the tools refused a call themselves, never offered to the host: input that does not parse, a path
 * outside the workspace, a session file restriction, or a session that no longer admits calls.
 */
export type NodeProviderToolRefusal = 'invalid_input' | 'outside_workspace' | 'restricted' | 'unavailable';

export interface NodeProviderToolResult {
  readonly tool: NodeProviderToolName | null;
  readonly status: NodeProviderToolStatus;
  /** Present only on the tools' own refusals; host denials, expiries and cancellations carry none. */
  readonly refusal?: NodeProviderToolRefusal;
  /** Bounded model-visible result text. */
  readonly text: string;
  readonly isError: boolean;
  /** Publications that are known to have occurred, in order, even when the call failed or fenced. */
  readonly changes: readonly NodeProviderToolFileChange[];
  readonly command?: NodeProviderToolCommandReceipt;
  /** Present when this call fenced the session or met an existing fence; later effects are refused. */
  readonly fence?: string;
}

export interface NodeProviderToolSession {
  /** Validates, decides, approves, performs and settles one call; at most one call is entered at a time. */
  call(input: NodeProviderToolCallInput): Promise<NodeProviderToolResult>;
  /** The reason later effects are refused, if a publication or join could not be settled. */
  readonly fence: string | undefined;
  /** Resolves when no call is entered or queued. */
  idle(): Promise<void>;
  /** Refuses new calls, withdraws approvals, stops commands, joins them and closes the helper. Retryable. */
  close(): Promise<void>;
}
