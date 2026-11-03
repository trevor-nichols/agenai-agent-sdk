import { z } from 'zod/v4';
import { immutable } from '../../../network/desktop/coordinator/administrativeRecovery/scalars.js';
import { restorationEvidenceSchema, restorationEventsDigest, restorationSpansDigest } from '../../../network/desktop/coordinator/administrativeRecovery/restoration.js';
import type { RestorationDiagnostic, RestorationEvent, RestorationEvidence, RestorationSpan, RestorationWarning } from '../../../network/desktop/coordinator/administrativeRecovery/restoration.js';
import { digestBytes } from '../native/framing.js';
import { RECOVERY_NATIVE_LIMITS } from '../native/schemas.js';
import type { NativeFact, RecoveryNativeLogBytes } from '../native/schemas.js';
import { recoveryStoreIdentityDigest, RecoveryRestorationError } from './engine.js';
import type { RecoveryEngineObservation } from './engine.js';

const lineSchema = z.object({ component: z.string().min(1).max(64).optional(),
  level: z.string().min(1).max(16), msg: z.string().max(65_536),
  container: z.string().regex(/^[a-f0-9]{64}$/u).optional(), error: z.string().max(65_536).optional(),
  version: z.string().max(64).optional(), revision: z.string().max(64).optional(),
  id: z.string().max(128).optional(), type: z.string().max(128).optional() });
const bootMarkerSchema = z.object({ component: z.literal('kmsg'), msg: z.string().startsWith('Linux version ') });
type LogEntry = z.infer<typeof lineSchema>;
type SpanRange = Readonly<{ spanStart: number; spanEnd: number }>;
interface Stream {
  sourceIdentity: string;
  end: bigint;
  pending: Buffer;
  pendingSpan: number;
}
const required = ['linux_boot', 'vm_identity', 'containerd_ready', 'dockerd_process', 'dockerd_start',
  'load_start', 'restore_start', 'load_complete', 'initialization_complete', 'api_listen'] as const;
const harmlessDockerdInfo = new Set([
  'waiting for containerd to be ready', 'resolving host.docker.internal. DNS', 'detected cgroup2 on /sys/fs/cgroup',
  'OTEL tracing is not configured, using no-op tracer provider',
  'CDI directory does not exist, skipping: failed to monitor for changes: no such file or directory',
  'Creating a containerd client', 'Starting daemon with containerd snapshotter integration enabled',
  'Docker daemon', 'Initializing buildkit', 'Completed buildkit initialization',
  'starting /bin/sh -c export LISTEN_PID="$$"; exec /usr/local/bin/dockerd --config-file /run/config/docker/daemon.json --containerd /run/containerd/containerd.sock --pidfile /run/desktop/docker.pid --swarm-default-advertise-addr=192.168.65.3 --allow-direct-routing --log-format json --host-gateway-ip 192.168.65.254',
]);
const optionalPlugins = new Map<string, Readonly<{ type: string; error: string; kind: RestorationDiagnostic['kind'] }>>([
  ['io.containerd.snapshotter.v1.blockfile', { type: 'io.containerd.snapshotter.v1', error: 'no scratch file generator: skip plugin', kind: 'containerd_blockfile_unconfigured' }],
  ['io.containerd.differ.v1.erofs', { type: 'io.containerd.differ.v1', error: 'failed to check mkfs.erofs availability: failed to run mkfs.erofs --help: exec: "mkfs.erofs": executable file not found in $PATH: skip plugin', kind: 'containerd_erofs_differ_unavailable' }],
  ['io.containerd.internal.v1.tracing', { type: 'io.containerd.internal.v1', error: 'skip plugin: tracing endpoint not configured', kind: 'containerd_tracing_unconfigured' }],
]);

/** Classifies only native-covered bytes from the current armed attempt. */
export class RestorationClassifier {
  private readonly streams = new Map<'init' | 'console', Stream>();
  private readonly cursors = new Map<string, Readonly<{ source: 'init' | 'console'; end: bigint }>>();
  private readonly spans: RestorationSpan[] = [];
  private readonly events: RestorationEvent[] = [];
  private readonly warnings: RestorationWarning[] = [];
  private readonly diagnostics: RestorationDiagnostic[] = [];
  private bytes = 0;
  private sequence = 0;
  private stage = 0;
  private containerdStarted = false;
  private sealed = false;
  private failure: RecoveryRestorationError | undefined;

  constructor(private readonly previousVmId?: string) {}

  get complete(): boolean { return this.stage === required.length && this.containerdStarted && this.failure === undefined; }

