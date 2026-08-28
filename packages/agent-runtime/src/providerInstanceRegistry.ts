// ------------------------------------------------------------------------------------------------
//                providerInstanceRegistry.ts - Driver materialization and disposal registry
// ------------------------------------------------------------------------------------------------

import {
  parseAgentCapabilities,
  parseAgentInstanceId,
  parseAgentProviderKey,
  type AgentInstanceId,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import { validateAgentProviderAdapter } from "./adapterValidation.js";
import {
  createAgentProviderCatalogEntries,
  createAgentProviderInstanceCatalogEntries,
  type AgentProviderCatalogEntry,
  type AgentProviderInstanceCatalogEntry,
} from "./providerCatalog.js";
import {
  AgentProviderConfigurationError,
  type AgentProviderDriver,
  type AgentProviderInstanceDefinition,
  type AgentProviderReadinessCheckInput,
  type MaterializedAgentProviderInstance,
} from "./providerDriver.js";
import {
  type AgentProviderReadiness,
  validateAgentProviderReadiness,
} from "./readiness.js";

// ------------------------------------------------------------------------------------------------
//                Registry Errors
// ------------------------------------------------------------------------------------------------

export const AGENT_PROVIDER_REGISTRY_ERROR_CODES = [
  "invalid_driver",
  "duplicate_provider",
  "duplicate_instance",
  "provider_not_registered",
  "multiple_instances_unsupported",
  "invalid_instance_configuration",
  "instance_materialization_failed",
  "instance_contract_mismatch",
  "instance_not_found",
  "instance_disposed",
  "instance_cleanup_failed",
  "registry_disposed",
] as const;

export type AgentProviderRegistryErrorCode =
  (typeof AGENT_PROVIDER_REGISTRY_ERROR_CODES)[number];

interface AgentProviderRegistryErrorInput {
  readonly code: AgentProviderRegistryErrorCode;
  readonly message: string;
  readonly providerKey?: AgentProviderKey;
  readonly instanceId?: AgentInstanceId;
  readonly cleanupFailureInstanceIds?: readonly AgentInstanceId[];
  readonly cause?: unknown;
}

export class AgentProviderRegistryError extends Error {
  readonly code: AgentProviderRegistryErrorCode;
  readonly providerKey?: AgentProviderKey;
  readonly instanceId?: AgentInstanceId;
  readonly cleanupFailureInstanceIds: readonly AgentInstanceId[];

  constructor(input: AgentProviderRegistryErrorInput) {
    super(
      input.message,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "AgentProviderRegistryError";
    this.code = input.code;
    this.providerKey = input.providerKey;
    this.instanceId = input.instanceId;
    this.cleanupFailureInstanceIds = Object.freeze([
      ...(input.cleanupFailureInstanceIds ?? []),
    ]);
  }
}

// ------------------------------------------------------------------------------------------------
//                Registry Contract
// ------------------------------------------------------------------------------------------------

export interface AgentProviderRegistry {
  readonly listProviderCatalogEntries: () => readonly AgentProviderCatalogEntry[];
  readonly listInstanceCatalogEntries: () => readonly AgentProviderInstanceCatalogEntry[];
  readonly listInstances: () => readonly MaterializedAgentProviderInstance[];
  readonly getInstance: (
    instanceId: AgentInstanceId,
  ) => MaterializedAgentProviderInstance | null;
  readonly hasInstance: (instanceId: AgentInstanceId) => boolean;
  readonly requireInstance: (
    instanceId: AgentInstanceId,
  ) => MaterializedAgentProviderInstance;
  readonly checkReadiness: (
    instanceId: AgentInstanceId,
    input?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<AgentProviderReadiness>;
  readonly dispose: () => Promise<void>;
}

export interface CreateAgentProviderRegistryInput {
  readonly drivers: readonly AgentProviderDriver[];
  readonly definitions: readonly AgentProviderInstanceDefinition[];
}

// ------------------------------------------------------------------------------------------------
//                Driver and Definition Validation
// ------------------------------------------------------------------------------------------------

function validateDrivers(
  drivers: readonly AgentProviderDriver[],
): ReadonlyMap<AgentProviderKey, AgentProviderDriver> {
  const driverMap = new Map<AgentProviderKey, AgentProviderDriver>();
  for (const candidate of drivers) {
    let providerKey: AgentProviderKey;
    try {
      providerKey = parseAgentProviderKey(candidate?.providerKey);
    } catch (cause) {
      throw new AgentProviderRegistryError({
        code: "invalid_driver",
        message: "Agent provider driver has an invalid provider key.",
        cause,
      });
    }
    const supportsMultipleInstances = candidate.supportsMultipleInstances;
    const materialize = candidate.materialize;
    if (
      typeof supportsMultipleInstances !== "boolean" ||
      typeof materialize !== "function"
    ) {
      throw new AgentProviderRegistryError({
        code: "invalid_driver",
        providerKey,
        message: `Agent provider driver ${providerKey} has an invalid runtime contract.`,
      });
    }
    if (driverMap.has(providerKey)) {
      throw new AgentProviderRegistryError({
        code: "duplicate_provider",
        providerKey,
        message: `Duplicate agent provider driver registered for ${providerKey}.`,
      });
    }
    driverMap.set(
      providerKey,
      Object.freeze({
        providerKey,
        supportsMultipleInstances,
        materialize: (definition: AgentProviderInstanceDefinition) =>
          materialize.call(candidate, definition),
      }),
    );
  }
  return driverMap;
}

function validateDefinitions(input: {
  readonly definitions: readonly AgentProviderInstanceDefinition[];
  readonly drivers: ReadonlyMap<AgentProviderKey, AgentProviderDriver>;
}): void {
  const instanceIds = new Set<string>();
  const providerCounts = new Map<AgentProviderKey, number>();
  for (const definition of input.definitions) {
    const instanceId = parseAgentInstanceId(definition.instanceId);
    const providerKey = parseAgentProviderKey(definition.providerKey);
    if (instanceIds.has(instanceId)) {
      throw new AgentProviderRegistryError({
        code: "duplicate_instance",
        providerKey,
        instanceId,
        message: `Duplicate agent provider instance ${instanceId}.`,
      });
    }
    instanceIds.add(instanceId);

    const driver = input.drivers.get(providerKey);
    if (!driver) {
      throw new AgentProviderRegistryError({
        code: "provider_not_registered",
        providerKey,
        instanceId,
        message: `No agent provider driver is registered for ${providerKey}.`,
      });
    }
    const providerCount = (providerCounts.get(driver.providerKey) ?? 0) + 1;
    providerCounts.set(driver.providerKey, providerCount);
    if (!driver.supportsMultipleInstances && providerCount > 1) {
      throw new AgentProviderRegistryError({
        code: "multiple_instances_unsupported",
        providerKey: driver.providerKey,
        instanceId,
        message: `Agent provider ${driver.providerKey} does not support multiple instances.`,
      });
    }
  }
}

// ------------------------------------------------------------------------------------------------
//                Instance Lifecycle
// ------------------------------------------------------------------------------------------------

type InstanceLifecycleStatus =
  | "active"
  | "disposing"
  | "dispose_failed"
  | "disposed";

interface ManagedInstance {
  readonly instance: MaterializedAgentProviderInstance;
  readonly lifecycle: {
    status: InstanceLifecycleStatus;
    disposePromise: Promise<void> | null;
  };
}

function managedInstance(
  rawInstance: MaterializedAgentProviderInstance,
  providerKey: AgentProviderKey,
): ManagedInstance {
  if (
    !rawInstance
    || typeof rawInstance !== "object"
    || typeof rawInstance.checkReadiness !== "function"
    || typeof rawInstance.dispose !== "function"
  ) {
    throw new AgentProviderRegistryError({
      code: "instance_contract_mismatch",
      providerKey,
      message:
        "Materialized instance must expose callable readiness and disposal ports.",
    });
  }
  const capabilities = parseAgentCapabilities(rawInstance.capabilities);
  const checkReadiness = rawInstance.checkReadiness.bind(rawInstance);
  const dispose = rawInstance.dispose.bind(rawInstance);
  const lifecycle: ManagedInstance["lifecycle"] = {
    status: "active",
    disposePromise: null,
  };
  const instance: MaterializedAgentProviderInstance = Object.freeze({
    instanceId: parseAgentInstanceId(rawInstance.instanceId),
    capabilities,
    adapter: validateAgentProviderAdapter(capabilities, rawInstance.adapter),
    checkReadiness: async (input?: AgentProviderReadinessCheckInput) => {
      const readiness = await checkReadiness(input);
      return validateAgentProviderReadiness(readiness);
    },
    dispose: () => {
      if (lifecycle.status === "disposed") return Promise.resolve();
      if (lifecycle.disposePromise) return lifecycle.disposePromise;
      lifecycle.status = "disposing";
      lifecycle.disposePromise = Promise.resolve()
        .then(() => dispose())
        .then(() => {
          lifecycle.status = "disposed";
        })
        .catch((error: unknown) => {
          lifecycle.status = "dispose_failed";
          throw error;
        })
        .finally(() => {
          lifecycle.disposePromise = null;
        });
      return lifecycle.disposePromise;
    },
  });
  if (capabilities.providerKey !== providerKey) {
    throw new AgentProviderRegistryError({
      code: "instance_contract_mismatch",
      providerKey,
      instanceId: instance.instanceId,
      message: "Materialized instance capabilities identify another provider.",
    });
  }
  return { instance, lifecycle };
}

async function disposeInstances(
  instances: readonly ManagedInstance[],
): Promise<readonly AgentInstanceId[]> {
  const failures: AgentInstanceId[] = [];
  for (const { instance } of [...instances].reverse()) {
    try {
      await instance.dispose();
    } catch {
      failures.push(instance.instanceId);
    }
  }
  return failures;
}

async function materializeInstances(input: {
  readonly definitions: readonly AgentProviderInstanceDefinition[];
  readonly drivers: ReadonlyMap<AgentProviderKey, AgentProviderDriver>;
}): Promise<readonly ManagedInstance[]> {
  const instances: ManagedInstance[] = [];
  for (const definition of input.definitions) {
    const driver = input.drivers.get(definition.providerKey)!;
    let rawInstance: MaterializedAgentProviderInstance;
    try {
      rawInstance = await driver.materialize(definition);
    } catch (error) {
      const cleanupFailureInstanceIds = await disposeInstances(instances);
      throw new AgentProviderRegistryError({
        code:
          error instanceof AgentProviderConfigurationError
            ? "invalid_instance_configuration"
            : "instance_materialization_failed",
        providerKey: definition.providerKey,
        instanceId: definition.instanceId,
        cleanupFailureInstanceIds,
        message:
          error instanceof AgentProviderConfigurationError
            ? `Agent provider configuration is invalid for ${definition.instanceId}.`
            : `Agent provider instance ${definition.instanceId} could not be materialized.`,
      });
    }

    let managed: ManagedInstance;
    try {
      managed = managedInstance(rawInstance, definition.providerKey);
      if (managed.instance.instanceId !== definition.instanceId) {
        throw new AgentProviderRegistryError({
          code: "instance_contract_mismatch",
          providerKey: definition.providerKey,
          instanceId: definition.instanceId,
          message: "Materialized instance returned another instanceId.",
        });
      }
    } catch (error) {
      let currentCleanupError: unknown;
      try {
        await rawInstance.dispose();
      } catch (cleanupError) {
        currentCleanupError = cleanupError;
      }
      const priorCleanupFailureIds = await disposeInstances(instances);
      const cleanupFailureInstanceIds = [
        ...(currentCleanupError === undefined ? [] : [definition.instanceId]),
        ...priorCleanupFailureIds,
      ];
      throw new AgentProviderRegistryError({
        code: "instance_contract_mismatch",
        providerKey: definition.providerKey,
        instanceId: definition.instanceId,
        cleanupFailureInstanceIds,
        message:
          error instanceof AgentProviderRegistryError
            ? error.message
            : `Materialized instance ${definition.instanceId} violates the provider contract.`,
        cause:
          currentCleanupError === undefined
            ? error
            : new AggregateError(
                [error, currentCleanupError],
                "Materialized instance contract validation and cleanup failed.",
              ),
      });
    }
    instances.push(managed);
  }
  return instances;
}

// ------------------------------------------------------------------------------------------------
//                Registry Construction
// ------------------------------------------------------------------------------------------------

export async function createAgentProviderRegistry(
  input: CreateAgentProviderRegistryInput,
): Promise<AgentProviderRegistry> {
  const drivers = validateDrivers(input.drivers);
  validateDefinitions({ definitions: input.definitions, drivers });
  const managedInstances = await materializeInstances({
    definitions: input.definitions,
    drivers,
  });
  const instanceMap = new Map(
    managedInstances.map((managed) => [managed.instance.instanceId, managed]),
  );
  const providerCatalog = createAgentProviderCatalogEntries(drivers.values());
  let registryStatus: InstanceLifecycleStatus = "active";
  let registryDisposePromise: Promise<void> | null = null;

  const getInstance = (
    instanceIdInput: AgentInstanceId,
  ): MaterializedAgentProviderInstance | null => {
    if (registryStatus !== "active") return null;
    const instanceId = parseAgentInstanceId(instanceIdInput);
    const managed = instanceMap.get(instanceId);
    return managed?.lifecycle.status === "active" ? managed.instance : null;
  };

  const lookupError = (
    instanceId: AgentInstanceId,
  ): AgentProviderRegistryError => {
    if (registryStatus !== "active") {
      return new AgentProviderRegistryError({
        code: "registry_disposed",
        instanceId,
        message: "Agent provider registry is disposed.",
      });
    }
    const managed = instanceMap.get(instanceId);
    return new AgentProviderRegistryError({
      code: managed ? "instance_disposed" : "instance_not_found",
      instanceId,
      providerKey: managed?.instance.capabilities.providerKey,
      message: managed
        ? `Agent provider instance ${instanceId} is disposed.`
        : `Agent provider instance ${instanceId} is not registered.`,
    });
  };

  const requireInstance = (
    instanceId: AgentInstanceId,
  ): MaterializedAgentProviderInstance => {
    const instance = getInstance(instanceId);
    if (!instance) throw lookupError(instanceId);
    return instance;
  };

  const dispose = (): Promise<void> => {
    if (registryStatus === "disposed") return Promise.resolve();
    if (registryDisposePromise) return registryDisposePromise;
    registryStatus = "disposing";
    registryDisposePromise = disposeInstances(managedInstances)
      .then((cleanupFailureInstanceIds) => {
        if (cleanupFailureInstanceIds.length > 0) {
          throw new AgentProviderRegistryError({
            code: "instance_cleanup_failed",
            instanceId: cleanupFailureInstanceIds[0],
            cleanupFailureInstanceIds,
            message: `${cleanupFailureInstanceIds.length} agent provider cleanup operation(s) failed.`,
          });
        }
        registryStatus = "disposed";
      })
      .catch((error: unknown) => {
        registryStatus = "dispose_failed";
        throw error;
      })
      .finally(() => {
        registryDisposePromise = null;
      });
    return registryDisposePromise;
  };

  return Object.freeze({
    listProviderCatalogEntries: () =>
      registryStatus === "active" ? providerCatalog : [],
    listInstanceCatalogEntries: () =>
      registryStatus === "active"
        ? createAgentProviderInstanceCatalogEntries(
            managedInstances
              .filter(({ lifecycle }) => lifecycle.status === "active")
              .map(({ instance }) => instance),
          )
        : [],
    listInstances: () =>
      registryStatus === "active"
        ? managedInstances
            .filter(({ lifecycle }) => lifecycle.status === "active")
            .map(({ instance }) => instance)
        : [],
    getInstance,
    hasInstance: (instanceId: AgentInstanceId) =>
      getInstance(instanceId) !== null,
    requireInstance,
    checkReadiness: async (
      instanceId: AgentInstanceId,
      readinessInput?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      return requireInstance(instanceId).checkReadiness(readinessInput);
    },
    dispose,
  });
}
