import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { parseDesktopVmObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import { parseDesktopHostObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/host.js';
import { identifyDesktopOwnedBridge, validateDesktopOwnedVm } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/topology.js';
import { nativeAddressNumber, prefixMask, formatNumericAddress } from '../../../../../../../packages/ai/sandbox-docker/src/network/address.js';
import { PRIVATE_POOL, overlaps } from './allocation.js';
import { decodeRecordedCensus, sha256 } from './trace-input.js';
import { captureDesktopRetainedTransition, validateDesktopRetainedTransition } from './retained.js';
import type { DesktopRetainedTransition } from './retained.js';

const reference = z.object({ path: z.string(), bytes: z.int().max(4 * 1024 ** 2), sha256: z.string() });
const networkResource = z.object({ kind: z.literal('network'), name: z.string(), id: z.string(), bridgeName: z.string(),
  labels: z.record(z.string(), z.string()), subnet: z.string(), gateway: z.string() });
const reportSchema = z.object({ status: z.string(), failure: z.unknown().optional(), resources: z.array(z.unknown()).max(16),
  snapshots: z.array(z.object({ phase: z.string(), raw: reference, parsed: reference })).max(96),
  finalObservationFailure: z.unknown().optional(), finalExactAbsence: reference.optional() });
const failure = (operation: () => unknown) => { try { operation(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } };

export async function analyzeIpam(directory: string) {
  const root = await realpath(directory);
  const read = async (path: string) => {
    const actual = await realpath(path); const local = relative(root, actual);
    if (local.startsWith('..') || local.startsWith('/')) throw new Error('IPAM reference escapes its original evidence root.');
    const raw = await readFile(actual); if (raw.length > 4 * 1024 ** 2) throw new Error('IPAM capture exceeds its finite byte bound.');
    return raw;
  };
  const reportRaw = await read(resolve(root, 'report.json')); const report = reportSchema.parse(JSON.parse(reportRaw.toString()));
  const networks = report.resources.flatMap((value) => { const parsed = networkResource.safeParse(value); return parsed.success ? [parsed.data] : []; });
  const snapshots: Array<{ entry: z.infer<typeof reportSchema>['snapshots'][number];
    vm: ReturnType<typeof parseDesktopVmObservation>; engine: Awaited<ReturnType<typeof decodeRecordedCensus>>;
    host: ReturnType<typeof parseDesktopHostObservation> }> = [];
  for (const entry of report.snapshots) {
    const raw = await read(entry.raw.path); const parsedRaw = await read(entry.parsed.path);
    if (sha256(raw) !== entry.raw.sha256 || raw.length !== entry.raw.bytes
      || sha256(parsedRaw) !== entry.parsed.sha256 || parsedRaw.length !== entry.parsed.bytes) throw new Error('Original IPAM snapshot integrity differs.');
    const document = z.object({ phase: z.string(), host: z.object({ snapshot: z.unknown() }), engine: z.unknown() }).parse(JSON.parse(parsedRaw.toString()));
    const vm = parseDesktopVmObservation(JSON.parse(raw.toString()));
    const engine = await decodeRecordedCensus(document.engine);
    const host = parseDesktopHostObservation(document.host.snapshot);
    snapshots.push({ entry, vm, engine, host });
  }
  const owned = networks.map((network) => {
    const original = snapshots.find(({ engine }) => engine.networks.some((entry) => entry.Id === network.id && Object.keys(entry.Containers).length === 0));
    if (!original) throw new Error('Original IPAM bridge has no captured empty snapshot.');
    return { resource: network, owned: identifyDesktopOwnedBridge({ networkId: network.id, name: network.name,
      bridgeName: network.bridgeName, labels: network.labels }, original.engine, original.vm) };
  });
  const retainedTransitions = new Map<string, DesktopRetainedTransition>();
  const analysis = snapshots.map(({ entry, vm, engine }) => ({ phase: entry.phase,
    raw: { file: basename(entry.raw.path), sha256: entry.raw.sha256 }, parsed: { file: basename(entry.parsed.path), sha256: entry.parsed.sha256 },
    members: owned.filter((member) => engine.networks.some((network) => network.Id === member.resource.id)).map((member) => {
      const network = engine.networks.find((candidate) => candidate.Id === member.resource.id);
      const endpoint = network !== undefined && Object.keys(network.Containers).length > 0;
      const error = failure(() => validateDesktopOwnedVm(vm, member.owned, endpoint));
      if (endpoint) {
        try { retainedTransitions.set(member.resource.id, captureDesktopRetainedTransition(member.owned, vm)); }
        catch { /* Tentative endpoint graphs cannot grant later retained transition authority. */ }
      }
      const context = retainedTransitions.get(member.resource.id);
      let researchRetained: Readonly<{ kind: string; fingerprint: string }> | null = null;
      const researchRetainedError = !endpoint && context ? failure(() => {
        const result = validateDesktopRetainedTransition(context, vm);
        researchRetained = { kind: result.kind, fingerprint: result.fingerprint };
      }) : null;
      // Isolating a route changes only the validator's route input; original raw bytes stay untouched.
      const rejectedRoutes = error ? vm.snapshot.routes.filter((route) => failure(() => validateDesktopOwnedVm({ ...vm,
        snapshot: { ...vm.snapshot, routes: [route] } }, member.owned, endpoint)) !== null) : [];
      const device = vm.snapshot.interfaces.find((candidate) => candidate.index === member.owned.device.index);
      return { role: member.resource.labels.role, networkId: member.resource.id, subnet: member.resource.subnet,
        index: member.owned.device.index, name: member.resource.bridgeName, endpoint, error, rejectedRoutes,
        researchRetained, researchRetainedError,
        device: device ? { flags: device.flags, operationalState: device.operationalState, carrier: device.carrier,
          tsoMaxSize: device.tsoMaxSize, addresses: device.addresses.map(({ attributes: _attributes, ...address }) => address) } : null };
    }) }));
  const hostRanges = new Set<string>();
  for (const { host } of snapshots) {
    for (const cidr of host.excludedCidrs) if (!cidr.includes(':')) {
      const [address, bits] = cidr.split('/');
      hostRanges.add(`${formatNumericAddress(nativeAddressNumber(address, 4) & prefixMask(4, Number(bits)), 4)}/${bits}`);
    }
  }
  const conflicts = PRIVATE_POOL.flatMap((candidate) => [...hostRanges].filter((occupied) => overlaps(candidate, occupied)).map((occupied) => ({ candidate, occupied })));
  const finalAbsence = report.finalExactAbsence ? await read(report.finalExactAbsence.path) : null;
  if (finalAbsence && report.finalExactAbsence && sha256(finalAbsence) !== report.finalExactAbsence.sha256) throw new Error('Final exact-absence evidence hash differs.');
  return { format: 'agenai.desktop-concurrency-ipam-analysis.v1', input: root, reportSha256: sha256(reportRaw), status: report.status,
    failure: report.failure, snapshotsVerified: snapshots.length,
    scope: 'Original raw VM documents decoded and original normalized Engine/host snapshots revalidated by current source. No native observations or raw inputs modified. A failed native attempt remains failed.',
    snapshots: analysis, pool: { candidate: '10.240.0.0/24', supplementalHostRanges: [...hostRanges].sort(), conflicts,
      hostNonoverlapAtTheseSamples: conflicts.length === 0,
      temporalScope: 'This separate IPAM attempt, not a missing host observation from frozen reproduction r3.' },
    finalExactAbsence: finalAbsence ? { reference: report.finalExactAbsence,
      observations: z.array(z.object({ kind: z.string(), name: z.string(), reference: z.string(), status: z.int() })).parse(JSON.parse(finalAbsence.toString())) } : null,
    finalObservationFailure: report.finalObservationFailure };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output || process.argv.length !== 4 || dirname(resolve(output)) !== dirname(fileURLToPath(import.meta.url))) {
    throw new Error('Usage: pnpm exec tsx analyze-ipam.ts <original-ipam-directory> <new-analysis-in-transitions.json>');
  }
  const result = await analyzeIpam(directory); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, status: result.status, snapshots: result.snapshotsVerified,
    rejected: result.snapshots.flatMap((snapshot) => snapshot.members.filter((member) => member.error).map((member) => ({ phase: snapshot.phase,
      member: member.role, routes: member.rejectedRoutes }))), hostConflicts: result.pool.conflicts })}\n`);
}
