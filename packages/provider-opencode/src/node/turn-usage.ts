// ------------------------------------------------------------------------------------------------
//                turn-usage.ts - One turn's usage accounting: arrival judgement, readback and ordered outputs
// ------------------------------------------------------------------------------------------------

import type { AgentTokenUsageObservation, AgentTurnId } from '@agen-ai/agent-protocol';
import { AgentProviderContractError, createAgentEventOutput, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import { NativeFailure } from './errors.js';
import type { turnEvents } from './events.js';
import type { TurnHost } from './turn.js';
import type { OpenCodeTurnOutcome, UsageEvent } from './usage.js';

export class TurnUsage {
  /** The first usage contract violation; the turn rethrows it once its owned work settled. */
  failure: AgentProviderContractError | undefined;

  constructor(
    private readonly host: TurnHost,
    private readonly turnId: AgentTurnId,
    private readonly event: ReturnType<typeof turnEvents>,
    private readonly refuse: (code: string, message: string) => void,
  ) {
    host.usage.beginTurn(turnId);
  }

  /** Usage is judged at arrival, paused or settling; a contract violation fences the session and ends the turn. */
  account(event: UsageEvent): void {
    try {
      if (!this.host.usage.admit(event)) this.refuse('opencode_model_drift', 'OpenCode ran a model step on another model.');
    } catch (cause) {
      if (!(cause instanceof AgentProviderContractError)) throw cause;
      this.failure ??= cause;
      this.refuse(cause.code, cause.message);
    }
  }

  /** Session totals that arrived since the last turn reported them. */
  pending(): AgentProviderOutput[] {
    return this.host.usage.pending({ sessionId: this.host.sessionId, turnId: this.turnId, occurredAt: new Date().toISOString() })
      .map((event) => createAgentEventOutput(event));
  }

  /**
   * After owned work settled: one bounded session readback, then the session snapshot and this
   * turn's model steps. Without a native result there is nothing to read back; a missing readback
   * leaves the streamed totals.
   */
  async settle(outcome: OpenCodeTurnOutcome | undefined, readable: boolean): Promise<AgentProviderOutput[]> {
    if (outcome && readable) {
      const baseline = this.host.usage.readbackBaseline();
      try {
        const readback = await this.host.native.readSession();
        if (readback.kind === 'available') this.host.usage.readback(this.host.native.sessionID, readback.session, baseline);
      } catch (cause) {
        if (cause instanceof AgentProviderContractError) { this.host.fail(cause.code); throw cause; }
        const code = cause instanceof NativeFailure && cause.stage === 'capacity' ? 'usage_capacity_exceeded' : 'usage_invalid';
        this.host.fail(code);
        this.host.usage.rejectReadback(code);
      }
    }
    if (this.failure) throw this.failure;
    const steps = this.outputs(() => this.host.usage.settle(outcome ?? 'lost'));
    return [...this.pending(), ...steps];
  }

  abandon(unprompted = false): void {
    this.host.usage.abandon(this.turnId, unprompted);
  }

  private outputs(observations: () => readonly AgentTokenUsageObservation[]): AgentProviderOutput[] {
    try {
      return observations().map((observation) => this.event('usage.observed', observation));
    } catch (cause) {
      this.host.fail(cause instanceof AgentProviderContractError ? cause.code : 'usage_invalid');
      throw cause;
    }
  }
}
