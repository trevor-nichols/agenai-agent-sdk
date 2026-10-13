// ------------------------------------------------------------------------------------------------
//                schemas.ts - Internal delegation scalar and uniqueness rules
// ------------------------------------------------------------------------------------------------

import { z } from "zod/v4";

const canonicalPattern = /^(?![\s\S]*[\u0000-\u001F\u007F-\u009F])\S(?:[\s\S]*\S)?$/u;
const canonicalMessage = "Delegation text must be canonical and contain no control or surrounding whitespace.";

export const CanonicalIdSchema = z.string().min(1).max(256).regex(canonicalPattern, canonicalMessage);
export const ReasoningSchema = z.string().min(1).max(128).regex(canonicalPattern, canonicalMessage);
export const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ExecutionModeSchema = z.enum(["standard", "fast"]);
export const ReasonTextSchema = z.string().min(1).max(2_000).regex(canonicalPattern, canonicalMessage);

export function requireUniqueValues(values: readonly string[], context: z.RefinementCtx, path: readonly (string | number)[]): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) context.addIssue({ code: "custom", path: [...path, index], message: "Delegation identities must be unique." });
    seen.add(value);
  }
}
