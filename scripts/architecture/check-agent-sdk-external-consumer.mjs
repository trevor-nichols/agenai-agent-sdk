// ------------------------------------------------------------------------------------------------
//                check-agent-sdk-external-consumer.mjs - Packed third-party SDK proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const PUBLIC_REPOSITORY_URL = "git+https://github.com/trevor-nichols/agenai-agent-sdk.git";
const PUBLIC_HOMEPAGE_URL = "https://github.com/trevor-nichols/agenai-agent-sdk#readme";
const PUBLIC_BUGS_URL = "https://github.com/trevor-nichols/agenai-agent-sdk/issues";
const PACKAGES = [
  {
    name: "@agenai/validation",
    root: "packages/validation",
    directory: "packages/validation",
    dependencies: { zod: "4.4.3" },
  },
  {
    name: "@agenai/agent-protocol",
    root: "packages/agent-protocol",
    directory: "packages/agent-protocol",
    dependencies: { "@agenai/validation": "^0.1.0", zod: "4.4.3" },
  },
  {
    name: "@agenai/agent-runtime",
    root: "packages/agent-runtime",
    directory: "packages/agent-runtime",
    dependencies: { "@agenai/agent-protocol": "^0.1.0" },
  },
];

// ------------------------------------------------------------------------------------------------
//                Process and Tarball Helpers
// ------------------------------------------------------------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  assert.equal(manifest.version, "0.1.0");
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
      definition.name !== "@agenai/validation"
    ) {
      assert.doesNotMatch(
        source,
        /(?:workspace|link|catalog):|\bfile:\/\//u,
        `${definition.name}/${relativeFile} contains a workspace-only reference`,
      );
      assert.doesNotMatch(
        source,
        FORBIDDEN_DECLARATION_FIELD_PATTERN,
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

import { normalizeValidationIssues } from "@agenai/validation";
import { normalizeZodValidationError } from "@agenai/validation/zod";
import {
  parseAgentConfigurationRevisionId,
  parseAgentInstanceId,
  parseAgentItemId,
  parseAgentProviderConversationId,
  parseAgentProviderKey,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentItemSnapshot,
} from "@agenai/agent-protocol";
import { parseAgentSessionBinding } from "@agenai/agent-protocol/sessions";
import { parseAgentTurnRunInput } from "@agenai/agent-protocol/turns";
import { parseAgentRequest } from "@agenai/agent-protocol/requests";
import { parseAgentEvent } from "@agenai/agent-protocol/events";
import { parseAgentCapabilities } from "@agenai/agent-protocol/capabilities";
import { parseAgentArtifactDescriptor } from "@agenai/agent-protocol/artifacts";
import { AgentEventSchema } from "@agenai/agent-protocol/zod";
import { AGENT_EVENT_JSON_SCHEMA } from "@agenai/agent-protocol/json-schema";
import {
  AGENT_PROVIDER_CONTRACT_ERROR_CODES,
  createAgentEventOutput,
  createAgentProviderReadiness,
  defineAgentProviderDriver,
  type AgentProviderSession,
} from "@agenai/agent-runtime";
import {
  createFakeAgentProvider,
  runAgentProviderConformance,
} from "@agenai/agent-runtime/testing";
import { z } from "zod/v4";

const require = createRequire(import.meta.url);
const protocolManifest = require("@agenai/agent-protocol/package.json") as { version: string };
assert.equal(protocolManifest.version, "0.1.0");

assert.equal(typeof parseAgentSessionBinding, "function");
assert.equal(typeof parseAgentTurnRunInput, "function");
assert.equal(typeof parseAgentRequest, "function");
assert.equal(typeof parseAgentArtifactDescriptor, "function");
assert.equal(AGENT_EVENT_JSON_SCHEMA.protocolVersion, 6);
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
  revision: parseAgentConfigurationRevisionId("configuration:1"),
  values: { model: "fake-model", mode: "agent" },
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
  protocolVersion: 6,
  providerKey: steeringProviderKey,
  sessions: { create: true, resume: false, branch: { kind: "unsupported" } },
  turns: {
    interactionModes: ["default"],
    interrupt: false,
    steer: {
      kind: "supported",
      input: { text: true, images: { kind: "unsupported" } },
    },
  },
  requests: { approval: false, elicitation: { kind: "unsupported" } },
  input: { text: true, images: { kind: "unsupported" } },
  output: {
    streaming: false,
    plans: false,
    fileChanges: "none",
    artifactKinds: [],
  },
  configuration: { kind: "managed" },
  interactionExtensions: {
    slashCommands: false,
    mcp: false,
    subagents: false,
    imageGeneration: false,
  },
  authentication: { kind: "unsupported" },
  versionReporting: true,
});
const packedSession = (sessionId = parseAgentSessionId("packed-steering-session")): AgentProviderSession => ({
  binding: {
    conversationId: parseAgentProviderConversationId("packed-steering-conversation"),
  },
  runTurn: async function* (input) {
    yield createAgentEventOutput({
      protocolVersion: 6,
      type: "turn.started",
      sessionId,
      turnId: input.turnId,
      occurredAt: "2026-08-04T00:00:00.000Z",
      payload: {},
    });
    yield createAgentEventOutput({
      protocolVersion: 6,
      type: "turn.completed",
      sessionId,
      turnId: input.turnId,
      occurredAt: "2026-08-04T00:00:01.000Z",
      payload: { outcome: "completed" },
    });
  },
  resolveRequest: async function* () {},
  interruption: { kind: "unsupported" },
  steering: {
    kind: "supported",
    steerTurn: async (input) => {
      assert.ok(input.parts.length > 0);
      return { status: "delivered" };
    },
  },
  configuration: { kind: "managed" },
  close: async () => undefined,
});
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
const steeringSession = await steeringInstance.adapter.createSession({
  sessionId: parseAgentSessionId("packed-steering-session"),
  workingDirectory: "/tmp/external-agent-sdk-steering-provider",
  configuration: {
    revision: parseAgentConfigurationRevisionId("packed-steering-configuration"),
    values: {},
  },
  onBindingCreated: () => undefined,
});
assert.equal(steeringSession.steering.kind, "supported");
if (steeringSession.steering.kind === "supported") {
  const steeringTurnId = parseAgentTurnId("packed-steering-turn");
  const steeringIterator = steeringSession.runTurn({
    turnId: steeringTurnId,
    interactionMode: "default",
    parts: [{ type: "text", text: "Start the packed provider." }],
  })[Symbol.asyncIterator]();
  assert.equal((await steeringIterator.next()).done, false);
  const result = await steeringSession.steering.steerTurn({
    turnId: steeringTurnId,
    parts: [{ type: "text", text: "Use Postgres." }],
  });
  assert.equal(result.status, "delivered");
  assert.equal((await steeringIterator.next()).done, false);
  assert.equal((await steeringIterator.next()).done, true);
}
await steeringSession.close({ reason: "idle" });
await steeringInstance.dispose();

