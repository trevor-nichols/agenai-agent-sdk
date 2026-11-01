import assert from 'node:assert/strict';
import { concurrencyCase, concurrencyEffects, requiredConcurrencyPhases } from './cases.mjs';

export function concurrencyScenarioBudget(manifest) {
  const selected = concurrencyCase(manifest.concurrency.caseId);
  const roles = [
    { role: 'independent_daemon_observer', count: 1, cpus: 1, memoryBytes: 256 * 1024 ** 2, pids: 32 },
    { role: 'compute', count: 2, ...manifest.workload.resources },
    { role: 'filesystem', count: 2, ...manifest.filesystem.configuration.resources },
    { role: 'egress_broker', count: 2, ...manifest.network.egress.configuration.broker.resources },
    { role: 'egress_relay', count: 2, ...manifest.network.egress.configuration.relay.resources },
    { role: 'route_observer', count: 2, ...manifest.network.routeAuthority.vmObserver.resources },
    { role: 'marker_fixture', count: selected.kind === 'foreign_endpoint' ? 3 : 2, cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 32 },
  ];
  const nanoCpus = roles.reduce((sum, role) => sum + role.count * role.cpus * 1_000_000_000, 0);
  const memoryBytes = roles.reduce((sum, role) => sum + role.count * role.memoryBytes, 0);
  const pids = roles.reduce((sum, role) => sum + role.count * role.pids, 0);
  assert(nanoCpus <= 4_000_000_000 && memoryBytes <= 4 * 1024 ** 3,
    'Two concurrent members, every helper, the independent observer and markers must fit four CPUs/four GiB.');
  const containersPerMember = 6; // compute + export + filesystem + broker + relay + native observer
  // A rejected terminal B checkpoint cannot undo completed cleanup, so that case also reaches the replacement member.
  const reachesReplacement = selected.kind === 'workflow' || selected.kind === 'persistence' && selected.boundary === 'destroyed';
  const maximumOriginalMembers = reachesReplacement ? 3 : 2;
  const bootstrapContainers = 5; // noncoordinated bootstrap omits filesystem; it is destroyed before baseline
  const markerContainers = selected.kind === 'foreign_endpoint' ? 3 : 2;
  const proxyActors = Object.freeze([
    { role: 'helper_control_stream', count: 2 * 4, lifetime: 'retained' },
    { role: 'primary_exec_stream', count: 2, lifetime: 'retained' },
    { role: 'marker_control_stream', count: markerContainers, lifetime: 'retained' },
    { role: 'primary_exec_status_poll', count: 2, lifetime: 'transient' },
    { role: 'member_infrastructure_health', count: 2, lifetime: 'transient' },
    { role: 'shared_coordinator_route_census', count: 1, lifetime: 'transient' },
    { role: 'workflow_effect_and_peer_continuity', count: 2, lifetime: 'transient' },
    { role: 'qualification_fixture_execution_and_inspection', count: 2, lifetime: 'transient' },
    { role: 'nested_before_topology_policy_inspection', count: 1, lifetime: 'transient' },
  ].map(Object.freeze));
  const retainedProxyStreams = proxyActors.filter(({ lifetime }) => lifetime === 'retained').reduce((sum, { count }) => sum + count, 0);
  const transientProxyLanes = proxyActors.filter(({ lifetime }) => lifetime === 'transient').reduce((sum, { count }) => sum + count, 0);
  // Full evidence ownership remains active after HTTP completion. The queue applies
  // backpressure when retirement lags; retirement is not bounded to one request per lane.
  const proxyCapacity = retainedProxyStreams + 2 * transientProxyLanes;
  const proxy = Object.freeze({ maxConnections: proxyCapacity, maxActiveRequests: proxyCapacity, maxPendingRequests: transientProxyLanes,
    maxRequestLifecycles: proxyCapacity + transientProxyLanes, actors: proxyActors,
    retainedStreams: retainedProxyStreams, transientLanes: transientProxyLanes, retirementSlots: transientProxyLanes,
    policy: 'Active requests retain all original evidence obligations. A bounded FIFO holds one blocked request per admitted transient producer; queued cancellation retains its slot through evidence retirement. No upstream dispatch occurs until full active ownership settles. Exhaustion is recorded without retry.' });
  const maximumScopes = maximumOriginalMembers * containersPerMember + bootstrapContainers + markerContainers;
  // The public schedule emits 151 joint or 159 staged observations, plus at most
  // one before/after survivor check for each original live peer during failure cleanup.
  const maximumWorkflowObservations = (selected.startMode === 'prepare_both' ? 151 : 159) + 2 * 2;
  const maximumPhases = maximumWorkflowObservations + requiredConcurrencyPhases(selected).length + 4;
  const maximumMessages = maximumOriginalMembers * 256 + maximumWorkflowObservations + 16;
  const maximumObserverAttachments = maximumOriginalMembers + 1; // original members plus the retired bootstrap
  const captureLifetimeMs = manifest.limits.scenarioMs + 4 * manifest.limits.cleanupMs + 180_000;
  const routePollMs = manifest.network.routeAuthority.pollIntervalMs;
  const routePolls = Math.ceil(captureLifetimeMs / routePollMs);
  const bootstrapPolls = Math.ceil((manifest.limits.startupMs + manifest.limits.cleanupMs) / routePollMs);
  const processPolls = Math.ceil(captureLifetimeMs / 100); // DockerProcessOwner.monitor
  const maximumEngineNetworks = manifest.concurrency.evidence.maxEngineNetworks;
  const networkTopology = Object.freeze({ maximumNetworks: maximumEngineNetworks, publicFixtureNetworks: 1,
    concurrentMemberNetworks: 2, foreignNetworks: selected.kind === 'foreign_network' ? 1 : 0 });
  // Complete capture: /info, two network lists, every exact network inspection, and
  // two daemon-authority checks (version + info) around the host/VM bracket.
  const engineGetsPerCensus = maximumEngineNetworks + 7;
  const topologyEffects = maximumOriginalMembers * concurrencyEffects.filter(({ action }) => action !== 'member_retire').length;
  // Broker create/start/close/delete, bridge delete and final observer close can each
  // enter a thirty-second settlement loop; every effect also has before/after capture.
  const settlingRecipesPerMember = 6;
  const settlingPolls = Math.ceil(30_000 / routePollMs) + 1;
  const topologyCaptures = 2 * topologyEffects + maximumOriginalMembers * settlingRecipesPerMember * settlingPolls
    + 2 * maximumObserverAttachments; // two-read activation/recovery baselines
  const engineProducers = Object.freeze([
    { role: 'primary_exec_status', calls: 2 * processPolls, getsPerCall: 1 },
    { role: 'member_infrastructure_health', calls: 2 * routePolls, getsPerCall: 11 },
    { role: 'shared_coordinator_maintenance', calls: routePolls, getsPerCall: engineGetsPerCensus },
    { role: 'bootstrap_health_and_route', calls: bootstrapPolls, getsPerCall: engineGetsPerCensus + 11 },
    { role: 'topology_before_after_and_settlement', calls: topologyCaptures, getsPerCall: engineGetsPerCensus },
    { role: 'effect_authority_and_resource_inspection', calls: topologyEffects, getsPerCall: 6 },
    { role: 'foreground_phase_file_and_fixture_inspection', calls: maximumPhases, getsPerCall: 8 },
    { role: 'final_resource_absence', calls: maximumScopes, getsPerCall: 2 },
    { role: 'image_and_fixture_preflight', calls: maximumObserverAttachments, getsPerCall: 16 },
  ].map(Object.freeze));
  const maximumEngineResponses = engineProducers.reduce((sum, { calls, getsPerCall }) => sum + calls * getsPerCall, 0);
  const maximumEngineTerminals = maximumEngineResponses; // one local terminal for every entered GET, including no-response cancellation
  const nativeObservations = 2 * (routePolls + bootstrapPolls + topologyCaptures);
  const nativeHeartbeats = 2 * Math.ceil(captureLifetimeMs / manifest.network.routeAuthority.vmObserver.control.heartbeatMs);
  const maximumVmFrames = nativeObservations + nativeHeartbeats + 2 * maximumObserverAttachments; // ready + closed
  const maximumVmControlFrames = nativeObservations + nativeHeartbeats + maximumObserverAttachments; // stop
  const maximumObservations = maximumEngineResponses + maximumEngineTerminals + maximumVmFrames + maximumVmControlFrames;
  const maximumObservationMetadataBytes = 16 * 1024; // bounded failure plus exact identity/hash/path/phase envelope
  const maximumObservationIndexBytes = maximumObservations * maximumObservationMetadataBytes;
  const maximumPhaseIndexBytes = 2 * maximumPhases * 65_536 + 1024 ** 2; // nested JSON indentation of bounded phase files
  const maximumReportBytes = maximumPhaseIndexBytes + maximumScopes * 65_536 + 16 * 1024 ** 2;
  // Response wire gets a payload-sized framing allowance, counted independently;
  // pathological fragmentation beyond that finite admission fails capture.
  const maximumNativeWireBytes = 2 * maximumVmFrames * manifest.concurrency.evidence.maxResponseBytes + maximumVmControlFrames * 4096;
  const maximumEngineRequests = maximumEngineResponses + topologyEffects + 4 * maximumPhases + maximumOriginalMembers * 32;
  const maximumEvidenceFiles = maximumObservations + maximumPhases + (maximumOriginalMembers + 1) * 256 + 128 + 64;
  const minimumEvidenceBytes = (maximumEngineResponses + maximumVmFrames) * manifest.concurrency.evidence.maxResponseBytes
    + maximumEngineTerminals * 2048
    + maximumVmControlFrames * 4096 + maximumNativeWireBytes
    + maximumObservationIndexBytes + maximumPhaseIndexBytes + 2 * maximumReportBytes + maximumEngineRequests * 2048
    + maximumPhases * 65_536 + (maximumOriginalMembers + 1) * 256 * 65_536
    + maximumOriginalMembers * manifest.limits.maxOutputBytes + 128 * 1024 ** 2 + 16 * 1024 ** 2;
  assert(Number.isSafeInteger(minimumEvidenceBytes));
  assert(manifest.concurrency.evidence.maxAttemptBytes >= minimumEvidenceBytes,
    'Evidence budget must retain the calculated full observer lifetime and every required phase.');
  return Object.freeze({ nanoCpus, memoryBytes, pids, roles: Object.freeze(roles.map(Object.freeze)),
    maximumConcurrentMembers: 2, maximumOriginalMembers, containersPerMember, bootstrapContainers, markerContainers,
    maximumScopes, observerCapacity: 128, proxy,
    maximumPhases, maximumWorkflowObservations, maximumMessages, maximumEngineResponses, maximumEngineTerminals, maximumVmFrames, maximumVmControlFrames,
    maximumObservations, maximumEvidenceFiles, minimumEvidenceBytes, maximumObserverAttachments,
    maximumObservationMetadataBytes, maximumObservationIndexBytes, maximumPhaseIndexBytes, maximumReportBytes, maximumNativeWireBytes,
    captureLifetimeMs, networkTopology, engineProducers,
    observationPolicy: 'The launcher lifetime includes preparation, worker execution and four cleanup allowances. Every Engine GET, VM reply and VM control has its own slot. Retained cleanup beyond the admitted count fails capture without truncation or retry.',
    computeExportPolicy: 'Stopped export substitutes one export container for its already-joined compute container; the two containers never run simultaneously for one owner.',
    requiredPhases: requiredConcurrencyPhases(selected),
    hostProcesses: Object.freeze(['qualification_controller', 'native_coordinator_holder', 'native_host_observer']),
    hostResourcePolicy: 'Host processes are bounded by captured machine floors, command deadlines and evidence limits; container CPU/memory caps do not cap host processes.' });
}

export function admitConcurrencyTopology(budget, inventory) {
  assert(Array.isArray(inventory.networks) && inventory.networks.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id))
    && new Set(inventory.networks).size === inventory.networks.length, 'Complete distinct Engine network identities are required before effects.');
  const topology = budget.networkTopology;
  const requiredNetworks = inventory.networks.length + topology.publicFixtureNetworks + topology.concurrentMemberNetworks + topology.foreignNetworks;
  assert(requiredNetworks <= topology.maximumNetworks, 'Captured baseline plus required concurrent topology exceeds maxEngineNetworks.');
  return Object.freeze({ baselineNetworks: Object.freeze([...inventory.networks]), requiredNetworks, maximumNetworks: topology.maximumNetworks });
}
