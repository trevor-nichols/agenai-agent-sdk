// ------------------------------------------------------------------------------------------------
//                platform.ts - Installed inert profile composition and real-controller rejection
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { SandboxStartError, SandboxUnsupportedError } from "@agen-ai/sandbox";
import type { DockerSandboxProfile } from "@agen-ai/sandbox-docker";
import { sandboxExampleConfiguration } from "./examples/sandbox/configuration.js";
import { isolatedSandboxRequest } from "./examples/sandbox/policy.js";

let engineRequests = 0;
const forbidden = (): never => {
  engineRequests += 1;
  throw new Error("Installed profile admission must reject a wrong controller before Engine I/O.");
};
http.request = forbidden; http.get = forbidden;
https.request = forbidden; https.get = forbidden;
net.connect = forbidden; net.createConnection = forbidden;
globalThis.fetch = async () => forbidden();
syncBuiltinESMExports();
const { createDockerSandboxBackend } = await import("@agen-ai/sandbox-docker");

const profiles: readonly DockerSandboxProfile[] = ["linux-x64", "desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"];
const operationRoot = fileURLToPath(new URL("../sandbox-platform-uncreated", import.meta.url));
const manifest = fileURLToPath(new URL("../sandbox-platform-fixture.json", import.meta.url));
const environment = {
  AGENAI_SANDBOX_TEST_ENGINE: `unix://${operationRoot}/absent.sock`,
  AGENAI_SANDBOX_TEST_MANIFEST: manifest,
  AGENAI_SANDBOX_TEST_OUTPUT: operationRoot,
};
const selected = [];
for (const profile of profiles) {
  const config = await sandboxExampleConfiguration({ ...environment, AGENAI_SANDBOX_TEST_PROFILE: profile });
  assert.equal(config.profile, profile);
  const backend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile,
    imageDigest: config.imageDigest, namespace: "installed-platform", user: config.user, spillDirectory: operationRoot });
  const owner = backend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
  assert.equal(owner.state.kind, "reserved");
  assert.equal(owner.recoveryRecord.backendRevision, `engine-1.52-v4-${profile}`);
  selected.push({ profile, owner });
}
const defaults = await sandboxExampleConfiguration(environment);
assert.equal(defaults.profile, "linux-x64");
const defaultBackend = createDockerSandboxBackend({ endpoint: defaults.endpoint, imageDigest: defaults.imageDigest,
  namespace: "installed-platform-default", user: defaults.user, spillDirectory: operationRoot });
const defaultOwner = defaultBackend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
assert.equal(defaultOwner.recoveryRecord.backendRevision, "engine-1.52-v4-linux-x64");
assert.equal(engineRequests, 0);
await assert.rejects(stat(operationRoot), { code: "ENOENT" });

const incompatibleProfile: DockerSandboxProfile = process.platform === "linux" && process.arch === "x64"
  ? "desktop-apple-virtualization-native-arm64" : "linux-x64";
const incompatible = selected.find(({ profile }) => profile === incompatibleProfile);
assert(incompatible);
await assert.rejects(incompatible.owner.start(), (error: unknown) => {
  assert(error instanceof SandboxStartError);
  assert(error.cause instanceof SandboxUnsupportedError);
  assert.equal(error.owner, incompatible.owner);
  return true;
});
assert.equal(engineRequests, 0);
await assert.rejects(stat(operationRoot), { code: "ENOENT" });

process.stdout.write(`${JSON.stringify({ proof: "packed-sandbox-platform-configuration", evidence: "inert-configuration-and-controller-rejection",
  controller: { os: process.platform, architecture: process.arch }, profiles, defaultProfile: defaults.profile,
  constructors: selected.length + 1, wrongControllerRejected: true, engineRequests, operationRootsCreated: 0,
  nativeMacQualification: "pending" })}\n`);
