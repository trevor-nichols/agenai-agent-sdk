// ------------------------------------------------------------------------------------------------
//                check-repository.mjs - Public Agent SDK repository contract
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { inspectReleaseSet } from "./release/verify-release-set.mjs";

// ------------------------------------------------------------------------------------------------
//                Public Workspace Policy
// ------------------------------------------------------------------------------------------------

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_URL = "git+https://github.com/trevor-nichols/agenai-agent-sdk.git";
const HOMEPAGE_URL = "https://github.com/trevor-nichols/agenai-agent-sdk#readme";
const BUGS_URL = "https://github.com/trevor-nichols/agenai-agent-sdk/issues";

const IGNORED_DIRECTORIES = new Set([".git", ".turbo", "coverage", "dist", "node_modules"]);
const PRIVATE_HOST_HOME_PATH = /\/home\/(?!sandbox(?:$|[\s`]))/u;
const PRIVATE_DOCUMENT_PATTERNS = [
  "/Users/",
  "packages/platform/validation",
  "packages/ai/agent-protocol",
  "packages/ai/agent-runtime",
  "packages/ai/agent-orchestration",
  "packages/ai/adapter-acp",
  "packages/ai/provider-acp",
  "packages/ai/acp-registry",
  "packages/ai/agent-history",
  "packages/ai/sandbox",
  "packages/ai/sandbox-docker",
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8"));
}

function assertNativeHistoryEnvironment(workflow, jobName) {
  const job = workflow.jobs?.[jobName];
  assert.equal(job?.["runs-on"], "ubuntu-24.04");
  const steps = job.steps;
  const setupIndex = steps.findIndex((step) => step.name === "Provision Linux native history sandbox");
  const checkIndex = steps.findIndex((step) => step.name === "Check SDK");
  const restoreIndex = steps.findIndex((step) => step.name === "Restore Ubuntu native history namespace restriction");
  assert(setupIndex >= 0 && setupIndex < checkIndex && checkIndex < restoreIndex);
  const setup = steps[setupIndex], restore = steps[restoreIndex];
  assert.equal(restore.if, "always()");
  for (const step of [setup, restore]) {
    assert.equal(step.shell, "bash");
    assert.equal(step.env.NATIVE_HISTORY_RUNNER_ENVIRONMENT, "${{ runner.environment }}");
    assert.equal(step.env.NATIVE_HISTORY_RUNNER_OS, "${{ runner.os }}");
    assert.match(step.run, /NATIVE_HISTORY_RUNNER_ENVIRONMENT:-.*github-hosted/u);
    assert.match(step.run, /NATIVE_HISTORY_RUNNER_OS:-.*Linux/u);
    assert.match(step.run, /ImageOS:-.*ubuntu24/u);
  }
  assert.match(setup.run, /apt-get install --yes --no-install-recommends bubblewrap/u);
  assert.match(setup.run, /read -r apparmor_userns_original/u);
  assert.match(setup.run, /NATIVE_HISTORY_APPARMOR_USERNS_ORIGINAL=%s/u);
  assert.match(setup.run, /sysctl --write kernel\.apparmor_restrict_unprivileged_userns=0/u);
  for (const flag of ["--unshare-user", "--uid 0", "--gid 0", "--unshare-net", "--unshare-pid", "--ro-bind / /", "--clearenv", "-- /usr/bin/true"]) {
    assert(setup.run.includes(flag), `Native history namespace smoke is missing ${flag}`);
  }
  assert.match(restore.run, /sysctl --write "kernel\.apparmor_restrict_unprivileged_userns=\$\{NATIVE_HISTORY_APPARMOR_USERNS_ORIGINAL\}"/u);
}

async function collectMarkdownFiles(directory = REPOSITORY_ROOT, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Public repository contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectMarkdownFiles(absolutePath, relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }
  return files;
}

// ------------------------------------------------------------------------------------------------
//                Repository Checks
// ------------------------------------------------------------------------------------------------

const rootManifest = await readJson("package.json");
assert.equal(rootManifest.name, "agenai-agent-sdk");
assert.equal(rootManifest.version, "0.4.6");
assert.equal(rootManifest.private, true);
assert.equal(rootManifest.license, "MIT");
assert.equal(rootManifest.packageManager, "pnpm@11.7.0");
assert.equal(rootManifest.engines?.node, ">=22.0.0");
assert.equal(rootManifest.scripts?.["test:release"], "node --test scripts/release/*.test.mjs");
assert.match(rootManifest.scripts?.check, /pnpm test:release/u);

const exportManifest = await readJson(".agenai-export.json");
assert.equal(exportManifest.schemaVersion, 1);
assert.match(exportManifest.sourceRevision, /^[a-f0-9]{40}$/u);
assert.equal(
  exportManifest.publicRepository,
  "https://github.com/trevor-nichols/agenai-agent-sdk",
);
assert.ok(exportManifest.ownedFiles.includes(".agenai-export.json"));
assert.deepEqual(exportManifest.ownedFiles, [...exportManifest.ownedFiles].sort());

const rootLicense = await readFile(path.join(REPOSITORY_ROOT, "LICENSE"), "utf8");
assert.match(rootLicense, /^MIT License\n\nCopyright \(c\) 2026 Trevor Nichols/u);
const workspaceConfig = await readFile(
  path.join(REPOSITORY_ROOT, "pnpm-workspace.yaml"),
  "utf8",
);
assert.deepEqual(parseYaml(workspaceConfig).allowBuilds, {
  esbuild: true,
  "@opencode/cli": false,
  "@xai-official/grok": false,
});
assert.match(workspaceConfig, /overrides:\n  fast-uri: 3\.1\.0/u);

const releaseWorkflow = await readFile(
  path.join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
  "utf8",
);
assertNativeHistoryEnvironment(parseYaml(await readFile(path.join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8")), "check");
assertNativeHistoryEnvironment(parseYaml(releaseWorkflow), "publish");
const validationInspection = releaseWorkflow.indexOf("Inspect validation publication");
const validationPublish = releaseWorkflow.indexOf("Publish validation");
const protocolInspection = releaseWorkflow.indexOf("Inspect agent protocol publication");
const protocolPublish = releaseWorkflow.indexOf("Publish agent protocol");
const runtimeInspection = releaseWorkflow.indexOf("Inspect agent runtime publication");
const runtimePublish = releaseWorkflow.indexOf("Publish agent runtime");
const orchestrationInspection = releaseWorkflow.indexOf("Inspect agent orchestration publication");
const orchestrationPublish = releaseWorkflow.indexOf("Publish agent orchestration");
const transportInspection = releaseWorkflow.indexOf("Inspect ACP transport publication");
const transportPublish = releaseWorkflow.indexOf("Publish ACP transport");
const providerInspection = releaseWorkflow.indexOf("Inspect ACP provider publication");
const providerPublish = releaseWorkflow.indexOf("Publish ACP provider");
const registryInspection = releaseWorkflow.indexOf("Inspect ACP registry publication");
const registryPublish = releaseWorkflow.indexOf("Publish ACP registry");
const historyInspection = releaseWorkflow.indexOf("Inspect agent history publication");
const historyPublish = releaseWorkflow.indexOf("Publish agent history");
const sandboxInspection = releaseWorkflow.indexOf("Inspect sandbox publication");
const sandboxPublish = releaseWorkflow.indexOf("Publish sandbox");
const sandboxDockerInspection = releaseWorkflow.indexOf("Inspect Docker sandbox publication");
const sandboxDockerPublish = releaseWorkflow.indexOf("Publish Docker sandbox");
const releaseSetVerification = releaseWorkflow.indexOf("Verify complete release artifact set");
assert.ok(releaseSetVerification >= 0 && releaseSetVerification < validationInspection);
assert.match(releaseWorkflow, /node scripts\/release\/verify-release-set\.mjs --release-ref "\$RELEASE_REF"/u);
assert.match(releaseWorkflow, /--release-ref "\$RELEASE_REF" --release-directory release/u);
assert.ok(validationInspection >= 0 && validationInspection < validationPublish);
assert.ok(validationPublish < protocolInspection && protocolInspection < protocolPublish);
assert.ok(protocolPublish < runtimeInspection && runtimeInspection < runtimePublish);
assert.ok(runtimePublish < orchestrationInspection && orchestrationInspection < orchestrationPublish);
assert.ok(orchestrationPublish < transportInspection && transportInspection < transportPublish);
assert.ok(transportPublish < providerInspection && providerInspection < providerPublish);
assert.ok(providerPublish < registryInspection && registryInspection < registryPublish);
assert.ok(registryPublish < historyInspection && historyInspection < historyPublish);
assert.ok(historyPublish < sandboxInspection && sandboxInspection < sandboxPublish);
assert.ok(sandboxPublish < sandboxDockerInspection && sandboxDockerInspection < sandboxDockerPublish);
assert.match(releaseWorkflow, /verify-package-publication\.mjs/u);
assert.match(releaseWorkflow, /--require-present --attempts 90 --delay-ms 10000/u);
assert.match(releaseWorkflow, /release_ref:/u);
assert.match(releaseWorkflow, /release_commit="\$\(git rev-parse "\$RELEASE_REF\^\{commit\}"\)"/u);
assert.match(releaseWorkflow, /RELEASE_SHA=\$release_commit/u);
assert.equal(releaseWorkflow.match(/--release-sha "\$RELEASE_SHA"/gu)?.length, 20);
assert.match(releaseWorkflow, /git diff --exit-code/u);
assert.match(releaseWorkflow, /scripts\/architecture\/agent-sdk-consumers/u);
assert.match(releaseWorkflow, /scripts\/development\/agent-sandbox-qualification/u);
assert.equal(releaseWorkflow.match(/npm publish \.\/release\//gu)?.length, 10);
assert.match(releaseWorkflow, /packages\/agent-orchestration/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/agent-orchestration pack/u);
assert.match(releaseWorkflow, /packages\/acp-transport/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/acp-transport pack/u);
assert.match(releaseWorkflow, /packages\/provider-acp/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/provider-acp pack/u);
assert.match(releaseWorkflow, /packages\/acp-registry/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/acp-registry pack/u);
assert.match(releaseWorkflow, /packages\/agent-history/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/agent-history pack/u);
assert.match(releaseWorkflow, /packages\/sandbox/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/sandbox pack/u);
assert.match(releaseWorkflow, /packages\/sandbox-docker/u);
assert.match(releaseWorkflow, /pnpm --filter @agen-ai\/sandbox-docker pack/u);
assert.match(releaseWorkflow, /npm audit signatures/u);
assert.doesNotMatch(
  releaseWorkflow,
  /NODE_AUTH_TOKEN|(?:^|\n)\s*(?:npm|pnpm exec npm)\s+dist-tag\b/u,
);

const releaseSet = await inspectReleaseSet({ repositoryRoot: REPOSITORY_ROOT });
assert.deepEqual(exportManifest.packages.map(({ packageName, destination }) => ({ packageName, destination })),
  releaseSet.packages.map(({ policy }) => ({ packageName: policy.name, destination: policy.root })));
for (const { policy, manifest } of releaseSet.packages) {
  const packageRequire = createRequire(path.join(REPOSITORY_ROOT, policy.root, "package.json"));
  const tsupManifestPath = packageRequire.resolve("tsup/package.json");
  assert.equal(packageRequire(tsupManifestPath).version, "8.5.0", `${policy.name}: unqualified tsup version`);
  assert.equal(createRequire(tsupManifestPath)("esbuild/package.json").version, "0.25.10", `${policy.name}: unqualified esbuild version`);
  assert.equal(manifest.private, false);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.sideEffects, false);
  assert.equal(manifest.engines?.node, ">=22.0.0");
  assert.deepEqual(manifest.dependencies ?? {}, policy.dependencies);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: REPOSITORY_URL,
    directory: policy.root,
  });
  assert.equal(manifest.homepage, HOMEPAGE_URL);
  assert.equal(manifest.bugs?.url, BUGS_URL);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.provenance, true);
  if (policy.name === "@agen-ai/agent-protocol") {
    assert.equal(manifest.devDependencies?.ajv, "8.17.1");
  }
  if (policy.name === "@agen-ai/sandbox") {
    assert.deepEqual(manifest.peerDependencies, { "@agen-ai/provider-acp": "workspace:^" });
    assert.deepEqual(manifest.peerDependenciesMeta, { "@agen-ai/provider-acp": { optional: true } });
    assert.equal(manifest.devDependencies?.["@agen-ai/provider-acp"], "workspace:^");
    assert.deepEqual(manifest.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./backend": { types: "./dist/backend/index.d.ts", import: "./dist/backend/index.js" },
      "./acp": { types: "./dist/acp/index.d.ts", import: "./dist/acp/index.js" },
      "./node": { types: "./dist/node/index.d.ts", import: "./dist/node/index.js" },
      "./package.json": "./package.json",
    });
  }
  if (policy.name === "@agen-ai/sandbox-docker") {
    assert.deepEqual(manifest.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./node": { types: "./dist/node/index.d.ts", import: "./dist/node/index.js" },
      "./package.json": "./package.json",
    });
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
  }
  if (policy.name === "@agen-ai/agent-history") {
    assert.deepEqual(manifest.peerDependencies, { "@agen-ai/acp-transport": "workspace:^", "@anthropic-ai/claude-agent-sdk": "0.3.306", "@cursor/sdk": "1.0.40", "@opencode/client": "2.1.2" });
    assert.deepEqual(manifest.peerDependenciesMeta, { "@agen-ai/acp-transport": { optional: true }, "@anthropic-ai/claude-agent-sdk": { optional: true }, "@cursor/sdk": { optional: true }, "@opencode/client": { optional: true } });
    assert.equal(manifest.devDependencies?.["@anthropic-ai/claude-agent-sdk"], "0.3.306");
    assert.equal(manifest.devDependencies?.["@openai/codex"], "0.163.0");
    assert.equal(manifest.devDependencies?.["@cursor/sdk"], "1.0.40");
    assert.equal(manifest.devDependencies?.["@opencode/client"], "2.1.2");
    assert.equal(manifest.devDependencies?.["@opencode/cli"], "2.1.2");
    assert.equal(manifest.devDependencies?.["@agen-ai/acp-transport"], "workspace:^");
    assert.equal(manifest.devDependencies?.["@xai-official/grok"], "1.0.62");
    assert.deepEqual(manifest.exports?.["./claude"], { types: "./dist/claude.d.ts", import: "./dist/claude.js" });
    assert.deepEqual(manifest.exports?.["./codex"], { types: "./dist/codex.d.ts", import: "./dist/codex.js" });
    assert.deepEqual(manifest.exports?.["./opencode"], { types: "./dist/opencode.d.ts", import: "./dist/opencode.js" });
    assert.deepEqual(manifest.exports?.["./cursor"], { types: "./dist/cursor.d.ts", import: "./dist/cursor.js" });
    assert.deepEqual(manifest.exports?.["./acp"], { types: "./dist/acp.d.ts", import: "./dist/acp.js" });
    assert.deepEqual(manifest.exports?.["./grok"], { types: "./dist/grok.d.ts", import: "./dist/grok.js" });
  }
  assert.equal(
    await readFile(path.join(REPOSITORY_ROOT, policy.root, "LICENSE"), "utf8"),
    rootLicense,
  );
}

for (const ownedFile of exportManifest.ownedFiles) {
  const state = await lstat(path.join(REPOSITORY_ROOT, ownedFile));
  assert.equal(state.isFile(), true, `Export-owned path must be a file: ${ownedFile}`);
  assert.equal(state.isSymbolicLink(), false, `Export-owned path cannot be a symlink: ${ownedFile}`);
}

for (const markdownFile of await collectMarkdownFiles()) {
  const contents = await readFile(path.join(REPOSITORY_ROOT, markdownFile), "utf8");
  assert.doesNotMatch(contents, /\u2014/u, `${markdownFile} contains an em dash`);
  assert.doesNotMatch(contents, PRIVATE_HOST_HOME_PATH, `${markdownFile} exposes a private host home path`);
  for (const privatePattern of PRIVATE_DOCUMENT_PATTERNS) {
    assert.equal(
      contents.includes(privatePattern),
      false,
      `${markdownFile} exposes private repository structure: ${privatePattern}`,
    );
  }
}

process.stdout.write("Public Agent SDK repository contract passed.\n");
