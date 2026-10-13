// ------------------------------------------------------------------------------------------------
//                publicApi.typecheck.ts - Plain, immutable public policy contracts
// ------------------------------------------------------------------------------------------------

import { parseAgentInstanceId, parseAgentSessionId, type AgentInstanceId } from "@agen-ai/agent-protocol";
import {
  DelegationValidationError,
  parseDelegationPolicySnapshot,
  parseDelegationTargetCatalog,
  resolveDelegationPolicy,
  type DelegationReasoning,
  type DelegationSemanticFact,
  type DelegationTargetCatalog,
  type DelegationUserSelection,
} from "../src/index.js";

const providerReasoning: DelegationReasoning = "future-harness-reasoning";
const unknown: DelegationSemanticFact<DelegationReasoning> = { kind: "unknown" };
void providerReasoning;
// @ts-expect-error Unknown semantic facts have no certified identity.
unknown.value;

const catalog: DelegationTargetCatalog = parseDelegationTargetCatalog({ catalogId: "catalog", revision: 1, targets: [] });
const policy = parseDelegationPolicySnapshot({ revision: 1 });
const result = resolveDelegationPolicy({ catalog, policy });
// @ts-expect-error Consumers cannot mutate published target collections.
catalog.targets.push({});
// @ts-expect-error Resolved admission mappings are immutable.
result.allowedTargets[0]!.reference.sourceRevision = 2;
// @ts-expect-error Resolver results are plain data, not validator schemas.
result.safeParse({});

const explicit: DelegationUserSelection = { kind: "explicit", targets: [] };
// @ts-expect-error Explicit selections do not carry a wildcard fast switch.
explicit.includeFast;
const instance: AgentInstanceId = parseAgentInstanceId("instance");
void instance;
// @ts-expect-error Native/session identities cannot select an authorized instance.
const wrongInstance: AgentInstanceId = parseAgentSessionId("session");
void wrongInstance;

const error = new DelegationValidationError([{ code: "invalid", path: ["catalogId"], message: "Invalid catalog identity." }]);
error.issues satisfies readonly { readonly code: string; readonly path: readonly (string | number)[]; readonly message: string }[];
