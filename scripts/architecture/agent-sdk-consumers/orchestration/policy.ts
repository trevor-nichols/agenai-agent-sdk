// ------------------------------------------------------------------------------------------------
//                policy.ts - Installed orchestration contracts and inert root proof
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import type {
  DelegationPolicySnapshot,
  DelegationTargetCatalog,
  ResolvedDelegationPolicy,
} from "@agen-ai/agent-orchestration";

const stdout = process.stdout;
void process.stderr;
let effectAttempts = 0;
const denyEffect = () => {
  effectAttempts += 1;
  throw new Error("Orchestration policy attempted process or network execution.");
};
for (const [facility, methods] of [
  [childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
  [http, ["request", "get", "createServer"]], [https, ["request", "get", "createServer"]],
  [net, ["connect", "createConnection", "createServer", "Socket"]], [tls, ["connect", "createServer", "TLSSocket"]],
  [dgram, ["createSocket"]], [workerThreads, ["Worker"]],
] as const) {
  for (const method of methods) assert.equal(Reflect.set(facility, method, denyEffect), true);
}
assert.equal(Reflect.set(globalThis, "fetch", denyEffect), true);
assert.equal(Reflect.set(globalThis, "WebSocket", denyEffect), true);
syncBuiltinESMExports();

const {
  DelegationValidationError,
  parseDelegationTargetCatalog,
  parseDelegationPolicySnapshot,
  resolveDelegationPolicy,
} = await import("@agen-ai/agent-orchestration");

// The explicit bridge import is also inert; only its start function may listen.
await import("@agen-ai/agent-orchestration/mcp");

const catalog: DelegationTargetCatalog = parseDelegationTargetCatalog({
  catalogId: "packed-catalog", revision: 1,
  targets: ["standard", "fast"].map((mode) => ({
    reference: {
      catalogId: "packed-catalog", catalogRevision: 1,
      targetId: mode, targetRevision: 1, sourceId: "packed-source", sourceRevision: 1,
    },
    instanceId: "packed-instance", providerKey: "packed-provider", modelId: "packed-model",
    label: `Packed ${mode} model`, options: [{ key: "speed", optionId: mode }],
    reasoning: { kind: "certified", value: "max" },
    executionMode: { kind: "certified", value: mode },
    certification: { mappingId: "packed-mapping", mappingRevision: 1 },
    availability: { kind: "available" }, limitations: [],
    application: {
      configuration: { kind: "managed", revision: `packed-config-${mode}` }, beforeFirstTurn: [],
    },
  })),
});

const defaultPolicy: DelegationPolicySnapshot = parseDelegationPolicySnapshot({ revision: 1 });
assert.equal(defaultPolicy.user.enabled, false);
assert.deepEqual(defaultPolicy.developer, { enabled: true, exclusions: [] });
const disabled: ResolvedDelegationPolicy = resolveDelegationPolicy({ catalog, policy: defaultPolicy });
assert.equal(disabled.enabled, false);
assert.deepEqual(disabled.allowedTargets, []);

const enabled = parseDelegationPolicySnapshot({ revision: 2, user: { enabled: true } });
const automatic = resolveDelegationPolicy({ catalog, policy: enabled });
assert.deepEqual(automatic.allowedTargets.map((target) => target.reference.targetId), ["standard"]);
assert.deepEqual(automatic.allowedTargets[0]?.reasoning, { kind: "certified", value: "max" });

const explicitFast = {
  enabled: true,
  selection: { kind: "explicit", targets: [{ catalogId: "packed-catalog", targetId: "fast" }] },
};
assert.deepEqual(resolveDelegationPolicy({ catalog, policy: parseDelegationPolicySnapshot({
  revision: 3, user: explicitFast,
}) }).allowedTargets.map((target) => target.reference.targetId), ["fast"]);
const excluded = resolveDelegationPolicy({ catalog, policy: parseDelegationPolicySnapshot({
  revision: 4, user: explicitFast,
  developer: { enabled: true, exclusions: [{ exclusionId: "no-fast", executionMode: "fast" }] },
}) });
assert.deepEqual(excluded.allowedTargets, []);
assert.ok(excluded.decisions.some((decision) => decision.reasons.some((reason) => reason.code === "developer_excluded")));
assert.deepEqual(resolveDelegationPolicy({ catalog, policy: parseDelegationPolicySnapshot({
  revision: 5, user: { enabled: true, selection: { kind: "explicit", targets: [] } },
}) }).allowedTargets, []);

assert.throws(() => parseDelegationTargetCatalog({
  ...catalog,
  targets: catalog.targets.map((target, index) => ({
    ...target, reference: { ...target.reference, sourceRevision: index + 1 },
  })),
}), DelegationValidationError);
assert.ok(Object.isFrozen(catalog.targets[0]?.application));
assert.equal(effectAttempts, 0);
stdout.write("External packed orchestration policy consumer passed with zero process/network execution.\n");
