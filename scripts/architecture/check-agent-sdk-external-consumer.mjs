// ------------------------------------------------------------------------------------------------
//                check-agent-sdk-external-consumer.mjs - Packed third-party SDK proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLiveRequestExample,
  assertSessionContinuationExample,
  assertAcpContinuationExample,
} from "./agent-sdk-consumers/request-lifecycle/reports.mjs";
import {
  CORE_CONSUMER_PACKAGES,
  consumerPackageManifest,
  packedOverridesSource,
  readDependencyBaseline,
  seedDependencyBaseline,
  verifyDependencyBaselineInstall,
} from "./agent-sdk-consumers/dependency-baseline.mjs";
import { assertAcpExecutionInputUnsupported, assertExecutionInputExample } from "./agent-sdk-consumers/execution-input/reports.mjs";
import { runNeutralSandboxConsumer } from "./agent-sdk-consumers/sandbox/proof.mjs";
import { runPortableSandboxConsumer, runSandboxPlatformCheck } from "./agent-sdk-consumers/sandbox/platform-proof.mjs";

// ------------------------------------------------------------------------------------------------
//                Release Policy
// ------------------------------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const LOCAL_PATH_MARKERS = [REPO_ROOT];
const FORBIDDEN_ARTIFACT_TEXT = [
  "@agenai/agent-contracts",
  "@agenai/agent-host-protocol",
  "@agenai/workspace-host-protocol",
  "AGENT_ACTIVE_INPUT_MODES",
  "AgentActiveInputCapability",
  "AgentActiveInputMode",
  "AgentActiveTurnInput",
  "AgentProviderActiveTextInput",
  "activeInput",
  "queue_next",
];
const FORBIDDEN_ARTIFACT_PATTERNS = [
  /@agenai\/service-[a-z0-9-]*/u,
  /@agenai\/db-[a-z0-9-]*/u,
];
const FORBIDDEN_DECLARATION_FIELD_PATTERN =
  /\b(?:teamId|workspaceId|assignedUserId|providerInstanceId|requestedByUserId|resolvedByUserId|visibility|sequence|storageBackend|objectLocator|metadata)\s*[?:]/u;
const FORBIDDEN_TRANSPORT_DECLARATION_FIELD_PATTERN =
  /\b(?:teamId|workspaceId|assignedUserId|providerInstanceId|requestedByUserId|resolvedByUserId|visibility|sequence|storageBackend|objectLocator)\s*[?:]/u;
const ACP_SCHEMA_ASSETS = [
  ...["LICENSE", "meta.json", "meta.unstable.json", "provenance.json", "schema.json", "schema.unstable.json", "protocol.generated.json"]
    .map((file) => `schema/v0.11.4/${file}`),
  ...["LICENSE", "meta.json", "schema.json", "provenance.json", "protocol.generated.json"]
    .map((file) => `schema/schema-v1.23.0/${file}`),
];
const PUBLIC_REPOSITORY_URL = "git+https://github.com/trevor-nichols/agenai-agent-sdk.git";
const PUBLIC_HOMEPAGE_URL = "https://github.com/trevor-nichols/agenai-agent-sdk#readme";
const PUBLIC_BUGS_URL = "https://github.com/trevor-nichols/agenai-agent-sdk/issues";
const PUBLIC_EXAMPLES_ROOT = "examples";
const EXECUTION_INPUT_CONSUMER_ROOT = "scripts/architecture/agent-sdk-consumers/execution-input";
const CORE_OPERATION_FILES = ["operations.ts", "operations/invoke.ts", "operations/fixture.ts"];
const CORE_GENERATION_FILES = ["generate-title.ts", "fixtures/generate-title.ts"];
const CORE_CONTINUATION_FILES = [
  "session-continuations.ts",
  "fixtures/session-continuations/provider.ts",
  "fixtures/session-continuations/shared.ts",
];
const PACKAGES = [
  {
    name: "@agen-ai/validation",
    root: "packages/validation",
    directory: "packages/validation",
    dependencies: { zod: "4.4.3" },
  },
  {
    name: "@agen-ai/agent-protocol",
    root: "packages/agent-protocol",
    directory: "packages/agent-protocol",
    dependencies: { "@agen-ai/validation": "^0.4.4", zod: "4.4.3" },
  },
  {
    name: "@agen-ai/agent-runtime",
    root: "packages/agent-runtime",
    directory: "packages/agent-runtime",
    dependencies: { "@agen-ai/agent-protocol": "^0.4.4" },
  },
  {
    name: "@agen-ai/agent-orchestration",
    root: "packages/agent-orchestration",
    directory: "packages/agent-orchestration",
    dependencies: {
      "@agen-ai/agent-runtime": "^0.4.4",
      "@agen-ai/agent-protocol": "^0.4.4",
      "@agen-ai/validation": "^0.4.4",
      zod: "4.4.3",
      "@modelcontextprotocol/sdk": "1.29.0",
    },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./store-adapter": { types: "./dist/store-adapter/index.d.ts", import: "./dist/store-adapter/index.js" },
      "./mcp": { types: "./dist/mcp/index.d.ts", import: "./dist/mcp/index.js" },
      "./package.json": "./package.json",
    },
  },
  {
    name: "@agen-ai/acp-transport",
    root: "packages/acp-transport",
    directory: "packages/acp-transport",
    dependencies: { ajv: "8.17.1" },
    assets: ACP_SCHEMA_ASSETS,
  },
  {
    name: "@agen-ai/provider-acp",
    root: "packages/provider-acp",
    directory: "packages/provider-acp",
    dependencies: {
      "@agen-ai/acp-transport": "^0.4.4",
      "@agen-ai/agent-runtime": "^0.4.4",
      "@agen-ai/agent-protocol": "^0.4.4",
    },
  },
  {
    name: "@agen-ai/acp-registry",
    root: "packages/acp-registry",
    directory: "packages/acp-registry",
    dependencies: { "@agen-ai/validation": "^0.4.4", zod: "4.4.3",
      "@openpgp/unbzip2-stream": "2.1.0", "buffer-crc32": "1.0.0", "tar-stream": "3.2.2", yauzl: "3.4.0" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./node": { types: "./dist/node/index.d.ts", import: "./dist/node/index.js" },
      "./package.json": "./package.json",
    },
  },
  {
    name: "@agen-ai/agent-history",
    root: "packages/agent-history",
    directory: "packages/agent-history",
    dependencies: { "@agen-ai/agent-protocol": "^0.4.4", "@agen-ai/validation": "^0.4.4", zod: "4.4.3" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./zod": { types: "./dist/zod.d.ts", import: "./dist/zod.js" },
      "./claude": { types: "./dist/claude.d.ts", import: "./dist/claude.js" },
      "./codex": { types: "./dist/codex.d.ts", import: "./dist/codex.js" },
      "./opencode": { types: "./dist/opencode.d.ts", import: "./dist/opencode.js" },
      "./cursor": { types: "./dist/cursor.d.ts", import: "./dist/cursor.js" },
      "./acp": { types: "./dist/acp.d.ts", import: "./dist/acp.js" },
      "./grok": { types: "./dist/grok.d.ts", import: "./dist/grok.js" },
      "./package.json": "./package.json",
    },
  },
  {
    name: "@agen-ai/sandbox",
    root: "packages/sandbox",
    directory: "packages/sandbox",
    dependencies: { "@agen-ai/validation": "^0.4.4", zod: "4.4.3" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./backend": { types: "./dist/backend/index.d.ts", import: "./dist/backend/index.js" },
      "./acp": { types: "./dist/acp/index.d.ts", import: "./dist/acp/index.js" },
      "./node": { types: "./dist/node/index.d.ts", import: "./dist/node/index.js" },
      "./package.json": "./package.json",
    },
  },
  {
    name: "@agen-ai/sandbox-docker",
    root: "packages/sandbox-docker",
    directory: "packages/sandbox-docker",
    dependencies: { "@agen-ai/sandbox": "^0.4.4", "@agen-ai/validation": "^0.4.4", zod: "4.4.3" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json",
    },
  },
];

// ------------------------------------------------------------------------------------------------
//                Process and Tarball Helpers
// ------------------------------------------------------------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const ownsProcessGroup = options.timeoutMs !== undefined && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsProcessGroup,
    });
    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        if (ownsProcessGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    let timedOut = false;
    let escalation;
    const deadline = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      escalation = setTimeout(() => terminate("SIGKILL"), 1_000);
    }, options.timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (deadline) clearTimeout(deadline);
      if (escalation) {
        terminate("SIGKILL");
        clearTimeout(escalation);
      }
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} exceeded ${options.timeoutMs}ms; its owned process group was terminated.`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}).`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

async function packPackage(definition, packsRoot) {
  const before = new Set(await readdir(packsRoot));
  await run("pnpm", ["--filter", definition.name, "build"]);
  await run("pnpm", ["pack", "--pack-destination", packsRoot], {
    cwd: path.join(REPO_ROOT, definition.root),
  });
  const created = (await readdir(packsRoot)).filter(
    (file) => file.endsWith(".tgz") && !before.has(file),
  );
  assert.equal(
    created.length,
    1,
    `${definition.name} must create exactly one tarball`,
  );
  return path.join(packsRoot, created[0]);
}

function collectStringLeaves(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStringLeaves(item, output);
  }
  return output;
}

async function collectFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else files.push(absolutePath);
    }
  }
  return files.sort();
}

function inspectPackedManifest(definition, manifest, archiveFiles) {
  assert.equal(manifest.name, definition.name);
  assert.equal(manifest.version, "0.4.4");
  assert.equal(manifest.private, false);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.sideEffects, false);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.engines?.node, ">=22.0.0");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.provenance, true);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: PUBLIC_REPOSITORY_URL,
    directory: definition.directory,
  });
  assert.equal(manifest.homepage, PUBLIC_HOMEPAGE_URL);
  assert.equal(manifest.bugs?.url, PUBLIC_BUGS_URL);
  assert.deepEqual(manifest.dependencies ?? {}, definition.dependencies);
  if (definition.exports) assert.deepEqual(manifest.exports, definition.exports);
  if (definition.name === "@agen-ai/sandbox") {
    assert.deepEqual(manifest.peerDependencies, { "@agen-ai/provider-acp": "^0.4.4" });
    assert.deepEqual(manifest.peerDependenciesMeta, { "@agen-ai/provider-acp": { optional: true } });
  }
  if (definition.name === "@agen-ai/agent-history") {
    assert.deepEqual(manifest.peerDependencies, { "@agen-ai/acp-transport": "^0.4.4", "@anthropic-ai/claude-agent-sdk": "0.3.306", "@cursor/sdk": "1.0.40", "@opencode/client": "2.1.2" });
    assert.deepEqual(manifest.peerDependenciesMeta, { "@agen-ai/acp-transport": { optional: true }, "@anthropic-ai/claude-agent-sdk": { optional: true }, "@cursor/sdk": { optional: true }, "@opencode/client": { optional: true } });
    assert.equal(manifest.devDependencies?.["@anthropic-ai/claude-agent-sdk"], "0.3.306");
    assert.equal(manifest.devDependencies?.["@openai/codex"], "0.163.0");
    assert.equal(manifest.devDependencies?.["@cursor/sdk"], "1.0.40");
    assert.equal(manifest.devDependencies?.["@opencode/client"], "2.1.2");
    assert.equal(manifest.devDependencies?.["@opencode/cli"], "2.1.2");
    assert.equal(manifest.devDependencies?.["@agen-ai/acp-transport"], "^0.4.4");
    assert.equal(manifest.devDependencies?.["@xai-official/grok"], "1.0.62");
    for (const section of ["optionalDependencies", "bundledDependencies"]) {
      assert.deepEqual(manifest[section] ?? {}, {}, `History ${section} is outside the qualified core graph`);
    }
  }

  const serializedManifest = JSON.stringify(manifest);
  assert.doesNotMatch(serializedManifest, /(?:workspace|link|catalog):/u);
  assert.doesNotMatch(serializedManifest, /"file:/u);
  assert.doesNotMatch(
    serializedManifest,
    /@agenai\/(?:workspace-host-protocol|service-|db-)/u,
  );

  const exportedTargets = collectStringLeaves(manifest.exports);
  for (const target of [
    manifest.main,
    manifest.module,
    manifest.types,
    ...exportedTargets,
  ]) {
    if (target === "./package.json") continue;
    assert.equal(typeof target, "string");
    assert.ok(
      target.startsWith("./dist/"),
      `${definition.name} export must target dist: ${target}`,
    );
    assert.ok(
      archiveFiles.has(`package/${target.slice(2)}`),
      `${definition.name} tarball is missing exported target ${target}`,
    );
  }
}

