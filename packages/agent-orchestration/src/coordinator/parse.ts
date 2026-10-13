// ------------------------------------------------------------------------------------------------
//                parse.ts - Bounded public coordinator input capture
// ------------------------------------------------------------------------------------------------

import { AgentRequestResolutionSchema, AgentTurnInputContentSchema } from "@agen-ai/agent-protocol/zod";
import { z } from "zod/v4";
import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationSchemaError } from "../shared/errors.js";
import { delegationDataBytes } from "../shared/identity.js";
import type { DelegationLimits } from "../shared/limits.js";
import { failDelegation } from "../shared/operational-errors.js";
import { CompletionPolicySchema, TargetReferenceSchema } from "../tasks/schemas.js";
import type { DelegationSendTaskInput, DelegationSpawnTaskInput } from "./types.js";

const operation = z.uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timeout = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const spawn: z.ZodType<DelegationSpawnTaskInput> = z.strictObject({
  operationId: operation, target: TargetReferenceSchema, expectedPolicyRevision: revision,
  input: AgentTurnInputContentSchema, completionPolicy: CompletionPolicySchema.optional(), timeoutMs: timeout.optional(),
});
const send: z.ZodType<DelegationSendTaskInput> = z.strictObject({
  operationId: operation, taskId: z.uuid(), mode: z.enum(["steer", "next_turn", "follow_up"]),
  input: AgentTurnInputContentSchema, target: TargetReferenceSchema, expectedPolicyRevision: revision,
});

export function parseCoordinatorInput<Value>(schema: z.ZodType<Value>, input: unknown): Value {
  const captured = copyBoundedDelegationData(input);
  const parsed = schema.safeParse(captured);
  if (!parsed.success) return delegationSchemaError(parsed.error, captured);
  return parsed.data;
}

function inputLimit(input: DelegationSpawnTaskInput["input"], limits: DelegationLimits): void {
  const characters = input.parts.reduce((count, part) => count + (part.type === "text" ? part.text.length : 0), input.summary?.length ?? 0);
  if (delegationDataBytes(input) > limits.maxInputBytes || characters > limits.maxInputTextCharacters) {
    failDelegation("capacity_exceeded", "Managed task input exceeds its configured content limit.");
  }
}

export function parseSpawnTaskInput(input: unknown, limits: DelegationLimits): DelegationSpawnTaskInput {
  const parsed = parseCoordinatorInput(spawn, input);
  inputLimit(parsed.input, limits);
  if (parsed.timeoutMs !== undefined && parsed.timeoutMs > limits.runTimeoutMs) failDelegation("capacity_exceeded", "Task timeout exceeds the configured run deadline.");
  return parsed;
}

export function parseSendTaskInput(input: unknown, limits: DelegationLimits): DelegationSendTaskInput {
  const parsed = parseCoordinatorInput(send, input);
  inputLimit(parsed.input, limits);
  return parsed;
}

export const parseOperationId = (input: unknown): string => parseCoordinatorInput(operation, input);
export const parseTaskId = (input: unknown): string => parseCoordinatorInput(z.uuid(), input);
export const parseRequestResolution = (input: unknown) => parseCoordinatorInput(AgentRequestResolutionSchema, input);
