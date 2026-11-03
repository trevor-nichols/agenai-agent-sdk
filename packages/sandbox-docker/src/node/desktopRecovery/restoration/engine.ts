import { z } from 'zod/v4';
import type { DockerApi } from '../../../resources/api.js';
import { DockerResponseByteBudget } from '../../../resources/api.js';
import { DOCKER_API } from '../../../policy/config.js';
import { coordinatorDigest } from '../../../network/desktop/coordinator/journal/schema.js';
import { observationFingerprint } from '../../../network/desktop/observation/engine.js';
import { immutable } from '../../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import type { NativeCurrentAdmissionFacts } from '../native/schemas.js';

const text = z.string().min(1).max(256).refine((value) => value.isWellFormed() && !/\p{Cc}/u.test(value));
const versionSchema = z.object({ Version: z.literal('29.1.2'), ApiVersion: z.literal('1.52'),
  MinAPIVersion: z.string().regex(/^1\.(?:[0-9]|[1-4][0-9]|5[0-2])$/u),
  GitCommit: z.string().regex(/^de45c2a(?:e4f524290c23d4f2d979c484f158f339a)?$/u),
  Os: z.literal('linux'), Arch: z.literal('arm64'), KernelVersion: z.literal('6.12.54-linuxkit') });
const infoSchema = z.object({ ID: text, DockerRootDir: z.literal('/var/lib/docker'), Driver: z.literal('overlayfs'),
  DriverStatus: z.array(z.tuple([text, text])).min(1).max(64), Architecture: z.literal('aarch64'),
  KernelVersion: z.literal('6.12.54-linuxkit'), LiveRestoreEnabled: z.literal(false), OSType: z.literal('linux'),
  OperatingSystem: z.literal('Docker Desktop'), CgroupVersion: z.literal('2'), CgroupDriver: z.literal('cgroupfs'),
  SecurityOptions: z.array(text).min(1).max(64), ServerVersion: z.literal('29.1.2'), Name: z.literal('docker-desktop'),
  MemoryLimit: z.literal(true), SwapLimit: z.literal(true), PidsLimit: z.literal(true),
  CpuCfsPeriod: z.literal(true), CpuCfsQuota: z.literal(true) });
const containerSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u),
  Names: z.array(z.string().min(2).max(256).regex(/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)).min(1).max(64),
  State: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']) });
export type RecoveryContainerSummary = z.infer<typeof containerSchema>;

export class RecoveryRestorationError extends Error {
  constructor(readonly reason: 'fresh_boot' | 'restoration' | 'composition' | 'producer' | 'capacity' | 'store' | 'engine' | 'endpoint',
    message: string, options?: ErrorOptions) { super(message, options); this.name = 'RecoveryRestorationError'; }
}

export async function captureRecoveryEngine(api: DockerApi, expectedId: string, signal?: AbortSignal) {
  const responseBudget = new DockerResponseByteBudget(3 * 1024 ** 2);
  const version = await api.json('GET', '/version', versionSchema, { signal, responseBudget });
  const info = await api.json('GET', '/info', infoSchema, { signal, responseBudget });
  const containers = await api.json('GET', `${DOCKER_API}/containers/json?all=1`, z.array(containerSchema).max(4096), { signal, responseBudget });
  if (info.ID !== expectedId || new Set(containers.map((container) => container.Id)).size !== containers.length
    || info.DriverStatus.length !== 1 || info.DriverStatus[0][0] !== 'driver-type'
    || info.DriverStatus[0][1] !== 'io.containerd.snapshotter.v1'
    || JSON.stringify([...info.SecurityOptions].sort()) !== JSON.stringify(['name=cgroupns', 'name=seccomp,profile=builtin'])) {
    throw new RecoveryRestorationError('engine', 'Docker restoration differs from the selected persistent Engine or fixed store/isolation profile.');
  }
  const identity = { version, info: { ...info,
    DriverStatus: [...info.DriverStatus].sort(([left], [right]) => left.localeCompare(right)),
    SecurityOptions: [...info.SecurityOptions].sort() } };
  return immutable({ identity, containers: [...containers].sort((left, right) => left.Id.localeCompare(right.Id)),
    engineIdentityDigest: coordinatorDigest('agenai.desktop-recovery.engine-identity.v1', JSON.stringify(identity)) });
}
export type RecoveryEngineObservation = Awaited<ReturnType<typeof captureRecoveryEngine>>;

export function recoveryNativeFactsDigest(facts: NativeCurrentAdmissionFacts): string {
  const { continuousNs: _continuousNs, ...stable } = facts;
  return coordinatorDigest('agenai.desktop-recovery.native-current-identity.v1', observationFingerprint({ ...stable,
    images: [...facts.images].sort((left, right) => left.role.localeCompare(right.role)),
    processes: [...facts.processes].sort((left, right) => left.pid - right.pid),
  }));
}

export function recoveryStoreIdentityDigest(facts: NativeCurrentAdmissionFacts): string {
  return coordinatorDigest('agenai.desktop-recovery.store-identity.v1', JSON.stringify(facts.store));
}

export function assertRestoredEngine(before: RecoveryEngineObservation, after: RecoveryEngineObservation): void {
  if (before.engineIdentityDigest !== after.engineIdentityDigest) {
    throw new RecoveryRestorationError('engine', 'Persistent Docker Engine configuration changed across the observed lifecycle.');
  }
}

export function assertNoRunningRecoveryContainers(observation: RecoveryEngineObservation): void {
  if (observation.containers.some((container) => container.State === 'running' || container.State === 'paused'
    || container.State === 'restarting' || container.State === 'removing')) {
    throw new RecoveryRestorationError('producer', 'Desktop observation requires every container to be quiescent.');
  }
}
