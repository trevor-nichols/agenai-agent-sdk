import assert from "node:assert/strict";
import { limits, nativeLaunch, parseGuestConfig } from "../../../scripts/development/agent-sandbox-qualification/capabilities/catalog/protocol.mjs";
import { NATIVE_CATALOG_TUPLE as tuple } from "./policy.mjs";

/** Check critical observed facts as well as the record's byte binding. */
export function verifyCatalogConfiguration(value) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ["format", "platform", "workload", "native", "bootstrap", "credential", "destinations",
    "files", "modelTasks", "observationMs", "cleanupMs", "requestMs", "guest", "helperBaseImage", "egress", "routeAuthority"].sort());
  assert.equal(value.format, "agenai.native-catalog-configuration.v1");
  assert.deepEqual(value.native, tuple.native, "Configuration selects a different native binary.");
  assert.deepEqual(value.bootstrap, tuple.bootstrap, "Configuration selects a different credential bootstrap.");
  assert.equal(value.workload.imageDigest, tuple.workloadImage);
  assert.deepEqual(value.workload.user, { uid: 65534, gid: 65534 });
  assert.equal(value.platform.profile, tuple.profile);
  assert.deepEqual(value.platform.expected.controller, { os: tuple.controller.os, architecture: tuple.controller.architecture, nodeVersion: tuple.controller.node });
  const daemon = value.platform.expected.daemon;
  for (const [field, expected] of Object.entries({ version: tuple.daemon.engine, apiVersion: tuple.daemon.api,
    architecture: tuple.daemon.architecture, kernelVersion: tuple.daemon.kernel })) assert.equal(daemon[field], expected);
  assert.deepEqual(value.platform.desktop, { version: tuple.daemon.desktop, vmm: "apple-virtualization", rosetta: true, enhancedContainerIsolation: false });
  assert.equal(value.helperBaseImage, tuple.helper.baseImage);
  assert.equal(value.egress.sourceDigest, tuple.helper.sourceDigest);
  for (const [field, expected] of Object.entries({ imageDigest: tuple.helper.image, protocol: tuple.helper.protocol })) {
    assert.equal(value.egress.configuration[field], expected);
  }
  assert.deepEqual(value.egress.configuration.user, tuple.helper.user);
  assert.equal(value.routeAuthority.kind, "local_docker_desktop");
  assert.equal(value.routeAuthority.profile, tuple.profile);
  assert.equal(value.routeAuthority.engine.endpoint, "selected_local_engine");
  assert.equal(value.routeAuthority.engine.id, daemon.id, "Observed daemon and route authority disagree.");
  assert.equal(value.routeAuthority.deployment.desktopVersion, tuple.daemon.desktop);
  assert.equal(String(value.routeAuthority.deployment.desktopBuild), String(tuple.daemon.build));
  assert.equal(value.routeAuthority.stability, "caller_owned_quiescence");
  assert.equal(value.routeAuthority.interception, "caller_owned_no_transparent_or_per_app_interception");
  for (const [field, expected] of Object.entries({ virtualMachineManager: "apple_virtualization", rosetta: true,
    enhancedContainerIsolation: false, hostNetworking: false, kernelUdp: false, networkingMode: "ipv4only", manualProxyConfiguration: false })) {
    assert.equal(value.routeAuthority.deployment[field], expected);
  }
  assert.equal(value.credential, "first_party_oidc_access_only"); assert.equal(value.files, "disabled"); assert.equal(value.modelTasks, 0);
  assert.equal(value.observationMs, limits.overallMs); assert.equal(value.cleanupMs, limits.cleanupMs); assert.equal(value.requestMs, limits.requestMs);
  assert.deepEqual(value.destinations, ["cli-chat-proxy.grok.com", "api.x.ai", "assets.grok.com", "auth.x.ai", "grok.com"]
    .map((hostname) => ({ hostname, port: 443 })));
  const guest = parseGuestConfig(value.guest.configuration);
  assert.deepEqual(guest, { format: "agenai.native-catalog-guest-config.v1", observation: "native",
    native: { executable: tuple.native.executable, bytes: tuple.native.bytes, sha256: tuple.native.sha256 },
    profile: "/workspace/work/native-state/grok", project: "/workspace/work/project", authFile: "/home/sandbox/.agenai-credentials/grok-auth.json" });
  assert.deepEqual(value.guest.limits, limits);
  assert.deepEqual(value.guest.nativeLaunch, nativeLaunch(guest), "Native launch differs from the bound guest protocol.");
  assert.deepEqual(value.guest.process, { executable: "/usr/local/bin/node",
    args: ["/workspace/work/catalog/guest/run.mjs", "/workspace/work/catalog/config.json"], cwd: "/workspace/work",
    env: { HOME: "/home/sandbox", TMPDIR: "/tmp", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
}