async function inspectTarball(definition, tarballPath, extractedRoot) {
  const listing = await run("tar", ["-tzf", tarballPath]);
  const entries = listing.stdout.split(/\r?\n/u).filter(Boolean);
  const archiveFiles = new Set(entries.filter((entry) => !entry.endsWith("/")));
  assert.ok(archiveFiles.has("package/package.json"));
  assert.ok(archiveFiles.has("package/README.md"));
  assert.ok(archiveFiles.has("package/LICENSE"));
  assert.ok([...archiveFiles].some((entry) => entry.endsWith(".js")));
  assert.ok([...archiveFiles].some((entry) => entry.endsWith(".d.ts")));
  for (const asset of definition.assets ?? []) {
    assert.ok(archiveFiles.has(`package/${asset}`), `${definition.name} tarball is missing pinned asset ${asset}`);
  }
  const schemaFiles = [...archiveFiles].filter((entry) => entry.startsWith("package/schema/"));
  assert.deepEqual(schemaFiles.sort(), (definition.assets ?? []).map((asset) => `package/${asset}`).sort(),
    `${definition.name} must ship only its approved protocol assets`);

  for (const entry of entries) {
    assert.ok(entry.startsWith("package/"), `unsafe archive entry: ${entry}`);
    assert.ok(!entry.includes("../"), `path traversal archive entry: ${entry}`);
    assert.doesNotMatch(
      entry,
      /(?:^|\/)(?:src|tests?|__tests__|node_modules|\.turbo)(?:\/|$)|\.tsbuildinfo$|\.map$/u,
      `source, test, cache, build metadata, and source maps are not publishable: ${entry}`,
    );
  }

  const packageRoot = path.join(
    extractedRoot,
    definition.name.replace("@agenai/", ""),
  );
  await mkdir(packageRoot, { recursive: true });
  await run("tar", ["-xzf", tarballPath, "-C", packageRoot]);
  const extractedPackageRoot = path.join(packageRoot, "package");
  const manifest = JSON.parse(
    await readFile(path.join(extractedPackageRoot, "package.json"), "utf8"),
  );
  inspectPackedManifest(definition, manifest, archiveFiles);

  for (const file of await collectFiles(extractedPackageRoot)) {
    const relativeFile = path.relative(extractedPackageRoot, file);
    if (!/(?:\.d\.ts|\.js|\.json|\.md|LICENSE)$/u.test(relativeFile)) continue;
    const source = await readFile(file, "utf8");
    for (const marker of [...FORBIDDEN_ARTIFACT_TEXT, ...LOCAL_PATH_MARKERS]) {
      assert.ok(
        !source.includes(marker),
        `${definition.name}/${relativeFile} contains ${marker}`,
      );
    }
    for (const pattern of FORBIDDEN_ARTIFACT_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${definition.name}/${relativeFile} contains a private package reference`,
      );
    }
    if (
      relativeFile.endsWith(".d.ts") &&
      definition.name !== "@agen-ai/validation"
    ) {
      assert.doesNotMatch(
        source,
        /(?:workspace|link|catalog):(?:[~^*]|\d|\.{0,2}\/)|\bfile:\/\//u,
        `${definition.name}/${relativeFile} contains a workspace-only reference`,
      );
      assert.doesNotMatch(
        source,
        definition.name === "@agen-ai/acp-transport"
          ? FORBIDDEN_TRANSPORT_DECLARATION_FIELD_PATTERN
          : FORBIDDEN_DECLARATION_FIELD_PATTERN,
        `${definition.name}/${relativeFile} contains product/control fields`,
      );
    }
  }

  return { manifest, tarballPath };
}

// ------------------------------------------------------------------------------------------------
//                Independent TypeScript Consumer
// ------------------------------------------------------------------------------------------------

const CONSUMER_SOURCE = `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { runAcpProviderConsumer } from "./provider.js";
import { runStructuredOutputRuntimeConsumer } from "./structured-output/runtime.js";

import {
  ACP_TRANSPORT_PACKAGE_NAME,
  ACP_SCHEMA_RELEASE,
  ACP_V1_23_0_SCHEMA_RELEASE,
  createAcpClient,
  createAcpSchemaValidator,
  type AcpJsonValue,
  type AcpUnknownExtensionPolicy,
} from "@agen-ai/acp-transport";
import { createAcpStandardSessionOperations, type AcpUnknownExtensionPolicy as ClientUnknownExtensionPolicy } from "@agen-ai/acp-transport/client";

import { normalizeValidationIssues } from "@agen-ai/validation";
import { normalizeZodValidationError } from "@agen-ai/validation/zod";
import {
  parseAgentCollaborationId,
  parseAgentConfigurationRevisionId,
  parseAgentEnvironmentId,
  parseAgentError,
  parseAgentGeneratedResourceId,
  parseAgentInstanceId,
  parseAgentIsoDateTime,
  parseAgentItemId,
  parseAgentOperationId,
  parseAgentOperationInvocationId,
  parseAgentProviderConversationId,
  parseAgentProviderKey,
  parseAgentRequestId,
  parseAgentSessionId,
  parseAgentTurnId,
  safeParseAgentError,
  type AgentError,
  type AgentItemSnapshot,
  type AgentRuntimeRetryingEvent,
} from "@agen-ai/agent-protocol";
import { parseAgentAccountQuotaSnapshot, type AgentAccountQuotaSnapshot } from "@agen-ai/agent-protocol/account-quota";
import { parseAgentSessionBinding } from "@agen-ai/agent-protocol/sessions";
import {
  parseAgentSessionDecisionChoiceId,
  parseAgentSessionDecisionRequest,
  parseAgentSessionDecisionResponseFor,
  parseAgentSessionFormRequest,
  parseAgentSessionPlanReviewRequest,
  parseAgentSessionResponseFor,
  type AgentSessionDecisionRequest,
} from "@agen-ai/agent-protocol/session-interactions";
import { parseAgentEnvironmentSnapshot, type AgentEnvironmentSnapshot } from "@agen-ai/agent-protocol/environment";
import { parseAgentEffectiveContentCatalog } from "@agen-ai/agent-protocol/effective-content";
import { parseAgentCommandCatalog } from "@agen-ai/agent-protocol/commands";
import { parseAgentExtensionCatalog } from "@agen-ai/agent-protocol/extensions";
import {
  validateAgentEnvironmentDiscoveryPort,
  validateAgentEnvironmentObservationPort,
  type AgentEnvironmentDiscoveryInput,
  type AgentEnvironmentDiscoveryPort,
  type AgentEnvironmentObservationPort,
} from "@agen-ai/agent-runtime/environment";
import { parseAgentTurnRunInput } from "@agen-ai/agent-protocol/turns";
import { parseAgentOutputSchema, validateAgentOutputValue } from "@agen-ai/agent-protocol/structured-output";
import { parseAgentRequest } from "@agen-ai/agent-protocol/requests";
import { parseAgentEvent } from "@agen-ai/agent-protocol/events";
import { parseAgentCapabilities } from "@agen-ai/agent-protocol/capabilities";
import { parseAgentArtifactDescriptor } from "@agen-ai/agent-protocol/artifacts";
import { AgentErrorSchema, AgentEventSchema, AgentSessionDecisionRequestSchema, AgentSessionRequestSchema, AgentSessionResponseSchema } from "@agen-ai/agent-protocol/zod";
import { AGENT_ERROR_JSON_SCHEMA, AGENT_EVENT_JSON_SCHEMA, AGENT_SESSION_DECISION_REQUEST_JSON_SCHEMA,
  AGENT_SESSION_FORM_REQUEST_JSON_SCHEMA, AGENT_SESSION_FORM_RESPONSE_JSON_SCHEMA,
  AGENT_SESSION_PLAN_REVIEW_REQUEST_JSON_SCHEMA, AGENT_SESSION_PLAN_REVIEW_RESPONSE_JSON_SCHEMA,
  AGENT_SESSION_REQUEST_JSON_SCHEMA, AGENT_SESSION_RESPONSE_JSON_SCHEMA,
  AGENT_OUTPUT_SCHEMA_JSON_SCHEMA, AGENT_STRUCTURED_OUTPUT_CAPABILITY_JSON_SCHEMA,
  AGENT_STRUCTURED_OUTPUT_REQUEST_JSON_SCHEMA, AGENT_STRUCTURED_OUTPUT_RESULT_JSON_SCHEMA,
  AGENT_TURN_COMPLETED_PAYLOAD_JSON_SCHEMA,
  AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY } from "@agen-ai/agent-protocol/json-schema";
import {
  AGENT_PROVIDER_CONTRACT_ERROR_CODES,
  createAgentEventOutput,
  createAgentProviderReadiness,
  defineAgentProviderDriver,
  validateAgentAccountQuotaPort,
  validateAgentProviderAdapter,
  type AgentAccountQuotaPort,
  type AgentSessionHostBinding,
  type AgentSessionInteraction,
  type AgentSessionInteractionContext,
  type AgentSessionInteractionTerminal,
  type AgentProviderSessionInteractionContext,
  type AgentProviderAdapter,
  type AgentValidatedProviderAdapter,
  type AgentCreateSessionInput,
  type AgentNativeContinuationContext,
  type AgentSessionInteractionOptions,
  type AgentProviderSession,
  type AgentTurnSteeringResult,
} from "@agen-ai/agent-runtime";
import {
  createFakeAgentProvider,
  runAgentProviderConformance,
} from "@agen-ai/agent-runtime/testing";
import { z } from "zod/v4";

const require = createRequire(import.meta.url);
const protocolManifest = require("@agen-ai/agent-protocol/package.json") as { version: string };
assert.equal(protocolManifest.version, "0.4.4");

const titleOutputSchema = parseAgentOutputSchema({
  type: "object", additionalProperties: false,
  properties: { title: { type: "string", minLength: 1, maxLength: 80 } }, required: ["title"],
});
assert.deepEqual(validateAgentOutputValue(titleOutputSchema, { title: "Conversation title" }), {
  success: true, data: { title: "Conversation title" },
});
assert.equal(validateAgentOutputValue(titleOutputSchema, { title: 42 }).success, false);
assert.equal(validateAgentOutputValue(titleOutputSchema, { title: "Title", extra: true }).success, false);

const packedFailure: AgentError = {
  category: "quota_exhausted", code: "allowance_unavailable", message: "The observed allowance is exhausted.",
  recovery: { kind: "wait_for_quota", quota: {
    sourceId: "packed-source", poolId: "packed-pool", windowId: "packed-window",
    observedAt: parseAgentIsoDateTime("2026-10-11T12:00:00.000Z"),
    reset: { at: parseAgentIsoDateTime("2026-10-11T13:00:00.000Z"), precision: "reported",
      observedAt: parseAgentIsoDateTime("2026-10-11T12:00:00.000Z") },
  } },
};
assert.deepEqual(parseAgentError(JSON.parse(JSON.stringify(packedFailure))), packedFailure);
assert.deepEqual(AgentErrorSchema.parse(packedFailure), packedFailure);
assert.equal(safeParseAgentError({ code: "legacy", message: "Legacy failure.", retryable: false }).success, false);
assert.equal(AGENT_ERROR_JSON_SCHEMA.protocolVersion, 13);
const packedRetry: AgentRuntimeRetryingEvent = {
  protocolVersion: 13, sessionId: parseAgentSessionId("packed-retry-session"),
  turnId: parseAgentTurnId("packed-retry-turn"), occurredAt: parseAgentIsoDateTime("2026-10-11T12:00:00.000Z"),
  type: "runtime.retrying", payload: { owner: "provider", error: packedFailure, attempt: 1, maxAttempts: 2, delayMs: 0 },
};
assert.deepEqual(parseAgentEvent(JSON.parse(JSON.stringify(packedRetry))), packedRetry);
assert.deepEqual(AgentEventSchema.parse(packedRetry), packedRetry);
assert.throws(() => parseAgentEvent({ ...packedRetry, protocolVersion: 11 }));

const quotaSnapshot: AgentAccountQuotaSnapshot = parseAgentAccountQuotaSnapshot({
  schemaVersion: 1, sourceId: "packed-source", observedAt: "2026-09-07T12:00:00.000Z",
  state: "available", completeness: "partial", windows: [],
  allowance: { included: "unknown", extra: "unknown", reserve: "unknown" },
});
const quotaLifetime = new AbortController();
const quotaCandidate: AgentAccountQuotaPort = { kind: "query", query: () => quotaSnapshot };
const quotaPort = validateAgentAccountQuotaPort({
  providerKey: parseAgentProviderKey("packed-provider"), port: quotaCandidate,
  signal: quotaLifetime.signal,
});
assert.equal(quotaPort.kind, "query");
if (quotaPort.kind !== "query") throw new Error("Packed quota port lost capability");
assert.deepEqual(await quotaPort.query({ signal: new AbortController().signal }), quotaSnapshot);
quotaLifetime.abort();
await assert.rejects(async () => quotaPort.query({ signal: new AbortController().signal }));

const environmentId = parseAgentEnvironmentId("packed-environment");
const emptyCatalog = { revision: 1, observedAt: "2026-09-08T12:00:00.000Z" };
assert.equal(parseAgentEffectiveContentCatalog({ ...emptyCatalog, content: [] }).content.length, 0);
const commandCatalog = parseAgentCommandCatalog({ ...emptyCatalog, commands: [] });
assert.equal(commandCatalog.commands.length, 0);
assert.equal(parseAgentExtensionCatalog({ ...emptyCatalog, extensions: [] }).extensions.length, 0);
const environmentSnapshot: AgentEnvironmentSnapshot = parseAgentEnvironmentSnapshot({
  schemaVersion: 1, environmentId, revision: 1,
  content: { kind: "available", extent: "session", completeness: "complete", reasons: [], catalog: { ...emptyCatalog, content: [] } },
  commands: { kind: "unsupported", reasons: [] },
  extensions: { kind: "unsupported", reasons: [] },
  integrations: { kind: "unsupported", reasons: [] },
});

const environmentConfiguration = {
  kind: "managed" as const,
  revision: parseAgentConfigurationRevisionId("packed-environment-configuration"),
};
const environmentWorkingDirectory = "/tmp/external-agent-sdk-environment";

const requireDiscoveryInput = (input: AgentEnvironmentDiscoveryInput) => input;
// @ts-expect-error Discovery inputs require the scoped working directory and configuration.
requireDiscoveryInput({
  signal: new AbortController().signal,
  environmentId,
});

const missingDiscoveryWatchPort = {
  kind: "read_and_watch" as const,
  domains: ["content"] as const,
  readEnvironment: async () => environmentSnapshot,
};
// @ts-expect-error A read_and_watch discovery port must expose watchEnvironment.
const typedMissingDiscoveryWatchPort: AgentEnvironmentDiscoveryPort = missingDiscoveryWatchPort;
void typedMissingDiscoveryWatchPort;

const discoverySnapshot: AgentEnvironmentSnapshot = parseAgentEnvironmentSnapshot({
  ...environmentSnapshot,
  content: { kind: "available", extent: "workspace_discovery", completeness: "complete", reasons: [], catalog: { ...emptyCatalog, content: [] } },
});
let discoveryWatchCleanupCount = 0;
const discoveryCandidate: AgentEnvironmentDiscoveryPort = {
  kind: "read_and_watch",
  domains: ["content"],
  async readEnvironment(input) {
    assert.equal(this, discoveryCandidate);
    assert.equal(input.environmentId, environmentId);
    assert.equal(input.workingDirectory, environmentWorkingDirectory);
    assert.deepEqual(input.configuration, environmentConfiguration);
    return discoverySnapshot;
  },
  async *watchEnvironment(input) {
    assert.equal(this, discoveryCandidate);
    assert.equal(input.environmentId, environmentId);
    assert.equal(input.workingDirectory, environmentWorkingDirectory);
    assert.deepEqual(input.configuration, environmentConfiguration);
    try {
      yield { environmentId, domains: ["content"] as const };
    } finally {
      discoveryWatchCleanupCount += 1;
    }
  },
};
const discoveryLifetime = new AbortController();
const discoveryPort = validateAgentEnvironmentDiscoveryPort({
  providerKey: parseAgentProviderKey("packed-environment-discovery-provider"),
  capability: { kind: "read_and_watch", domains: ["content"] },
  port: discoveryCandidate,
  signal: discoveryLifetime.signal,
});
assert.equal(discoveryPort.kind, "read_and_watch");
if (discoveryPort.kind !== "read_and_watch") {
  throw new Error("Packed discovery port lost its watch capability");
}
let discoveryExecutionStarted = 0;
assert.deepEqual(
  await discoveryPort.readEnvironment({
    signal: new AbortController().signal,
    environmentId,
    workingDirectory: environmentWorkingDirectory,
    configuration: environmentConfiguration,
    onProviderExecutionStarted: () => {
      discoveryExecutionStarted += 1;
    },
  }),
  discoverySnapshot,
);
assert.equal(discoveryExecutionStarted, 1);
const discoveryWatchIterator = discoveryPort.watchEnvironment({
  signal: new AbortController().signal,
  environmentId,
  workingDirectory: environmentWorkingDirectory,
  configuration: environmentConfiguration,
})[Symbol.asyncIterator]();
assert.deepEqual(await discoveryWatchIterator.next(), {
  done: false,
  value: { environmentId, domains: ["content"] },
});
await discoveryWatchIterator.return?.();
assert.equal(discoveryWatchCleanupCount, 1);
discoveryLifetime.abort();

const isProviderContractError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AgentProviderContractError";
assert.throws(
  () => validateAgentEnvironmentObservationPort({
    providerKey: parseAgentProviderKey("packed-environment-malformed-provider"),
    capability: { kind: "read", domains: ["content"] },
    port: { kind: "read", domains: ["content"] },
    signal: new AbortController().signal,
  }),
  isProviderContractError,
);
assert.throws(
  () => validateAgentEnvironmentObservationPort({
    providerKey: parseAgentProviderKey("packed-environment-parity-provider"),
    capability: { kind: "read_and_watch", domains: ["content"] },
    port: {
      kind: "read",
      domains: ["content"],
      readEnvironment: async () => environmentSnapshot,
    },
    signal: new AbortController().signal,
  }),
  isProviderContractError,
);

const environmentLifetime = new AbortController();
const environmentCandidate: AgentEnvironmentObservationPort = {
  kind: "read", domains: ["content"],
  async readEnvironment(input) {
    assert.equal(this, environmentCandidate);
    assert.equal(input.environmentId, environmentId);
    return environmentSnapshot;
  },
};
const environmentPort = validateAgentEnvironmentObservationPort({
  providerKey: parseAgentProviderKey("packed-environment-provider"),
  capability: { kind: "read", domains: ["content"] },
  port: environmentCandidate,
  signal: environmentLifetime.signal,
});
assert.equal(environmentPort.kind, "read");
if (environmentPort.kind !== "read") {
  throw new Error("Packed observation port lost its read capability");
}

const readInput = { environmentId, signal: new AbortController().signal };
assert.deepEqual(await environmentPort.readEnvironment(readInput), environmentSnapshot);
await assert.rejects(() => environmentPort.readEnvironment({ ...readInput, environmentId: parseAgentEnvironmentId("wrong-generation") }));
environmentLifetime.abort();
await assert.rejects(() => environmentPort.readEnvironment(readInput));

const wrongSnapshotLifetime = new AbortController();
const wrongSnapshotPort = validateAgentEnvironmentObservationPort({
  providerKey: parseAgentProviderKey("packed-environment-wrong-snapshot-provider"),
  capability: { kind: "read", domains: ["content"] },
  port: {
    kind: "read",
    domains: ["content"],
    readEnvironment: async () => ({
      ...environmentSnapshot,
      environmentId: parseAgentEnvironmentId("returned-wrong-generation"),
    }),
  },
  signal: wrongSnapshotLifetime.signal,
});
if (wrongSnapshotPort.kind !== "read") {
  throw new Error("Packed wrong-snapshot port lost its read capability");
}
await assert.rejects(
  () => wrongSnapshotPort.readEnvironment(readInput),
  isProviderContractError,
);
wrongSnapshotLifetime.abort();

const undeclaredDomainLifetime = new AbortController();
const undeclaredDomainPort = validateAgentEnvironmentObservationPort({
  providerKey: parseAgentProviderKey("packed-environment-undeclared-domain-provider"),
  capability: { kind: "read", domains: ["content"] },
  port: {
    kind: "read",
    domains: ["content"],
    readEnvironment: async () => ({
      ...environmentSnapshot,
      commands: {
        kind: "available",
        extent: "session",
        completeness: "complete",
        reasons: [],
        catalog: commandCatalog,
      },
    }),
  },
  signal: undeclaredDomainLifetime.signal,
});
if (undeclaredDomainPort.kind !== "read") {
  throw new Error("Packed undeclared-domain port lost its read capability");
}
await assert.rejects(
  () => undeclaredDomainPort.readEnvironment(readInput),
  isProviderContractError,
);
undeclaredDomainLifetime.abort();

let resolvePendingObservation:
  ((value: AgentEnvironmentSnapshot | PromiseLike<AgentEnvironmentSnapshot>) => void)
  | undefined;
let pendingObservationResolved = false;
const pendingObservationLifetime = new AbortController();
const pendingObservationPort = validateAgentEnvironmentObservationPort({
  providerKey: parseAgentProviderKey("packed-environment-pending-provider"),
  capability: { kind: "read", domains: ["content"] },
  port: {
    kind: "read",
    domains: ["content"],
    readEnvironment: async () => new Promise<AgentEnvironmentSnapshot>((resolve) => {
      resolvePendingObservation = resolve;
    }),
  },
  signal: pendingObservationLifetime.signal,
});
if (pendingObservationPort.kind !== "read") {
  throw new Error("Packed pending observation port lost its read capability");
}
const pendingReadAbort = new AbortController();
const pendingRead = pendingObservationPort.readEnvironment({
  environmentId,
  signal: pendingReadAbort.signal,
}).then(() => {
  pendingObservationResolved = true;
});
assert.ok(resolvePendingObservation);
pendingReadAbort.abort(new DOMException("Pending environment read canceled.", "AbortError"));
await assert.rejects(pendingRead);
assert.equal(pendingObservationResolved, false);
const resolvePending = resolvePendingObservation;
assert.ok(resolvePending);
resolvePending(environmentSnapshot);
await Promise.resolve();
assert.equal(pendingObservationResolved, false);
pendingObservationLifetime.abort();

const referencePart = {
  type: "content_reference" as const,
  environmentId,
  environmentRevision: 2,
  contentCatalogRevision: 3,
  contentId: "packed-content",
  contentRevision: 4,
  arguments: JSON.stringify({ mode: "preview", scope: "document" }),
};
const referenceInput = parseAgentTurnRunInput({
  turnId: parseAgentTurnId("packed-content-reference"), interactionMode: "default",
  parts: [referencePart],
});
assert.deepEqual(referenceInput.parts[0], referencePart);
const roundTrippedReferenceInput = parseAgentTurnRunInput(
  JSON.parse(JSON.stringify(referenceInput)),
);
assert.deepEqual(roundTrippedReferenceInput.parts[0], referenceInput.parts[0]);
assert.throws(() => parseAgentTurnRunInput({
  turnId: parseAgentTurnId("packed-content-reference-utf8-limit"),
  interactionMode: "default",
  parts: [{ ...referencePart, arguments: "é".repeat(2_049) }],
}));
assert.throws(() => parseAgentTurnRunInput({
  turnId: parseAgentTurnId("packed-content-reference-size-limit"),
  interactionMode: "default",
  parts: Array.from({ length: 17 }, () => ({
    type: "text" as const,
    text: "x".repeat(63_000),
  })),
}));

assert.equal(typeof parseAgentSessionBinding, "function");
assert.equal(typeof parseAgentTurnRunInput, "function");
assert.equal(typeof parseAgentRequest, "function");
assert.equal(typeof parseAgentArtifactDescriptor, "function");
assert.equal(AGENT_EVENT_JSON_SCHEMA.protocolVersion, 13);
assert.ok(AGENT_PROVIDER_CONTRACT_ERROR_CODES.includes("invalid_session"));

const normalized = normalizeValidationIssues(
  [{ code: "custom", path: ["value"], message: "Invalid value" }],
  { value: 42 },
);
assert.equal(normalized[0]?.path[0], "value");
const validationSchema = z.object({ value: z.string() });
const invalid = validationSchema.safeParse({ value: 42 });
assert.equal(invalid.success, false);
if (!invalid.success) {
  assert.equal(normalizeZodValidationError(validationSchema, invalid.error, { value: 42 }).length, 1);
}

const configuration = {
  kind: "selected" as const,
  revision: parseAgentConfigurationRevisionId("configuration:1"),
  catalogRevision: 1,
  selections: [{
    key: "model",
    fieldRevision: 1,
    value: { fieldKind: "single_select" as const, optionId: "fake-model" },
  }],
};

const localFileInput = parseAgentTurnRunInput({
  turnId: parseAgentTurnId("external-turn:local-file"),
  interactionMode: "default",
  parts: [{
    type: "image",
    source: {
      type: "local_file",
      path: "/run/agenai/images/reference.webp",
      mediaType: "image/webp",
      byteSize: 64,
      widthPixels: 8,
      heightPixels: 8,
      sha256: "a".repeat(64),
    },
  }],
});
assert.equal(localFileInput.parts[0]?.type, "image");

const steeringProviderKey = parseAgentProviderKey("packed-steering-provider");
const steeringCapabilities = parseAgentCapabilities({
  protocolVersion: 13,
  providerKey: steeringProviderKey,
  sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
  turns: {
    structuredOutput: { kind: "unsupported" },
    interactionModes: ["default"],
    interrupt: false,
    steer: {
      kind: "supported",
      input: { text: true, images: { kind: "unsupported" }, contentReferences: { kind: "unsupported" } },
    },
  },
  requests: {
    approval: { kind: "unsupported" },
    elicitation: { kind: "unsupported" },
  },
  context: {
    usage: { kind: "unsupported" },
    compaction: { kind: "unsupported" },
  },
  input: { text: true, images: { kind: "unsupported" }, contentReferences: { kind: "unsupported" } },
  output: {
    streaming: false,
    plans: false,
    fileChanges: "none",
    artifactKinds: [],
  },
  configuration: { kind: "managed" },
  operations: { kind: "unsupported" },
  managedContent: { kind: "unsupported" },
  integrations: { kind: "unsupported" },
  environment: { instance: { kind: "unsupported" }, session: { kind: "unsupported" } },
  collaboration: { kind: "unsupported" },
  generatedResources: { kind: "unsupported" },
  authentication: { kind: "unsupported" },
  versionReporting: true,
});
let packedSteeringResult: AgentTurnSteeringResult = { status: "delivered" };
let packedRunCount = 0;
const packedSession = (sessionId = parseAgentSessionId("packed-steering-session")): AgentProviderSession => ({
  binding: {
    conversationId: parseAgentProviderConversationId("packed-steering-conversation"),
  },
  startTurn: (input) => ({
    turnId: input.turnId,
    outputs: (async function* () {
      packedRunCount += 1;
      yield createAgentEventOutput({
        protocolVersion: 13,
        type: "turn.started",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:00.000Z",
        payload: {},
      });
      yield createAgentEventOutput({
        protocolVersion: 13,
        type: "turn.completed",
        sessionId,
        turnId: input.turnId,
        occurredAt: "2026-08-04T00:00:01.000Z",
        payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } },
      });
    })(),
    resolveRequest: async () => { throw new Error("The steering fixture has no pending request."); },
  }),
  interruption: { kind: "unsupported" },
  steering: {
    kind: "supported",
    steerTurn: async (input) => {
      assert.ok(input.parts.length > 0);
      return packedSteeringResult;
    },
  },
  configuration: { kind: "managed" },
  operations: { kind: "unsupported" },
  managedContent: { kind: "unsupported" },
  environment: { kind: "unsupported" },
  collaboration: { kind: "unsupported" },
  generatedResources: { kind: "unsupported" },
  close: async () => undefined,
});
// Packed declarations and export maps must support a complete outside-turn decision.
const decision: AgentSessionDecisionRequest = parseAgentSessionDecisionRequest({
  kind: "decision", requestId: parseAgentRequestId("packed-session-decision"),
  sessionId: parseAgentSessionId("packed-interaction-session"),
  title: "Allow workspace configuration?", target: { kind: "workspace", path: "/tmp/packed-workspace" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  choices: [{ choiceId: parseAgentSessionDecisionChoiceId("decline"), label: "Keep gated",
    description: "Leave workspace configuration gated.",
    consequence: { kind: "decline", configuration: "remains_gated" } }],
});
assert.deepEqual(AgentSessionDecisionRequestSchema.parse(decision), decision);
assert.equal(AGENT_SESSION_DECISION_REQUEST_JSON_SCHEMA.protocolVersion, 13);
assert.throws(() => parseAgentSessionDecisionResponseFor(decision, { kind: "decision", choiceId: "unoffered" }));
// The installed portable graph includes forms and exact plan snapshots independently of runtime support.
const packedForm = parseAgentSessionFormRequest({
  kind: "form", requestId: "packed-form", sessionId: decision.sessionId, title: "Choose a workspace name",
  fields: [{ kind: "text", fieldId: "name", label: "Name", required: true,
    sensitivity: "ordinary", multiline: false, maxLength: 40 }],
  choices: [{ choiceId: "submit", action: "submit", label: "Submit" }],
});
const packedFormResponse = parseAgentSessionResponseFor(packedForm, {
  kind: "form", action: "submit", choiceId: "submit", answers: [{ kind: "text", fieldId: "name", value: "Packed workspace" }],
});
assert.deepEqual(AgentSessionRequestSchema.parse(packedForm), packedForm);
assert.deepEqual(AgentSessionResponseSchema.parse(packedFormResponse), packedFormResponse);
assert.throws(() => parseAgentSessionResponseFor(packedForm, {
  kind: "form", action: "submit", choiceId: "submit", answers: [],
}));
const packedReview = parseAgentSessionPlanReviewRequest({
  kind: "plan_review", requestId: "packed-review", sessionId: decision.sessionId, title: "Review the exact plan",
  plan: { planId: "packed-plan", revision: "revision:1", title: "Implementation",
    content: { kind: "text", format: "markdown", text: "Inspect the workspace, then apply the approved change." } },
  choices: [{ choiceId: "revise", action: "revise", label: "Request changes" }],
});
const packedReviewResponse = parseAgentSessionResponseFor(packedReview, {
  kind: "plan_review", action: "revise", choiceId: "revise", planId: "packed-plan", revision: "revision:1",
  feedback: "Inspect failure handling first.",
});
assert.deepEqual(AgentSessionRequestSchema.parse(packedReview), packedReview);
assert.deepEqual(AgentSessionResponseSchema.parse(packedReviewResponse), packedReviewResponse);
assert.throws(() => parseAgentSessionResponseFor(packedReview, { ...packedReviewResponse, revision: "revision:2" }));
assert.equal(AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.length, 40);
for (const artifact of [AGENT_SESSION_FORM_REQUEST_JSON_SCHEMA, AGENT_SESSION_FORM_RESPONSE_JSON_SCHEMA,
  AGENT_SESSION_PLAN_REVIEW_REQUEST_JSON_SCHEMA, AGENT_SESSION_PLAN_REVIEW_RESPONSE_JSON_SCHEMA,
  AGENT_SESSION_REQUEST_JSON_SCHEMA, AGENT_SESSION_RESPONSE_JSON_SCHEMA,
  AGENT_OUTPUT_SCHEMA_JSON_SCHEMA, AGENT_STRUCTURED_OUTPUT_CAPABILITY_JSON_SCHEMA,
  AGENT_STRUCTURED_OUTPUT_REQUEST_JSON_SCHEMA, AGENT_STRUCTURED_OUTPUT_RESULT_JSON_SCHEMA,
  AGENT_TURN_COMPLETED_PAYLOAD_JSON_SCHEMA]) {
  assert.equal(artifact.protocolVersion, 13);
  assert.ok(AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.includes(artifact));
}
// Installed declarations must keep producer authority separate from application handlers.
// This compile-only consumer has no candidate/native effects.
export function installedSessionRoles(
  candidate: AgentProviderAdapter,
  validated: AgentValidatedProviderAdapter,
  producer: AgentProviderSessionInteractionContext,
  consumer: AgentSessionInteractionContext,
  continuation: AgentNativeContinuationContext,
  opening: AgentCreateSessionInput,
): void {
  const applicationOpening: AgentCreateSessionInput = {
    ...opening, interactions: consumer, nativeContinuations: continuation,
  };
  const producerOpening: Parameters<AgentProviderAdapter["createSession"]>[0] = {
    sessionId: opening.sessionId, workingDirectory: opening.workingDirectory,
    configuration: opening.configuration, onBindingCreated: opening.onBindingCreated,
    interactions: producer,
  };
  // @ts-expect-error A raw provider cannot receive application interaction/continuation handlers.
  const candidateAsValidated: AgentValidatedProviderAdapter = candidate;
  // @ts-expect-error A consumer adapter cannot be substituted for a producer adapter.
  const validatedAsCandidate: AgentProviderAdapter = validated;
  // @ts-expect-error Unbounded human waiting cannot carry a conflicting finite timeout.
  const conflictingWait: AgentSessionInteractionOptions = { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { requestTimeoutMs: 300_000 } };
  void [applicationOpening, producerOpening, candidateAsValidated, validatedAsCandidate, conflictingWait];
}

const presented: AgentSessionInteraction[] = [];
const interactions: AgentSessionInteractionContext = { onRequest: (handle) => { presented.push(handle); } };
let decisionEntries = 0;
let interactionCloses = 0;
const interactionAdapter = validateAgentProviderAdapter(steeringCapabilities, {
  sessionInteractions: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "decision" }],
    producerOwnership: "exclusive", humanWait: ["bounded"] },
  createSession(input) {
    const native = packedSession(input.sessionId);
    input.onBindingCreated(native.binding);
    let settleTerminal: ((value: AgentSessionInteractionTerminal) => void) | undefined;
    const terminal = new Promise<AgentSessionInteractionTerminal>((resolve) => { settleTerminal = resolve; });
    const lifetime = new AbortController();
    const callback = Promise.resolve(input.interactions?.onRequest({
      kind: "direct", request: decision, signal: lifetime.signal, terminal,
      respond: async ({ signal: _signal, ...value }) => {
        const response = parseAgentSessionDecisionResponseFor(decision, value);
        decisionEntries += 1;
        assert.ok(settleTerminal);
        settleTerminal({ kind: "answered", response });
        return { status: "delivered" };
      },
    }));
    return { ...native, close: async () => {
      interactionCloses += 1;
      lifetime.abort();
      assert.ok(settleTerminal);
      settleTerminal({ kind: "session_closed" });
      await callback;
    } };
  },
  resumption: { kind: "unsupported" }, branching: { kind: "unsupported" },
  authentication: { kind: "unsupported" },
});
const interactionSession = await interactionAdapter.createSession({
  sessionId: decision.sessionId, workingDirectory: "/tmp/packed-workspace",
  configuration: environmentConfiguration, onBindingCreated: () => undefined, interactions,
});
assert.equal(presented.length, 1);
const interaction = presented[0];
assert.ok(interaction);
assert.equal(decisionEntries, 0);
const answer = { kind: "decision" as const, choiceId: decision.choices[0].choiceId };
assert.deepEqual(await interaction.respond(answer), { status: "delivered" });
assert.deepEqual(await interaction.terminal, { kind: "answered", response: answer });
const repeatAnswer = await interaction.respond(answer);
assert.equal(repeatAnswer.status, "rejected");
if (repeatAnswer.status === "rejected") assert.equal(repeatAnswer.requestState, "unavailable");
assert.equal(decisionEntries, 1);
await interactionSession.close({ reason: "idle" });
assert.equal(interactionCloses, 1);

