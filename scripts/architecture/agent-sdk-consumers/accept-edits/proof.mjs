import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INVALID_WIRING = `import type { NodeClaudeProviderOptions } from '@agen-ai/provider-claude';
import type { NodeOpenCodeProviderOptions } from '@agen-ai/provider-opencode';
const login: NodeClaudeProviderOptions['credential'] = { kind: 'oauth', value: 'x' };
const route: NodeOpenCodeProviderOptions['provider'] = 'google';
void login; void route;
`;

/**
 * Compiles the accept-edits example against the packed declarations and runs its compiled CLI and
 * credentialless tests under Node's permission model with process and network APIs disabled.
 * Native provider behavior is qualified separately by the MS008 runner on the same packed archives.
 */
export async function runAcceptEditsExample({ repoRoot, consumerRoot, run }) {
  const fixtureRoot = path.join(consumerRoot, "accept-edits-fixtures");
  await mkdir(fixtureRoot, { mode: 0o700 });
  const guard = path.join(consumerRoot, "accept-edits-guard.mjs");
  const neutralGuard = await readFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/neutral-guard.mjs"), "utf8");
  await writeFile(guard, neutralGuard + "\nfor (const key of Object.keys(process.env)) delete process.env[key];\n" + ["HOME", "TMPDIR", "TMP", "TEMP"]
    .map((key) => `process.env.${key} = ${JSON.stringify(fixtureRoot)};`).join("\n") + "\n", { flag: "wx" });
  await writeFile(path.join(consumerRoot, "tsconfig.accept-edits.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2024", "DOM"], module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
      types: ["node"], rootDir: ".", outDir: "accept-edits-dist" },
    include: ["examples/accept-edits/**/*.ts"],
  }, null, 2) + "\n", { flag: "wx" });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.accept-edits.json"], { cwd: consumerRoot });
  const sourceRoot = path.join(consumerRoot, "examples/accept-edits");
  const exampleRoot = "accept-edits-dist/examples/accept-edits";
  for (const file of await readdir(sourceRoot, { recursive: true })) {
    if (file.endsWith(".json")) await writeFile(path.join(consumerRoot, exampleRoot, file), await readFile(path.join(sourceRoot, file)), { flag: "wx" });
  }
  const permission = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const readOnly = [permission, `--allow-fs-read=${consumerRoot}`, "--import", guard];
  const permissions = [permission, `--allow-fs-read=${consumerRoot}`, `--allow-fs-write=${fixtureRoot}`, "--import", guard];

  const help = await run(process.execPath, [...readOnly, `${exampleRoot}/main.js`, "--help"], { cwd: consumerRoot, timeoutMs: 10_000 });
  for (const command of ["check-config", "prepare", "run"]) assert(help.stdout.includes(command), `Example help must document ${command}.`);
  const template = path.join(consumerRoot, exampleRoot, "run-config.example.json");
  const checked = JSON.parse((await run(process.execPath, [...readOnly, `${exampleRoot}/main.js`, "check-config", "--config", template],
    { cwd: consumerRoot, timeoutMs: 10_000 })).stdout);
  assert.deepEqual(checked, { valid: true, provider: "claude", route: "anthropic", model: "REPLACE-with-the-full-model-id",
    requestedPolicy: "provider_accept_edits", approvals: "exact", nativeExecution: false });
  assert.deepEqual(await readdir(fixtureRoot), [], "Help and configuration checks must be inert.");

  const tests = await run(process.execPath, [...permissions, "--test-reporter=tap", `${exampleRoot}/tests.js`], { cwd: consumerRoot, timeoutMs: 60_000 });
  process.stdout.write(tests.stdout);
  assert.match(tests.stdout, /# pass 11\n# fail 0\n/u);
  assert.deepEqual(await readdir(fixtureRoot), [], "Installed example tests must release their scratch.");

  await writeFile(path.join(consumerRoot, "invalid-accept-edits-wiring.ts"), INVALID_WIRING, { flag: "wx" });
  await writeFile(path.join(consumerRoot, "tsconfig.invalid-accept-edits.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, types: ["node"], noEmit: true },
    include: ["invalid-accept-edits-wiring.ts"],
  }, null, 2) + "\n", { flag: "wx" });
  await assert.rejects(run("pnpm", ["exec", "tsc", "--project", "tsconfig.invalid-accept-edits.json"], { cwd: consumerRoot }), (error) => {
    const message = error instanceof Error ? error.message : "";
    return /invalid-accept-edits-wiring\.ts\(3,\d+\): error TS2322: Type '"oauth"' is not assignable/u.test(message)
      && /invalid-accept-edits-wiring\.ts\(4,\d+\): error TS2322: Type '"google"' is not assignable/u.test(message);
  }, "Packed declarations must admit only the explicit API-key credential and the two OpenCode model routes.");

  const files = [];
  for (const entry of await readdir(sourceRoot, { recursive: true, withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Accept-edits source evidence requires physical files.");
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(absolute);
    files.push({ path: `examples/accept-edits/${path.relative(sourceRoot, absolute).split(path.sep).join("/")}`,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const proof = { proof: "packed-accept-edits-example", scope: "compiled example, inert CLI and credentialless owner refusals; native rows are separate",
    help: "inert", template: "valid", tests: "11 passed", invalidWiring: "rejected",
    filesystemPermissions: "Node Permission Model; writes only to the fixture root; process and network APIs disabled", files };
  process.stdout.write(JSON.stringify({ ...proof, files: files.length }) + "\n");
  return proof;
}
