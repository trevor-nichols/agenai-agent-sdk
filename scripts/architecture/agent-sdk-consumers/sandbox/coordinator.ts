// Installed public coordinator contract. Native activation remains a separate Darwin proof.
import assert from "node:assert/strict";
import type { OperationOptions, SandboxRecoveryRecord, SandboxReconciliation } from "@agen-ai/sandbox";
import { SandboxValidationError } from "@agen-ai/sandbox";
import { createCoordinatedDockerSandboxBackend, DockerDesktopCoordinatorError } from "@agen-ai/sandbox-docker";
import type {
  DockerDesktopCoordinator, DockerDesktopCoordinatorAuthority, DockerDesktopCoordinatorCleanupOpen,
  DockerDesktopCoordinatorFailure, DockerDesktopCoordinatorMemberConfiguration, DockerDesktopCoordinatorOperationOptions,
  DockerDesktopCoordinatorRecovery,
} from "@agen-ai/sandbox-docker";
import { createDockerDesktopCoordinator, createDockerLinuxRouteAuthority } from "@agen-ai/sandbox-docker/node";
import type { DockerDesktopCoordinatorOptions } from "@agen-ai/sandbox-docker/node";

// Compile the cleanup capability's complete public call boundary without inventing native authority.
export function reconcileOriginalCoordinatorMember(recovery: DockerDesktopCoordinatorRecovery,
  configuration: DockerDesktopCoordinatorMemberConfiguration, record: SandboxRecoveryRecord,
  operation?: OperationOptions): Promise<SandboxReconciliation> {
  return recovery.reconcile({ configuration, record }, operation);
}

function failure(owner: DockerDesktopCoordinator, expected: DockerDesktopCoordinatorFailure) {
  return (error: unknown): boolean => {
    assert(error instanceof DockerDesktopCoordinatorError);
    assert.equal(error.owner, owner, "A rejected public operation retains its exact original owner.");
    assert.deepEqual(error.failure, expected);
    return true;
  };
}

export async function proveInstalledCoordinator(options: DockerDesktopCoordinatorOptions,
  configuration: DockerDesktopCoordinatorMemberConfiguration) {
  const owner = createDockerDesktopCoordinator(options);
  assert(Object.isFrozen(owner));
  assert.deepEqual(owner.state, { kind: "inert" });
  const invalidOperations: readonly unknown[] = [{ timeoutMs: 0 }, { timeoutMs: 60_001 }, { signal: {} },
    { unknown: true }, Object.defineProperty({}, "timeoutMs", { enumerable: true, get() { throw new Error("Accessor entered."); } })];
  for (const operation of invalidOperations) {
    for (const method of [owner.initialize, owner.activate, owner.settle, owner.close]) {
      await assert.rejects(Reflect.apply(method, owner, [operation]), failure(owner, { kind: "invalid_input" }));
      assert.deepEqual(owner.state, { kind: "inert" });
    }
    await assert.rejects(Reflect.apply(owner.reopenCleanup, owner, [undefined, operation]), failure(owner, { kind: "invalid_input" }));
  }
  await assert.rejects(owner.reopenCleanup({ expectedGeneration: "not-an-original-generation" }), failure(owner, { kind: "invalid_input" }));
  const cancellation = new AbortController();
  cancellation.abort(new Error("Cancelled before entering native preparation."));
  const operation: DockerDesktopCoordinatorOperationOptions = { signal: cancellation.signal, timeoutMs: 1000 };
  const activation: Promise<DockerDesktopCoordinatorAuthority> = owner.activate(operation);
  await assert.rejects(activation, failure(owner, { kind: "interrupted", by: "signal", effect: "not_entered" }));
  const cleanup: Promise<DockerDesktopCoordinatorCleanupOpen> = owner.reopenCleanup(undefined, operation);
  await assert.rejects(cleanup, failure(owner, { kind: "interrupted", by: "signal", effect: "not_entered" }));
  await assert.rejects(owner.initialize(operation), failure(owner, { kind: "interrupted", by: "signal", effect: "not_entered" }));
  assert.deepEqual(owner.state, { kind: "inert" });

  const invalidCapabilities = [owner, { ...owner }, options.routeAuthority,
    { kind: "desktop_coordinator", generation: "b73880bf-d5b2-4d94-824b-370a1ad1d660" }];
  for (const coordinator of invalidCapabilities) {
    assert.throws(() => Reflect.apply(createCoordinatedDockerSandboxBackend, undefined, [{ ...configuration, coordinator }]),
      { name: "TypeError", message: "Coordinated Desktop backends require an original active coordinator capability." });
  }
  for (const routeAuthority of [{ ...options.routeAuthority }, JSON.parse(JSON.stringify(options.routeAuthority))]) {
    assert.throws(() => Reflect.apply(createDockerDesktopCoordinator, undefined, [{ ...options, routeAuthority }]), SandboxValidationError);
  }
  const linux = createDockerLinuxRouteAuthority({ kind: "local_linux_same_host", stability: "caller_owned_quiescence",
    ipExecutable: { path: "/explicit-unopened/ip", sha256: "1".repeat(64) },
    pollIntervalMs: 1000, commandTimeoutMs: 5000, maxOutputBytes: 1024 * 1024 });
  assert.throws(() => Reflect.apply(createDockerDesktopCoordinator, undefined, [{ ...options, routeAuthority: linux }]),
    { name: "TypeError", message: "Desktop coordination requires an original Desktop route authority." });
  assert.throws(() => Reflect.apply(createDockerDesktopCoordinator, undefined, [{ ...options, unexpected: true }]),
    { name: "TypeError", message: "Desktop coordinator configuration rejects unknown fields and accessors." });
  assert.throws(() => Reflect.apply(createDockerDesktopCoordinator, undefined, [{ ...options,
    helper: { ...options.helper, protocol: "foreign-coordinator.v1" } }]), SandboxValidationError);

  await owner.settle({ timeoutMs: 1000 });
  owner.closeAdmission();
  assert.deepEqual(owner.state, { kind: "blocked", failure: { kind: "admission_closed" } });
  await assert.rejects(owner.initialize(), failure(owner, { kind: "invalid_state" }));
  await assert.rejects(owner.activate(), failure(owner, { kind: "invalid_state" }));
  await assert.rejects(owner.reopenCleanup(), failure(owner, { kind: "invalid_state" }));
  await owner.close();
  await owner.close();
  await owner.settle();
  assert.deepEqual(owner.state, { kind: "closed", result: "never_activated" });
  return { state: owner.state, invalidOperationInputs: invalidOperations.length,
    cancelledBeforeEntry: ["initialize", "activate", "reopenCleanup"],
    invalidMemberCapabilitiesRejected: invalidCapabilities.length, clonedRouteAuthoritiesRejected: 2,
    foreignRouteAuthorityRejected: true, unknownConfigurationRejected: true, invalidHelperRejected: true,
    originalErrorOwner: true, closedIdempotently: true, nativeActivation: "not_run" };
}