const steeringDriver = defineAgentProviderDriver({
  providerKey: steeringProviderKey,
  supportsMultipleInstances: false,
  parseConfiguration: () => ({}),
  createInstance: ({ instanceId }) => ({
    instanceId,
    capabilities: steeringCapabilities,
    adapter: {
      createSession(input) {
        const session = packedSession(input.sessionId);
        input.onBindingCreated(session.binding);
        return session;
      },
      resumption: { kind: "unsupported" },
      branching: { kind: "unsupported" },
      authentication: { kind: "unsupported" },
    },
    accountQuota: { kind: "unsupported" },
    environment: { kind: "unsupported" },
    checkReadiness: () => createAgentProviderReadiness({
      status: "ready",
      checkedAt: "2026-08-04T00:00:00.000Z",
      version: "1.0.0-test",
    }),
    dispose: async () => undefined,
  }),
});
const steeringInstance = await steeringDriver.materialize({
  providerKey: steeringProviderKey,
  instanceId: parseAgentInstanceId("packed-steering-instance"),
  driverConfiguration: {},
});
const steeringAdapter = validateAgentProviderAdapter(steeringCapabilities, steeringInstance.adapter);
const packedSteeringCases: readonly AgentTurnSteeringResult[] = [
  { status: "delivered" },
  { status: "rejected", error: { category: "unknown", code: "not_accepted", message: "Input was rejected.", recovery: { kind: "unknown" } } },
  { status: "delivery_uncertain", error: { category: "unknown", code: "receipt_lost", message: "Delivery is unknown.", recovery: { kind: "unknown" } } },
];
for (const expected of packedSteeringCases) {
  packedSteeringResult = expected;
  const steeringSession = await steeringAdapter.createSession({
    sessionId: parseAgentSessionId("packed-steering-session-" + expected.status),
    workingDirectory: "/tmp/external-agent-sdk-steering-provider",
    configuration: {
      kind: "managed",
      revision: parseAgentConfigurationRevisionId("packed-steering-configuration"),
    },
    onBindingCreated: () => undefined,
  });
  assert.equal(steeringSession.steering.kind, "supported");
  if (steeringSession.steering.kind !== "supported") throw new Error("Steering must be supported.");
  const steeringTurnId = parseAgentTurnId("packed-steering-turn-" + expected.status);
  const steeringIterator = steeringSession.startTurn({
    turnId: steeringTurnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Start the packed provider." }],
  }).outputs[Symbol.asyncIterator]();
  assert.equal((await steeringIterator.next()).done, false);
  const result = await steeringSession.steering.steerTurn({
    turnId: steeringTurnId,
    parts: [{ type: "text", text: "Use Postgres." }],
  });
  assert.deepEqual(result, expected);
  assert.equal((await steeringIterator.next()).done, false);
  assert.equal((await steeringIterator.next()).done, true);
  const runsBeforeNextTurn = packedRunCount;
  const nextTurnInput = {
    turnId: parseAgentTurnId("packed-after-steering-" + expected.status),
    interactionMode: "default" as const,
    parts: [{ type: "text" as const, text: "Another turn." }],
  };
  if (expected.status === "delivery_uncertain") {
    assert.throws(() => steeringSession.startTurn(nextTurnInput), { code: "session_unusable" });
    assert.equal(packedRunCount, runsBeforeNextTurn);
  } else {
    const nextTurn = steeringSession.startTurn(nextTurnInput).outputs[Symbol.asyncIterator]();
    assert.equal((await nextTurn.next()).done, false);
    assert.equal((await nextTurn.next()).done, false);
    assert.equal((await nextTurn.next()).done, true);
    assert.equal(packedRunCount, runsBeforeNextTurn + 1);
  }
  await steeringSession.close({ reason: "idle" });
}
await steeringInstance.dispose();

// Exercise the published binding declarations and callback graph from packed JS.
const packedBindingCalls: string[] = [];
const packedHostBinding: AgentSessionHostBinding = {
  bindingId: "packed-host-binding",
  tools: [{
    name: "read_task",
    description: "Inspect a task authorized by this session.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { task: { type: "string", maxLength: 128 } },
      required: ["task"],
      additionalProperties: false,
    },
  }],
  instructions: { placement: "tool_context", text: "Use read_task to inspect managed tasks." },
  invoke(input) {
    packedBindingCalls.push("invoke:" + input.arguments.task);
    return { kind: "success", value: { state: "settled" } };
  },
  release() { packedBindingCalls.push("release"); },
};
let forwardedPackedBinding: AgentSessionHostBinding | undefined;
const bindingAdapter = validateAgentProviderAdapter(steeringCapabilities, {
  hostBinding: { kind: "supported", toolTransport: "callback", instructionPlacements: ["tool_context"] },
  createSession(input) {
    forwardedPackedBinding = input.hostBinding;
    const session = packedSession(input.sessionId);
    input.onBindingCreated(session.binding);
    return { ...session, close() { packedBindingCalls.push("close"); } };
  },
  resumption: { kind: "unsupported" },
  branching: { kind: "unsupported" },
  authentication: { kind: "unsupported" },
});
const bindingSession = await bindingAdapter.createSession({
  sessionId: parseAgentSessionId("packed-bound-session"),
  workingDirectory: "/tmp/external-agent-sdk-binding",
  configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("packed-binding-config") },
  hostBinding: packedHostBinding,
  onBindingCreated: () => undefined,
});
assert.ok(forwardedPackedBinding);
assert.deepEqual(await forwardedPackedBinding.invoke({
  invocationId: "packed-invocation", toolName: "read_task", arguments: { task: "child-1" },
}), { kind: "success", value: { state: "settled" } });
await bindingSession.close({ reason: "shutdown" });
assert.deepEqual(packedBindingCalls, ["invoke:child-1", "close", "release"]);

const fake = createFakeAgentProvider();
const report = await runAgentProviderConformance({
  driver: fake.driver,
  definition: fake.definition,
  workingDirectory: "/tmp/external-agent-sdk-consumer",
  configuration,
  configurationSelection: {
    key: "model",
    expectedCatalogRevision: 1,
    expectedFieldRevision: 1,
    value: { fieldKind: "single_select", optionId: "fake-model-2" },
  },
  operationInvocation: {
    invocationId: parseAgentOperationInvocationId("external-invocation:1"),
    operationId: parseAgentOperationId("fake.session.reset"),
    expectedRevision: 1,
    values: [],
  },
  collaborationSpawn: {
    collaborationId: parseAgentCollaborationId("external-collaboration:1"),
    role: "reviewer",
    title: "External consumer review",
    objective: "Review the packed external consumer.",
    createdAt: parseAgentIsoDateTime("2026-01-01T00:00:00.000Z"),
  },
  generatedResourceId: parseAgentGeneratedResourceId("fake-resource:1"),
  createSessionId: parseAgentSessionId("external-session:create"),
  resumeSessionId: parseAgentSessionId("external-session:resume"),
  branchSessionId: parseAgentSessionId("external-session:branch"),
  abortedSessionId: parseAgentSessionId("external-session:aborted"),
  interruptionSessionId: parseAgentSessionId("external-session:interruption"),
  turn: {
    turnId: parseAgentTurnId("external-turn:1"),
    interactionMode: "default",
    parts: [{ type: "text", text: "Exercise the packed provider." }],
  },
  interruptionTurn: {
    turnId: parseAgentTurnId("external-turn:interruption"),
    interactionMode: "default",
    parts: [{ type: "text", text: "Interrupt this packed provider turn." }],
  },
  resolutionFor: async (request, { signal }) => {
    await Promise.resolve();
    signal.throwIfAborted();
    assert.equal(request.requestKind, "approval");
    if (request.requestKind !== "approval") {
      throw new TypeError("The deterministic fake must open an approval request.");
    }
    const option = request.options.find((candidate) => candidate.decision === "approved" && candidate.consequence.kind === "scoped"
      && candidate.consequence.persistence === "once" && candidate.consequence.scope.kind === "exact_action");
    assert.ok(option);
    return {
      requestKind: "approval",
      requestId: request.requestId,
      disposition: "selected",
      optionId: option.optionId,
    };
  },
  branchSource: (binding, turnId) => ({
    sessionId: parseAgentSessionId("external-session:create"),
    binding,
    throughTurn: { turnId, historyAnchor: binding.historyAnchor! },
  }),
});
assert.ok(report.checks.includes("create_session"));
assert.ok(report.checks.includes("resume_session"));
assert.ok(report.checks.includes("request_resolution"));
assert.ok(report.checks.includes("interruption"));
assert.ok(report.checks.includes("environment_instance"));
assert.ok(report.checks.includes("environment_session"));
assert.ok(report.checks.includes("idempotent_session_close"));
assert.ok(report.checks.includes("idempotent_disposal"));

const limitedProviderKey = parseAgentProviderKey("limited-external-provider");
const limited = createFakeAgentProvider({
  providerKey: limitedProviderKey,
  instanceId: "limited-external-instance",
  capabilities: parseAgentCapabilities({
    protocolVersion: 13,
    providerKey: limitedProviderKey,
    sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
    turns: {
      structuredOutput: { kind: "unsupported" },
      interactionModes: ["default"],
      interrupt: false,
      steer: { kind: "unsupported" },
    },
    requests: {
      approval: { kind: "unsupported" },
      elicitation: { kind: "unsupported" },
    },
    context: {
      usage: { kind: "unsupported" },
      compaction: { kind: "unsupported" },
    },
    input: { text: true, images: { kind: "unsupported" }, contentReferences: { kind: "unsupported" } },
    output: {
      streaming: false,
      plans: false,
      fileChanges: "none",
      artifactKinds: [],
    },
    configuration: { kind: "managed" },
    operations: { kind: "unsupported" },
    managedContent: { kind: "unsupported" },
    integrations: { kind: "unsupported" },
  environment: { instance: { kind: "unsupported" }, session: { kind: "unsupported" } },
    collaboration: { kind: "unsupported" },
    generatedResources: { kind: "unsupported" },
    authentication: { kind: "unsupported" },
    versionReporting: true,
  }),
});
const limitedReport = await runAgentProviderConformance({
  driver: limited.driver,
  definition: limited.definition,
  workingDirectory: "/tmp/external-agent-sdk-consumer-limited",
  configuration: {
    kind: "managed",
    revision: parseAgentConfigurationRevisionId("limited-configuration:1"),
  },
  createSessionId: parseAgentSessionId("limited-session:create"),
  resumeSessionId: parseAgentSessionId("limited-session:resume"),
  abortedSessionId: parseAgentSessionId("limited-session:aborted"),
  interruptionSessionId: parseAgentSessionId("limited-session:interruption"),
  turn: {
    turnId: parseAgentTurnId("limited-turn:1"),
    interactionMode: "default",
    parts: [{ type: "text", text: "Exercise unsupported capabilities." }],
  },
  interruptionTurn: {
    turnId: parseAgentTurnId("limited-turn:interruption"),
    interactionMode: "default",
    parts: [{ type: "text", text: "Unused interruption fixture." }],
  },
  resolutionFor: () => {
    throw new Error("Limited provider must not open a request.");
  },
});
assert.ok(limitedReport.checks.includes("branch_session"));
assert.ok(limitedReport.checks.includes("interruption"));

const event = parseAgentEvent({
  protocolVersion: 13,
  type: "turn.started",
  sessionId: parseAgentSessionId("round-trip-session"),
  turnId: parseAgentTurnId("round-trip-turn"),
  occurredAt: "2026-08-04T00:00:00.000Z",
  payload: {},
});
const roundTripped = parseAgentEvent(JSON.parse(JSON.stringify(event)));
assert.deepEqual(roundTripped, event);
assert.deepEqual(AgentEventSchema.parse(event), event);

const commandItem: AgentItemSnapshot = {
  itemId: parseAgentItemId("packed-command"),
  itemKind: "command_execution",
  status: "completed",
  details: {
    commandSummary: "Run packed consumer checks",
    workingPath: "consumer",
    exitCode: 0,
  },
};
const itemEvent = parseAgentEvent({
  protocolVersion: 13,
  type: "item.completed",
  sessionId: parseAgentSessionId("round-trip-session"),
  turnId: parseAgentTurnId("round-trip-turn"),
  occurredAt: "2026-08-04T00:00:00.000Z",
  payload: commandItem,
});
assert.deepEqual(itemEvent.payload, commandItem);
assert.throws(
  () => parseAgentEvent({
    ...itemEvent,
    payload: {
      itemId: "packed-command-v2",
      itemKind: "command_execution",
      status: "completed",
      attributes: { commandSummary: "Retired V2 shape" },
    },
  }),
  TypeError,
);

assert.equal(ACP_TRANSPORT_PACKAGE_NAME, "@agen-ai/acp-transport");
assert.equal(ACP_SCHEMA_RELEASE, "v0.11.4");
assert.equal(ACP_V1_23_0_SCHEMA_RELEASE, "schema-v1.23.0");
const unknownExtensionPolicy: AcpUnknownExtensionPolicy = "standard" satisfies ClientUnknownExtensionPolicy;
const modernValidator = createAcpSchemaValidator("stable", "schema-v1.23.0");
assert.equal(modernValidator.profile, "schema-v1.23.0");
assert.equal(modernValidator.protocolVersion, 1);
assert.throws(() => Reflect.apply(createAcpSchemaValidator, undefined, ["stable", "unknown-profile"]),
  { reasonCode: "acp_schema_profile_unsupported" });
