import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import { DockerResponseByteBudget } from '../../../resources/api.js';
import type { DockerApi } from '../../../resources/api.js';
import type { DockerDesktopRouteAuthorityBinding } from '../../routeAuthority.js';
import type { DesktopVmObserverClient } from '../client.js';
import type { DesktopRouteCensus } from '../acquisition.js';
import { deniedCoverage } from '../../policy.js';
import { requireSameAuthority } from '../topology.js';
import { DESKTOP_COORDINATOR_POLICY } from '../coordinator/policy.js';
import type { DesktopHostAuthorityObservation } from './host.js';
import type { DesktopVmObservation } from './vm.js';
import { readDesktopEngineNetworks } from './engine.js';
import type { DesktopEngineNetworkCensus } from './engine.js';

export interface DesktopCompleteObservation {
  readonly host: DesktopHostAuthorityObservation;
  readonly engine: DesktopEngineNetworkCensus;
  readonly vmBefore: DesktopVmObservation;
  readonly vmAfter: DesktopVmObservation;
  readonly census: DesktopRouteCensus;
}

export async function captureDesktopCompleteObservation(options: Readonly<{
  api: DockerApi;
  binding: DockerDesktopRouteAuthorityBinding;
  observer: DesktopVmObserverClient;
  expectedHost: DesktopHostAuthorityObservation;
  assertEndpoint(signal: AbortSignal): Promise<void>;
}>, signal: AbortSignal): Promise<DesktopCompleteObservation> {
  const { api, binding, observer, expectedHost, assertEndpoint } = options;
  const budget = new DockerResponseByteBudget(DESKTOP_COORDINATOR_POLICY.rawBracketBytes);
  signal.throwIfAborted();
  await assertEndpoint(signal);
  const host = await binding.observeHost(signal, budget);
  requireSameAuthority(host.executableIdentity, expectedHost.executableIdentity, 'Desktop host observer executable identity changed.');
  requireSameAuthority(host.fingerprint, expectedHost.fingerprint, 'Desktop host route/interface/proxy authority changed.');
  const vmBefore = await observer.observe(signal, budget);
  const engine = await readDesktopEngineNetworks(api, signal, budget);
  const vmAfter = await observer.observe(signal, budget);
  const afterHost = await binding.observeHost(signal, budget);
  requireSameAuthority(afterHost.executableIdentity, host.executableIdentity, 'Desktop host observer executable changed during observation.');
  requireSameAuthority(afterHost.fingerprint, host.fingerprint, 'Desktop host authority changed during complete observation.');
  await assertEndpoint(signal);
  if (engine.id !== binding.identity.engine.id || engine.kernel !== vmBefore.snapshot.kernel
    || engine.kernel !== vmAfter.snapshot.kernel) {
    throw new SandboxUnsupportedError('Desktop Engine identity or VM kernel differs from the selected authority.');
  }
  if (Buffer.byteLength(JSON.stringify({ host, engine, vmBefore, vmAfter }), 'utf8') > DESKTOP_COORDINATOR_POLICY.observationBytes) {
    throw new SandboxUnsupportedError('Complete Desktop observation exceeds its normalized byte bound.');
  }
  const excludedCidrs = deniedCoverage([...host.excludedCidrs, ...vmAfter.excludedCidrs, ...engine.excludedCidrs,
    binding.identity.deployment.dockerSubnet, '::/0']);
  const census = Object.freeze({ hostname: engine.hostname, kernel: engine.kernel, excludedCidrs, host, engine, vm: vmAfter });
  return Object.freeze({ host, engine, vmBefore, vmAfter, census });
}
