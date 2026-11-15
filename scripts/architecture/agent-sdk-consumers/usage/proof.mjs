// ------------------------------------------------------------------------------------------------
//                proof.mjs - Installed token-usage example and contract proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTRACT = "scripts/architecture/agent-sdk-consumers/usage/contract.ts";
const PROOF = "scripts/architecture/agent-sdk-consumers/usage/proof.mjs";
const INSTALLED_USAGE_EXPORTS = {
  "@agen-ai/agent-protocol": { types: "./dist/public/usage.d.ts", import: "./dist/public/usage.js" },
  "@agen-ai/agent-runtime": { types: "./dist/usage/index.d.ts", import: "./dist/usage/index.js" },
};
const DECLARATION_ENTRYPOINTS = [
  ["@agen-ai/agent-protocol", "./dist/public/index.d.ts"],
  ["@agen-ai/agent-protocol", "./dist/public/usage.d.ts"],
  ["@agen-ai/agent-runtime", "./dist/usage/index.d.ts"],
];
const DECLARATION_PACKAGE_IMPORTS = new Set(["@agen-ai/agent-protocol", "@agen-ai/validation"]);

const INVALID_USAGE = `import type { AgentTokenCount, AgentTokenUsageCoverage } from "@agen-ai/agent-protocol/usage";
import { summarizeTokenUsageView, type AgentTokenUsageLedger, type AgentTokenUsageViewSummary } from "@agen-ai/agent-runtime/usage";
const unsupportedLowerBound: AgentTokenCount = { kind: "at_least", value: 1, reasons: ["unsupported"] };
const reasonlessPartial: AgentTokenUsageCoverage = { kind: "partial", reasons: [] };
declare const ledger: AgentTokenUsageLedger; declare const viewId: Parameters<typeof summarizeTokenUsageView>[1];
const assumedSummary: AgentTokenUsageViewSummary = summarizeTokenUsageView(ledger, viewId);
const forgedLedger: AgentTokenUsageLedger = {};
void unsupportedLowerBound; void reasonlessPartial; void assumedSummary; void forgedLedger;
`;

// ------------------------------------------------------------------------------------------------
//                Expected Report
// ------------------------------------------------------------------------------------------------

const exact = (value) => ({ kind: "exact", value });
const atLeast = (value, ...reasons) => ({ kind: "at_least", value, reasons });
const unavailable = (...reasons) => ({ kind: "unavailable", reasons });
const io = (inputTokens, outputTokens) => ({ inputTokens, outputTokens });

/** Hand-written outcomes; lower bounds and unmeasured new work must never read as zero. */
export const EXPECTED_USAGE_REPORT = {
  example: "usage", evidence: "synthetic", protocolVersion: 14,
  scenarios: [
    { scenario: "no_measurement", withoutObservation: "no_summary",
      explicit: { scopeCount: 1, total: io(unavailable("not_reported"), unavailable("not_reported")) } },
    { scenario: "inclusive_subdivisions", total: { inputTokens: exact(1000), cacheReadInputTokens: exact(800),
      cacheCreationInputTokens: unavailable("not_reported"), outputTokens: exact(50), reasoningOutputTokens: unavailable("not_reported") } },
    { scenario: "partial_reasoning", total: { outputTokens: exact(100), reasoningOutputTokens: atLeast(7, "native_result_incomplete") } },
    { scenario: "stable_history", admissions: ["recorded", "recorded"], total: io(exact(600), exact(60)), newWork: io(exact(200), exact(20)) },
    { scenario: "duplicate_replay", replay: "duplicate", sameLedger: true, changedContent: "usage_identity_conflict",
      total: io(exact(600), exact(60)), newWork: io(exact(200), exact(20)) },
    { scenario: "unknown_baseline",
      unknownOrigin: { total: io(exact(600), exact(60)), newWork: io(unavailable("origin_unknown"), unavailable("origin_unknown")) },
      unknownComparison: { total: io(exact(600), exact(60)), newWork: io(unavailable("history_incomplete"), exact(20)) } },
    { scenario: "historical_backfill", total: io(exact(1000), exact(100)),
      newWork: io(unavailable("history_incomplete"), unavailable("history_incomplete")) },
    { scenario: "continuing_checkpoints", deliveries: [["turn-1", "open"], ["turn-2", "open"], ["turn-2", "final"]],
      scopeCount: 1, total: io(exact(300), exact(30)), newWork: io(exact(300), exact(30)), afterFinal: "usage_sequence_invalid" },
    { scenario: "parent_and_child", authoritative: io(exact(1000), exact(100)), detail: io(exact(300), exact(30)) },
    { scenario: "equal_deltas", scopeCount: 2, total: io(exact(400), exact(40)) },
    { scenario: "unavailable_on_success", outcome: "completed", eventTypes: ["turn.started", "usage.observed", "turn.completed"],
      deliveryTurn: "turn-1", accountingScope: "turn:turn-1", measurement: unavailable("native_result_incomplete"),
      total: io(unavailable("native_result_incomplete"), unavailable("native_result_incomplete")),
      rebuiltFromJson: "identical", starts: 1, sessionCloses: 1 },
  ],
};
const EXPECTED_CONTRACT_REPORT = { proof: "packed-token-usage-contract", evidence: "synthetic", protocolExports: 15, runtimeExports: 7,
  schemaEntrypoints: ["plain", "zod", "zod-portable", "json-schema"], rejection: "frozen", pendingDeliveries: 2 };

