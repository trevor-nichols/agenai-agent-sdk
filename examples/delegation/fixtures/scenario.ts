// ------------------------------------------------------------------------------------------------
//                scenario.ts - Separate executor entrypoint for durable crash qualification
// ------------------------------------------------------------------------------------------------

import { crashAt, recoverCrash } from "./crash.js";
import { ownershipScenario } from "./ownership.js";
import { crashInbox, recoverInbox } from "./inboxCrash.js";
import { reopenDurableFailure, settleDurableFailure } from "./failure.js";
import { failRequestReceipt, recoverRequestReceipt, retainWithdrawnRequestReceipt, recoverWithdrawnRequestReceipt } from "./requestRecovery.js";

const [root, mode, encoded] = process.argv.slice(2);
if (!root || !mode) throw new Error("A qualification root and scenario are required.");
const options = JSON.parse(encoded ?? "{}") as Record<string, unknown>;
try {
  if (mode === "request_withdrawal" || mode === "recover_request_withdrawal") {
    const detail = mode === 'request_withdrawal' ? await retainWithdrawnRequestReceipt(root) : await recoverWithdrawnRequestReceipt(root);
    process.send?.({ event: 'complete', detail });
    process.disconnect?.();
  } else if (mode === "request_receipt_failure" || mode === "recover_request_receipt") {
    const loss = options.loss;
    if (loss !== 'before_commit' && loss !== 'after_commit') throw new Error('A request receipt loss boundary is required.');
    const detail = mode === 'request_receipt_failure' ? await failRequestReceipt(root, loss) : await recoverRequestReceipt(root, loss);
    process.send?.({ event: 'complete', detail });
    process.disconnect?.();
  } else if (mode === "settle_failure" || mode === "reopen_failure") {
    const policy = options.policy;
    if (policy !== "collect" && policy !== "next_turn" && policy !== "automatic") throw new Error("A valid failure completion policy is required.");
    const detail = mode === "settle_failure" ? await settleDurableFailure(root, policy) : await reopenDurableFailure(root, policy);
    process.send?.({ event: "complete", detail });
    process.disconnect?.();
  } else if (mode === "recover" || mode === "recover_inbox" || ["owner", "contender", "takeover"].includes(mode)) {
    const detail = mode === "recover" ? await recoverCrash(root, String(options.stage))
      : mode === "recover_inbox" ? await recoverInbox(root, String(options.stage)) : await ownershipScenario(root, mode);
    process.send?.({ event: "complete", detail });
    process.disconnect?.();
  } else if (["inbox_accept", "inbox_accept_expired", "parent_intent", "accepted_revoked", "future_retry"].includes(mode)) await crashInbox(root, mode);
  else await crashAt(root, mode);
} catch (error) {
  process.send?.({ event: "error", detail: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined } });
  process.exitCode = 1;
  process.disconnect?.();
}