assert.throws(() => createAcpSchemaValidator("unstable", "schema-v1.23.0"),
  { reasonCode: "acp_schema_channel_unsupported" });
const invalidProfileStdout = new PassThrough();
const invalidProfileStdin = new PassThrough();
try {
  for (const { profile, channel, reasonCode } of [
    { profile: "unknown-profile", channel: "stable", reasonCode: "acp_schema_profile_unsupported" },
    { profile: "schema-v1.23.0", channel: "unstable", reasonCode: "acp_schema_channel_unsupported" },
  ]) {
    assert.throws(() => Reflect.apply(createAcpClient, undefined, [{
      stdout: invalidProfileStdout, stdin: invalidProfileStdin, schemaProfile: profile, schemaChannel: channel,
    }]), { reasonCode });
  }
} finally {
  invalidProfileStdout.destroy();
  invalidProfileStdin.destroy();
}
assert.throws(() => createAcpSchemaValidator("stable").validate("agent", "session/delete", "request",
  { sessionId: "packed-native-session" }), { reasonCode: "acp_method_not_in_pinned_schema" });
modernValidator.validate("client", "elicitation/create", "request", {
  mode: "form", message: "Choose", sessionId: "packed-native-session",
  requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] },
});
assert.throws(() => modernValidator.validate("client", "elicitation/create", "request", {
  mode: "form", message: "Choose", sessionId: "packed-native-session",
  requestedSchema: { type: "object", properties: { name: { type: "string", minLength: "bad" } }, required: ["name"] },
}), { reasonCode: "acp_method_payload_invalid" });
for (const { channel, profile } of [
  { channel: "stable", profile: "v0.11.4" },
  { channel: "unstable", profile: "v0.11.4" },
  { channel: "stable", profile: "schema-v1.23.0" },
] as const) {
  const validator = createAcpSchemaValidator(channel, profile);
  validator.validate("agent", "initialize", "request", { protocolVersion: 1 });
  assert.throws(() => validator.validate("agent", "initialize", "request", { protocolVersion: "1" }),
    { reasonCode: "acp_method_payload_invalid" });
  const stdout = new PassThrough();
  const methods: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        assert.ok(chunk.byteLength <= 4097);
        const frame = JSON.parse(chunk.toString("utf8")) as { jsonrpc: string; id: string; method: string; params: AcpJsonValue };
        assert.equal(frame.jsonrpc, "2.0");
        assert.ok(frame.id.startsWith("packed-"));
        methods.push(frame.method);
        let result: AcpJsonValue;
        switch (frame.method) {
          case "initialize":
            assert.deepEqual(frame.params, { protocolVersion: 1 });
            result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
            break;
          case "session/new":
            assert.deepEqual(frame.params, { cwd: "/tmp/packed-acp-session", mcpServers: [] });
            result = { sessionId: "packed-native-session" };
            break;
          case "session/prompt":
            assert.deepEqual(frame.params, { sessionId: "packed-native-session", prompt: [{ type: "text", text: "Hello" }] });
            result = { stopReason: "end_turn" };
            break;
          case "session/delete":
            assert.equal(profile, "schema-v1.23.0");
            assert.deepEqual(frame.params, { sessionId: "packed-native-session" });
            result = {};
            break;
          default:
            throw new Error("Unexpected packed ACP method: " + frame.method);
        }
        const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n");
        stdout.write(response.subarray(0, 7));
        stdout.write(response.subarray(7));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  const client = createAcpClient({
    stdout, stdin, schemaChannel: channel, outboundRequestIdPrefix: "packed-",
    unknownExtensionPolicy,
    ...(profile === "schema-v1.23.0" ? { schemaProfile: profile } : {}),
    limits: { maxInboundFrameBytes: 4096, maxOutboundFrameBytes: 4096, maxOutboundBufferedBytes: 4097,
      maxOutstandingRequests: 1, defaultRequestTimeoutMs: 1000, maxRequestTimeoutMs: 1000 },
  });
  try {
    const operations = createAcpStandardSessionOperations(client);
    if (profile === "schema-v1.23.0") {
      await assert.rejects(client.request("initialize", { protocolVersion: 2 }),
        { reasonCode: "acp_protocol_version_unsupported" });
    } else {
      await assert.rejects(client.request("session/delete", { sessionId: "packed-native-session" }),
        { reasonCode: "acp_outbound_method_not_registered" });
    }
    assert.deepEqual(methods, []);
    assert.deepEqual(await operations.initialize({ protocolVersion: 1 }),
      { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    assert.deepEqual(await operations.newSession({ cwd: "/tmp/packed-acp-session", mcpServers: [] }),
      { sessionId: "packed-native-session" });
    assert.deepEqual(await operations.prompt({ sessionId: "packed-native-session", prompt: [{ type: "text", text: "Hello" }] }),
      { stopReason: "end_turn" });
    const expectedMethods = ["initialize", "session/new", "session/prompt"];
    if (profile === "schema-v1.23.0") {
      assert.deepEqual(await client.request("session/delete", { sessionId: "packed-native-session" }), {});
      expectedMethods.push("session/delete");
    }
    assert.deepEqual(methods, expectedMethods);
  } finally {
    await client.dispose();
    stdout.destroy();
    stdin.destroy();
  }
  assert.equal((await client.closed).kind, "disposed");
}

await runAcpProviderConsumer();
process.stdout.write(JSON.stringify({ proof: "packed-structured-output-runtime", ...(await runStructuredOutputRuntimeConsumer()) }) + "\\n");
process.stdout.write("External packed agent SDK consumer passed.\\n");
`;

const ACP_PROVIDER_CONSUMER_SOURCE = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  parseAgentConfigurationRevisionId,
  parseAgentInstanceId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentEvent,
} from "@agen-ai/agent-protocol";
import {
  validateAgentProviderAdapter,
  type AgentProviderDriver,
  type AgentProviderOutput,
  type AgentProviderSession,
} from "@agen-ai/agent-runtime";
import { createAcpProviderDriver, type AcpHostFacilities, type AcpPermissionMappingSelection,
  type AcpPermissionMenuSignature, type AcpPermissionOptionSignature } from "@agen-ai/provider-acp";
import { createNodeAcpProviderDriver } from "@agen-ai/provider-acp/node";

async function collectEvents(iterator: AsyncIterator<AgentProviderOutput>, untilRequest = false): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let count = 0;
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    assert.ok(++count <= 64, "The fixture must produce a bounded output stream.");
    if (next.value.kind === "event") {
      events.push(next.value.event);
      if (untilRequest && next.value.event.type === "request.opened") break;
    }
  }
  return events;
}

async function openSession(driver: AgentProviderDriver, name: string) {
  const instance = await driver.materialize({
    providerKey: driver.providerKey,
    instanceId: parseAgentInstanceId(name + "-instance"),
    driverConfiguration: {},
  });
  try {
    const sessionId = parseAgentSessionId(name + "-session");
    let bindingCount = 0;
    let createdBinding: AgentProviderSession["binding"] | undefined;
    const session = await validateAgentProviderAdapter(instance.capabilities, instance.adapter).createSession({
      sessionId,
      workingDirectory: fileURLToPath(new URL("../", import.meta.url)),
      configuration: { kind: "managed", revision: parseAgentConfigurationRevisionId("packed-acp-configuration") },
      onBindingCreated(binding) {
        bindingCount += 1;
        createdBinding = binding;
      },
    });
    assert.equal(bindingCount, 1);
    assert.deepEqual(createdBinding, session.binding);
    return { instance, session };
  } catch (error) {
    await instance.dispose();
    throw error;
  }
}

function startTextTurn(session: AgentProviderSession, name: string) {
  return session.startTurn({
    turnId: parseAgentTurnId(name + "-turn"), interactionMode: "default",
    parts: [{ type: "text", text: "Exercise retained offline ACP" }],
    signal: AbortSignal.timeout(5_000),
  });
}

function runTextTurn(session: AgentProviderSession, name: string) {
  return collectEvents(startTextTurn(session, name).outputs[Symbol.asyncIterator]());
}

export async function runAcpProviderConsumer(): Promise<void> {
  const declaredOption: AcpPermissionOptionSignature = { optionId: "remembered", kind: "allow_always" };
  const declaredMenu: AcpPermissionMenuSignature = { toolKind: "edit", options: [declaredOption] };
  const permissionMapping: AcpPermissionMappingSelection = { mapping: "declared-complete-consequences-v1",
    agentInfo: { name: "packed-declared-peer", version: "1.0.0" }, menus: [declaredMenu] };
  let constructorConnections = 0;
  const declaredDriver = createAcpProviderDriver({ providerKey: "packed-declared-constructor", permissionMapping,
    createConnection() { constructorConnections += 1; throw new Error("Construction must remain inert."); } });
  assert.equal(declaredDriver.providerKey, "packed-declared-constructor");
  assert.equal(constructorConnections, 0);
  const stdout = new PassThrough();
  const methods: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        assert.ok(chunk.byteLength <= 16_384);
        const frame = JSON.parse(chunk.toString("utf8")) as {
          id: string; method: string; params: { protocolVersion?: number; sessionId?: string };
        };
        methods.push(frame.method);
        let result: unknown;
        if (frame.method === "initialize") {
          assert.equal(frame.params.protocolVersion, 1);
          result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "packed-peer", version: "1.0.0" } };
        } else if (frame.method === "session/new") {
          stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "_packed/optional_observation", params: {} }) + "\\n");
          result = { sessionId: "borrowed-native-session" };
        } else if (frame.method === "session/prompt") {
          assert.equal(frame.params.sessionId, "borrowed-native-session");
          stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "borrowed-native-session", update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Borrowed stream response" },
            },
          } }) + "\\n");
          result = { stopReason: "end_turn" };
        } else {
          throw new Error("Unexpected injected ACP method: " + frame.method);
        }
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n");
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  try {
    const borrowed = await openSession(createAcpProviderDriver({
      providerKey: "packed-acp-borrowed",
      createConnection: () => ({ stdout, stdin, ownership: "borrowed" }),
      limits: { initializationTimeoutMs: 5_000, cancellationTimeoutMs: 1_000 },
    }), "packed-borrowed");
    try {
      const events = await runTextTurn(borrowed.session, "packed-borrowed");
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      assert.ok(events.some((event) => event.type === "content.delta" && event.payload.delta === "Borrowed stream response"));
      assert.ok(events.some((event) => event.type === "item.completed" && event.payload.itemKind === "assistant_message"));
      assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
    } finally {
      try { await borrowed.session.close({ reason: "shutdown" }); }
      finally { await borrowed.instance.dispose(); }
    }
    assert.equal(stdout.destroyed, false);
    assert.equal(stdin.destroyed, false);
    assert.equal(stdin.writableEnded, false);
  } finally {
    stdout.destroy();
    stdin.destroy();
  }

  const reportPath = fileURLToPath(new URL("../acp-peer-report.json", import.meta.url));
  const owned = await openSession(createNodeAcpProviderDriver({
    providerKey: "packed-acp-node",
    unknownExtensionPolicy: "standard",
    limits: { initializationTimeoutMs: 5_000, cancellationTimeoutMs: 1_000 },
    launch: {
      executable: process.execPath,
      args: [fileURLToPath(new URL("../acp-peer.mjs", import.meta.url)), reportPath, "permission"],
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      shutdownTimeoutMs: 1_000,
    },
  }), "packed-node");
  try {
    const execution = startTextTurn(owned.session, "packed-node");
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const initial = await collectEvents(iterator, true);
    const waiting = await iterator.next();
    assert.ok(!waiting.done && waiting.value.kind === "event" && waiting.value.event.type === "turn.state_changed");
    initial.push(waiting.value.event);
    const requests = initial.filter((event) => event.type === "request.opened");
    assert.equal(requests.length, 1);
    const request = requests[0]?.payload.request;
    assert.ok(request && request.requestKind === "approval");
    assert.equal(request.subject.kind, "tool");
    if (request.subject.kind !== "tool") throw new Error("Expected a correlated tool approval.");
    const approved = request.options.find((option) => option.decision === "approved" && option.consequence.kind === "scoped"
      && option.consequence.persistence === "once" && option.consequence.scope.kind === "exact_action");
    assert.ok(approved);
    assert.deepEqual(approved.consequence, { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } });
    assert.equal(initial.some((event) => event.type === "turn.completed"), false);
    assert.ok(initial.some((event) => event.type === "turn.state_changed" && event.payload.state === "waiting_for_request"));
    assert.deepEqual(await execution.resolveRequest({ resolution: {
      requestKind: "approval", requestId: request.requestId, disposition: "selected", optionId: approved.optionId,
    }, signal: AbortSignal.timeout(5_000) }), { status: "delivered" });
    const resumed = await collectEvents(iterator);
    const tool = resumed.find((event) => event.type === "item.completed" && event.payload.itemKind === "dynamic_tool_call");
    assert.ok(tool && tool.type === "item.completed");
    assert.equal(tool.payload.itemId, request.subject.itemId);
    assert.equal(tool.payload.status, "completed");
    assert.equal(resumed.filter((event) => event.type === "turn.completed").length, 1);
    assert.ok(resumed.some((event) => event.type === "content.delta" && event.payload.delta === "Retained offline result"));
    assert.ok(resumed.some((event) => event.type === "item.completed" && event.payload.itemKind === "assistant_message"));
  } finally {
    try { await owned.session.close({ reason: "shutdown" }); }
    finally { await owned.instance.dispose(); }
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    pid: number; methods: string[]; permissionResponses: unknown[]; exited: boolean;
  };
  assert.deepEqual(report.methods, ["initialize", "session/new", "session/prompt"]);
  assert.deepEqual(report.permissionResponses, [{ id: "permission-1", result: { outcome: { outcome: "selected", optionId: "allow" } } }]);
  assert.equal(report.exited, true);
  assert.throws(() => process.kill(report.pid, 0), { code: "ESRCH" });
  await runAdvancedAcpProviderConsumer();
}

async function runAdvancedAcpProviderConsumer(): Promise<void> {
  const workingDirectory = fileURLToPath(new URL("../", import.meta.url));
  const resumedSessionId = parseAgentSessionId("packed-advanced-resumed");
  const connections: { stdout: PassThrough; stdin: Writable }[] = [];
  const methods: string[] = [];
  const formReplies: unknown[] = [];
  let model = "balanced";
  let hostReads = 0;
  const configOptions = () => [{
    id: "native-model", name: "Model", type: "select", currentValue: model,
    options: [{ value: "balanced", name: "Balanced" }, { value: "quality", name: "Quality" }],
  }];
  const host: AcpHostFacilities = {
    readTextFile(input) {
      assert.equal(input.sessionId, resumedSessionId);
      assert.equal(input.workingDirectory, workingDirectory);
      assert.equal(input.path, workingDirectory + "README.md");
      assert.equal(input.signal.aborted, false);
      hostReads += 1;
      return "Host-approved fixture text";
    },
  };
  const driver = createAcpProviderDriver({
    providerKey: "packed-acp-advanced", configuration: "selectable", host,
    limits: { initializationTimeoutMs: 5_000, cancellationTimeoutMs: 1_000 },
    createConnection() {
      const stdout = new PassThrough();
      let pendingPrompt: string | number | undefined;
      const send = (frame: unknown) => { stdout.write(JSON.stringify(frame) + "\\n"); };
      const update = (text: string) => ({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "advanced-native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } });
      const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          try {
            assert.ok(chunk.byteLength <= 16_384);
            const frame = JSON.parse(chunk.toString("utf8")) as {
              id: string | number; method?: string; params?: Record<string, unknown>; result?: unknown;
            };
            if (frame.method) {
              methods.push(frame.method);
              assert.ok(methods.length <= 16, "The advanced peer must receive bounded native operations.");
              if (frame.method === "initialize") {
                const capabilities = frame.params?.clientCapabilities as {
                  session?: { configOptions?: { boolean?: object } }; elicitation?: { form?: object }; fs?: { readTextFile?: boolean };
                };
                assert.deepEqual(capabilities.session?.configOptions?.boolean, {});
                assert.deepEqual(capabilities.elicitation?.form, {});
                assert.equal(capabilities.fs?.readTextFile, true);
                send({ jsonrpc: "2.0", id: frame.id, result: {
                  protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [],
                  agentInfo: { name: "packed-advanced-peer", version: "1.0.0" },
                } });
              } else if (frame.method === "session/new") {
                send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "advanced-native", configOptions: configOptions() } });
              } else if (frame.method === "session/set_config_option") {
                assert.equal(frame.params?.sessionId, "advanced-native");
                assert.equal(frame.params?.configId, "native-model");
                assert.equal(frame.params?.value, "quality");
                model = "quality";
                send({ jsonrpc: "2.0", id: frame.id, result: { configOptions: configOptions() } });
              } else if (frame.method === "session/load") {
                assert.equal(frame.params?.sessionId, "advanced-native");
                assert.equal(frame.params?.cwd, workingDirectory);
                stdout.write([
                  update("HISTORICAL CONTENT MUST REMAIN HIDDEN"),
                  { jsonrpc: "2.0", id: frame.id, result: { configOptions: configOptions() } },
                ].map((message) => JSON.stringify(message)).join("\\n") + "\\n");
              } else if (frame.method === "session/prompt") {
                assert.equal(frame.params?.sessionId, "advanced-native");
                assert.equal(pendingPrompt, undefined);
                pendingPrompt = frame.id;
                send({ jsonrpc: "2.0", id: "packed-read", method: "fs/read_text_file", params: {
                  sessionId: "advanced-native", path: workingDirectory + "README.md", line: 1, limit: 1,
                } });
              } else throw new Error("Unexpected advanced ACP method: " + frame.method);
            } else if (frame.id === "packed-read") {
              assert.deepEqual(frame.result, { content: "Host-approved fixture text" });
              send({ jsonrpc: "2.0", id: "packed-form", method: "elicitation/create", params: {
                mode: "form", sessionId: "advanced-native", message: "Continue this fixture?",
                requestedSchema: { type: "object", properties: { proceed: { type: "boolean", title: "Continue?" } }, required: ["proceed"] },
              } });
            } else {
              assert.equal(frame.id, "packed-form");
              assert.ok(pendingPrompt !== undefined);
              assert.equal(formReplies.length, 0);
              formReplies.push(frame.result);
              assert.deepEqual(frame.result, { action: "accept", content: { proceed: false } });
              stdout.write([
                update("LIVE AFTER LOAD"),
                { jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } },
              ].map((message) => JSON.stringify(message)).join("\\n") + "\\n");
              pendingPrompt = undefined;
            }
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      connections.push({ stdout, stdin });
      return { stdout, stdin, ownership: "borrowed" };
    },
  });
  const instance = await driver.materialize({
    providerKey: driver.providerKey, instanceId: parseAgentInstanceId("packed-advanced-instance"), driverConfiguration: {},
  });
  const adapter = validateAgentProviderAdapter(instance.capabilities, instance.adapter);
  const configuration = {
    kind: "selected" as const, revision: parseAgentConfigurationRevisionId("packed-advanced-configuration"), catalogRevision: 1, selections: [],
  };
  try {
    const initial = await adapter.createSession({
      sessionId: parseAgentSessionId("packed-advanced-created"), workingDirectory, configuration, onBindingCreated() {},
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(initial.configuration.kind, "selectable");
    if (initial.configuration.kind !== "selectable") throw new Error("Expected installed selectable configuration.");
    const catalog = await initial.configuration.listConfiguration();
    const field = catalog.fields.find((candidate) => candidate.label === "Model");
    assert.ok(field?.fieldKind === "single_select");
    const option = field.options.find((candidate) => candidate.label === "Quality");
    assert.ok(option);
    const selected = {
      key: field.key, expectedCatalogRevision: catalog.revision, expectedFieldRevision: field.revision,
      value: { fieldKind: "single_select" as const, optionId: option.optionId },
    };
    let configurationStarted = 0;
    assert.equal((await initial.configuration.applyConfigurationSelection({
      selection: selected, onProviderExecutionStarted() { configurationStarted += 1; }, signal: AbortSignal.timeout(5_000),
    })).status, "completed");
    assert.equal(configurationStarted, 1);
    await assert.rejects(async () => initial.configuration.kind === "selectable"
      ? initial.configuration.applyConfigurationSelection({ selection: selected }) : Promise.reject(new Error("Lost configuration port")));
    assert.equal(methods.filter((method) => method === "session/set_config_option").length, 1);
    const binding = initial.binding;
    await initial.close({ reason: "idle" });
    assert.equal(adapter.resumption.kind, "supported");
    if (adapter.resumption.kind !== "supported") throw new Error("Expected installed load-based resumption.");
    const resumed = await adapter.resumption.resumeSession({
      sessionId: resumedSessionId, workingDirectory, configuration, binding, signal: AbortSignal.timeout(5_000),
    });
    try {
      assert.deepEqual(resumed.binding, binding);
      const execution = startTextTurn(resumed, "packed-advanced");
      const iterator = execution.outputs[Symbol.asyncIterator]();
      const first = await collectEvents(iterator, true);
      const intentEvent = first.find((event) => event.type === "request.opened");
      assert.ok(intentEvent?.type === "request.opened" && intentEvent.payload.request.requestKind === "elicitation");
      const intent = intentEvent.payload.request;
      const intentField = intent.fields[0];
      assert.ok(intentField?.kind === "single_select");
      const provideAnswers = intentField.options.find((candidate) => candidate.label === "Provide answers");
      assert.ok(provideAnswers);
      assert.deepEqual(formReplies, []);
      assert.deepEqual(await execution.resolveRequest({ resolution: {
        requestKind: "elicitation", requestId: intent.requestId, disposition: "answered",
        answers: [{ fieldId: intentField.fieldId, kind: "single_select", value: provideAnswers.value }],
      }, signal: AbortSignal.timeout(5_000) }), { status: "delivered" });
      assert.deepEqual(formReplies, []);
      const second = await collectEvents(iterator, true);
      const fieldsEvent = second.find((event) => event.type === "request.opened");
      assert.ok(fieldsEvent?.type === "request.opened" && fieldsEvent.payload.request.requestKind === "elicitation");
      const fields = fieldsEvent.payload.request;
      const boolean = fields.fields[0];
      assert.ok(boolean?.kind === "boolean");
      assert.notEqual(fields.requestId, intent.requestId);
      assert.deepEqual(formReplies, []);
      assert.deepEqual(await execution.resolveRequest({ resolution: {
        requestKind: "elicitation", requestId: fields.requestId, disposition: "answered",
        answers: [{ fieldId: boolean.fieldId, kind: "boolean", value: false }],
      }, signal: AbortSignal.timeout(5_000) }), { status: "delivered" });
      const final = await collectEvents(iterator);
      const events = [...first, ...second, ...final];
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      assert.equal(events.filter((event) => event.type === "request.opened").length, 2);
      assert.equal(events.filter((event) => event.type === "content.delta").map((event) => event.payload.delta).join(""), "LIVE AFTER LOAD");
      assert.deepEqual(formReplies, [{ action: "accept", content: { proceed: false } }]);
      assert.equal(hostReads, 1);
      assert.deepEqual(methods, ["initialize", "session/new", "session/set_config_option", "initialize", "session/load", "session/prompt"]);
    } finally { await resumed.close({ reason: "shutdown" }); }
  } finally {
    try { await instance.dispose(); }
    finally { for (const connection of connections) { connection.stdout.destroy(); connection.stdin.destroy(); } }
  }
}
`;

const ACP_REGISTRY_CONSUMER_SOURCE = String.raw`import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import workerThreads from "node:worker_threads";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import type { AcpInstallPolicy, CreateAcpInstallPlanInput, AcpRegistrySource } from "@agen-ai/acp-registry";
import type { FetchAcpRegistrySnapshotInput, FetchedAcpRegistrySnapshot } from "@agen-ai/acp-registry/node";

const stdout = process.stdout;
void process.stderr;
let effectAttempts = 0;
const denyEffect = () => {
  effectAttempts += 1;
  throw new Error("Registry metadata operations attempted process or network execution.");
};
for (const [facility, methods] of [
  [childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
  [http, ["request", "get"]], [https, ["request", "get"]],
  [net, ["connect", "createConnection", "Socket"]], [tls, ["connect", "TLSSocket"]],
  [dgram, ["createSocket"]], [workerThreads, ["Worker"]],
] as const) {
  for (const method of methods) assert.equal(Reflect.set(facility, method, denyEffect), true);
}
assert.equal(Reflect.set(globalThis, "fetch", denyEffect), true);
assert.equal(Reflect.set(globalThis, "WebSocket", denyEffect), true);
syncBuiltinESMExports();

const {
  AcpRegistryValidationError, parseAcpRegistrySnapshot, searchAcpRegistry,
  selectAcpRegistryDistribution, createAcpInstallPlan,
} = await import("@agen-ai/acp-registry");
const nodeRegistry = await import("@agen-ai/acp-registry/node");
const boundedFetch: (input: FetchAcpRegistrySnapshotInput) => Promise<FetchedAcpRegistrySnapshot> = nodeRegistry.fetchAcpRegistrySnapshot;
assert.equal(typeof boundedFetch, "function");

const source: AcpRegistrySource = {
  namespace: "packed-fixture", kind: "local", channel: "stable",
  location: "fixture:registry/catalog.json", profile: "published-v1",
};
const literalArgs = ["--label", "literal;$(never-executed)"];
const content = JSON.stringify({
  version: "1.0.0", extensions: [], agents: [
    {
      id: "fixture-binary", name: "Fixture binary", version: "1.2.3",
      description: "Fixture assistant for deterministic installs",
      license: "MIT", license_url: "https://fixtures.example.test/LICENSE",
      distribution: {
        binary: { "linux-x86_64": {
          archive: "https://fixtures.example.test/agent-1.2.3.tar.gz",
          cmd: "./bin/agent", sha256: "ab".repeat(32), args: literalArgs,
        } },
        npx: { package: "@fixture/metadata-adapter" },
      },
    },
    {
      id: "fixture-notes", name: "Notes helper", version: "2.0.0",
      description: "Metadata notes editor", license_url: "https://fixtures.example.test/notes/LICENSE",
      distribution: { uvx: { package: "notes-helper==2.0.0" } },
    },
  ],
});
const snapshot = parseAcpRegistrySnapshot({ source, content: new TextEncoder().encode(content) });
assert.equal(snapshot.rawDigest, "sha256:" + createHash("sha256").update(content).digest("hex"));
assert.equal(parseAcpRegistrySnapshot({ source, content }).digest, snapshot.digest);
assert.notEqual(parseAcpRegistrySnapshot({ source, content: content + "\n" }).digest, snapshot.digest);
const matches = searchAcpRegistry(snapshot, {
  query: "fixture assistant", distributionKinds: ["binary"], target: "linux-x86_64",
});
assert.deepEqual(matches.map((entry) => entry.id), ["fixture-binary"]);
const entry = matches[0]!;
assert.equal(selectAcpRegistryDistribution(entry, { target: "linux-x86_64", preference: ["npx", "binary"] }).kind, "npx");
assert.throws(() => selectAcpRegistryDistribution(entry, { target: "darwin-aarch64", preference: ["binary"] }),
  (error: unknown) => error instanceof AcpRegistryValidationError && error.issues.some((issue) => issue.code === "acp_registry_distribution_not_found"));
const policy: AcpInstallPolicy = {
  network: "allow", allowedOrigins: ["https://fixtures.example.test"], allowInsecureHttp: false,
  packageScripts: "deny", integrity: "require-expected-sha256", reproducibility: "require-complete",
  allowedEnvironmentKeys: [],
};
const input: CreateAcpInstallPlanInput = {
  entryIdentity: entry.identity, expectedSnapshotDigest: snapshot.digest, expectedEntryDigest: entry.digest,
  target: "linux-x86_64", distributionPreference: ["binary"], policy,
};
const plan = createAcpInstallPlan(snapshot, input);
assert.equal(plan.digest, createAcpInstallPlan(snapshot, input).digest);
assert.equal(plan.rawSnapshotDigest, snapshot.rawDigest);
assert.equal(plan.launch.executable, "bin/agent");
assert.deepEqual(plan.launch.args, literalArgs);
assert.deepEqual(plan.launch.env, {});
assert.equal(plan.launch.shell, false);
assert.deepEqual(plan.reproducibility, { classification: "pinned-binary", gaps: [], verified: false });
assert.ok(Object.isFrozen(snapshot.entries));
assert.ok(Object.isFrozen(plan));
assert.ok(Object.isFrozen(plan.launch.args));
assert.ok(Object.isFrozen(plan.policy.allowedOrigins));
assert.throws(() => (plan.launch.args as string[]).push("mutated"), TypeError);
assert.throws(() => createAcpInstallPlan(snapshot, { ...input, expectedEntryDigest: "sha256:" + "00".repeat(32) }), AcpRegistryValidationError);
assert.throws(() => createAcpInstallPlan(snapshot, {
  ...input, distributionPreference: ["npx"],
  toolchains: [
    { kind: "node", version: "22.23.2", sha256: "sha256:" + "cd".repeat(32) },
    { kind: "npm", version: "11.7.0", sha256: "sha256:" + "ef".repeat(32) },
  ],
}),
  (error: unknown) => error instanceof AcpRegistryValidationError && error.issues.some((issue) => issue.code === "acp_registry_package_resolution_required"));
assert.equal(effectAttempts, 0);
stdout.write("External packed ACP registry metadata consumer passed with zero process/network execution.\n");
`;

const INTENTIONALLY_INVALID_CONSUMER_SOURCE = `import type {
  AgentCapabilities,
} from "@agen-ai/agent-protocol";

const retiredProtocolVersion: AgentCapabilities["protocolVersion"] = 11;
void retiredProtocolVersion;
`;

const INTENTIONALLY_INVALID_HISTORY_SCHEMA_CONSUMER_SOURCE = `import {
  AgentHistorySourceSchema,
} from "@agen-ai/agent-history";

void AgentHistorySourceSchema;
`;

async function writePackedOverrides(consumerRoot, dependencies) {
  await writeFile(path.join(consumerRoot, ".pnpmfile.cjs"),
    packedOverridesSource(dependencies));
}

function assertApprovalWalkthrough(report, expectedResolution, completionText) {
  assert.deepEqual(report.resolution, expectedResolution);
  assert.equal(report.receipt, "delivered");
  assert.equal(report.cleanup, "joined");
  assert.deepEqual(report.transcript, ["turn.started", "request.opened",
    "output:Independent work continues while the approval is open.", "answer.submitted", "answer.delivered",
    `output:${completionText}`, "turn.completed:completed", "session.closed", "handler.joined"]);
  for (const option of report.offered) {
    if (option.consequence.kind === "scoped") {
      assert.deepEqual(option.consequence, { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } });
      assert.equal(option.display, "once; exact_action");
    } else {
      assert.equal(option.consequence.kind, "provider_managed_remembrance");
      assert.deepEqual(option.consequence.duration, { kind: "unknown" });
      assert.deepEqual(option.consequence.applicability, { kind: "unknown" });
      assert.match(option.consequence.explanation, /Duration and future matching are unspecified/u);
      assert.match(option.display, /^Duration: unknown; applicability: unknown\./u);
    }
  }
}

function assertRememberedCoreExample(report) {
  assert.equal(report.example, "remembered-approvals");
  assert.equal(report.evidence, "synthetic");
  assert.deepEqual(report.offered.map(({ optionId, label, decision, consequence }) =>
    ({ optionId, label, decision, kind: consequence.kind })), [
    { optionId: "remembered:once", label: "Allow once", decision: "approved", kind: "scoped" },
    { optionId: "remembered:allow", label: "Allow and remember", decision: "approved", kind: "provider_managed_remembrance" },
  ]);
  assertApprovalWalkthrough(report, { requestKind: "approval", requestId: "remembered:request",
    disposition: "selected", optionId: "remembered:allow" }, "The original turn continues; native persistence remains unobserved.");
  assert.deepEqual({ starts: report.starts, outputReaders: report.outputReaders, acceptedAnswers: report.acceptedAnswers,
    closes: report.closes, producerJoined: report.producerJoined },
  { starts: 1, outputReaders: 1, acceptedAnswers: 1, closes: 1, producerJoined: true });
  assert.equal(report.nativePersistence, "unobserved");
  assert.equal(report.effect, "not_performed");
}

function assertRememberedAcpExample(report) {
  assert.equal(report.example, "remembered-approvals-acp");
  assert.equal(report.evidence, "synthetic");
  assert.equal(report.mapping, "declared-complete-consequences-v1");
  assert.equal(report.nativePersistence, "unobserved");
  assert.equal(report.effect, "not_performed");
  assert.equal(report.cleanup, "joined");
  assert.deepEqual(report.scenarios.map(({ name }) => name), ["remember-allow", "remember-deny", "cancel"]);
  const expectedReplies = [
    { id: "permission:remember-allow", outcome: { outcome: "selected", optionId: "native-remember-allow" } },
    { id: "permission:remember-deny", outcome: { outcome: "selected", optionId: "native-remember-deny" } },
    { id: "permission:cancel", outcome: { outcome: "cancelled" } },
  ];
  const permissions = report.nativeFrames.filter(({ direction, frame }) =>
    direction === "peer_to_host" && frame.method === "session/request_permission");
  assert.deepEqual(permissions.map(({ frame }) => ({ id: frame.id, toolKind: frame.params.toolCall.kind,
    options: frame.params.options.map(({ optionId, kind }) => ({ optionId, kind })) })), expectedReplies.map(({ id }) => ({
    id, toolKind: "edit", options: [
      { optionId: "native-allow-once", kind: "allow_once" }, { optionId: "native-remember-allow", kind: "allow_always" },
      { optionId: "native-deny-once", kind: "reject_once" }, { optionId: "native-remember-deny", kind: "reject_always" },
    ],
  })));
  const replies = report.nativeFrames.filter(({ direction, frame }) => direction === "host_to_peer" && frame.result);
  assert.deepEqual(replies.map(({ frame }) => ({ id: frame.id, outcome: frame.result.outcome })), expectedReplies,
    "Remembered denial must select the exact native rejection option; cancellation must carry no option.");
  const prompts = report.nativeFrames.filter(({ direction, frame }) => direction === "host_to_peer" && frame.method === "session/prompt");
  assert.deepEqual(prompts.map(({ frame }) => frame.params.prompt), [
    [{ type: "text", text: "remember-allow" }], [{ type: "text", text: "remember-deny" }], [{ type: "text", text: "cancel" }],
  ], "Each original native prompt must remain owned through permission delivery and terminality.");
  for (const scenario of report.scenarios) {
    assert.deepEqual(scenario.offered.map(({ optionId, decision, consequence }) => ({ optionId, decision, kind: consequence.kind })), [
      { optionId: "acp:option:1", decision: "approved", kind: "scoped" },
      { optionId: "acp:option:2", decision: "approved", kind: "provider_managed_remembrance" },
      { optionId: "acp:option:3", decision: "denied", kind: "scoped" },
      { optionId: "acp:option:4", decision: "denied", kind: "provider_managed_remembrance" },
    ]);
    assertApprovalWalkthrough(scenario, scenario.name === "cancel"
      ? { requestKind: "approval", requestId: "acp:request:1", disposition: "canceled" }
      : { requestKind: "approval", requestId: "acp:request:1", disposition: "selected",
        optionId: scenario.name === "remember-allow" ? "acp:option:2" : "acp:option:4" },
    `Original native prompt completed after ${scenario.name}.`);
  }
}

async function exampleIdentities(consumerRoot, files) {
  return Promise.all(files.map(async (file) => ({
    path: `examples/${file}`,
    sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "examples", file))).digest("hex"),
  })));
}