const fake = createFakeAgentProvider();
const report = await runAgentProviderConformance({
  driver: fake.driver,
  definition: fake.definition,
  workingDirectory: "/tmp/external-agent-sdk-consumer",
  configuration,
  updatedConfiguration: {
    revision: parseAgentConfigurationRevisionId("configuration:2"),
    values: { model: "fake-model-2", mode: "agent" },
  },
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
  resolutionFor: (request) => ({
    requestKind: "approval",
    requestId: request.requestId,
    decision: "approved",
  }),
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
assert.ok(report.checks.includes("idempotent_session_close"));
assert.ok(report.checks.includes("idempotent_disposal"));

const limitedProviderKey = parseAgentProviderKey("limited-external-provider");
const limited = createFakeAgentProvider({
  providerKey: limitedProviderKey,
  instanceId: "limited-external-instance",
  capabilities: parseAgentCapabilities({
    protocolVersion: 6,
    providerKey: limitedProviderKey,
    sessions: { create: true, resume: true, branch: { kind: "unsupported" } },
    turns: {
      interactionModes: ["default"],
      interrupt: false,
      steer: { kind: "unsupported" },
    },
    requests: { approval: false, elicitation: { kind: "unsupported" } },
    input: { text: true, images: { kind: "unsupported" } },
    output: {
      streaming: false,
      plans: false,
      fileChanges: "none",
      artifactKinds: [],
    },
    configuration: { kind: "managed" },
    interactionExtensions: {
      slashCommands: false,
      mcp: false,
      subagents: false,
      imageGeneration: false,
    },
    authentication: { kind: "unsupported" },
    versionReporting: true,
  }),
});
const limitedReport = await runAgentProviderConformance({
  driver: limited.driver,
  definition: limited.definition,
  workingDirectory: "/tmp/external-agent-sdk-consumer-limited",
  configuration: {
    revision: parseAgentConfigurationRevisionId("limited-configuration:1"),
    values: {},
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
  protocolVersion: 6,
  type: "turn.started",
  sessionId: parseAgentSessionId("round-trip-session"),
  turnId: parseAgentTurnId("round-trip-turn"),
  occurredAt: "2026-08-04T00:00:00.000Z",
  payload: { message: "Packed event." },
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
  protocolVersion: 6,
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

process.stdout.write("External packed agent SDK consumer passed.\\n");
`;

async function runConsumer(tempRoot, artifacts) {
  const consumerRoot = path.join(tempRoot, "consumer");
  const sourceRoot = path.join(consumerRoot, "src");
  await mkdir(sourceRoot, { recursive: true });
  const tarballFor = (name) =>
    artifacts.find((artifact) => artifact.manifest.name === name).tarballPath;
  const fileDependency = (name) => `file:${tarballFor(name)}`;
  const packageJson = {
    name: "agent-sdk-external-consumer-proof",
    version: "1.0.0",
    private: true,
    type: "module",
    packageManager: "pnpm@11.7.0",
    engines: { node: ">=22.0.0" },
    dependencies: {
      "@agenai/validation": fileDependency("@agenai/validation"),
      "@agenai/agent-protocol": fileDependency("@agenai/agent-protocol"),
      "@agenai/agent-runtime": fileDependency("@agenai/agent-runtime"),
      zod: "4.4.3",
    },
    devDependencies: { "@types/node": "24.10.1", typescript: "5.9.3" },
  };
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
    include: ["src/**/*.ts"],
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
  await writeFile(
    path.join(consumerRoot, ".pnpmfile.cjs"),
    `const packedDependencies = ${JSON.stringify({
      "@agenai/validation": fileDependency("@agenai/validation"),
      "@agenai/agent-protocol": fileDependency("@agenai/agent-protocol"),
      "@agenai/agent-runtime": fileDependency("@agenai/agent-runtime"),
    })};\nmodule.exports = { hooks: { readPackage(pkg) {\n  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {\n    if (!pkg[section]) continue;\n    for (const [name, tarball] of Object.entries(packedDependencies)) {\n      if (Object.hasOwn(pkg[section], name)) pkg[section][name] = tarball;\n    }\n  }\n  return pkg;\n} } };\n`,
  );
  await run("pnpm", ["install", "--ignore-scripts", "--prefer-offline"], {
    cwd: consumerRoot,
  });
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], {
    cwd: consumerRoot,
  });
  const execution = await run("node", ["dist/scenario.js"], {
    cwd: consumerRoot,
  });
  assert.match(
    execution.stdout,
    /External packed agent SDK consumer passed\./u,
  );
}

// ------------------------------------------------------------------------------------------------
//                Proof Orchestration
// ------------------------------------------------------------------------------------------------

async function main() {
  const tempRoot = await mkdtemp(
    path.join(tmpdir(), "agenai-agent-sdk-consumer-"),
  );
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
    await runConsumer(tempRoot, artifacts);
    process.stdout.write(
      "Agent SDK tarballs, manifests, declarations, and external consumer passed.\n",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
