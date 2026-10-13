// ------------------------------------------------------------------------------------------------
//                guidance.ts - Truthful generated managed and native tool instructions
// ------------------------------------------------------------------------------------------------

import type { DelegationBindingSnapshot } from "../coordinator/types.js";
import { DELEGATION_TOOL_NAMES } from "./schemas.js";

export function validateNativeToolNames(input: readonly string[] | undefined): readonly string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 32) throw new TypeError("Native tool names require a bounded array.");
  const names = [...input];
  if (new Set(names).size !== names.length
    || names.some((name) => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)
      || (DELEGATION_TOOL_NAMES as readonly string[]).includes(name))) {
    throw new TypeError("Native tool names must be bounded, unique, and distinct from managed tool names.");
  }
  return names;
}

export function delegationGuidance(snapshot: DelegationBindingSnapshot, nativeTools: readonly string[]): string {
  return [
    "Managed delegation is optional and governed by current host and user policy. These instructions do not grant execution or approval authority.",
    "Use delegation_targets to obtain currently permitted exact target references and policyRevision. An emptyReason of delegation_disabled means delegation is disabled; no_permitted_targets means it is enabled but current policy permits no targets. Unknown semantics remain unknown; do not infer capability from a label. Fast execution requires explicit selection.",
    "Use delegate_task for independent child work. Required operationId is a caller-chosen UUID: choose it once for an action, retain it, and reuse it only with identical arguments for an exact retry. Never invent a fresh operation ID to retry an uncertain result.",
    `Task text is bounded to ${snapshot.limits.maxInputBytes} serialized input bytes and ${snapshot.limits.maxInputTextCharacters} characters in total; prompt, message, and context each allow at most 16 KiB UTF-8. Context is ordinary task input.`,
    `Completion defaults to collect. Available completion policies: ${snapshot.completionPolicies.join(", ")}. Collect results with task_status; next_turn and automatic, when available, only enqueue through the host inbox and do not prove parent consumption or start a parent model turn.`,
    `task_status may wait at most ${snapshot.limits.maxWaitMs} ms. A timeout or canceled tool invocation does not cancel the child. Follow returned cursors for complete target and run history; a truncated result summary is explicitly marked and references remain available.`,
    "task_send steer applies only to a supported active turn and never falls back to a queue. next_turn reserves a later run; follow_up requires a definitive settled, safely resumable conversation. delivered, queued, rejected, and delivery_uncertain have distinct meanings. Inspect delivery_uncertain or recovery_required; do not replay uncertain work.",
    "A waiting approval or elicitation requires the host's live request channel. These tools cannot approve, authenticate, choose executable commands, change policy, or resolve a request handle.",
    "task_cancel requests interruption. requested does not mean stopped; confirmed requires terminal evidence, and recovery_required means stop is unproven. Retain the canonical accepted cancellation operation ID for retries. Existing status and cancellation access can remain available after delegation is disabled.",
    nativeTools.length === 0
      ? "No native collaboration tool names were certified for this binding. These managed tools make no claim about native tool availability."
      : `The host certifies these independent native tools in this session: ${nativeTools.join(", ")}. Use their native descriptions for native collaboration; managed tools do not replace or alter them.`,
  ].join("\n\n");
}
