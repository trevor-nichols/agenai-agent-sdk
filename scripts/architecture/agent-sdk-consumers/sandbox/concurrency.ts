// Installed public workflow admission only; native concurrent owners require prepared authority.
import assert from "node:assert/strict";
import { parseSandboxRequest } from "@agen-ai/sandbox";
import { createDockerSandboxBackend } from "@agen-ai/sandbox-docker";
import type { DockerDesktopCoordinatorMemberConfiguration } from "@agen-ai/sandbox-docker";
import { createDockerDesktopCoordinator } from "@agen-ai/sandbox-docker/node";
import type { DockerDesktopCoordinatorOptions } from "@agen-ai/sandbox-docker/node";
import { runConcurrentSandboxWorkflow } from "./examples/sandbox/concurrency/index.js";
import type { ConcurrentMemberInput, ConcurrentWorkflowOptions } from "./examples/sandbox/concurrency/index.js";
import { isolatedSandboxRequest } from "./examples/sandbox/policy.js";

export async function proveInstalledConcurrentExample(coordinatorOptions: DockerDesktopCoordinatorOptions,
  configuration: DockerDesktopCoordinatorMemberConfiguration) {
  const coordinator = createDockerDesktopCoordinator(coordinatorOptions);
  function member(label: "a" | "b" | "c"): ConcurrentMemberInput {
    const hostname = `${label}.example.test`;
    const backend = createDockerSandboxBackend({ ...configuration, namespace: `installed-concurrency-${label}` });
    const request = parseSandboxRequest({ policy: { ...isolatedSandboxRequest().policy,
      files: { kind: "read_write" }, network: { kind: "restricted_https", destinations: [{ hostname, port: 443 }] } } });
    return { backend, request, recovery: { kind: "in_process" }, forbidden: [],
      positive: { hostname, port: 443, path: "/", status: 200, bodyBytes: 0,
        bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
      destination: `${configuration.spillDirectory}/uncreated-export-${label}` };
  }
  const options: ConcurrentWorkflowOptions = { coordinator, members: [member("a"), member("b")], replacement: member("c"),
    startMode: "prepare_both", removalOrder: ["a", "b"], operationTimeoutMs: 1000 };
  try {
    await assert.rejects(runConcurrentSandboxWorkflow(options), { name: "AssertionError", actual: "inert", expected: "active",
      message: /^Explicitly activate the original coordinator before this workflow\./u });
    assert.deepEqual(coordinator.state, { kind: "inert" });
  } finally { await coordinator.close(); }
  assert.deepEqual(coordinator.state, { kind: "closed", result: "never_activated" });
  return { import: "inert", inactiveCoordinator: "rejected_before_reservation", nativeWorkflow: "not_run" };
}
