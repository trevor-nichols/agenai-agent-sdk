// ------------------------------------------------------------------------------------------------
//                ledgerState.ts - Opaque immutable ledger handles - Dependencies: scope accounting
// ------------------------------------------------------------------------------------------------

import type {
  AgentSessionId,
  AgentTokenUsageCounterName,
  AgentTokenUsageScopeKind,
  AgentTokenUsageView,
  AgentUsageObservationId,
  AgentUsageScopeId,
  AgentUsageViewId,
} from "@agen-ai/agent-protocol";

import type { ScopeAccounting, ScopeContribution } from "./scopeAccounting.js";
import type { AgentTokenUsageLedger, AgentTokenUsageViewSummary } from "./types.js";

export type CounterMagnitude = Readonly<Record<AgentTokenUsageCounterName, number>>;

export interface UsageViewState {
  readonly canonical: string;
  readonly view: AgentTokenUsageView;
  readonly scopeKind: AgentTokenUsageScopeKind;
  readonly scopeIds: readonly AgentUsageScopeId[];
  readonly magnitude: CounterMagnitude;
}

export interface UsageScopeState {
  readonly canonical: string;
  readonly viewId: AgentUsageViewId;
  readonly final: boolean;
  readonly accounting: ScopeAccounting;
  readonly contribution: ScopeContribution;
  readonly magnitude: CounterMagnitude;
}

export interface UsageLedgerState {
  readonly sessionId: AgentSessionId;
  /** Canonical JSON of every admitted observation, keyed by its identity. */
  readonly observations: ReadonlyMap<AgentUsageObservationId, string>;
  readonly snapshotRevisions: ReadonlySet<string>;
  readonly retainedBytes: number;
  readonly views: ReadonlyMap<AgentUsageViewId, UsageViewState>;
  readonly scopes: ReadonlyMap<AgentUsageScopeId, UsageScopeState>;
  /** Views whose scopes name the key as their container. */
  readonly containers: ReadonlyMap<AgentUsageScopeId, readonly AgentUsageViewId[]>;
  readonly semanticScopes: ReadonlySet<string>;
  readonly authoritativeViewId: AgentUsageViewId | null;
}

type Summarize = () => AgentTokenUsageViewSummary;

// Assigned once by the handle's static block, so ledger state stays unreachable by reflection.
let unwrapHandle: (ledger: unknown) => Readonly<{
  state: UsageLedgerState;
  summary: (viewId: AgentUsageViewId, summarize: Summarize) => AgentTokenUsageViewSummary;
}>;

class TokenUsageLedgerHandle {
  readonly #state: UsageLedgerState;
  /** Summaries are pure functions of this handle's immutable state. */
  readonly #summaries = new Map<AgentUsageViewId, AgentTokenUsageViewSummary>();

  constructor(state: UsageLedgerState) {
    this.#state = state;
    Object.freeze(this);
  }

  static {
    unwrapHandle = (ledger) => {
      if (typeof ledger !== "object" || ledger === null || !(#state in ledger)) {
        throw new TypeError("Expected a token usage ledger.");
      }
      const handle = ledger as TokenUsageLedgerHandle;
      return {
        state: handle.#state,
        summary(viewId, summarize) {
          const retained = handle.#summaries.get(viewId);
          if (retained !== undefined) return retained;
          const summary = summarize();
          handle.#summaries.set(viewId, summary);
          return summary;
        },
      };
    };
  }
}

/** The brand is type-only; this module is the ledger's sole runtime constructor. */
export const wrapUsageLedger = (state: UsageLedgerState): AgentTokenUsageLedger =>
  new TokenUsageLedgerHandle(state) as unknown as AgentTokenUsageLedger;
export const usageLedgerState = (ledger: AgentTokenUsageLedger): UsageLedgerState => unwrapHandle(ledger).state;
export const memoizedUsageSummary = (
  ledger: AgentTokenUsageLedger,
  viewId: AgentUsageViewId,
  summarize: Summarize,
): AgentTokenUsageViewSummary => unwrapHandle(ledger).summary(viewId, summarize);