// ------------------------------------------------------------------------------------------------
//                Installed Declarations
// ------------------------------------------------------------------------------------------------

async function assertPlainDeclarations(consumerRoot) {
  let files = 0;
  for (const [name, entrypoint] of DECLARATION_ENTRYPOINTS) {
    const packageRoot = path.join(consumerRoot, "node_modules", name);
    const pending = [path.join(packageRoot, entrypoint)];
    const visited = new Set();
    while (pending.length > 0) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(source, /zod/iu, `${path.relative(packageRoot, file)} must not expose Zod through ${name}/${entrypoint}.`);
      for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith(".")) pending.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".d.ts")));
        else assert.ok(DECLARATION_PACKAGE_IMPORTS.has(specifier), `${name} declarations import unexpected ${specifier}.`);
      }
    }
    files += visited.size;
  }
  return files;
}

async function sourceIdentities(root, prefix) {
  const files = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "Usage proof evidence requires physical files.");
    if (!entry.isFile()) continue;
    const bytes = await readFile(path.join(entry.parentPath, entry.name));
    files.push({ path: `${prefix}/${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")}`,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

// ------------------------------------------------------------------------------------------------
//                Proof
// ------------------------------------------------------------------------------------------------

/**
 * Compiles the copied usage example and an independent contract against the installed core packages,
 * then runs both under Node's permission model with network access replaced by a failing guard.
 */
export async function runUsageExample({ repoRoot, consumerRoot, run }) {
  for (const [name, expected] of Object.entries(INSTALLED_USAGE_EXPORTS)) {
    const manifest = JSON.parse(await readFile(path.join(consumerRoot, "node_modules", name, "package.json"), "utf8"));
    assert.deepEqual(manifest.exports?.["./usage"], expected, `${name} must export ./usage.`);
  }
  const declarationFiles = await assertPlainDeclarations(consumerRoot);

  await mkdir(path.join(consumerRoot, "usage-proof"));
  await copyFile(path.join(repoRoot, CONTRACT), path.join(consumerRoot, "usage-proof/contract.ts"));
  await writeFile(path.join(consumerRoot, "tsconfig.usage.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2024", "DOM"], module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false,
      types: ["node"], rootDir: ".", outDir: "usage-dist" },
    include: ["examples/usage/**/*.ts", "usage-proof/*.ts"],
  }, null, 2) + "\n", { flag: "wx" });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.usage.json"], { cwd: consumerRoot });

  const permission = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const isolated = [permission, `--allow-fs-read=${consumerRoot}`, "--import", "./offline-guard.mjs"];
  const example = await run(process.execPath, [...isolated, "usage-dist/examples/usage/main.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(example.stdout.trim()), EXPECTED_USAGE_REPORT);
  process.stdout.write(example.stdout);
  const contract = await run(process.execPath, [...isolated, "usage-dist/usage-proof/contract.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(contract.stdout.trim()), EXPECTED_CONTRACT_REPORT);
  process.stdout.write(contract.stdout);

  await writeFile(path.join(consumerRoot, "invalid-usage.ts"), INVALID_USAGE, { flag: "wx" });
  await writeFile(path.join(consumerRoot, "tsconfig.invalid-usage.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false,
      types: ["node"], noEmit: true },
    include: ["invalid-usage.ts"],
  }, null, 2) + "\n", { flag: "wx" });
  await assert.rejects(run("pnpm", ["exec", "tsc", "--project", "tsconfig.invalid-usage.json"], { cwd: consumerRoot }), (error) => {
    const message = error instanceof Error ? error.message : "";
    return [
      /invalid-usage\.ts\(3,\d+\): error TS2322: Type '"unsupported"' is not assignable/u,
      /invalid-usage\.ts\(4,\d+\): error TS2322: Type '\[\]' is not assignable to type 'AgentTokenUsageReasons'/u,
      /invalid-usage\.ts\(6,\d+\): error TS2322: Type 'AgentTokenUsageViewSummary \| undefined' is not assignable/u,
      /invalid-usage\.ts\(7,\d+\): error TS2741: Property '\[ledgerBrand\]' is missing/u,
    ].every((pattern) => pattern.test(message));
  }, "Installed usage declarations must reject unsupported lower bounds, reasonless partial coverage, assumed summaries and forged ledgers.");

  const files = [
    ...await sourceIdentities(path.join(consumerRoot, "examples/usage"), "examples/usage"),
    ...await Promise.all([[CONTRACT, "usage-proof/contract.ts"], [PROOF]].map(async ([source, copied]) => {
      const bytes = await readFile(path.join(copied ? consumerRoot : repoRoot, copied ?? source));
      return { path: source, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    })),
  ];
  const proof = { proof: "packed-token-usage-example",
    scope: "synthetic installed example and contract; no native provider is exercised",
    scenarios: EXPECTED_USAGE_REPORT.scenarios.length, declarationFiles, invalidUsage: "rejected",
    filesystemPermissions: "Node Permission Model; reads only the consumer root; network guarded", files };
  process.stdout.write(JSON.stringify({ ...proof, files: files.length }) + "\n");
  return proof;
}
