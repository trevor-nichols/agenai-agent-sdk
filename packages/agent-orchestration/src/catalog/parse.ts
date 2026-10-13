// ------------------------------------------------------------------------------------------------
//                parse.ts - Public bounded certified-target parser
// ------------------------------------------------------------------------------------------------

import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationSchemaError } from "../shared/errors.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { TargetCatalogSchema } from "./schemas.js";
import type { DelegationTargetCatalog } from "./types.js";

export function parseDelegationTargetCatalog(input: unknown): DelegationTargetCatalog {
  const captured = copyBoundedDelegationData(input);
  const parsed = TargetCatalogSchema.safeParse(captured);
  if (!parsed.success) return delegationSchemaError(parsed.error, captured);
  return freezeDelegationData(parsed.data);
}
