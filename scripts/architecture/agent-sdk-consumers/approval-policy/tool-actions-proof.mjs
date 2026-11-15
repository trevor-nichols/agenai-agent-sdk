import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runToolActionsProof({ consumerRoot, fixtureRoot, guard, exampleRoot }) {
  const testRoot = path.join(consumerRoot, exampleRoot, "native/tests");
  const { runToolActionsProof: runOwnedChildren } = await import(pathToFileURL(path.join(testRoot, "tool-actions-proof.js")).href);
  return runOwnedChildren({ fixtureRoot, guardFile: guard, childFile: path.join(testRoot, "tool-actions-child.js"), cwd: consumerRoot });
}
