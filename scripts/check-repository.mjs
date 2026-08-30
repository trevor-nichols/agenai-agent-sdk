// ------------------------------------------------------------------------------------------------
//                check-repository.mjs - Public Agent SDK repository contract
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------------------------------------
//                Public Workspace Policy
// ------------------------------------------------------------------------------------------------

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_URL = "git+https://github.com/trevor-nichols/agenai-agent-sdk.git";
const HOMEPAGE_URL = "https://github.com/trevor-nichols/agenai-agent-sdk#readme";
const BUGS_URL = "https://github.com/trevor-nichols/agenai-agent-sdk/issues";
const PACKAGE_POLICIES = [
  {
    root: "packages/validation",
    name: "@agen-ai/validation",
    dependencies: { zod: "catalog:" },
  },
  {
    root: "packages/agent-protocol",
    name: "@agen-ai/agent-protocol",
    dependencies: { "@agen-ai/validation": "workspace:^", zod: "catalog:" },
  },
  {
    root: "packages/agent-runtime",
    name: "@agen-ai/agent-runtime",
    dependencies: { "@agen-ai/agent-protocol": "workspace:^" },
  },
];
const IGNORED_DIRECTORIES = new Set([".git", ".turbo", "coverage", "dist", "node_modules"]);
const PRIVATE_DOCUMENT_PATTERNS = [
  "/home/",
  "/Users/",
  "packages/platform/validation",
  "packages/ai/agent-protocol",
  "packages/ai/agent-runtime",
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8"));
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
assert.equal(rootManifest.version, "0.2.1");
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
assert.match(workspaceConfig, /allowBuilds:\n  esbuild: true/u);
assert.match(workspaceConfig, /overrides:\n  fast-uri: 3\.1\.0/u);

const releaseWorkflow = await readFile(
  path.join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
  "utf8",
);
const validationInspection = releaseWorkflow.indexOf("Inspect validation publication");
const validationPublish = releaseWorkflow.indexOf("Publish validation");
const protocolInspection = releaseWorkflow.indexOf("Inspect agent protocol publication");
const protocolPublish = releaseWorkflow.indexOf("Publish agent protocol");
const runtimeInspection = releaseWorkflow.indexOf("Inspect agent runtime publication");
const runtimePublish = releaseWorkflow.indexOf("Publish agent runtime");
assert.ok(validationInspection >= 0 && validationInspection < validationPublish);
assert.ok(validationPublish < protocolInspection && protocolInspection < protocolPublish);
assert.ok(protocolPublish < runtimeInspection && runtimeInspection < runtimePublish);
assert.match(releaseWorkflow, /verify-package-publication\.mjs/u);
assert.match(releaseWorkflow, /--require-present --attempts 30 --delay-ms 5000/u);
assert.match(releaseWorkflow, /release_ref:/u);
assert.match(releaseWorkflow, /git diff --exit-code/u);
assert.equal(releaseWorkflow.match(/npm publish \.\/release\//gu)?.length, 3);
assert.match(releaseWorkflow, /npm audit signatures/u);
assert.doesNotMatch(
  releaseWorkflow,
  /NODE_AUTH_TOKEN|(?:^|\n)\s*(?:npm|pnpm exec npm)\s+dist-tag\b/u,
);

for (const policy of PACKAGE_POLICIES) {
  const manifest = await readJson(`${policy.root}/package.json`);
  assert.equal(manifest.name, policy.name);
  assert.equal(manifest.version, "0.2.1");
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
  for (const privatePattern of PRIVATE_DOCUMENT_PATTERNS) {
    assert.equal(
      contents.includes(privatePattern),
      false,
      `${markdownFile} exposes private repository structure: ${privatePattern}`,
    );
  }
}

process.stdout.write("Public Agent SDK repository contract passed.\n");
