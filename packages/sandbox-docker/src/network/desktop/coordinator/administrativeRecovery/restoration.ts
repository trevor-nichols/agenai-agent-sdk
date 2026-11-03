import { z } from 'zod/v4';
import { coordinatorDigest } from '../journal/schema.js';
import { digestSchema, sequenceSchema } from './scalars.js';

const offset = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const identity = z.string().min(1).max(128).refine((value) => value.isWellFormed() && !/\p{Cc}/u.test(value));
const spanRange = { spanStart: z.number().int().min(0).max(511), spanEnd: z.number().int().min(0).max(511) };
export const restorationSpanSchema = z.strictObject({ source: z.enum(['init', 'console']), sourceIdentity: identity,
  start: offset, end: offset, sequence: sequenceSchema, sha256: digestSchema });
export const restorationEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('linux_boot'), ...spanRange }),
  z.strictObject({ kind: z.literal('vm_identity'), vmId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u), ...spanRange }),
  z.strictObject({ kind: z.literal('containerd_ready'), ...spanRange }),
  z.strictObject({ kind: z.literal('dockerd_process'), pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ...spanRange }),
  z.strictObject({ kind: z.literal('dockerd_start'), ...spanRange }),
  z.strictObject({ kind: z.literal('load_start'), ...spanRange }),
  z.strictObject({ kind: z.literal('restore_start'), ...spanRange }),
  z.strictObject({ kind: z.literal('load_complete'), ...spanRange }),
  z.strictObject({ kind: z.literal('initialization_complete'), ...spanRange }),
  z.strictObject({ kind: z.literal('api_listen'), ...spanRange }),
]);
export const restorationWarningSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mount_probe'), containerId: z.string().regex(/^[a-f0-9]{64}$/u), ...spanRange }),
  z.strictObject({ kind: z.literal('nftables_cleanup'), family: z.enum(['ipv4', 'ipv6']), ...spanRange }),
  z.strictObject({ kind: z.literal('snapshotter_deprecation'), ...spanRange }),
  z.strictObject({ kind: z.literal('containerd_config_migration'), ...spanRange }),
]);
export const restorationDiagnosticSchema = z.strictObject({ kind: z.enum(['telemetry_unimplemented', 'containerd_blockfile_unconfigured', 'containerd_erofs_differ_unavailable', 'containerd_tracing_unconfigured']), ...spanRange });
export const restorationEvidenceSchema = z.strictObject({ kind: z.literal('accepted'),
  profile: z.literal('stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1'),
  sourceSpanDigest: digestSchema, classifiedEventsDigest: digestSchema, engineIdentityDigest: digestSchema,
  storeIdentityDigest: digestSchema, spans: z.array(restorationSpanSchema).min(1).max(512),
  events: z.array(restorationEventSchema).min(10).max(128), warnings: z.array(restorationWarningSchema).max(256), diagnostics: z.array(restorationDiagnosticSchema).max(256) });
export type RestorationSpan = z.infer<typeof restorationSpanSchema>;
export type RestorationEvent = z.infer<typeof restorationEventSchema>;
export type RestorationWarning = z.infer<typeof restorationWarningSchema>;
export type RestorationEvidence = z.infer<typeof restorationEvidenceSchema>;

export type RestorationDiagnostic = z.infer<typeof restorationDiagnosticSchema>;
export function restorationSpansDigest(spans: readonly RestorationSpan[]): string {
  return coordinatorDigest('agenai.desktop-recovery.restoration-spans.v1', JSON.stringify(spans.map((span) => restorationSpanSchema.parse(span))));
}
export function restorationEventsDigest(input: Readonly<{ events: readonly RestorationEvent[]; warnings: readonly RestorationWarning[]; diagnostics: readonly RestorationDiagnostic[] }>): string {
  return coordinatorDigest('agenai.desktop-recovery.restoration-events.v1', JSON.stringify({
    events: input.events.map((event) => restorationEventSchema.parse(event)),
    warnings: input.warnings.map((warning) => restorationWarningSchema.parse(warning)),
    diagnostics: input.diagnostics.map((diagnostic) => restorationDiagnosticSchema.parse(diagnostic)),
  }));
}
