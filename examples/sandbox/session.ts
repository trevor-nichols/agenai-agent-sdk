// ------------------------------------------------------------------------------------------------
//                session.ts - Owned public ACP sandbox lifecycle
// ------------------------------------------------------------------------------------------------

import type {
  AgentConfigurationRevisionId, AgentInstanceId, AgentProviderKey, AgentSessionId,
} from "@agen-ai/agent-protocol";
import {
  createAgentProviderRegistry,
  AgentProviderRegistryError,
  isAgentProviderSessionCleanupErrorFor,
  type AgentCreateSessionInput,
  type AgentProviderRegistry,
  type AgentProviderSession,
} from "@agen-ai/agent-runtime";
import {
  createNodeAcpProviderDriver,
  NodeAcpExecutionCleanupError,
  type CreateNodeAcpProviderDriverOptions,
  type NodeAcpLaunchOptions,
} from "@agen-ai/provider-acp/node";
import type {
  Sandbox, SandboxBackend, SandboxTreeSource, SandboxRecoveryPolicy, SandboxRequestInput,
} from "@agen-ai/sandbox";
import { createSandboxAcpIntegration } from "@agen-ai/sandbox/acp";
import { collectSandboxFiles, type CollectedSandboxFile, type SandboxTransferObservationOptions } from "./collect.js";

interface SandboxAcpSessionOptions {
  readonly backend: SandboxBackend;
  readonly request: SandboxRequestInput;
  readonly recovery: SandboxRecoveryPolicy;
  readonly entries: SandboxTreeSource;
  readonly identity: Readonly<{
    providerKey: AgentProviderKey;
    instanceId: AgentInstanceId;
    sessionId: AgentSessionId;
    configurationRevision: AgentConfigurationRevisionId;
  }>;
  readonly launch: (sandbox: Sandbox) => Omit<NodeAcpLaunchOptions, "cwd">;
  readonly driver?: Omit<CreateNodeAcpProviderDriverOptions, "providerKey" | "launch" | "executionBoundary" | "host">;
  readonly exportPaths: readonly string[];
  readonly maxExportBytes: number;
  readonly transferOptions?: (operation: "import" | "export") => SandboxTransferObservationOptions;
  readonly afterClose?: (sandbox: Sandbox) => Promise<void>;
}

export class SandboxAcpSessionError extends AggregateError {
  constructor(
    readonly primaryFailure: Readonly<{ error: unknown }> | undefined,
    readonly cleanupFailures: readonly Readonly<{ operation: string; error: unknown }>[],
    readonly retryCleanup: () => Promise<void>,
    readonly owner: ReturnType<SandboxBackend["reserve"]>,
  ) {
    super([
      ...(primaryFailure ? [primaryFailure.error] : []),
      ...cleanupFailures.map(({ error }) => error),
    ], "Sandbox ACP workflow failed; original failures and cleanup owners are retained.");
    this.name = "SandboxAcpSessionError";
  }
}

/** Reuse this lifecycle with an explicitly prepared native ACP image and launch recipe. */
export async function withSandboxAcpSession<T>(
  options: SandboxAcpSessionOptions,
  run: (session: AgentProviderSession, sandbox: Sandbox) => Promise<T>,
) {
  const owner = options.backend.reserve(options.request, options.recovery);
  let registry: AgentProviderRegistry | undefined;
  let session: AgentProviderSession | undefined;
  let pendingOpeningCleanup: (() => Promise<void>) | undefined;
  let primaryFailure: Readonly<{ error: unknown }> | undefined;
  const cleanupFailures: Array<Readonly<{ operation: string; error: unknown }>> = [];
  let work: Readonly<{ result: T; sandbox: Sandbox }> | undefined;
  let completed: Readonly<{ result: T; files: readonly CollectedSandboxFile[] }> | undefined;
  const closeSession = async () => { if (session) { await session.close({}); session = undefined; } };
  const disposeRegistry = async () => { if (registry) { await registry.dispose(); registry = undefined; } };
  const closeProvider = async () => {
    if (pendingOpeningCleanup) { await pendingOpeningCleanup(); pendingOpeningCleanup = undefined; }
    await closeSession();
    await disposeRegistry();
  };
  const retryCleanup = async () => {
    const failures: unknown[] = [];
    for (const cleanup of [closeProvider, () => owner.destroy()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Sandbox ACP cleanup remains owned.");
  };
  try {
    const sandbox = await owner.start();
    await sandbox.importTree(options.entries, options.transferOptions?.("import"));
    const driver = createNodeAcpProviderDriver({
      ...options.driver,
      providerKey: options.identity.providerKey,
      ...createSandboxAcpIntegration(sandbox),
      launch: { ...options.launch(sandbox), cwd: sandbox.workspace },
    });
    try {
      registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{
        providerKey: options.identity.providerKey, instanceId: options.identity.instanceId, driverConfiguration: {},
      }] });
    } catch (error) {
      if (error instanceof AgentProviderRegistryError && error.code === "instance_materialization_failed"
        && error.cause instanceof NodeAcpExecutionCleanupError) {
        const retained = error.cause;
        pendingOpeningCleanup = () => retained.retryCleanup();
      }
      throw error;
    }
    const instance = registry.requireInstance(options.identity.instanceId);
    const opening: AgentCreateSessionInput = {
      sessionId: options.identity.sessionId,
      workingDirectory: sandbox.workspace,
      configuration: { kind: "managed", revision: options.identity.configurationRevision },
      onBindingCreated() {},
    };
    try { session = await instance.adapter.createSession(opening); }
    catch (error) {
      if (isAgentProviderSessionCleanupErrorFor(error, opening)) pendingOpeningCleanup = () => error.retryCleanup();
      throw error;
    }
    work = { result: await run(session, sandbox), sandbox };
  } catch (error) {
    primaryFailure = { error };
  }
  try {
    // An opening error already owns its failed cleanup; only an explicit retry may re-enter it.
    if (!pendingOpeningCleanup) {
      try { await closeProvider(); }
      catch (error) { cleanupFailures.push({ operation: "provider-close", error }); }
    }
    if (!primaryFailure && !cleanupFailures.length && work) {
      await options.afterClose?.(work.sandbox);
      completed = { result: work.result, files: await collectSandboxFiles(work.sandbox, options.exportPaths,
        options.maxExportBytes, options.transferOptions?.("export")) };
    }
  } catch (error) { primaryFailure = { error }; }
  finally {
    try { await owner.destroy(); }
    catch (error) { cleanupFailures.push({ operation: "sandbox-destroy", error }); }
  }
  if (primaryFailure || cleanupFailures.length) {
    throw new SandboxAcpSessionError(primaryFailure, Object.freeze(cleanupFailures), retryCleanup, owner);
  }
  if (!completed) throw new Error("Sandbox ACP workflow did not produce a result.");
  return { ...completed, recoveryRecord: owner.recoveryRecord };
}