const HISTORY_EXAMPLE_FILES = ["browse.ts", "summary.ts", "fixture.ts", "main.ts", "claude.ts"];

const HISTORY_CONSUMER_PACKAGES = ["@agen-ai/validation", "@agen-ai/agent-protocol", "@agen-ai/agent-history"];

async function prepareHistoryConsumer(tempRoot, artifacts, directory, files, additionalDependencies = {}) {
  const consumerRoot = path.join(tempRoot, directory);
  const sourceRoot = path.join(consumerRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  const dependencies = Object.fromEntries(HISTORY_CONSUMER_PACKAGES.map((name) => [name,
    `file:${artifacts.find((artifact) => artifact.manifest.name === name).tarballPath}`]));
  await writeFile(path.join(consumerRoot, "package.json"), JSON.stringify({
    name: `agent-sdk-${directory}-proof`, version: "1.0.0", private: true, type: "module",
    packageManager: "pnpm@11.7.0", engines: { node: ">=22.0.0" },
    dependencies: { "@agen-ai/agent-history": dependencies["@agen-ai/agent-history"],
      "@agen-ai/agent-protocol": dependencies["@agen-ai/agent-protocol"], ...additionalDependencies },
    devDependencies: { "@types/node": "24.10.1", typescript: "5.9.3" },
  }, null, 2) + "\n");
  await writeFile(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src",
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ["node"],
  }, include: ["src/**/*.ts"] }, null, 2) + "\n");
  await mkdir(path.join(sourceRoot, "history-example"), { recursive: true });
  for (const file of HISTORY_EXAMPLE_FILES) {
    await copyFile(path.join(REPO_ROOT, "examples/history", file), path.join(sourceRoot, "history-example", file));
  }
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/history/browse-example.ts"), path.join(sourceRoot, "browse-example.ts"));
  for (const file of files) {
    await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/history", file), path.join(sourceRoot, file));
  }
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"), "packages: []\n\nautoInstallPeers: false\n");
  await writePackedOverrides(consumerRoot, dependencies);
  return consumerRoot;
}