  consume(chunk: Readonly<RecoveryNativeLogBytes & { bytes: Uint8Array }>): void {
    if (this.failure) throw this.failure;
    if (this.sealed) throw new RecoveryRestorationError('restoration', 'Restoration source interval has already closed.');
    try { this.consumeActual(chunk); }
    catch (cause) {
      this.failure = cause instanceof RecoveryRestorationError ? cause
        : new RecoveryRestorationError('restoration', 'Native log bytes violate the strict restoration parser.', { cause });
      throw this.failure;
    }
  }

  private consumeActual(chunk: Readonly<RecoveryNativeLogBytes & { bytes: Uint8Array }>): void {
    if (chunk.phase !== 'observed') this.refuse('fresh_boot', 'Baseline log bytes cannot establish a fresh armed boot.');
    if (chunk.bytes.length === 0) return;
    if (chunk.bytes.length > RECOVERY_NATIVE_LIMITS.chunkBytes || digestBytes(chunk.bytes) !== chunk.sha256
      || BigInt(chunk.end) - BigInt(chunk.start) !== BigInt(chunk.bytes.length) || chunk.sequence <= this.sequence) {
      this.refuse('restoration', 'Native log span has an invalid digest, extent or ordering.');
    }
    this.bytes += chunk.bytes.length;
    if (this.bytes > RECOVERY_NATIVE_LIMITS.logBytes || this.spans.length >= RECOVERY_NATIVE_LIMITS.chunks) {
      this.refuse('capacity', 'Restoration source interval exceeds its fixed byte or span capacity.');
    }
    this.sequence = chunk.sequence;
    const index = this.spans.length;
    this.spans.push({ source: chunk.source, sourceIdentity: chunk.sourceIdentity,
      start: chunk.start, end: chunk.end, sequence: chunk.sequence, sha256: `sha256:${chunk.sha256}` });
    const cursor = this.cursors.get(chunk.sourceIdentity);
    if (cursor !== undefined && (cursor.source !== chunk.source || cursor.end !== BigInt(chunk.start))) {
      this.refuse('restoration', 'Native log source coverage has a gap, replay or source-family substitution.');
    }
    if (cursor === undefined && this.cursors.size >= 64) this.refuse('capacity', 'Restoration source identities exceed their fixed capacity.');
    this.cursors.set(chunk.sourceIdentity, { source: chunk.source, end: BigInt(chunk.end) });
    if (chunk.source === 'console') return;
    let stream = this.streams.get(chunk.source);
    if (stream === undefined) {
      stream = { sourceIdentity: chunk.sourceIdentity, end: BigInt(chunk.start), pending: Buffer.alloc(0), pendingSpan: index };
      this.streams.set(chunk.source, stream);
    } else if (stream.sourceIdentity !== chunk.sourceIdentity) {
      if (stream.pending.length !== 0) this.refuse('restoration', 'Rotated log source does not preserve complete line coverage.');
      stream.sourceIdentity = chunk.sourceIdentity; stream.end = BigInt(chunk.start);
    }
    if (stream.end !== BigInt(chunk.start)) this.refuse('restoration', 'Native log source coverage has a gap, replay or truncation.');
    stream.end = BigInt(chunk.end);
    const combined = Buffer.concat([stream.pending, Buffer.from(chunk.bytes)]);
    let offset = 0;
    let first = true;
    for (;;) {
      const end = combined.indexOf(10, offset);
      if (end === -1) break;
      const line = combined.subarray(offset, end);
      if (line.length > RECOVERY_NATIVE_LIMITS.chunkBytes) this.refuse('capacity', 'Restoration log line exceeds 64 KiB.');
      const range = { spanStart: first && stream.pending.length > 0 ? stream.pendingSpan : index, spanEnd: index };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
      this.classifyLine(text, range);
      offset = end + 1; first = false;
    }
    const remaining = combined.subarray(offset);
    if (remaining.length > RECOVERY_NATIVE_LIMITS.chunkBytes) this.refuse('capacity', 'Restoration log line exceeds 64 KiB.');
    if (offset > 0 || stream.pending.length === 0) stream.pendingSpan = index;
    stream.pending = Buffer.from(remaining);
  }

