// ------------------------------------------------------------------------------------------------
//                bridges-proof.mjs - Exact optional native bridge examples against packed packages
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { packedOverridesSource } from "../dependency-baseline.mjs";

async function runCompiledTests({ root, directory, guard, run, selectedTests, ownedFixtureRoot }) {
  const available = (await readdir(path.join(root, directory))).filter((name) => name.endsWith(".test.js")).sort();
  const tests = selectedTests ?? available;
  assert.ok(tests.length > 0, "The bridge example must exercise its public composition");
  assert(tests.every((name) => available.includes(name)), "Selected bridge tests must exist in the compiled consumer");
  const runner = path.join(root, `${path.basename(path.dirname(directory))}${ownedFixtureRoot ? "-files" : ""}-tests.mjs`);
  const temporaryEnvironment = ownedFixtureRoot
    ? ["TMPDIR", "TMP", "TEMP"].map((name) => `process.env.${name} = ${JSON.stringify(ownedFixtureRoot)};`).join("\n")
    : "";
  await writeFile(runner, `${temporaryEnvironment}\n${tests.map((name) => `await import(${JSON.stringify(`./${directory}/${name}`)});`).join("\n")}\n`, { flag: "wx" });
  const permission = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const result = await run(process.execPath, [permission, `--allow-fs-read=${root}`,
    ...(ownedFixtureRoot ? [`--allow-fs-write=${ownedFixtureRoot}`] : []), "--import", guard, runner],
    { cwd: root, timeoutMs: 60_000 });
  process.stdout.write(result.stdout);
  if (ownedFixtureRoot) assert.deepEqual(await readdir(ownedFixtureRoot), [], "Credential fixture sources must be removed after the tests settle");
  return { files: tests, processAndNetwork: "prohibited", filesystem: ownedFixtureRoot ? "owned_credential_fixtures" : "read_only_consumer" };
}

async function exampleIdentities(root, entry, result = []) {
  for (const child of (await readdir(path.join(root, entry), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    assert.ok(!child.isSymbolicLink(), "Example evidence requires ordinary source files");
    if (child.name === "node_modules" || child.name === "dist") continue;
    const relative = path.join(entry, child.name);
    if (child.isDirectory()) await exampleIdentities(root, relative, result);
    else if (child.isFile()) result.push({ path: relative, sha256: createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex") });
  }
  return result;
}

export async function runSandboxBridgeExamples({ repoRoot, consumerRoot, run }) {
  const guard = path.join(consumerRoot, "sandbox-bridge-guard.mjs");
  await copyFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/neutral-guard.mjs"), guard);
  const grok = await runCompiledTests({ root: consumerRoot, directory: "platform-dist/examples/sandbox/grok/tests", guard, run });
  const shared = await runCompiledTests({ root: consumerRoot, directory: "platform-dist/examples/sandbox/credentials/tests", guard, run });
  const codexDirectory = "platform-dist/examples/sandbox/codex/tests";
  const codexMemoryTests = (await readdir(path.join(consumerRoot, codexDirectory)))
    .filter((name) => name.endsWith(".test.js") && name !== "auth-file.test.js").sort();
  const codexMemory = await runCompiledTests({ root: consumerRoot, directory: codexDirectory, guard, run, selectedTests: codexMemoryTests });
  const ownedFixtureRoot = path.join(consumerRoot, "credential-fixtures");
  await mkdir(ownedFixtureRoot, { mode: 0o700 });
  const codexFiles = await runCompiledTests({ root: consumerRoot, directory: codexDirectory, guard, run,
    selectedTests: ["auth-file.test.js"], ownedFixtureRoot });

  const root = path.join(consumerRoot, "claude-bridge-consumer");
  await mkdir(root);
  const example = path.join(consumerRoot, "examples/sandbox/claude");
  await cp(example, root, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const consumer = JSON.parse(await readFile(path.join(consumerRoot, "package.json"), "utf8"));
  const packages = Object.fromEntries(["@agen-ai/sandbox", "@agen-ai/validation"].map((name) => {
    assert.ok(consumer.dependencies[name]?.startsWith("file:"), "Bridge proof requires packed SDK archives");
    return [name, consumer.dependencies[name]];
  }));
  assert.equal(manifest.dependencies["@anthropic-ai/claude-agent-sdk"], "0.3.273");
  manifest.dependencies = { ...manifest.dependencies, ...packages };
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\nautoInstallPeers: false\ncatalog:\n  zod: 4.4.3\n");
  await writeFile(path.join(root, ".pnpmfile.cjs"), packedOverridesSource(packages));
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: root });
  assert.deepEqual((await readdir(path.join(root, "node_modules/@agen-ai"))).sort(), ["sandbox", "validation"]);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: root });
  const claudeGuard = path.join(root, "sandbox-bridge-guard.mjs");
  await copyFile(guard, claudeGuard);
  const claude = await runCompiledTests({ root, directory: "dist/tests", guard: claudeGuard, run });
  return { proof: "packed-sandbox-native-bridge-examples", grok, claude: { ...claude, sdk: "0.3.273", consumerRoot: root },
    credentials: { shared, codex: { memory: codexMemory, files: codexFiles } },
    examples: (await Promise.all(["grok", "claude", "credentials", "codex", "opencode", "cursor"]
      .map((directory) => exampleIdentities(consumerRoot, `examples/sandbox/${directory}`)))).flat(),
    nativeExecution: "not_run", authentication: "not_run" };
}