async function runHistoryConsumer(tempRoot, artifacts) {
  const consumerRoot = await prepareHistoryConsumer(tempRoot, artifacts, "history-consumer", ["scenario.ts", "types.ts", "codex.ts"]);
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/history/offline-guard.mjs"),
    path.join(consumerRoot, "offline-guard.mjs"));
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: consumerRoot });
  const absent = ["@agen-ai/agent-runtime", "@agen-ai/agent-orchestration", "@agen-ai/acp-transport", "@agen-ai/provider-acp", "@agen-ai/acp-registry",
    "@anthropic-ai/claude-agent-sdk", "@cursor/sdk", "@opencode-ai/sdk", "@opencode/client", "@openai/codex", "@xai-official/grok"];
  await run(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = createRequire(path.resolve('package.json'));
const history = createRequire(root.resolve('@agen-ai/agent-history/package.json'));
for (const name of ${JSON.stringify(absent)}) {
  for (const resolver of [root, history]) assert.throws(() => resolver.resolve(name), { code: 'MODULE_NOT_FOUND' });
}`], { cwd: consumerRoot });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  await writeFile(path.join(consumerRoot, "intentionally-invalid-schema.ts"),
    INTENTIONALLY_INVALID_HISTORY_SCHEMA_CONSUMER_SOURCE);
  await writeFile(path.join(consumerRoot, "tsconfig.invalid.json"), JSON.stringify({
    extends: "./tsconfig.json", compilerOptions: { noEmit: true, rootDir: "." },
    include: ["intentionally-invalid-schema.ts"],
  }, null, 2) + "\n");
  await assert.rejects(run("pnpm", ["exec", "tsc", "--project", "tsconfig.invalid.json"], { cwd: consumerRoot }),
    (error) => error instanceof Error && /error TS(?:2305|2724): (?:Module )?'"@agen-ai\/agent-history"' has no exported member(?: named)? 'AgentHistorySourceSchema'\./u.test(error.message),
    "Composable history schemas must be unavailable from the ordinary packed entrypoint.");
  const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const execution = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "--import", "./offline-guard.mjs", "dist/scenario.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  const proof = JSON.parse(execution.stdout.trim());
  assert.deepEqual(proof, {
    proof: "history-only-root", evidence: "synthetic", catalogTitles: ["First history", "Second history"],
    transcriptTexts: ["Fixture question", "Fixture answer"], nativeDisposals: 1,
    foreignCursorDelegations: 0, unsupportedRename: true, claudeImportWithoutPeer: true, codexImportWithoutPeer: true,
    opencodeImportWithoutPeer: true, cursorImportWithoutPeer: true, acpImportWithoutPeer: true, grokImportWithoutPeer: true,
  });
  process.stdout.write(execution.stdout);
  const exampleExecution = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "--import", "./offline-guard.mjs", "dist/history-example/main.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  const exampleProof = JSON.parse(exampleExecution.stdout.trim());
  assert.deepEqual(exampleProof, {
    source: { kind: "example-memory-snapshot", scopeKind: "provider_defined", resourceOwnership: "borrowed", storageEffects: { kind: "none" } },
    capabilities: Object.fromEntries(["catalog", "lookup", "transcript", "views", "metadataSearch", "contentSearch", "rename", "archive", "restore", "delete"]
      .map((name) => [name, ["catalog", "lookup", "transcript"].includes(name) ? { status: "supported" }
        : { status: "unsupported", reason: "native_unavailable" }])),
    catalog: { status: "read", traversal: "exhausted", pages: [1, 1].map((items) => ({ items, consistency: "snapshot",
      coverage: { view: "catalog", children: "included", omissions: [] } })) },
    selected: true, metadataRead: true,
    transcript: { status: "read", traversal: "exhausted", pages: ["compaction", "message", "tool_call", "tool_result", "message"]
      .map((kind) => ({ recordKinds: [kind], consistency: "snapshot",
        coverage: { view: "retained_chain", children: "excluded", omissions: ["compacted", "subagents_excluded"] } })) },
    cleanup: "closed",
  });
  process.stdout.write(exampleExecution.stdout);
  const codexExecution = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "--import", "./offline-guard.mjs", "dist/codex.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  const codexProof = JSON.parse(codexExecution.stdout.trim());
  assert.deepEqual(codexProof, { proof: "packed-codex-borrowed-history", evidence: "synthetic",
    titles: ["Borrowed Alpha", "Borrowed Beta"], records: 4, nativeIdentityPreserved: true,
    foreignCursorDelegations: 0, borrowedPortUsableAfterClose: true, executionMethods: 0, titleSearchMatches: 1, browseExample: { catalogCount: 2, transcriptStatus: "read", transcriptRecords: 4, coverageViews: ["retained_chain"], metadataRead: true } });
  process.stdout.write(codexExecution.stdout);
  return { packages: HISTORY_CONSUMER_PACKAGES, absentPackages: absent, proof, codexProof, exampleProof, exampleFiles: await Promise.all(HISTORY_EXAMPLE_FILES.map(async (file) => ({
    path: `examples/history/${file}`, sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "src/history-example", file))).digest("hex"),
  }))), files: await Promise.all(["scenario.ts", "types.ts", "codex.ts", "offline-guard.mjs"].map(async (file) => ({
    path: `scripts/architecture/agent-sdk-consumers/history/${file}`,
    sha256: createHash("sha256").update(await readFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/history", file))).digest("hex"),
  }))) };
}

async function runClaudeHistoryConsumer(tempRoot, artifacts) {
  const consumerRoot = await prepareHistoryConsumer(tempRoot, artifacts, "claude-history-consumer", ["claude-native.ts"],
    { "@anthropic-ai/claude-agent-sdk": "0.3.306" });
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"),
    "packages: []\n\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n  - '@anthropic-ai/claude-agent-sdk@0.3.306'\n");
  await run("pnpm", ["install", "--ignore-scripts", "--no-optional", "--prefer-offline"], { cwd: consumerRoot });
  const identity = await run(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.resolve('package.json'));
const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
const manifest = JSON.parse(await readFile(path.join(path.dirname(entry), 'package.json'), 'utf8'));
assert.equal(manifest.name, '@anthropic-ai/claude-agent-sdk');
assert.equal(manifest.version, '0.3.306');
assert.equal(manifest.claudeCodeVersion, '2.1.306');
const sdkSha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
assert.equal(sdkSha256, '48480d49d4493e2aec28227d8db8f8432743c7aa32facbdb9a7ce0a0363f7503');
const nativePackages = (await readdir('node_modules/.pnpm')).filter((name) => name.startsWith('@anthropic-ai+claude-agent-sdk-'));
assert.deepEqual(nativePackages, []);
process.stdout.write(JSON.stringify({ sdkVersion: manifest.version, sdkSha256, sdkDeclaredCodeVersion: manifest.claudeCodeVersion, nativeBinaryPackages: 0 }));
`], { cwd: consumerRoot });
  const sdk = JSON.parse(identity.stdout);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  const execution = await run(process.execPath, ["dist/claude-native.js"], { cwd: consumerRoot, timeoutMs: 120_000 });
  const proof = JSON.parse(execution.stdout.trim());
  assert.deepEqual(proof, { proof: "packed-claude-history", evidence: "native-reader-synthetic-store", homes: [
    { label: "HOME-A", catalogCount: 4, alphaRecords: 7, compactRecords: 3, browseExample: { catalogCount: 4, transcriptStatus: "read", transcriptRecords: 7, coverageViews: ["retained_chain"], metadataRead: true } },
    { label: "HOME-B", catalogCount: 4, alphaRecords: 7, compactRecords: 3, browseExample: { catalogCount: 4, transcriptStatus: "read", transcriptRecords: 7, coverageViews: ["retained_chain"], metadataRead: true } },
  ], missing: "not_found", emptyRecords: 0, workerRootsAfterClose: 0, readerStoreUnchanged: true,
    management: { renamedTitle: "Packed renamed Beta", deleteStatus: "applied", subagentsRemoved: true,
      foreignProjectPreserved: true, readerAlphaPreserved: true } });
  process.stdout.write(execution.stdout);
  const nativeExampleExecution = await run(process.execPath, ["dist/history-example/claude.js",
    "--config-home", path.join(consumerRoot, "native-fixtures/HOME-A/config"),
    "--project", path.join(consumerRoot, "native-fixtures/project"),
    "--temporary-root", path.join(consumerRoot, "native-fixtures/HOME-A/workers"),
    "--resource-launcher", "/usr/bin/prlimit", "--conversation-id", "20000001-1111-4111-8111-111111111111"],
  { cwd: consumerRoot, timeoutMs: 120_000 });
  const nativeExampleProof = JSON.parse(nativeExampleExecution.stdout.trim());
  assert.equal(nativeExampleProof.selected, true);
  assert.equal(nativeExampleProof.metadataRead, true);
  assert.equal(nativeExampleProof.catalog.status, "read");
  assert.equal(nativeExampleProof.catalog.traversal, "exhausted");
  assert.equal(nativeExampleProof.catalog.pages.reduce((count, page) => count + page.items, 0), 3);
  assert.equal(nativeExampleProof.transcript.status, "read");
  assert.equal(nativeExampleProof.transcript.traversal, "exhausted");
  assert.equal(nativeExampleProof.transcript.pages.reduce((count, page) => count + page.recordKinds.length, 0), 7);
  for (const page of nativeExampleProof.transcript.pages) assert.equal(page.coverage.view, "retained_chain");
  for (const name of ["rename", "archive", "restore", "delete"]) assert.equal(nativeExampleProof.capabilities[name].status, "unsupported");
  assert.equal(nativeExampleProof.cleanup, "closed");
  assert.deepEqual(await readdir(path.join(consumerRoot, "native-fixtures/HOME-A/workers")), []);
  process.stdout.write(nativeExampleExecution.stdout);
  return { packages: [...HISTORY_CONSUMER_PACKAGES, "@anthropic-ai/claude-agent-sdk"], sdk, proof, nativeExampleProof,
    file: { path: "scripts/architecture/agent-sdk-consumers/history/claude-native.ts",
      sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "src/claude-native.ts"))).digest("hex") } };
}

async function runCodexHistoryConsumer(tempRoot, artifacts) {
  const consumerRoot = await prepareHistoryConsumer(tempRoot, artifacts, "codex-history-consumer", ["codex-native.ts"],
    { "@openai/codex": "0.163.0" });
  const configPath = path.join(consumerRoot, "tsconfig.json");
  const compilerProfile = JSON.parse(await readFile(configPath, "utf8"));
  compilerProfile.compilerOptions.lib = ["ES2024"];
  await writeFile(configPath, JSON.stringify(compilerProfile, null, 2) + "\n");
  const definition = PACKAGES.find((entry) => entry.name === "@agen-ai/agent-history");
  assert(definition);
  const helperFiles = ["codex-fixture.ts", "codex-fixture-server.ts"];
  for (const file of helperFiles) {
    await copyFile(path.join(REPO_ROOT, definition.root, "tests/helpers", file), path.join(consumerRoot, "src", file));
  }
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"),
    "packages: []\n\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n  - '@openai/codex@0.163.0 || 0.163.0-linux-x64 || 0.163.0-linux-arm64 || 0.163.0-darwin-x64 || 0.163.0-darwin-arm64 || 0.163.0-win32-x64 || 0.163.0-win32-arm64'\n");
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: consumerRoot });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  const execution = await run(process.execPath, ["dist/codex-native.js"], { cwd: consumerRoot, timeoutMs: 180_000 });
  const proof = JSON.parse(execution.stdout.trim());
  assert.deepEqual(proof, {
    proof: "packed-codex-native-history", evidence: "native-reader-synthetic-store", version: "0.163.0",
    executableSha256: "399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215",
    fixtureProvenance: "https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server/tests/common/rollout.rs",
    coldCatalogCount: 1, coldCatalogContinuation: false, metadataSetup: "explicit-fixture-only-native-metadata-repair",
    catalogCount: 5, strictBeforeRepair: 0, strictAfterRepair: 5, legacyRecords: 6, indexedRecords: 6,
    variantRecords: 6, emptyRecords: 0, missing: "not_found", workerRootsAfterClose: 0, legacyReadRolloutsUnchanged: true,
    indexedSetup: "explicit-fixture-only-native-migration", titleSearchMatches: 1,
    rename: "applied", archive: "applied", restore: "applied", delete: "applied",
    archiveCascade: true, restoreParentOnly: true, deleteCascade: true,
    browseExample: { catalogCount: 5, transcriptStatus: "read", transcriptRecords: 6, coverageViews: ["retained_chain"], metadataRead: true },
  });
  process.stdout.write(execution.stdout);
  const files = [
    { source: "scripts/architecture/agent-sdk-consumers/history/codex-native.ts", copied: "codex-native.ts" },
    ...helperFiles.map((file) => ({ source: `${definition.root}/tests/helpers/${file}`, copied: file })),
  ];
  return { packages: [...HISTORY_CONSUMER_PACKAGES, "@openai/codex"], proof,
    files: await Promise.all(files.map(async ({ source, copied }) => ({ path: source,
      sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "src", copied))).digest("hex") }))) };
}

async function runOpenCodeHistoryConsumer(tempRoot, artifacts) {
  const consumerRoot = await prepareHistoryConsumer(tempRoot, artifacts, "opencode-history-consumer", ["opencode-native.ts"],
    { "@opencode/client": "2.1.2", "@opencode/cli": "2.1.2" });
  const configPath = path.join(consumerRoot, "tsconfig.json");
  const compilerProfile = JSON.parse(await readFile(configPath, "utf8"));
  compilerProfile.compilerOptions.lib = ["ES2024"];
  await writeFile(configPath, JSON.stringify(compilerProfile, null, 2) + "\n");
  const definition = PACKAGES.find((entry) => entry.name === "@agen-ai/agent-history");
  assert(definition);
  await copyFile(path.join(REPO_ROOT, definition.root, "tests/helpers/opencode-fixture.ts"),
    path.join(consumerRoot, "src/opencode-fixture.ts"));
  const nativePackages = ["client", "protocol", "schema", "cli", "cli-linux-x64", "cli-darwin-x64", "cli-linux-arm64",
    "cli-windows-x64", "cli-darwin-arm64", "cli-windows-arm64", "cli-linux-x64-musl", "cli-linux-arm64-musl",
    "cli-linux-x64-baseline", "cli-darwin-x64-baseline", "cli-windows-x64-baseline", "cli-linux-x64-baseline-musl"];
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"),
    `packages: []\n\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n${nativePackages.map((name) => `  - '@opencode/${name}@2.1.2'`).join("\n")}\n`);
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: consumerRoot });
  const identity = await run(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.resolve('package.json'));
const entry = fileURLToPath(import.meta.resolve('@opencode/client/promise'));
const manifest = JSON.parse(await readFile(path.join(path.dirname(entry), '../../package.json'), 'utf8'));
assert.equal(manifest.name, '@opencode/client');
assert.equal(manifest.version, '2.1.2');
assert.deepEqual(manifest.dependencies, { '@opencode/schema': '2.1.2', '@opencode/protocol': '2.1.2' });
for (const resolveFrom of [require, createRequire(entry)]) {
  assert.throws(() => resolveFrom.resolve('solid-js'), { code: 'MODULE_NOT_FOUND' });
}
const promiseEntrySha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
assert.equal(promiseEntrySha256, '29e020d2ff626a7a230b7054eb86d2c4933bebe6feb3629cd934afd799816177');
process.stdout.write(JSON.stringify({ clientVersion: manifest.version,
  promiseEntrySha256,
  dependencies: manifest.dependencies, optionalSolidPeerInstalled: false }));
`], { cwd: consumerRoot });
  const sdk = JSON.parse(identity.stdout);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  const execution = await run(process.execPath, ["dist/opencode-native.js"], { cwd: consumerRoot, timeoutMs: 120_000 });
  const proof = JSON.parse(execution.stdout.trim());
  assert.deepEqual(proof, {
    proof: "packed-opencode-native-history", evidence: "native-reader-synthetic-store", version: "2.1.2",
    executableSha256: "22636c800ba6c8dc5353e264183bb3927725d824cba412f007dea9c694740f52",
    projectCatalogCount: 4, otherProjectCatalogCount: 1, transcriptRecords: 9, filteredUserRecords: 2,
    emptyRecords: 0, missing: "not_found", foreignProject: "unsupported_scope", accessDenied: "access_denied", serverUsableAfterClose: true,
    executionRequests: 0, titleSearchMatches: 1,
    rename: "applied", archive: "applied", restore: "applied", delete: "applied",
    archiveParentOnly: true, restoreParentOnly: true, deleteCascade: true,
    browseExample: { catalogCount: 4, transcriptStatus: "read", transcriptRecords: 9, coverageViews: ["retained_chain"], metadataRead: true },
  });
  process.stdout.write(execution.stdout);
  const files = [
    { source: "scripts/architecture/agent-sdk-consumers/history/opencode-native.ts", copied: "opencode-native.ts" },
    { source: `${definition.root}/tests/helpers/opencode-fixture.ts`, copied: "opencode-fixture.ts" },
  ];
  return { packages: [...HISTORY_CONSUMER_PACKAGES, "@opencode/client", "@opencode/cli"], sdk, proof,
    files: await Promise.all(files.map(async ({ source, copied }) => ({ path: source,
      sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "src", copied))).digest("hex") }))) };
}

async function runCursorHistoryConsumer(tempRoot, artifacts) {
  const consumerRoot = await prepareHistoryConsumer(tempRoot, artifacts, "cursor-history-consumer", ["cursor-native.ts"],
    { "@cursor/sdk": "1.0.40", zod: "4.4.3" });
  const manifestPath = path.join(consumerRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.engines.node = ">=22.13";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const definition = PACKAGES.find((entry) => entry.name === "@agen-ai/agent-history");
  assert(definition);
  await copyFile(path.join(REPO_ROOT, definition.root, "tests/helpers/cursor-fixture.ts"),
    path.join(consumerRoot, "src/cursor-fixture.ts"));
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"),
    "packages: []\n\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n  - '@cursor/sdk@1.0.40'\n");
  await run("pnpm", ["install", "--ignore-scripts", "--no-optional", "--prefer-offline"], { cwd: consumerRoot });
  const identity = await run(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 13), 'Cursor native history requires Node >=22.13');
const entry = fileURLToPath(import.meta.resolve('@cursor/sdk'));
assert(entry.endsWith('/dist/esm/index.js'));
const manifest = JSON.parse(await readFile(path.join(path.dirname(entry), '../../package.json'), 'utf8'));
assert.equal(manifest.name, '@cursor/sdk');
assert.equal(manifest.version, '1.0.40');
assert.equal(manifest.engines.node, '>=22.13');
const sdkEntrySha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
assert.equal(sdkEntrySha256, 'fa955abb770bd70961ce878e184adf431b3bf6ba034f8ffce69ff2104b2a5bfe');
const sqliteEntry = fileURLToPath(import.meta.resolve('@cursor/sdk/sqlite'));
assert.equal(sqliteEntry, path.join(path.dirname(entry), 'sqlite.js'));
const sqliteEntrySha256 = createHash('sha256').update(await readFile(sqliteEntry)).digest('hex');
assert.equal(sqliteEntrySha256, '3ca3eae5ed43241e6e393488981d07b2e93d8ddb278a0b13d509247f1de77b52');
const sdkRequire = createRequire(entry);
assert.equal(sdkRequire('zod/package.json').version, '4.4.3');
assert(sdkRequire.resolve('zod/v3').includes('/zod/'));
const executorPackages = (await readdir('node_modules/.pnpm')).filter((name) => /^@cursor\\+sdk-(?:linux|darwin|win32)-/u.test(name));
assert.deepEqual(executorPackages, []);
process.stdout.write(JSON.stringify({ sdkVersion: manifest.version, sdkEntrySha256, sqliteEntrySha256,
  validatorVersion: '4.4.3', executorPackages: 0 }));
`], { cwd: consumerRoot });
  const sdk = JSON.parse(identity.stdout);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  const execution = await run(process.execPath, ["dist/cursor-native.js"], { cwd: consumerRoot, timeoutMs: 180_000 });
  const proof = JSON.parse(execution.stdout.trim());
  assert.deepEqual(proof, {
    proof: "packed-cursor-native-history", evidence: "native-reader-synthetic-store",
    stores: [
      { backend: "jsonl", label: "STORE-A", catalogCount: 3, checkpointRecords: 9, terminalRunViews: 3, storedRunRecords: 2, checkpointOnlyRunRecords: 0, browseExample: { catalogCount: 3, transcriptStatus: "read", transcriptRecords: 9, coverageViews: ["current_checkpoint"], metadataRead: true } },
      { backend: "jsonl", label: "STORE-B", catalogCount: 3, checkpointRecords: 9, terminalRunViews: 3, storedRunRecords: 2, checkpointOnlyRunRecords: 0, browseExample: { catalogCount: 3, transcriptStatus: "read", transcriptRecords: 9, coverageViews: ["current_checkpoint"], metadataRead: true } },
      { backend: "sqlite", label: "SQLITE", catalogCount: 3, checkpointRecords: 9, terminalRunViews: 3, storedRunRecords: 2, checkpointOnlyRunRecords: 0, browseExample: { catalogCount: 3, transcriptStatus: "read", transcriptRecords: 9, coverageViews: ["current_checkpoint"], metadataRead: true } },
    ], emptyRecords: 0, missing: "not_found", foreignProject: "unsupported_scope",
    workerRootsAfterClose: 0, readPhase: { jsonlStoreUnchanged: true, sqliteSemanticRowsUnchanged: true },
    management: ["jsonl", "sqlite"].map((backend) => ({ backend, archived: true, restored: true, deleted: true,
      dependentRuns: 0, dependentEvents: 0, dependentCheckpoints: 0, foreignAgentPreserved: true })),
  });
  process.stdout.write(execution.stdout);
  const files = [
    { source: "scripts/architecture/agent-sdk-consumers/history/cursor-native.ts", copied: "cursor-native.ts" },
    { source: `${definition.root}/tests/helpers/cursor-fixture.ts`, copied: "cursor-fixture.ts" },
  ];
  return { packages: [...HISTORY_CONSUMER_PACKAGES, "@cursor/sdk", "zod"], sdk, proof,
    files: await Promise.all(files.map(async ({ source, copied }) => ({ path: source,
      sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "src", copied))).digest("hex") }))) };
}

async function runGrokHistoryConsumer(tempRoot, artifacts) {
  const transport = artifacts.find((artifact) => artifact.manifest.name === "@agen-ai/acp-transport");
  assert(transport);
  const consumerRoot = await prepareHistoryConsumer(tempRoot, artifacts, "grok-history-consumer", ["acp-reader.ts", "grok-native.ts"],
    { "@agen-ai/acp-transport": `file:${transport.tarballPath}`, "@xai-official/grok": "1.0.62" });
  const definition = PACKAGES.find((entry) => entry.name === "@agen-ai/agent-history");
  assert(definition);
  const helpers = ["acp-peer.ts", "grok-fixture.ts"];
  for (const file of helpers) await copyFile(path.join(REPO_ROOT, definition.root, "tests/helpers", file), path.join(consumerRoot, "src", file));
  await writeFile(path.join(consumerRoot, "src/main.ts"), [
    "import { proveAcpHistory } from './acp-reader.js';",
    "import { proveGrokHistory } from './grok-native.js';",
    "console.log(JSON.stringify({proof:'packed-acp-grok-history',acp:await proveAcpHistory(),grok:await proveGrokHistory()}));",
    "",
  ].join("\n"));
  await writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"),
    `packages: []\n\nautoInstallPeers: false\n\nminimumReleaseAgeExclude:\n${["grok", "grok-darwin-arm64", "grok-darwin-x64", "grok-linux-arm64", "grok-linux-x64", "grok-win32-arm64", "grok-win32-x64"]
      .map((name) => `  - '@xai-official/${name}@1.0.62'`).join("\n")}\n`);
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], { cwd: consumerRoot });
  const identity = await run(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.resolve('package.json'));