  private classifyLine(text: string, range: SpanRange): void {
    if (text === '' || text === `${'-'.repeat(80)}>8`) return;
    let input: unknown;
    try { input = JSON.parse(text); }
    catch { this.refuse('restoration', 'Native init log entry is not complete JSON.'); }
    if (this.stage === 0 && !bootMarkerSchema.safeParse(input).success) return;
    const entry = lineSchema.parse(input);
    if (entry.component === 'kmsg' && entry.msg.startsWith('Linux version ')) {
      if (!entry.msg.startsWith('Linux version 6.12.54-linuxkit ') || entry.level !== 'info') {
        this.refuse('fresh_boot', 'Fresh Linux boot differs from the qualified kernel.');
      }
      this.event({ kind: 'linux_boot', ...range }); return;
    }
    if (entry.component === 'kmsg' && entry.msg.startsWith('Kernel command line: ')) {
      const match = /(?:^| )com\.docker\.VMID=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?: |$)/u.exec(entry.msg);
      if (match === null || entry.level !== 'info' || match[1] === this.previousVmId) {
        this.refuse('fresh_boot', 'Fresh Linux boot is missing a new qualified VM identity.');
      }
      this.event({ kind: 'vm_identity', vmId: match[1], ...range }); return;
    }
    if (entry.component === 'containerd') {
      const skipped = entry.id === undefined ? undefined : optionalPlugins.get(entry.id);
      if (entry.msg === 'skip loading plugin' && entry.level === 'info' && this.containerdStarted
        && skipped !== undefined && skipped.type === entry.type && skipped.error === entry.error
        && !this.diagnostics.some((diagnostic) => diagnostic.kind === skipped.kind)) {
        this.addDiagnostic({ kind: skipped.kind, ...range }); return;
      }
      if (entry.msg === 'starting containerd') {
        if (this.containerdStarted || entry.level !== 'info' || entry.error !== undefined
          || entry.version !== 'v2.2.0' || entry.revision !== '1c4457e00facac03ce1d75f7b6777a7a851e5c41') {
          this.refuse('restoration', 'Containerd startup differs from the qualified restoration profile.');
        }
        this.containerdStarted = true;
      } else if (entry.msg === 'Configuration migrated from version 2, use `containerd config migrate` to avoid migration'
        && entry.level === 'warning' && entry.error === undefined && this.containerdStarted) {
        this.addWarning({ kind: 'containerd_config_migration', ...range }); return;
      } else if (entry.level !== 'info' || entry.error !== undefined) {
        this.refuse('restoration', 'Unclassified containerd startup diagnostic prevents healthy restoration acceptance.');
      }
    }
    if (entry.component === 'otelcol' && entry.level === 'warning' && entry.msg === 'telemetry not implemented'
      && entry.error === undefined) {
      this.addDiagnostic({ kind: 'telemetry_unimplemented', ...range }); return;
    }
    if (entry.component !== 'dockerd') {
      if (entry.level !== 'info' || entry.error !== undefined) this.refuse('restoration', 'Unclassified startup diagnostic prevents restoration acceptance.');
      return;
    }
    if (this.warning(entry, range)) return;
    if (entry.level !== 'info' || entry.error !== undefined) this.refuse('restoration', 'Unclassified Docker restoration diagnostic.');
    const pid = /^adding process ([1-9][0-9]{0,9}) to \/sys\/fs\/cgroup\/restricted$/u.exec(entry.msg);
    if (pid !== null) { this.event({ kind: 'dockerd_process', pid: Number(pid[1]), ...range }); return; }
    const marker = new Map<string, RestorationEvent['kind']>([
      ['containerd is ready', 'containerd_ready'], ['Starting up', 'dockerd_start'],
      ['Loading containers: start.', 'load_start'], ['Restoring containers: start.', 'restore_start'],
      ['Loading containers: done.', 'load_complete'], ['Daemon has completed initialization', 'initialization_complete'],
    ]).get(entry.msg);
    if (marker !== undefined) {
      if (marker === 'linux_boot' || marker === 'vm_identity' || marker === 'dockerd_process') {
        this.refuse('restoration', 'Invalid restoration classifier marker.');
      }
      this.event({ kind: marker, ...range }); return;
    }
    if (entry.msg === 'API listen on /var/run/docker.raw.sock') {
      this.event({ kind: 'api_listen', ...range }); return;
    }
    if (entry.msg === 'API listen on [::]:2375' && (required[this.stage] === 'api_listen' || this.stage === required.length)) return;
    if (!harmlessDockerdInfo.has(entry.msg)) this.refuse('restoration', 'Unclassified Docker startup message prevents restoration acceptance.');
  }

  private warning(entry: LogEntry, range: SpanRange): boolean {
    if (entry.msg === 'failed to determine if container is already mounted' && entry.level === 'warning'
      && entry.error === undefined && entry.container !== undefined && this.stage >= 7 && this.stage <= 8) {
      this.addWarning({ kind: 'mount_probe', containerId: entry.container, ...range }); return true;
    }
    if ((entry.msg === 'Deleting nftables IPv4 rules' || entry.msg === 'Deleting nftables IPv6 rules')
      && entry.level === 'info' && entry.error === 'exit status 1' && this.stage >= 7 && this.stage <= 8) {
      this.addWarning({ kind: 'nftables_cleanup', family: entry.msg.includes('IPv4') ? 'ipv4' : 'ipv6', ...range }); return true;
    }
    if (entry.msg === '"containerd-snapshotter" is now the default and no longer needed to be set'
      && entry.level === 'warning' && entry.error === undefined && this.stage === 5) {
      this.addWarning({ kind: 'snapshotter_deprecation', ...range }); return true;
    }
    return false;
  }

  private event(event: RestorationEvent): void {
    if (required[this.stage] !== event.kind) this.refuse('fresh_boot', 'Required fresh boot and restoration boundaries are missing, duplicated or reordered.');
    if (this.events.length >= RECOVERY_NATIVE_LIMITS.events) this.refuse('capacity', 'Restoration event capacity is exhausted.');
    this.events.push(event); this.stage++;
  }

  private addWarning(warning: RestorationWarning): void {
    if (this.warnings.length >= RECOVERY_NATIVE_LIMITS.warnings) this.refuse('capacity', 'Restoration warning capacity is exhausted.');
    this.warnings.push(warning);
  }

  private addDiagnostic(diagnostic: RestorationDiagnostic): void {
    if (this.diagnostics.length >= RECOVERY_NATIVE_LIMITS.warnings) this.refuse('capacity', 'Restoration diagnostic capacity is exhausted.');
    this.diagnostics.push(diagnostic);
  }

  finish(finished: Extract<NativeFact, { kind: 'finished' }>, engine: RecoveryEngineObservation,
    armed: Extract<NativeFact, { kind: 'armed' }>): RestorationEvidence {
    if (this.failure) throw this.failure;
    if (!this.complete) this.refuse('fresh_boot', 'Native source interval has no complete fresh Linux and healthy Docker restoration sequence.');
    if ([...this.streams.values()].some((stream) => stream.pending.length > 0)) {
      this.refuse('restoration', 'Restoration source interval ends inside a log line.');
    }
    const initial = new Map(armed.logSources.map((source) => [source.sourceIdentity, source]));
    if (initial.size !== armed.logSources.length) this.refuse('restoration', 'Armed source identities are not unique.');
    const observed = new Set<string>();
    for (const span of this.spans) {
      if (observed.has(span.sourceIdentity)) continue;
      const source = initial.get(span.sourceIdentity);
      if (source === undefined ? span.start !== '0' : source.source !== span.source || source.initialOffset !== span.start) {
        this.refuse('restoration', 'Classified bytes do not begin at the actual armed source offset or a new rotation boundary.');
      }
      observed.add(span.sourceIdentity);
    }
    const nativeSpans = this.spans.map((span) => ({ source: span.source, sourceIdentity: span.sourceIdentity,
      sequence: span.sequence, start: span.start, end: span.end, sha256: span.sha256.slice(7) }));
    if (JSON.stringify(nativeSpans) !== JSON.stringify(finished.spans)
      || digestBytes(Buffer.from(JSON.stringify(nativeSpans))) !== finished.spanManifestSha256) {
      this.refuse('restoration', 'Native completion does not close exactly the classified byte interval.');
    }
    const visible = new Set(engine.containers.map((container) => container.Id));
    if (this.warnings.some((warning) => warning.kind === 'mount_probe' && !visible.has(warning.containerId))) {
      this.refuse('restoration', 'A mount-state warning lacks matching full-ID container visibility after restoration.');
    }
    const evidence = restorationEvidenceSchema.parse({ kind: 'accepted',
      profile: 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1',
      sourceSpanDigest: restorationSpansDigest(this.spans),
      classifiedEventsDigest: restorationEventsDigest({ events: this.events, warnings: this.warnings, diagnostics: this.diagnostics }),
      engineIdentityDigest: engine.engineIdentityDigest, storeIdentityDigest: recoveryStoreIdentityDigest(finished.facts),
      spans: this.spans, events: this.events, warnings: this.warnings, diagnostics: this.diagnostics });
    this.sealed = true;
    return immutable(evidence);
  }

  private refuse(reason: RecoveryRestorationError['reason'], message: string): never {
    throw new RecoveryRestorationError(reason, message);
  }
}

/** An optional bounded baseline cross-check; missing old VMID is not boot proof. */
export function baselineVmIdentity(bytes: Uint8Array): string | undefined {
  if (bytes.length > RECOVERY_NATIVE_LIMITS.chunkBytes) throw new RecoveryRestorationError('capacity', 'Baseline log tail exceeds 64 KiB.');
  const firstNewline = Buffer.from(bytes).indexOf(10);
  if (firstNewline === -1) return undefined;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(firstNewline + 1));
  const matches = [...text.matchAll(/(?:^| )com\.docker\.VMID=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?: |"|$)/gu)];
  return matches.at(-1)?.[1];
}
