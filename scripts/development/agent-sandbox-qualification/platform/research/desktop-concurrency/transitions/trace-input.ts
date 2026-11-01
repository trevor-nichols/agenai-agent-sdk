import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod/v4';
import { parseSandboxRecoveryRecord } from '../../../../../../../packages/ai/sandbox/dist/index.js';
import { DockerApi } from '../../../../../../../packages/ai/sandbox-docker/src/resources/api.js';
import { DockerEngine } from '../../../../../../../packages/ai/sandbox-docker/src/engine/client.js';
import type { DockerEngineResponse } from '../../../../../../../packages/ai/sandbox-docker/src/engine/contracts.js';
import { readDesktopEngineNetworks } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/engine.js';
import { parseDesktopVmObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/vm.js';
import { parseDesktopVmObserverFrame } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/protocol.js';
import { parseDesktopHostObservation } from '../../../../../../../packages/ai/sandbox-docker/src/network/desktop/observation/host.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const entrySchema = z.object({ kind: z.enum(['engine', 'observer']), path: z.string(), observedAt: z.iso.datetime(),
  bytes: z.int().min(0).max(4 * 1024 ** 2), sha256: digest, phase: z.string(), traceId: z.int().min(0),
  method: z.string().optional(), target: z.string().optional(), status: z.int().optional(),
  containerId: z.string().optional(), frameKind: z.string().optional(), sequence: z.int().optional(), namespace: z.string().optional() });
const checkpointSchema = z.object({ path: z.string(), sha256: digest, phase: z.string(), at: z.iso.datetime() });
const record = z.unknown().transform(parseSandboxRecoveryRecord);
const reportSchema = z.object({ format: z.literal('agenai.desktop-concurrency-reproduction.v1'), status: z.string(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), engine: z.object({ id: z.string(), kernel: z.string(), version: z.string() }),
  packages: z.array(z.object({ name: z.string(), version: z.string(), subpath: z.string(), entrySha256: digest })),
  hostObservations: z.array(z.object({ phase: z.string(), path: z.string(), bytes: z.int().max(4 * 1024 ** 2), sha256: digest })).max(256).default([]),
  cleanupFailures: z.array(z.unknown()), owners: z.array(z.object({ label: z.string(), namespace: z.string(), start: z.string(),
    failure: z.unknown().optional(), afterStartRecord: record, afterStartState: z.unknown(), finalRecord: record, finalState: z.unknown(),
    checkpoints: z.array(checkpointSchema).max(256), finalCensus: z.array(z.object({ role: z.string(), status: z.int(),
      identity: z.object({ kind: z.string() }) })).max(9) })).min(1).max(4) });
const indexSchema = z.object({ format: z.literal('agenai.desktop-concurrency-research-capture.v1'),
  entries: z.array(entrySchema).max(4096), failures: z.array(z.unknown()).max(32), bytes: z.int().max(128 * 1024 ** 2), completeness: z.literal('complete') });
const traceSchema = z.object({ id: z.int(), method: z.string(), target: z.string(), status: z.int().nullable(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), failure: z.unknown().nullable() });

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type Entry = z.infer<typeof entrySchema>;
export type RawEntry = Readonly<{ entry: Entry; raw: Buffer; value: unknown }>;

export async function readTrace(directory: string) {
  const root = await realpath(directory);
  const checkedRead = async (path: string, maximum = 4 * 1024 ** 2) => {
    const actual = await realpath(path); const local = relative(root, actual);
    if (local.startsWith('..') || local.startsWith('/')) throw new Error('Trace reference escapes the original evidence directory.');
    const raw = await readFile(actual);
    if (raw.length > maximum) throw new Error('Trace input exceeds its byte bound.');
    return raw;
  };
  const reportRaw = await checkedRead(resolve(root, 'report.json'));
  const indexRaw = await checkedRead(resolve(root, 'capture/index.json'));
  const traceRaw = await checkedRead(resolve(root, 'engine-trace.jsonl'));
  const report = reportSchema.parse(JSON.parse(reportRaw.toString()));
  const index = indexSchema.parse(JSON.parse(indexRaw.toString()));
  if (index.failures.length) throw new Error('Capture reports incomplete observations.');
  const entries: RawEntry[] = [];
  for (const entry of index.entries) {
    const raw = await checkedRead(entry.path);
    if (sha256(raw) !== entry.sha256 || raw.length !== entry.bytes) throw new Error(`Capture integrity mismatch: ${entry.path}`);
    entries.push({ entry, raw, value: JSON.parse(raw.toString()) });
  }
  if (entries.reduce((total, entry) => total + entry.raw.length, 0) !== index.bytes) throw new Error('Capture total byte count differs.');
  const checkpoints = [];
  for (const owner of report.owners) {
    for (const entry of owner.checkpoints) {
      const raw = await checkedRead(entry.path);
      if (sha256(raw) !== entry.sha256) throw new Error(`Checkpoint integrity mismatch: ${entry.path}`);
      const checkpoint = parseSandboxRecoveryRecord(JSON.parse(raw.toString()));
      if (checkpoint.namespace !== owner.namespace || checkpoint.phase !== entry.phase) throw new Error('Checkpoint owner/phase correlation differs.');
      checkpoints.push({ label: owner.label, entry, record: checkpoint });
    }
  }
  const trace = traceRaw.toString().trim().split('\n').map((line) => traceSchema.parse(JSON.parse(line))).sort((a, b) => a.id - b.id);
  const vm = entries.filter(({ entry }) => entry.kind === 'observer' && entry.frameKind === 'observation').map((item) => {
    const frame = parseDesktopVmObserverFrame(item.value);
    if (frame.kind !== 'observation' || frame.sequence !== item.entry.sequence) throw new Error('Observer index and decoded frame disagree.');
    return { ...item, observation: parseDesktopVmObservation(frame.document) };
  });
  const host = [];
  for (const entry of report.hostObservations) {
    const raw = await checkedRead(entry.path);
    if (sha256(raw) !== entry.sha256 || raw.length !== entry.bytes) throw new Error('Original Host document integrity differs.');
    host.push({ entry, observation: parseDesktopHostObservation(JSON.parse(raw.toString())) });
  }
  return { root, report, entries, checkpoints, trace, vm, host, hashes: { report: sha256(reportRaw), index: sha256(indexRaw), trace: sha256(traceRaw) } };
}

