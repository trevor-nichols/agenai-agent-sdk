// ------------------------------------------------------------------------------------------------
//                liveBaseline.ts - Activation authority, settled baselines, restart detection and unconfirmed bridge removals
// ------------------------------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxOperationError } from '@agen-ai/sandbox';
import type { DesktopCompleteObservation } from '../observation/complete.js';
import type { DesktopEngineIdentity, DesktopEngineNetworkCensus } from '../observation/engine.js';
import type { DesktopHostAuthorityObservation } from '../observation/host.js';
import type { DesktopVmObservation } from '../observation/vm.js';
import { desktopAddressesSettled, requireSameAuthority } from '../topology.js';
import { DESKTOP_COORDINATOR_POLICY } from './policy.js';

type DesktopExternalEngine = Omit<DesktopEngineNetworkCensus, 'excludedCidrs'>;
interface DesktopAuthorityObservation { readonly host: DesktopHostAuthorityObservation; readonly engine: DesktopEngineIdentity }

/** Moby recreates its default bridge only when the daemon starts, and the Engine API cannot remove it. */
export class DesktopEngineRestartedError extends SandboxOperationError {
  constructor() {
    super('driver_failure', 'Desktop Engine restarted while the coordinator owned resources in its VM.');
  }
}

function defaultBridgeId(engine: DesktopExternalEngine): string | undefined {
  return engine.networks.find((network) => network.Name === 'bridge' && network.Driver === 'bridge'
    && network.Options['com.docker.network.bridge.default_bridge'] === 'true')?.Id;
}

/** Activation may read Desktop's cached replies; host authority and Engine identity survive a Resource Saver VM restart. */
export function requireDesktopAuthority(observed: DesktopAuthorityObservation, activation: DesktopAuthorityObservation): void {
  requireSameAuthority(observed.host.fingerprint, activation.host.fingerprint, 'Desktop host authority differs from the original baseline.');
  requireSameAuthority(observed.host.executableIdentity, activation.host.executableIdentity, 'Desktop host observer identity changed.');
  const identity = ({ id, hostname, kernel }: DesktopEngineIdentity) => ({ id, hostname, kernel });
  requireSameAuthority(identity(observed.engine), identity(activation.engine), 'Desktop Engine identity differs from its activation.');
}

/**
 * A freshly booted VM finishes duplicate address detection on Desktop's own interfaces after its Engine starts. No member owns
 * a VM interface before the baseline, so the baseline waits for that kernel state across both VM reads of one observation.
 */
export async function captureDesktopSettledBaseline<T extends Readonly<{ complete: DesktopCompleteObservation }>>(
  capture: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + DESKTOP_COORDINATOR_POLICY.transitionTimeoutMs;
  while (true) {
    const observed = await capture();
    const { vmBefore, vmAfter } = observed.complete;
    if (vmBefore.fingerprint === vmAfter.fingerprint && desktopAddressesSettled(vmAfter.snapshot.interfaces)) return observed;
    if (performance.now() >= deadline) throw new SandboxOperationError('deadline_exceeded', 'Desktop VM addresses did not settle for a baseline.');
    await delay(Math.min(DESKTOP_COORDINATOR_POLICY.pollIntervalMs, Math.max(1, deadline - performance.now())));
  }
}

export function requireSameExternalEngine(observed: DesktopExternalEngine, baseline: DesktopExternalEngine): void {
  const original = defaultBridgeId(baseline);
  if (original !== undefined && defaultBridgeId(observed) !== original) throw new DesktopEngineRestartedError();
  requireSameAuthority(observed, baseline, 'External Desktop Engine topology changed.');
}

/** A bridge deleted while no observer ran is proven gone only by the next live VM observation. */
export function requireDesktopBridgesRemoved(observations: readonly DesktopVmObservation[], bridgeNames: ReadonlySet<string>): void {
  if (observations.some((observation) => observation.snapshot.interfaces.some((device) => bridgeNames.has(device.name)))) {
    throw new SandboxOperationError('driver_failure', 'Desktop owned bridge remains in the VM after its Engine deletion.');
  }
}
