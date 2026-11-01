// Record the complete copied public example tree, including nested programs and assets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function copyPublicExampleSources(source, destination) {
  await cp(source, destination, { recursive: true, filter: async (entry) => {
    if (path.basename(entry) === "node_modules") return false;
    const state = await lstat(entry);
    assert(!state.isSymbolicLink(), "Public example sources cannot borrow a mutable symlink target.");
    assert(state.isDirectory() || state.isFile(), "Public examples contain only ordinary source files and directories.");
    return true;
  } });
}

export async function sandboxExampleSourceIdentities(consumerRoot) {
  const root = path.join(consumerRoot, "examples/sandbox");
  const state = await lstat(root);
  assert(state.isDirectory() && !state.isSymbolicLink(), "Sandbox example evidence requires a physical source directory.");
  async function visit(relative) {
    const identities = [];
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const file = path.posix.join(relative, entry.name);
      assert(!entry.isSymbolicLink(), "Sandbox example evidence cannot borrow a mutable symlink target.");
      if (entry.isDirectory()) identities.push(...await visit(file));
      else {
        assert(entry.isFile(), "Sandbox examples contain only ordinary source files and directories.");
        const bytes = await readFile(path.join(root, file));
        identities.push({ path: `examples/sandbox/${file}`, bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
    return identities;
  }
  return (await visit("")).sort((left, right) => left.path.localeCompare(right.path, "en"));
}