const wrapperPath = require.resolve('@xai-official/grok/package.json');
const wrapper = require(wrapperPath);
const nativePath = require.resolve('@xai-official/grok-linux-x64/package.json', { paths: [path.dirname(wrapperPath)] });
const native = require(nativePath);
assert.equal(wrapper.name, '@xai-official/grok');
assert.equal(wrapper.version, '1.0.62');
assert.equal(native.name, '@xai-official/grok-linux-x64');
assert.equal(native.version, '1.0.62');
assert.equal(wrapper.optionalDependencies['@xai-official/grok-linux-x64'], '1.0.62');
const transport = require('@agen-ai/acp-transport/package.json');
assert.equal(transport.version, '0.4.4');
process.stdout.write(JSON.stringify({wrapperVersion:wrapper.version,platformVersion:native.version,transportVersion:transport.version,lifecycleScripts:false}));
`], { cwd: consumerRoot });
  const runtime = JSON.parse(identity.stdout);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  const execution = await run(process.execPath, ["dist/main.js"], { cwd: consumerRoot, timeoutMs: 180_000 });
  const proof = JSON.parse(execution.stdout.trim());
  assert.deepEqual(proof, { proof: "packed-acp-grok-history",
    acp: { catalogIds: ["peer-alpha", "peer-beta", "peer-gamma"], transcript: "unsupported", absentCatalog: "unsupported",
      callerTransportSurvived: true, executionMethods: [], browseExample: { catalogCount: 3, transcriptStatus: "unsupported", transcriptRecords: 0, coverageViews: [], metadataRead: false } },
    grok: { runtimeVersion: "1.0.62", catalogIds: ["70000004-1111-4111-8111-111111111111", "70000002-1111-4111-8111-111111111111", "70000001-1111-4111-8111-111111111111"],
      alphaRecords: 7, betaRecords: 4, emptyRecords: 0, missing: "not_found", otherProject: "unsupported_scope", sourceIsolation: true,
      workerRootsAfterClose: 0, loadHistoryCode: -32601, executionMethods: [],
      metadataSearch: "native-case-insensitive", contentSearch: "native-fts-user-prompts", nativeSearchHits: 2,
      sourceBytesPreservedBySearch: true, localRename: "applied", localDelete: "applied", missingDelete: "applied",
      childRetained: true, lostNativeReceipt: "outcome_unknown", duplicateMutationFenced: true, withheldNativeReceipts: 1, browseExample: { catalogCount: 3, transcriptStatus: "read", transcriptRecords: 7, coverageViews: ["stored_updates"], metadataRead: true } },
  });
  process.stdout.write(execution.stdout);
  const files = [
    ...["acp-reader.ts", "grok-native.ts"].map((file) => ({ source: `scripts/architecture/agent-sdk-consumers/history/${file}`, copied: file })),
    ...helpers.map((file) => ({ source: `${definition.root}/tests/helpers/${file}`, copied: file })),
  ];
  return { packages: [...HISTORY_CONSUMER_PACKAGES, "@agen-ai/acp-transport", "@xai-official/grok"],
    evidence: { acp: "synthetic-peer", grok: "native-reader-synthetic-store" }, runtime, proof,
    files: await Promise.all(files.map(async ({ source, copied }) => ({ path: source,
      sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, "src", copied))).digest("hex") }))) };
}

async function runCoreConsumer(tempRoot, artifacts, dependencyBaseline) {
  const consumerRoot = path.join(tempRoot, "core-consumer");
  await mkdir(path.join(consumerRoot, "src"), { recursive: true });
  await mkdir(path.join(consumerRoot, "examples/fixtures"), { recursive: true });
  const coreNames = CORE_CONSUMER_PACKAGES;
  const dependencies = Object.fromEntries(coreNames.map((name) => [name,
    `file:${artifacts.find((artifact) => artifact.manifest.name === name).tarballPath}`]));
  await writeFile(path.join(consumerRoot, "package.json"), JSON.stringify(consumerPackageManifest("core-consumer", dependencies), null, 2) + "\n");
  await writeFile(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: ".",
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false, types: ["node"],
  }, include: ["src/*.ts", "examples/lifecycle-interactions.ts", "examples/remembered-approvals.ts", "examples/session-continuations.ts", "examples/operations.ts", "examples/execution-input/**/*.ts", ...CORE_GENERATION_FILES.map((file) => `examples/${file}`)] }, null, 2) + "\n");
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/session-interactions/core.ts"), path.join(consumerRoot, "src/core.ts"));
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/operation-lifecycle.ts"),
    path.join(consumerRoot, "src/operation-lifecycle.ts"));
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/structured-output/generation.ts"),
    path.join(consumerRoot, "src/generation.ts"));
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/remembered-approvals/core-types.ts"),
    path.join(consumerRoot, "src/remembered-types.ts"));
  const runtimeDefinition = PACKAGES.find((entry) => entry.name === "@agen-ai/agent-runtime");
  await copyFile(path.join(REPO_ROOT, runtimeDefinition.root, "tests/externalProvider.typecheck.ts"),
    path.join(consumerRoot, "src/external-provider-types.ts"));
  for (const file of [...CORE_CONTINUATION_FILES, ...CORE_OPERATION_FILES, ...CORE_GENERATION_FILES]) {
    const destination = path.join(consumerRoot, "examples", file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(REPO_ROOT, PUBLIC_EXAMPLES_ROOT, file), destination);
  }
  const continuationExamples = await exampleIdentities(consumerRoot, CORE_CONTINUATION_FILES);
  const operationExamples = await exampleIdentities(consumerRoot, CORE_OPERATION_FILES);
  const generationExamples = await exampleIdentities(consumerRoot, CORE_GENERATION_FILES);
  await cp(path.join(REPO_ROOT, PUBLIC_EXAMPLES_ROOT, "execution-input"),
    path.join(consumerRoot, "examples/execution-input"), { recursive: true });
  const executionInputExamples = await exampleIdentities(consumerRoot,
    (await collectFiles(path.join(consumerRoot, "examples/execution-input")))
      .map((file) => path.relative(path.join(consumerRoot, "examples"), file).split(path.sep).join("/")));
  for (const [source, destination] of [["core.mjs", "execution-input.mjs"], ["offline-guard.mjs", "execution-input-offline-guard.mjs"]]) {
    await copyFile(path.join(REPO_ROOT, EXECUTION_INPUT_CONSUMER_ROOT, source), path.join(consumerRoot, destination));
  }
  const examplePath = path.join(consumerRoot, "examples/lifecycle-interactions.ts");
  await copyFile(path.join(REPO_ROOT, PUBLIC_EXAMPLES_ROOT, "lifecycle-interactions.ts"), examplePath);
  const exampleSha256 = createHash("sha256").update(await readFile(examplePath)).digest("hex");
  const rememberedExamplePath = path.join(consumerRoot, "examples/remembered-approvals.ts");
  await copyFile(path.join(REPO_ROOT, PUBLIC_EXAMPLES_ROOT, "remembered-approvals.ts"), rememberedExamplePath);
  await copyFile(path.join(REPO_ROOT, PUBLIC_EXAMPLES_ROOT, "fixtures/approval-walkthrough.ts"),
    path.join(consumerRoot, "examples/fixtures/approval-walkthrough.ts"));
  const rememberedExampleSha256 = createHash("sha256").update(await readFile(rememberedExamplePath)).digest("hex");
  await writeFile(path.join(consumerRoot, "offline-guard.mjs"),
    'globalThis.fetch = async () => { throw new Error("Core-only session interaction proof must execute without network access."); };\n');
  await writePackedOverrides(consumerRoot, dependencies);
  const seed = dependencyBaseline ? await seedDependencyBaseline({ baseline: dependencyBaseline, profile: "core-consumer", consumerRoot, artifacts }) : undefined;
  await run("pnpm", ["install", "--ignore-scripts", seed ? "--frozen-lockfile" : "--prefer-offline"], { cwd: consumerRoot });
  const dependencyEvidence = seed ? await verifyDependencyBaselineInstall(seed) : undefined;
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const executionInput = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "--import", "./execution-input-offline-guard.mjs", "execution-input.mjs", REPO_ROOT],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertExecutionInputExample(JSON.parse(executionInput.stdout.trim()));
  process.stdout.write(executionInput.stdout);
  const generationDefinitions = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/src/generation.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(generationDefinitions.stdout.trim()), {
    proof: "packed-generation-definitions", inferred: "title:string", schemaOnly: "json-object",
  });
  process.stdout.write(generationDefinitions.stdout);
  const generationExample = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/examples/fixtures/generate-title.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(generationExample.stdout.trim()), {
    example: "generate-title", title: "Planning a garden", turns: 1, cleanup: "closed",
  });
  process.stdout.write(generationExample.stdout);
  const operationLifecycle = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/src/operation-lifecycle.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(operationLifecycle.stdout.trim()), {
    proof: "packed-operation-lifecycle", evidence: "synthetic", dispatches: 1, nativeCloses: 1, overlappingTurns: 0, cleanup: "joined",
  });
  process.stdout.write(operationLifecycle.stdout);
  const operations = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/examples/operations.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(operations.stdout.trim()), {
    example: "operations", evidence: "synthetic", scenarios: [
      { scenario: "unsupported", status: "unsupported", dispatches: 0, compactionObserved: false },
      { scenario: "missing", status: "unavailable", dispatches: 0, compactionObserved: false },
      { scenario: "fields", status: "unsupported_descriptor", dispatches: 0, compactionObserved: false },
      { scenario: "declined", status: "declined", dispatches: 0, compactionObserved: false },
      { scenario: "effect", status: "settled", dispatches: 1, compactionObserved: true },
      { scenario: "no_effect", status: "settled", dispatches: 1, compactionObserved: false },
      { scenario: "pre_abort", status: "canceled_before_execution", dispatches: 0, compactionObserved: false },
      { scenario: "entered_abort", status: "uncertain", dispatches: 1, compactionObserved: false },
    ], turns: 0, cleanup: "joined",
  });
  process.stdout.write(operations.stdout);
  const example = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/examples/lifecycle-interactions.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(example.stdout.trim()), {
    example: "lifecycle-interactions", evidence: "synthetic", pendingAfterOpening: true, receipt: "delivered", terminal: "answered",
    effect: "not_performed", turns: 0, acceptedAnswers: 1, sessionCloses: 1, instanceDisposals: 1, cleanup: "joined",
    transcript: ["handler.offered", "opening.returned", "host.selected:decline", "answer.delivered", "decision.answered", "session.closed", "instance.disposed"],
  });
  process.stdout.write(example.stdout);
  const continuation = await run(process.execPath,
    ["--import", "./offline-guard.mjs", "dist/examples/session-continuations.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertSessionContinuationExample(JSON.parse(continuation.stdout.trim()));
  process.stdout.write(continuation.stdout);
  const remembered = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/examples/remembered-approvals.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertRememberedCoreExample(JSON.parse(remembered.stdout.trim()));
  process.stdout.write(remembered.stdout);
  const core = await run(process.execPath, ["--import", "./offline-guard.mjs", "dist/src/core.js", REPO_ROOT],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const report = JSON.parse(core.stdout.trim());
  assert.equal(report.proof, "core-only-session-interactions");
  assert.equal(report.evidence, "synthetic");
  assert.deepEqual(report.scenarios, [
    { scenario: "pending-close", openings: 1, callbacks: 1, answers: 0, nativeCloses: 1, hostReleases: 1, turns: 0, cleanup: "joined" },
    { scenario: "returned-cleanup", openings: 1, callbacks: 1, answers: 0, nativeCloses: 2, hostReleases: 1, turns: 0, cleanup: "joined" },
    { scenario: "opening-cleanup", openings: 1, callbacks: 1, answers: 0, nativeCloses: 1, hostReleases: 1, turns: 0, cleanup: "joined" },
  ]);
  process.stdout.write(core.stdout);
  const executionInputProofFiles = await Promise.all([["core.mjs", "execution-input.mjs"],
    ["offline-guard.mjs", "execution-input-offline-guard.mjs"]].map(async ([source, destination]) => ({
    path: `${EXECUTION_INPUT_CONSUMER_ROOT}/${source}`,
    sha256: createHash("sha256").update(await readFile(path.join(consumerRoot, destination))).digest("hex"),
  })));
  executionInputProofFiles.push({ path: `${EXECUTION_INPUT_CONSUMER_ROOT}/reports.mjs`,
    sha256: createHash("sha256").update(await readFile(path.join(REPO_ROOT, EXECUTION_INPUT_CONSUMER_ROOT, "reports.mjs"))).digest("hex") });
  return { exampleSha256, rememberedExampleSha256, continuationExamples, operationExamples, generationExamples,
    executionInputExamples, executionInputProofFiles, packages: coreNames, dependencyEvidence };
}

async function runConsumer(tempRoot, artifacts, dependencyBaseline) {
  const consumerRoot = path.join(tempRoot, "consumer");
  const sourceRoot = path.join(consumerRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  const tarballFor = (name) =>
    artifacts.find((artifact) => artifact.manifest.name === name).tarballPath;
  const fileDependency = (name) => `file:${tarballFor(name)}`;
  const packageJson = consumerPackageManifest("consumer", Object.fromEntries(PACKAGES.map(({ name }) => [name, fileDependency(name)])));
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["src/scenario.ts", "src/registry.ts", "src/registry-provider/*.ts", "src/orchestration/*.ts", "src/session-interactions/*.ts", "src/execution-input/*.ts"],
  };
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await writeFile(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
  );
  await writeFile(path.join(sourceRoot, "scenario.ts"), CONSUMER_SOURCE);
  await writeFile(path.join(sourceRoot, "provider.ts"), ACP_PROVIDER_CONSUMER_SOURCE);
  await writeFile(path.join(sourceRoot, "registry.ts"), ACP_REGISTRY_CONSUMER_SOURCE);
  await mkdir(path.join(sourceRoot, "execution-input"));
  for (const file of ["acp.ts", "peer.ts"]) {
    await copyFile(path.join(REPO_ROOT, EXECUTION_INPUT_CONSUMER_ROOT, file), path.join(sourceRoot, "execution-input", file));
  }
  await copyFile(path.join(REPO_ROOT, EXECUTION_INPUT_CONSUMER_ROOT, "offline-guard.mjs"),
    path.join(consumerRoot, "execution-input-offline-guard.mjs"));
  await mkdir(path.join(sourceRoot, "structured-output"));
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/structured-output/runtime.ts"),
    path.join(sourceRoot, "structured-output/runtime.ts"));
  await mkdir(path.join(sourceRoot, "session-interactions"));
  for (const file of ["node.ts", "controlled-owner.ts", "registry-cleanup.ts", "execution-reference.ts"]) {
    await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/session-interactions", file),
      path.join(sourceRoot, "session-interactions", file));
  }
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/session-interactions/peer.mjs"),
    path.join(consumerRoot, "session-interaction-peer.mjs"));
  await mkdir(path.join(sourceRoot, "orchestration"));
  for (const file of ["policy.ts", "execution.ts", "acp.ts", "acp-host.ts", "acp-ownership.ts", "acp-failures.ts"]) {
    await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/orchestration", file),
      path.join(sourceRoot, "orchestration", file));
  }
  const integratedFixtureRoot = path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/registry-provider");
  await mkdir(path.join(sourceRoot, "registry-provider"));
  await mkdir(path.join(consumerRoot, "registry-provider-fixtures"));
  for (const file of ["consumer.ts", "installation.ts"]) {
    await copyFile(path.join(integratedFixtureRoot, file), path.join(sourceRoot, "registry-provider", file));
  }
  for (const file of ["peer.mjs", "peer.py", "generate.py"]) {
    await copyFile(path.join(integratedFixtureRoot, file), path.join(consumerRoot, "registry-provider-fixtures", file));
  }
  await mkdir(path.join(consumerRoot, "orchestration-fixtures"));
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/orchestration/acp-peer.mjs"),
    path.join(consumerRoot, "orchestration-fixtures/peer.mjs"));
  for (const file of ["peer.py", "generate.py"]) {
    await copyFile(path.join(integratedFixtureRoot, file), path.join(consumerRoot, "orchestration-fixtures", file));
  }
  await copyFile(path.join(integratedFixtureRoot, "peer.mjs"), path.join(consumerRoot, "acp-peer.mjs"));
  await cp(path.join(REPO_ROOT, PUBLIC_EXAMPLES_ROOT), path.join(consumerRoot, "examples"), { recursive: true });
  await copyFile(path.join(REPO_ROOT, "scripts/architecture/agent-sdk-consumers/sandbox/session-lifecycle.ts"),
    path.join(consumerRoot, "sandbox-session-lifecycle.ts"));
  await writeFile(path.join(consumerRoot, "tsconfig.sandbox.json"), `${JSON.stringify({
    compilerOptions: { ...tsconfig.compilerOptions, lib: ["ES2024"], rootDir: ".", noEmit: true }, include: ["sandbox-session-lifecycle.ts"],
  }, null, 2)}\n`);
  const liveExampleSha256 = createHash("sha256")
    .update(await readFile(path.join(consumerRoot, "examples/live-request-output.ts"))).digest("hex");
  const rememberedAcpExampleSha256 = createHash("sha256")
    .update(await readFile(path.join(consumerRoot, "examples/remembered-approvals-acp.ts"))).digest("hex");
  await writeFile(path.join(consumerRoot, "examples-offline-guard.mjs"),
    'globalThis.fetch = async () => { throw new Error("Public examples must execute without network access."); };\n');
  await writeFile(
    path.join(sourceRoot, "intentionally-invalid.ts"),
    INTENTIONALLY_INVALID_CONSUMER_SOURCE,
  );
  await writeFile(
    path.join(consumerRoot, "tsconfig.invalid.json"),
    `${JSON.stringify({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, noEmit: true },
      include: ["src/intentionally-invalid.ts"],
    }, null, 2)}\n`,
  );
  await writePackedOverrides(consumerRoot, Object.fromEntries(PACKAGES.map(({ name }) => [name, fileDependency(name)])));
  const seed = dependencyBaseline ? await seedDependencyBaseline({ baseline: dependencyBaseline, profile: "consumer", consumerRoot, artifacts }) : undefined;
  await run("pnpm", ["install", "--ignore-scripts", seed ? "--frozen-lockfile" : "--prefer-offline"], {
    cwd: consumerRoot,
  });
  const dependencyEvidence = seed ? await verifyDependencyBaselineInstall(seed) : undefined;
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], {
    cwd: consumerRoot,
  });
  await run("pnpm", ["exec", "tsc", "--project", "examples/tsconfig.json", "--noEmit"], { cwd: consumerRoot });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.sandbox.json"], { cwd: consumerRoot });
  const sandboxLifecycle = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "sandbox-session-lifecycle.ts"], { cwd: consumerRoot, timeoutMs: 30_000 });
  const sandboxLifecycleReport = JSON.parse(sandboxLifecycle.stdout.trim());
  assert.deepEqual(sandboxLifecycleReport, { proof: "packed-sandbox-example-cleanup", evidence: "in-memory-public-acp", observations: [
    { scenario: "materialization", nativeStarts: 1, initializeCount: 0, sessionCreates: 0, originalFailureRetained: true, explicitRetry: "joined", cleanup: "destroyed" },
    { scenario: "session-opening", nativeStarts: 1, initializeCount: 1, sessionCreates: 1, originalFailureRetained: true, explicitRetry: "joined", cleanup: "destroyed" },
    { scenario: "callback", nativeStarts: 1, initializeCount: 1, sessionCreates: 1, originalFailureRetained: true, explicitRetry: "joined", cleanup: "destroyed" },
  ] });
  process.stdout.write(sandboxLifecycle.stdout);
  const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const sandboxPlatformReport = await runSandboxPlatformCheck({ repoRoot: REPO_ROOT, consumerRoot, run });
  const unsupportedInput = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "--import", "./execution-input-offline-guard.mjs", "dist/execution-input/acp.js", REPO_ROOT],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertAcpExecutionInputUnsupported(JSON.parse(unsupportedInput.stdout.trim()));
  process.stdout.write(unsupportedInput.stdout);
  const executionReference = await run(process.execPath, [permissionFlag, `--allow-fs-read=${consumerRoot}`,
    "dist/session-interactions/execution-reference.js"], { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.deepEqual(JSON.parse(executionReference.stdout.trim()), {
    proof: "packed-linux-execution-reference", evidence: "inert-public-composition", hostInputsRequired: true,
    publicBoundaryCompatible: true, hostsConstructed: 2, hostStarts: 0, nativeStarts: 0, operationRootsCreated: 0, unusedHostsDisposed: 2,
  });
  process.stdout.write(executionReference.stdout);
  const liveExample = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/live-request-output.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertLiveRequestExample(JSON.parse(liveExample.stdout.trim()));
  process.stdout.write(liveExample.stdout);
  const rememberedAcpExample = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/remembered-approvals-acp.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertRememberedAcpExample(JSON.parse(rememberedAcpExample.stdout.trim()));
  process.stdout.write(rememberedAcpExample.stdout);
  const continuationAcp = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/session-continuations-acp.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assertAcpContinuationExample(JSON.parse(continuationAcp.stdout.trim()));
  process.stdout.write(continuationAcp.stdout);
  const continuationAcpFiles = await exampleIdentities(consumerRoot, [
    "session-continuations-acp.ts",
    ...(await readdir(path.join(consumerRoot, "examples/fixtures/session-continuations")))
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .sort().map((file) => `fixtures/session-continuations/${file}`),
  ]);
  const nativeTests = (await readdir(path.join(consumerRoot, "examples/delegation/native/tests")))
    .filter((file) => file.endsWith(".test.ts")).sort();
  assert.ok(nativeTests.length > 0, "Native qualification requires executable hermetic public tests.");
  const native = await run(process.execPath, ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "--test",
    ...nativeTests.map((file) => `examples/delegation/native/tests/${file}`)], { cwd: consumerRoot, timeoutMs: 180_000 });
  process.stdout.write(native.stdout);
  process.stdout.write("Native qualification hermetic tests passed offline against packed public packages.\n");
  if (process.env.AGENT_SDK_DURABLE_TEST_ROOT) {
    assert.ok(path.isAbsolute(process.env.AGENT_SDK_DURABLE_TEST_ROOT), "The durable qualification root must be absolute.");
    const durableTests = (await readdir(path.join(consumerRoot, "examples/delegation/tests")))
      .filter((file) => file.endsWith(".test.ts")).sort();
    assert.ok(durableTests.length > 0, "Durable qualification requires executable public tests.");
    const durable = await run(process.execPath, ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "--test",
      ...durableTests.map((file) => `examples/delegation/tests/${file}`)], { cwd: consumerRoot, timeoutMs: 180_000 });
    process.stdout.write(durable.stdout);
    process.stdout.write("Durable delegation reference passed against packed public packages.\n");
    const failures = await run(process.execPath, ["--import", "./examples-offline-guard.mjs", "--import", "tsx",
      "examples/delegation/failures.ts"], { cwd: consumerRoot, timeoutMs: 30_000 });
    const failureSummaries = failures.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(failureSummaries, [{
      example: "delegation-failures", evidence: "synthetic",
      retry: { observations: 1, terminalCount: 1, outcome: "completed", providerInvocations: 1 },
      collected: { reopened: true, outcome: { kind: "failed", error: {
        category: "quota_exhausted", code: "allowance_exhausted", message: "The child allowance is exhausted.", recovery: { kind: "wait_for_quota" },
      } } },
      uncertain: { recoveryHint: "retry", outcome: { kind: "recovery_required", reason: "dispatch_uncertain" },
        rejectedModes: ["follow_up", "next_turn"], providerInvocationsAfterReopen: 0 },
      providerInvocations: 3, cleanup: "closed",
    }]);
    process.stdout.write(failures.stdout);
    process.stdout.write("Public failure handling example passed offline against packed packages.\n");
  }
  for (const example of ["local-command", "registry-install-run"]) {
    const execution = await run(process.execPath, ["--import", "./examples-offline-guard.mjs", "--import", "tsx", `examples/${example}.ts`],
      { cwd: consumerRoot, timeoutMs: 30_000 });
    const outputs = execution.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const events = outputs.filter((output) => output.kind === "event").map((output) => output.event);
    for (const type of ["turn.started", "request.opened", "turn.completed"]) {
      assert.equal(events.filter((event) => event.type === type).length, 1, `${example}: exactly one ${type}`);
    }
    assert.equal(events.at(-1)?.type, "turn.completed");
    assert.equal(events.at(-1)?.payload.outcome, "completed");
    assert.equal(events.filter((event) => event.type === "content.delta").map((event) => event.payload.delta).join(""),
      "Completed the original native prompt.");
  }
  process.stdout.write("Documented public local-command and registry-install-run examples passed against packed packages.\n");
  const cleanupExample = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/fixtures/session-cleanup.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const cleanupSummaries = cleanupExample.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    .filter((entry) => entry.example === "session-cleanup");
  assert.deepEqual(cleanupSummaries, [{ example: "session-cleanup", openingRetry: true, closeRetry: true, cleanup: "closed" }]);
  process.stdout.write(`${JSON.stringify(cleanupSummaries[0])}\n`);
  const acpCleanup = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/fixtures/acp-session-cleanup.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const acpCleanupSummaries = acpCleanup.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(acpCleanupSummaries, [{ example: "acp-session-cleanup", bootstrapOpeningRetry: true,
    bootstrapCloseRetry: true, parentOpeningRetry: true, cleanup: "closed" }]);
  process.stdout.write(acpCleanup.stdout);
  const directDelegation = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/delegation/workflow.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const directSummaries = directDelegation.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    .filter((entry) => entry.example === "delegation-direct");
  assert.equal(directSummaries.length, 1);
  assert.deepEqual(directSummaries[0], {
    example: "delegation-direct", disabledInvocations: 0, standardApplied: true, maxApplied: true,
    fastApplied: true, exclusion: "developer_excluded", sourceChange: "stale_target",
    progress: "Configured child is working.", steering: "delivered", nextTurnRuns: 2,
    cancellation: "canceled", approval: "resolved", nativeInvocations: 6, cleanup: "closed",
    steeringMessages: 1, resumedSessions: 1, interruptions: 1, resolvedRequests: 1,
  });
  process.stdout.write(directDelegation.stdout);
  const acpDelegation = await run(process.execPath,
    ["--import", "./examples-offline-guard.mjs", "--import", "tsx", "examples/delegation/acp.ts"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const acpSummaries = acpDelegation.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    .filter((entry) => entry.example === "delegation-acp");
  assert.equal(acpSummaries.length, 1);
  assert.deepEqual(acpSummaries[0], {
    example: "delegation-acp", toolsInvoked: ["delegation_targets", "delegate_task", "task_status"],
    parentEndedBeforeChildCompletion: true, childOutcome: "succeeded", approval: "resolved",
    appliedModel: "Example model", appliedSpeed: "Standard", appliedReasoning: "Max",
    completionDelivered: true, nativeSteering: "unsupported", bridgeAcquired: 1,
    bridgeReleased: 1, cleanup: "closed",
  });
  process.stdout.write(acpDelegation.stdout);
  await assert.rejects(
    run("pnpm", ["exec", "tsc", "--project", "tsconfig.invalid.json"], {
      cwd: consumerRoot,
    }),
    (error) => error instanceof Error && /TS2322/u.test(error.message),
    "The retired V9 discriminator must fail in an independent TypeScript consumer.",
  );
  const execution = await run("node", ["dist/scenario.js"], {
    cwd: consumerRoot,
  });
  assert.match(
    execution.stdout,
    /External packed agent SDK consumer passed\./u,
  );
  const registryExecution = await run("node", ["dist/registry.js"], { cwd: consumerRoot });
  assert.match(registryExecution.stdout, /External packed ACP registry metadata consumer passed with zero process\/network execution\./u);
  const orchestrationExecution = await run(process.execPath, ["dist/orchestration/policy.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  assert.equal(orchestrationExecution.stdout.trim(),
    "External packed orchestration policy consumer passed with zero process/network execution.");
  process.stdout.write(orchestrationExecution.stdout);
  const managedExecution = await run(process.execPath, ["dist/orchestration/execution.js"],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const managedLines = managedExecution.stdout.trim().split(/\r?\n/u);
  assert.equal(managedLines.length, 2);
  assert.deepEqual(JSON.parse(managedLines[0]), {
    proof: "packed-store-contract", evidence: "synthetic", contractVersion: 4,
    obsoleteOwnerEntries: 0, childStarts: 1, resourceReleases: 1, grantReleases: 1, cleanup: "closed",
  });
  assert.equal(managedLines[1], "External packed managed delegation execution consumer passed.");
  process.stdout.write(managedExecution.stdout);
  const managedAcpExecution = await run(process.execPath, ["dist/orchestration/acp.js", REPO_ROOT],
    { cwd: consumerRoot, timeoutMs: 90_000 });
  assert.match(managedAcpExecution.stdout, /External packed ACP managed delegation qualification passed\./u);
  process.stdout.write(managedAcpExecution.stdout);
  const installationExecution = await run("node", ["dist/registry-provider/consumer.js", REPO_ROOT], { cwd: consumerRoot });
  assert.match(installationExecution.stdout, /External packed registry→binary\/npm\/uv→offline provider proof passed/u);
  process.stdout.write(installationExecution.stdout);
  const interactionExecution = await run(process.execPath, ["--import", "./examples-offline-guard.mjs", "dist/session-interactions/node.js", REPO_ROOT],
    { cwd: consumerRoot, timeoutMs: 30_000 });
  const interactionReport = JSON.parse(interactionExecution.stdout.trim());
  assert.equal(interactionReport.proof, "packed-controlled-node-session-interactions");
  assert.equal(interactionReport.evidence, "synthetic");
  assert.equal(interactionReport.executionBoundary, "controlled-single-child");
  assert.deepEqual(interactionReport.scenarios, [
    { scenario: "answer", callbacks: 1, nativeReplies: 1, nativePromptFrames: 0, sdkTurns: 0, childAndGroupGone: true, effect: "not_performed" },
    { scenario: "pending", callbacks: 1, nativeReplies: 0, nativePromptFrames: 0, sdkTurns: 0, childAndGroupGone: true, effect: "not_performed" },
  ]);
  assert.deepEqual(interactionReport.startupCleanup, {
    scenario: "registry-startup-cleanup", cause: "NodeAcpExecutionCleanupError", pendingStartupRetained: true,
    pendingReleaseRetained: true, reservations: 1, starts: 1, releases: 1, joins: 1, nativeStarts: 0, cleanup: "joined",
  });
  process.stdout.write(interactionExecution.stdout);
  for (const profile of ["v0.11.4", "schema-v1.23.0"]) {
    const schemaPath = path.join(consumerRoot, `node_modules/@agen-ai/acp-transport/schema/${profile}/schema.json`);
    const schemaBytes = await readFile(schemaPath);
    const checkSchemaFailure = (expected) => run("node", ["--input-type=module", "--eval",
    `import assert from "node:assert/strict";
