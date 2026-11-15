import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runPendingCleanupProof } from "./pending-cleanup-proof.mjs";
import { runToolActionsProof } from "./tool-actions-proof.mjs";

export async function runApprovalPolicyExamples({ repoRoot, consumerRoot, run }) {
  const fixtureRoot = path.join(consumerRoot, "approval-policy-fixtures");
  await mkdir(fixtureRoot, { mode: 0o700 });
  const guard = path.join(consumerRoot, "approval-policy-guard.mjs");
  const existingGuard = await readFile(path.join(repoRoot, "scripts/architecture/agent-sdk-consumers/sandbox/neutral-guard.mjs"), "utf8");
  await writeFile(guard, existingGuard + "\nfor (const key of Object.keys(process.env)) delete process.env[key];\n" + ["HOME", "TMPDIR", "TMP", "TEMP"]
    .map((key) => `process.env.${key} = ${JSON.stringify(fixtureRoot)};`).join("\n") + "\n", { flag: "wx" });
  await writeFile(path.join(consumerRoot, "tsconfig.approval-policy.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2024", "DOM"], module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
      types: ["node"], rootDir: ".", outDir: "approval-policy-dist" },
    include: ["examples/approval-policy/**/*.ts"],
  }, null, 2) + "\n", { flag: "wx" });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.approval-policy.json"], { cwd: consumerRoot });
  const sourceRoot = path.join(consumerRoot, "examples/approval-policy");
  for (const file of await readdir(sourceRoot, { recursive: true })) {
    if (!file.endsWith(".json")) continue;
    const target = path.join(consumerRoot, "approval-policy-dist/examples/approval-policy", file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(sourceRoot, file)), { flag: "wx" });
  }
  const permission = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const permissions = [permission, `--allow-fs-read=${consumerRoot}`, `--allow-fs-write=${fixtureRoot}`, "--import", guard];
  const exampleRoot = "approval-policy-dist/examples/approval-policy";
  const execution = await run(process.execPath, [...permissions, `${exampleRoot}/walkthrough.js`], { cwd: consumerRoot, timeoutMs: 30_000 });
  const report = JSON.parse(execution.stdout.trim());
  assert.equal(report.example, "approval-policy");
  assert.equal(report.evidence, "synthetic_contract_demonstration");
  assert.equal(report.nativeReview, "not_exercised");
  assert.equal(report.nativeProcesses, 0);
  assert.deepEqual(report.scenarios.map(({ requested }) => requested), [null, "host", "provider_auto_review", "provider_bypass", "provider_auto_review"]);
  assert.equal(report.genericAcp.rejection, "approval_policy_unsupported");
  assert.deepEqual(await readdir(fixtureRoot), [], "Default walkthrough scratch must settle before returning.");

  const compiled = await readdir(path.join(consumerRoot, exampleRoot), { recursive: true });
  const tests = compiled.filter((file) => file.endsWith(".test.js")).sort();
  assert(tests.includes("walkthrough.test.js"), "The installed walkthrough's effect assertions must run.");
  assert(tests.some((file) => file.startsWith(`native${path.sep}`)), "The native command's credentialless tests must run.");
  const walkthroughTests = await run(process.execPath, [...permissions, `${exampleRoot}/walkthrough.test.js`],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  process.stdout.write(walkthroughTests.stdout);
  const runner = path.join(consumerRoot, "approval-policy-native-tests.mjs");
  await writeFile(runner, tests.filter((file) => file.startsWith(`native${path.sep}`))
    .map((file) => `await import(${JSON.stringify(`./${exampleRoot}/${file.split(path.sep).join("/")}`)});`).join("\n") + "\n", { flag: "wx" });
  // Node's Permission Model unconditionally forbids fsync, even on allowed paths.
  // Keep real durable I/O in these tests; the guard clears ambient credentials and prohibits process/network APIs.
  const nativeTests = await run(process.execPath, ["--import", guard, runner], { cwd: consumerRoot, timeoutMs: 90_000 });
  process.stdout.write(nativeTests.stdout);
  assert.deepEqual(await readdir(fixtureRoot), [], "Installed example tests must release their scratch.");

  const help = await run(process.execPath, [permission, `--allow-fs-read=${consumerRoot}`, "--import", guard, `${exampleRoot}/native.js`, "--help"],
    { cwd: consumerRoot, timeoutMs: 10_000 });
  for (const command of ["prepare", "check-config", "run"]) assert(help.stdout.includes(command), `Native help must document ${command}.`);
  assert.deepEqual(await readdir(fixtureRoot), [], "Native help must be inert.");
  const pendingCleanup = await runPendingCleanupProof({ consumerRoot, fixtureRoot, permissions, exampleRoot });
  assert.deepEqual(await readdir(fixtureRoot), [], "Pending cleanup proof must settle each owned process and file.");
  // Keep supervision outside the neutral lane; its actual compiled child still imports the unchanged guard.
  const toolActions = await runToolActionsProof({ consumerRoot, fixtureRoot, guard, exampleRoot });
  assert.deepEqual(await readdir(fixtureRoot), [], "Tool-action proof must reap each guarded child and release its fixture output.");

  const invalid = "import type { AgentApprovalPolicy } from '@agen-ai/agent-runtime';\nconst invalid: AgentApprovalPolicy = { kind: 'approve_everything' };\nvoid invalid;\n";
  await writeFile(path.join(consumerRoot, "invalid-approval-policy.ts"), invalid, { flag: "wx" });
  await writeFile(path.join(consumerRoot, "tsconfig.invalid-approval-policy.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      skipLibCheck: false, types: ["node"], noEmit: true }, include: ["invalid-approval-policy.ts"],
  }, null, 2) + "\n", { flag: "wx" });
  await assert.rejects(run("pnpm", ["exec", "tsc", "--project", "tsconfig.invalid-approval-policy.json"], { cwd: consumerRoot }),
    (error) => error instanceof Error && /invalid-approval-policy\.ts\(2,\d+\): error TS2322: Type '"approve_everything"' is not assignable/u.test(error.message),
    "The packed public policy declaration must reject the specific unknown policy kind.");

  const files = [];
  for (const entry of (await readdir(sourceRoot, { recursive: true, withFileTypes: true }))) {
    assert(!entry.isSymbolicLink(), "Approval-policy source evidence requires physical files.");
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(absolute);
    files.push({ path: `examples/approval-policy/${path.relative(sourceRoot, absolute).split(path.sep).join("/")}`,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const proof = { proof: "packed-approval-policy-examples", scope: "synthetic contract and inert native command only",
    policies: report.scenarios.map(({ requested, effective }) => ({ requested, effective })),
    genericAcp: report.genericAcp.rejection, tests, nativeHelp: "inert", pendingCleanup, toolActions, invalidPublicSelection: "rejected",
    effects: "owned fixture filesystem effects and explicit child supervisors; guarded children prohibit process/network APIs and clear ambient environment",
    filesystemPermissions: { walkthrough: "Node Permission Model", nativeHelp: "Node Permission Model, read-only",
      nativeDurableTests: "standard Node filesystem for real fsync; test-owned scratch, no filesystem isolation claim",
      toolActionChildren: "standard Node filesystem for real fsync; neutral process/network guard, no filesystem isolation claim" }, files };
  process.stdout.write(JSON.stringify({ ...proof, files: files.length }) + "\n");
  return proof;
}
