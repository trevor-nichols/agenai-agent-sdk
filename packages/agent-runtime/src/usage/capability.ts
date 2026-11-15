// ------------------------------------------------------------------------------------------------
//                capability.ts - Declared token-usage view matching - Dependencies: agent-protocol
// ------------------------------------------------------------------------------------------------

import {
  AGENT_TOKEN_USAGE_COUNTERS,
  type AgentTokenUsageCapability,
  type AgentTokenUsageCounterName,
  type AgentTokenUsageCounters,
  type AgentTokenUsageObservation,
} from "@agen-ai/agent-protocol";

import { canonicalUsageJson } from "./canonical.js";

/** A listed counter is never unsupported; an unlisted counter is always unavailable/unsupported. */
function countersMatch(
  counters: AgentTokenUsageCounters,
  reported: ReadonlySet<AgentTokenUsageCounterName>,
  exempt: ReadonlySet<AgentTokenUsageCounterName>,
): boolean {
  return AGENT_TOKEN_USAGE_COUNTERS.every((name) => {
    if (exempt.has(name)) return true;
    const count = counters[name];
    const unsupported = count.kind === "unavailable" && count.reasons[0] === "unsupported";
    return reported.has(name) !== unsupported;
  });
}

const NO_EXEMPTION: ReadonlySet<AgentTokenUsageCounterName> = new Set();
/** Model rows cannot count SDK turns; the protocol already fixes their turns as unsupported. */
const ROW_EXEMPTION: ReadonlySet<AgentTokenUsageCounterName> = new Set(["turns"]);

export function isTokenUsageObservationDeclared(
  capability: AgentTokenUsageCapability,
  observation: AgentTokenUsageObservation,
): boolean {
  if (capability.kind !== "supported") return false;
  const declared = capability.views.find((entry) => entry.view.viewId === observation.view.viewId);
  if (declared === undefined || declared.scopeKind !== observation.scope.kind) return false;
  if (canonicalUsageJson(declared.view) !== canonicalUsageJson(observation.view)) return false;
  const { measurement } = observation;
  if (measurement.kind === "unavailable") return true;
  const reported = new Set(declared.reportedCounters);
  if (!countersMatch(measurement.counters, reported, NO_EXEMPTION)) return false;
  const { attribution } = measurement;
  if (!declared.attribution.includes(attribution.kind)) return false;
  return attribution.kind !== "mixed"
    || attribution.rows.every((row) => countersMatch(row.counters, reported, ROW_EXEMPTION));
}