import { createAcpSchemaValidator } from "@agen-ai/acp-transport";
assert.throws(() => createAcpSchemaValidator("stable", ${JSON.stringify(profile)}), ${JSON.stringify(expected)});`], { cwd: consumerRoot });
    try {
      await rm(schemaPath);
      await checkSchemaFailure({ code: "ENOENT" });
      await writeFile(schemaPath, Buffer.concat([schemaBytes, Buffer.from("\n")]));
      await checkSchemaFailure({ reasonCode: "acp_schema_identity_mismatch" });
    } finally {
      await writeFile(schemaPath, schemaBytes);
    }
  }
  const executionInputAcpProofFiles = await Promise.all(["acp.ts", "peer.ts", "offline-guard.mjs"].map(async (file) => ({
    path: `${EXECUTION_INPUT_CONSUMER_ROOT}/${file}`,
    sha256: createHash("sha256").update(await readFile(path.join(consumerRoot,
      file === "offline-guard.mjs" ? "execution-input-offline-guard.mjs" : `src/execution-input/${file}`))).digest("hex"),
  })));
  executionInputAcpProofFiles.push({ path: `${EXECUTION_INPUT_CONSUMER_ROOT}/reports.mjs`,
    sha256: createHash("sha256").update(await readFile(path.join(REPO_ROOT, EXECUTION_INPUT_CONSUMER_ROOT, "reports.mjs"))).digest("hex") });
  return { liveExampleSha256, rememberedAcpExampleSha256, continuationAcpFiles, dependencyEvidence, executionInputAcpProofFiles, sandboxPlatformReport };
}

// ------------------------------------------------------------------------------------------------
//                Proof Orchestration
// ------------------------------------------------------------------------------------------------

function parseArguments(argv) {
  const usage = "Usage: test:agent-sdk-external-consumer [--profile full|sandbox-platform] [--output <new-absolute-directory> [--dependency-baseline <retained-consumer-root>]]\nThe sandbox-platform profile requires --output and excludes --dependency-baseline.\n";
  if (argv.length === 1 && argv[0] === "--help") return { help: usage };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    assert.ok(typeof value === "string" && !Object.hasOwn(options, option), usage);
    if (option === "--profile") {
      assert.ok(value === "full" || value === "sandbox-platform", usage);
      options[option] = value;
    } else {
      assert.ok((option === "--output" || option === "--dependency-baseline") && path.isAbsolute(value), usage);
      options[option] = path.resolve(value);
    }
  }
  assert.ok(!options["--dependency-baseline"] || options["--output"], usage);
  const profile = options["--profile"] ?? "full";
  assert.ok(profile !== "sandbox-platform" || (options["--output"] && !options["--dependency-baseline"]), usage);
  return { profile, outputRoot: options["--output"], baselineRoot: options["--dependency-baseline"] };
}

async function packedArtifactIdentities(artifacts) {
  return Promise.all(artifacts.map(async ({ manifest, tarballPath }) => ({
    name: manifest.name, version: manifest.version,
    sha256: createHash("sha256").update(await readFile(tarballPath)).digest("hex"),
  })));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(options.help); return; }
  const { outputRoot, baselineRoot, profile } = options;
  if (baselineRoot) {
    assert.ok(outputRoot !== baselineRoot && !outputRoot.startsWith(`${baselineRoot}${path.sep}`)
      && !baselineRoot.startsWith(`${outputRoot}${path.sep}`), "Output and dependency baseline must not overlap");
    assert.equal(await realpath(baselineRoot), baselineRoot, "Dependency baseline root must be an existing physical directory");
    assert.equal(PACKAGES.length, 7,
      "--dependency-baseline is historical seven-package 0.4.2 qualification; the current ten-package source needs a separately qualified baseline");
  }
  const dependencyBaseline = baselineRoot ? await readDependencyBaseline(baselineRoot, PACKAGES.map(({ name }) => name)) : undefined;
  let tempRoot;
  if (outputRoot === undefined) {
    tempRoot = await mkdtemp(path.join(tmpdir(), "agenai-agent-sdk-consumer-"));
  } else {
    const parent = path.dirname(outputRoot);
    assert.equal(await realpath(parent), parent, "output parent must be an existing physical directory");
    assert.ok(
      outputRoot !== REPO_ROOT && !outputRoot.startsWith(`${REPO_ROOT}${path.sep}`),
      "consumer must live outside the workspace",
    );
    await mkdir(outputRoot);
    tempRoot = outputRoot;
  }
  let passed = false;
  try {
    assert.ok(
      !tempRoot.startsWith(`${REPO_ROOT}${path.sep}`),
      "consumer must live outside the workspace",
    );
    const packsRoot = path.join(tempRoot, "packs");
    const extractedRoot = path.join(tempRoot, "extracted");
    await mkdir(packsRoot, { recursive: true });
    await mkdir(extractedRoot, { recursive: true });

    const artifacts = [];
    for (const definition of PACKAGES) {
      const tarballPath = await packPackage(definition, packsRoot);
      artifacts.push(
        await inspectTarball(definition, tarballPath, extractedRoot),
      );
    }
    const sandboxConsumer = await runNeutralSandboxConsumer({ repoRoot: REPO_ROOT, tempRoot, artifacts, run, publicExamplesRoot: PUBLIC_EXAMPLES_ROOT });
    if (profile === "sandbox-platform") {
      const sandboxPlatformConsumer = await runPortableSandboxConsumer({ repoRoot: REPO_ROOT, tempRoot, artifacts, run, publicExamplesRoot: PUBLIC_EXAMPLES_ROOT });
      process.stdout.write(`${JSON.stringify({ proof: "agent-sdk-sandbox-platform-artifact-identities", profile,
        scope: "portable sandbox configuration/examples only; full SDK runtime and native platform execution not run",
        sandboxConsumer, sandboxPlatformConsumer, packages: await packedArtifactIdentities(artifacts),
      })}\n`);
      process.stdout.write(`Sandbox-platform installed proof passed; consumer retained at ${outputRoot}.\n`);
      passed = true;
      return;
    }
    const { liveExampleSha256, rememberedAcpExampleSha256, continuationAcpFiles, dependencyEvidence,
      executionInputAcpProofFiles, sandboxPlatformReport } = await runConsumer(tempRoot, artifacts, dependencyBaseline);
    const coreConsumer = await runCoreConsumer(tempRoot, artifacts, dependencyBaseline);
    const historyConsumer = await runHistoryConsumer(tempRoot, artifacts);
    const claudeHistoryConsumer = await runClaudeHistoryConsumer(tempRoot, artifacts);
    const codexHistoryConsumer = await runCodexHistoryConsumer(tempRoot, artifacts);
    const opencodeHistoryConsumer = await runOpenCodeHistoryConsumer(tempRoot, artifacts);
    const cursorHistoryConsumer = await runCursorHistoryConsumer(tempRoot, artifacts);
    const grokHistoryConsumer = await runGrokHistoryConsumer(tempRoot, artifacts);
    const dependencyEvidencePath = dependencyBaseline ? path.join(tempRoot, "dependency-baseline.json") : undefined;
    if (dependencyEvidencePath) await writeFile(dependencyEvidencePath, JSON.stringify({
      schema: "agenai.agent-sdk.consumer-dependency-baseline.v1", baselineRoot,
      profiles: [coreConsumer.dependencyEvidence, dependencyEvidence],
    }, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(`${JSON.stringify({
      proof: "agent-sdk-packed-artifact-identities",
      sandboxConsumer,
      sandboxPlatformConsumer: sandboxPlatformReport,
      historyConsumer,
      claudeHistoryConsumer,
      codexHistoryConsumer,
      opencodeHistoryConsumer,
      cursorHistoryConsumer,
      grokHistoryConsumer,
      example: {
        path: "examples/live-request-output.ts",
        sha256: liveExampleSha256,
      },
      operationsExample: { files: coreConsumer.operationExamples, installedSdkPackages: coreConsumer.packages },
      generationExample: { files: coreConsumer.generationExamples, installedSdkPackages: coreConsumer.packages },
      executionInputExample: { files: coreConsumer.executionInputExamples, proofFiles: coreConsumer.executionInputProofFiles,
        installedSdkPackages: coreConsumer.packages, scope: "neutral synthetic provider; no public native input provider" },
      executionInputAcpProof: { files: executionInputAcpProofFiles, scope: "actual packed ACP constructors with a synthetic serialized peer",
        profiles: ["generic-acp", "grok-labels-and-adverts", "grok-1.0.62-structured-output"], ownership: ["borrowed", "owned"] },
      sessionContinuationExample: { files: coreConsumer.continuationExamples, installedSdkPackages: coreConsumer.packages },
      sessionContinuationAcpExample: { files: continuationAcpFiles },
      lifecycleExample: { path: "examples/lifecycle-interactions.ts", sha256: coreConsumer.exampleSha256, installedSdkPackages: coreConsumer.packages },
      rememberedExample: { path: "examples/remembered-approvals.ts", sha256: coreConsumer.rememberedExampleSha256,
        installedSdkPackages: coreConsumer.packages },
      rememberedAcpExample: { path: "examples/remembered-approvals-acp.ts", sha256: rememberedAcpExampleSha256 },
      ...(dependencyEvidencePath ? { dependencyBaselineEvidence: dependencyEvidencePath } : {}),
      packages: await packedArtifactIdentities(artifacts),
    })}\n`);
    process.stdout.write(
      "Agent SDK tarballs, manifests, declarations, and external consumer passed.\n",
    );
    passed = true;
    if (outputRoot !== undefined) {
      process.stdout.write(`Agent SDK external consumer retained at ${outputRoot}.\n`);
    }
  } finally {
    if (outputRoot === undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    } else if (!passed) {
      process.stderr.write(`Failed agent SDK packed consumer retained at ${outputRoot}.\n`);
    }
  }
}

await main();
