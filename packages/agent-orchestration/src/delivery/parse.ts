// ------------------------------------------------------------------------------------------------
//                parse.ts - Bounded validator-neutral parent inbox results
// ------------------------------------------------------------------------------------------------

import { z } from "zod/v4";
import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationSchemaError } from "../shared/errors.js";
import { delegationDataBytes } from "../shared/identity.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { AtSchema, OpaqueIdSchema } from "../tasks/schemas.js";
import type { DelegationInboxAcceptance, DelegationInboxInspection } from "./types.js";

const accepted = z.strictObject({ status: z.literal("accepted"), inboxId: OpaqueIdSchema, acceptedAt: AtSchema });
const rejected = z.strictObject({ status: z.literal("rejected"), reason: z.enum(["revoked", "parent_retired", "expired", "dismissed"]) });
const acceptance: z.ZodType<DelegationInboxAcceptance> = z.discriminatedUnion("status", [accepted, rejected,
  z.strictObject({ status: z.literal("blocked"), reason: z.enum(["busy", "authority_unavailable", "capacity"]), retryAt: AtSchema }),
  z.strictObject({ status: z.literal("uncertain") }),
]).refine((value) => delegationDataBytes(value) <= 2_048, "Inbox result exceeds its bounded receipt.");
const inspection: z.ZodType<DelegationInboxInspection> = z.discriminatedUnion("status", [accepted, rejected,
  z.strictObject({ status: z.literal("absent") }),
]).refine((value) => delegationDataBytes(value) <= 2_048, "Inbox inspection exceeds its bounded receipt.");

function parse<Value>(schema: z.ZodType<Value>, input: unknown): Value {
  const captured = copyBoundedDelegationData(input);
  const result = schema.safeParse(captured);
  if (!result.success) return delegationSchemaError(result.error, captured);
  return freezeDelegationData(result.data);
}

export const parseDelegationInboxAcceptance = (input: unknown): DelegationInboxAcceptance => parse(acceptance, input);
export const parseDelegationInboxInspection = (input: unknown): DelegationInboxInspection => parse(inspection, input);