// Production JSON/schema/census decoding with no transport access. Older captures lack /info;
// only those use explicit report id/kernel metadata and an unknown Name marker.
class CapturedApi extends DockerApi {
  private listReads = 0;
  constructor(private readonly open: RawEntry, private readonly close: RawEntry,
    private readonly inspections: readonly RawEntry[], private readonly identity: Readonly<{ id: string; kernel: string }>,
    private readonly capturedInfo?: RawEntry) {
    super(new DockerEngine('/unentered-read-only-capture'), 30_000);
  }
  override async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string): Promise<DockerEngineResponse> {
    if (method !== 'GET') throw new Error('Trace decoder forbids mutation.');
    if (path === '/info' && this.capturedInfo) return { statusCode: 200, body: this.capturedInfo.raw };
    if (path === '/info') return { statusCode: 200,
      body: Buffer.from(JSON.stringify({ ID: this.identity.id, Name: 'not-retained-in-capture', KernelVersion: this.identity.kernel })) };
    const item = path === '/v1.52/networks' ? this.listReads++ === 0 ? this.open : this.close
      : this.inspections.find(({ entry }) => entry.target === path);
    if (!item || item.entry.status !== 200) throw new Error(`Missing successful captured Engine response: ${path}`);
    return { statusCode: 200, body: item.raw };
  }
}

export async function decodeCensuses(input: Awaited<ReturnType<typeof readTrace>>) {
  const listEntries = input.entries.filter(({ entry }) => entry.kind === 'engine' && entry.target === '/v1.52/networks');
  if (listEntries.length % 2 !== 0) throw new Error('Unpaired captured Engine network list.');
  const result = [];
  for (let index = 0; index < listEntries.length; index += 2) {
    const open = listEntries[index]; const close = listEntries[index + 1];
    const inspections = input.entries.filter(({ entry }) => entry.kind === 'engine' && entry.traceId > open.entry.traceId
      && entry.traceId < close.entry.traceId && /^\/v1\.52\/networks\/[a-f0-9]{64}$/u.test(entry.target ?? ''));
    const info = input.entries.findLast(({ entry }) => entry.kind === 'engine' && entry.target === '/info'
      && entry.status === 200 && entry.traceId < open.entry.traceId);
    const census = await readDesktopEngineNetworks(new CapturedApi(open, close, inspections, input.report.engine, info));
    const before = input.vm.findLast(({ entry }) => entry.observedAt < open.entry.observedAt);
    const after = before && input.vm.find(({ entry }) => entry.observedAt > close.entry.observedAt && entry.containerId === before.entry.containerId);
    if (!before || !after) throw new Error('Complete Engine census lacks its correlated observer bracket.');
    result.push({ open, close, inspections, before, after, census, info });
  }
  return result;
}

/** Revalidate a retained normalized Engine snapshot through the existing source census decoder. */
export async function decodeRecordedCensus(input: unknown) {
  const value = z.object({ id: z.string(), hostname: z.string(), kernel: z.string(),
    networks: z.array(z.object({ Id: z.string() }).passthrough()).min(1).max(128) }).parse(input);
  class NormalizedApi extends DockerApi {
    constructor() { super(new DockerEngine('/unentered-normalized-capture'), 30_000); }
    override async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string): Promise<DockerEngineResponse> {
      if (method !== 'GET') throw new Error('Recorded census decoder forbids mutation.');
      const body = path === '/info' ? { ID: value.id, Name: value.hostname, KernelVersion: value.kernel }
        : path === '/v1.52/networks' ? value.networks.map(({ Id }) => ({ Id }))
        : value.networks.find(({ Id }) => path === `/v1.52/networks/${Id}`);
      if (!body) throw new Error('Normalized census lacks the requested original network.');
      return { statusCode: 200, body: Buffer.from(JSON.stringify(body)) };
    }
  }
  return readDesktopEngineNetworks(new NormalizedApi());
}
