// ------------------------------------------------------------------------------------------------
//                types.ts - Native process inputs, binary streams and leader exit receipts
// ------------------------------------------------------------------------------------------------

import type { Readable, Writable } from 'node:stream';
import type { OperationOptions } from '../contracts.js';
import type { SandboxGuestPath } from '../files/types.js';
import type { SandboxProcessId } from '../policy/types.js';

export interface SandboxProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface SandboxProcessSpec extends Omit<SandboxProcessInput, 'executable' | 'cwd'> {
  readonly executable: SandboxGuestPath;
  readonly cwd: SandboxGuestPath;
}

export type SandboxProcessExit =
  | Readonly<{ kind: 'exited'; code: number }>
  | Readonly<{ kind: 'signaled'; signal: string }>
  | Readonly<{ kind: 'unavailable'; reason: 'sandbox_stopped' }>;

export interface SandboxProcessStreams {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** The leader's exit observation does not establish descendant quiescence. */
  readonly exit: Promise<SandboxProcessExit>;
}

export interface SandboxProcessReservation {
  readonly id: SandboxProcessId;
  readonly stopScope: 'sandbox';
  start(options?: OperationOptions): Promise<SandboxProcessStreams>;
  stop(): Promise<void>;
}
