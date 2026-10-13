// ------------------------------------------------------------------------------------------------
//                parse.ts - Public bounded policy parser
// ------------------------------------------------------------------------------------------------

import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationSchemaError } from "../shared/errors.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { PolicySnapshotSchema } from "./schemas.js";
import type { DelegationPolicySnapshot } from "./types.js";

export function parseDelegationPolicySnapshot(input: unknown): DelegationPolicySnapshot {
  const captured = copyBoundedDelegationData(input);
  const parsed = PolicySnapshotSchema.safeParse(captured);
  if (!parsed.success) return delegationSchemaError(parsed.error, captured);
  return freezeDelegationData(parsed.data);
}
