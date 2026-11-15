import type { AgentTurnId } from '@agen-ai/agent-protocol';
import type { AgentProviderSession } from '@agen-ai/agent-runtime';
import type { AcceptEditsReport, AcceptEditsStopCode } from './report.js';

/**
 * One stop request for the whole run: cancellation, the run deadline and every bound share it.
 * The interruption it starts is kept and joined before cleanup, never dropped.
 */
export class RunStopper {
  private readonly controller = new AbortController();
  private target: Readonly<{ session: AgentProviderSession; turnId: AgentTurnId }> | undefined;
  private interruption: Promise<void> = Promise.resolve();
  private interruptionStarted = false;
  private graceTimer: NodeJS.Timeout | undefined;
  private releaseGrace: () => void = () => {};
  /** Resolves `settleMs` after a stop request, so an unresponsive turn is closed by its owners. */
  readonly graceElapsed = new Promise<void>((resolve) => { this.releaseGrace = resolve; });

  constructor(private readonly report: AcceptEditsReport, private readonly settleMs: number) {}

  get signal(): AbortSignal { return this.controller.signal; }
  get stopped(): boolean { return this.report.stopCode !== null; }

  stop(code: AcceptEditsStopCode): void {
    if (this.report.stopCode !== null) return;
    this.report.stopCode = code;
    this.controller.abort(new Error(`Accept-edits run stopped: ${code}.`));
    this.graceTimer = setTimeout(this.releaseGrace, this.settleMs);
    this.interrupt();
  }

  /** Makes the active turn interruptible; a stop requested earlier interrupts it immediately. */
  attach(session: AgentProviderSession, turnId: AgentTurnId): void {
    this.target = { session, turnId };
    if (this.stopped) this.interrupt();
  }

  async join(): Promise<void> {
    await this.interruption;
    clearTimeout(this.graceTimer);
  }

  private interrupt(): void {
    const target = this.target;
    if (!target || this.interruptionStarted) return;
    this.interruptionStarted = true;
    this.report.interruption = 'requested';
    const { interruption } = target.session;
    this.interruption = Promise.resolve()
      .then(() => {
        if (interruption.kind !== 'supported') throw new Error('Turn interruption is unsupported.');
        return interruption.interruptTurn({ turnId: target.turnId, reason: 'user_requested' });
      })
      .then((result) => { this.report.interruption = result.status === 'failed' ? 'failed' : 'accepted'; },
        () => { this.report.interruption = 'failed'; });
  }
}
