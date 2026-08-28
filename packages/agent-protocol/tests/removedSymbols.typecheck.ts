// ------------------------------------------------------------------------------------------------
//                removedSymbols.typecheck.ts - V4 hard-cut compile proofs
// ------------------------------------------------------------------------------------------------

import * as protocol from "../src/public/index.js";

// @ts-expect-error Provider queue modes were deleted in Agent Protocol V4.
protocol.AGENT_ACTIVE_INPUT_MODES;

// @ts-expect-error Active-input modes were deleted in Agent Protocol V4.
type RemovedActiveInputMode = protocol.AgentActiveInputMode;

// @ts-expect-error Active-input capabilities were deleted in Agent Protocol V4.
type RemovedActiveInputCapability = protocol.AgentActiveInputCapability;

void (null as unknown as RemovedActiveInputMode);
void (null as unknown as RemovedActiveInputCapability);
