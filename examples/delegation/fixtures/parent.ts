// ------------------------------------------------------------------------------------------------
//                parent.ts - Fresh file-backed parent authority and observable native dispatch
// ------------------------------------------------------------------------------------------------

import type { ParentDestination, ParentInboxHost } from "../inbox/index.js";
import { persistJson, readJson, recordInvocation } from "./journal.js";

export const idleParent: ParentDestination = { revision: 1, lifecycle: "idle", resultAccess: true, executionAllowed: true };
export const setParent = (root: string, state: ParentDestination) => persistJson(root, "parent-authority.json", state);

export function createParentHost(root: string, options: { readonly onDispatch?: () => void | Promise<void> } = {}) {
  let owned = false;
  let releases = 0;
  const host: ParentInboxHost = {
    inspectParent: () => readJson<ParentDestination>(root, "parent-authority.json"),
    acquireTurn() {
      if (owned) return undefined;
      owned = true;
      const revision = readJson<ParentDestination>(root, "parent-authority.json").revision;
      const signal = new AbortController().signal;
      function assertCurrent() {
        const current = readJson<ParentDestination>(root, "parent-authority.json");
        if (!owned || current.revision !== revision || current.lifecycle !== "idle" || !current.executionAllowed || !current.resultAccess) {
          throw new Error("Current parent execution authority is unavailable.");
        }
      }
      return { signal, assertCurrent, async dispatch() {
        assertCurrent();
        recordInvocation(root, "parent");
        await options.onDispatch?.();
        return { status: "acknowledged" as const };
      }, release() { if (owned) { owned = false; releases += 1; } } };
    },
  };
  return { host, releases: () => releases };
}
