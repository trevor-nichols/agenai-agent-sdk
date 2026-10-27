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
import { SandboxStartError, SandboxUnsupportedError, SandboxValidationError, parseSandboxRequest } from "@agen-ai/sandbox";
import type { SandboxTransferSymlinkSupport } from "@agen-ai/sandbox";
import type { DockerSandboxFilesystemOptions, DockerSandboxProfile } from "@agen-ai/sandbox-docker";
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
const { createDockerDesktopRouteAuthority } = await import("@agen-ai/sandbox-docker/node");
await import("./examples/sandbox/combined/index.js");

const profiles: readonly DockerSandboxProfile[] = ["linux-x64", "desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"];
const operationRoot = fileURLToPath(new URL("../sandbox-platform-uncreated", import.meta.url));
const manifest = fileURLToPath(new URL("../sandbox-platform-fixture.json", import.meta.url));
const environment = {
  AGENAI_SANDBOX_TEST_ENGINE: `unix://${operationRoot}/absent.sock`,
  AGENAI_SANDBOX_TEST_MANIFEST: manifest,
  AGENAI_SANDBOX_TEST_OUTPUT: operationRoot,
};
const filesystem: DockerSandboxFilesystemOptions = {
  imageDigest: `sha256:${"8".repeat(64)}`, protocol: "agenai.sandbox.filesystem.v1",
  executable: "/usr/local/bin/agenai-sandbox-files", layout: "agenai.sandbox.workspace.v1", user: { uid: 65534, gid: 65534 },
  resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2,
  control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 },
};
const selected = [];
const preservingTransfers: Array<{ profile: DockerSandboxProfile; support: SandboxTransferSymlinkSupport | undefined }> = [];
let filesystemGrantsReserved = 0;
let unconfiguredFilesystemGrantsRejected = 0;
for (const profile of profiles) {
  const backendRevision = `engine-1.52-${profile === "linux-x64" ? "v5" : "v6"}-${profile}`;
  const config = await sandboxExampleConfiguration({ ...environment, AGENAI_SANDBOX_TEST_PROFILE: profile });
  assert.equal(config.profile, profile);
  const backend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile,
    imageDigest: config.imageDigest, namespace: "installed-platform", user: config.user, spillDirectory: operationRoot });
  preservingTransfers.push({ profile, support: backend.support.transferSymlinks });
  const owner = backend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
  assert.equal(owner.state.kind, "reserved");
  assert.equal(owner.recoveryRecord.backendRevision, backendRevision);
  selected.push({ profile, owner });
  const filesBackend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile,
    imageDigest: config.imageDigest, namespace: "installed-platform-files", user: config.user, spillDirectory: operationRoot, filesystem });
  const disabled = filesBackend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
  assert.deepEqual(disabled.recoveryRecord.resources.map(({ role }) => role), ["compute", "storage", "export"]);
  for (const kind of ["read_only", "read_write"] as const) {
    const request = parseSandboxRequest({ policy: { ...isolatedSandboxRequest().policy, files: { kind } } });
    assert.throws(() => backend.reserve(request, { kind: "in_process" }), SandboxUnsupportedError);
    unconfiguredFilesystemGrantsRejected += 1;
    const live = filesBackend.reserve(request, { kind: "in_process" });
    assert.deepEqual(live.state, { kind: "reserved" });
    assert.equal(live.recoveryRecord.backendRevision, backendRevision);
    assert.deepEqual(live.recoveryRecord.resources.map(({ role }) => role), ["compute", "storage", "export", "filesystem"]);
    assert.equal(live.recoveryRecord.configurationDigest, disabled.recoveryRecord.configurationDigest);
    assert.notEqual(live.recoveryRecord.policyDigest, disabled.recoveryRecord.policyDigest);
    filesystemGrantsReserved += 1;
  }
}
let desktopAuthorities = 0;
let desktopRestrictedReservations = 0;
for (const profile of ["desktop-apple-virtualization-native-arm64", "desktop-apple-virtualization-rosetta-amd64"] as const) {
  const routeAuthority = createDockerDesktopRouteAuthority({ kind: "local_docker_desktop", profile,
    stability: "caller_owned_quiescence", interception: "caller_owned_no_transparent_or_per_app_interception",
    engine: { endpoint: environment.AGENAI_SANDBOX_TEST_ENGINE, id: "unopened-desktop-engine" },
    deployment: { desktopVersion: "4.54.0", desktopBuild: "212467", virtualMachineManager: "apple_virtualization",
      rosetta: true, enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false,
      networkingMode: "ipv4only", dnsInhibition: "auto", dockerSubnet: "192.168.65.0/24",
      proxyMode: "automatic_system", manualProxyConfiguration: false },
    hostObserver: { protocol: "agenai.desktop-host-network.v1", executable: { path: `${operationRoot}/unopened-observer`, sha256: "2".repeat(64) },
      sourceDigest: `sha256:${"3".repeat(64)}` },
    vmObserver: { protocol: "agenai.sandbox.desktop-route-observer.v1", observationProtocol: "agenai.desktop-vm-network.v1",
      imageDigest: `sha256:${"4".repeat(64)}`, sourceDigest: `sha256:${"5".repeat(64)}`,
      executable: "/usr/local/bin/agenai-sandbox-desktop-route", user: { uid: 1000, gid: 1000 },
      resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2,
      control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 } },
    pollIntervalMs: 100, commandTimeoutMs: 1000, maxOutputBytes: 1024 * 1024 });
  const options = { endpoint: environment.AGENAI_SANDBOX_TEST_ENGINE, profile, imageDigest: `sha256:${"1".repeat(64)}`,
    namespace: "installed-desktop-authority", spillDirectory: operationRoot, user: { uid: 1000, gid: 1000 },
    egress: { imageDigest: `sha256:${"6".repeat(64)}`, protocol: "agenai.sandbox.egress-connect.v1" as const,
      user: { uid: 1000, gid: 1000 }, routeAuthority, control: { heartbeatMs: 100, leaseTimeoutMs: 60_000 },
      broker: { resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2 },
      relay: { resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2 } } };
  const backend = createDockerSandboxBackend(options);
  assert.deepEqual(backend.reserve(isolatedSandboxRequest(), { kind: "in_process" }).state, { kind: "reserved" });
  const restricted = createDockerSandboxBackend({ ...options, filesystem: { ...filesystem, user: options.user } }).reserve(parseSandboxRequest({
    policy: { ...isolatedSandboxRequest().policy, files: { kind: "read_write" },
      network: { kind: "restricted_https", destinations: [{ hostname: "api.example.com", port: 443 }] } },
  }), { kind: "in_process" });
  assert.equal(restricted.recoveryRecord.backendRevision, `engine-1.52-v6-${profile}`);
  assert.deepEqual(restricted.recoveryRecord.resources.map(({ role }) => role).sort(),
    ["compute", "storage", "export", "filesystem", "network", "egress_socket", "egress_broker", "egress_relay", "route_observer"].sort());
  assert(restricted.recoveryRecord.resources.every(({ identity }) => identity.kind === "planned"));
  desktopRestrictedReservations += 1;
  for (const replacement of [{ ...routeAuthority }, JSON.parse(JSON.stringify(routeAuthority))]) {
    assert.throws(() => Reflect.apply(createDockerSandboxBackend, undefined, [{ ...options,
      egress: { ...options.egress, routeAuthority: replacement } }]), SandboxValidationError);
  }
  assert.throws(() => createDockerSandboxBackend({ ...options, endpoint: `${options.endpoint}.other` }), SandboxValidationError);
  desktopAuthorities += 1;
}
const defaults = await sandboxExampleConfiguration(environment);
assert.equal(defaults.profile, "linux-x64");
const defaultBackend = createDockerSandboxBackend({ endpoint: defaults.endpoint, imageDigest: defaults.imageDigest,
  namespace: "installed-platform-default", user: defaults.user, spillDirectory: operationRoot });
const defaultOwner = defaultBackend.reserve(isolatedSandboxRequest(), { kind: "in_process" });
assert.equal(defaultOwner.recoveryRecord.backendRevision, "engine-1.52-v5-linux-x64");
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
  constructors: selected.length + 1, desktopAuthorities, desktopRestrictedReservations,
  authorityClonesRejected: true, wrongControllerRejected: true, engineRequests, operationRootsCreated: 0,
  filesystemConstructors: profiles.length, filesystemGrantsReserved, unconfiguredFilesystemGrantsRejected,
  preservingTransfers, combinedExampleImport: "inert",
  nativeMacQualification: "pending" })}\n`);
