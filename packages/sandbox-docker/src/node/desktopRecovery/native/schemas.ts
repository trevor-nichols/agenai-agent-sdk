import { z } from 'zod/v4';
import { COORDINATOR_JOURNAL_LIMITS } from '../../../network/desktop/coordinator/journal/schema.js';

export const RECOVERY_NATIVE_LIMITS = Object.freeze({
  canonicalBytes: COORDINATOR_JOURNAL_LIMITS.framedBytes - COORDINATOR_JOURNAL_LIMITS.nativeHeaderBytes,
  frameBytes: 262_144, frameHeaderBytes: 512, chunkBytes: 65_536, logBytes: 32 * 1024 ** 2,
  chunks: 512, metadataBytes: 1024 ** 2, events: 128, warnings: 256,
});

export const wireDigest = z.string().regex(/^[a-f0-9]{64}$/u);
export const wireUuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
export const wireUnsigned = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedText = z.string().min(1).max(256).refine((value) => value.isWellFormed() && !/\p{Cc}/u.test(value));
const sourceIdentity = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:._-]+$/u);
const physicalState = { stateDevice: wireUnsigned, stateInode: wireUnsigned };
export const nativeClaimSchema = z.strictObject({
  rootDevice: wireUnsigned, rootInode: wireUnsigned, lockDevice: wireUnsigned, lockInode: wireUnsigned,
});
const nativeRoleSchema = z.enum(['backend', 'virtualization', 'build', 'desktop_ui', 'desktop_gpu', 'desktop_helper', 'desktop_renderer', 'desktop_cli', 'docker_cli', 'vmnetd',
  'plugin_ai', 'plugin_buildx', 'plugin_compose', 'plugin_debug', 'plugin_extension', 'plugin_init', 'plugin_mcp', 'plugin_model',
  'plugin_offload', 'plugin_sandbox', 'plugin_sbom', 'plugin_scout', 'secrets_pass', 'credential_desktop', 'credential_osxkeychain', 'credential_ecr_login', 'kubectl']);
export const nativeProcessSchema = z.strictObject({
  role: nativeRoleSchema,
  pid: positive, uid: z.number().int().nonnegative().max(4_294_967_295), parentPid: z.number().int().nonnegative(),
  processGroup: z.number().int().nonnegative(), startSeconds: wireUnsigned, startMicroseconds: wireUnsigned,
  pidVersion: z.number().int().nonnegative().max(4_294_967_295).nullable(), imageSha256: wireDigest,
});
export const nativeImageSchema = z.strictObject({
  role: nativeRoleSchema,
  sha256: wireDigest, identifier: boundedText, team: boundedText,
});
export const nativePeerSchema = z.strictObject({
  pid: positive, pidVersion: z.number().int().nonnegative().max(4_294_967_295),
  uid: z.number().int().nonnegative().max(4_294_967_295), device: wireUnsigned, inode: wireUnsigned,
});
export const nativeStoreSchema = z.strictObject({
  parentDevice: wireUnsigned, parentInode: wireUnsigned, device: wireUnsigned, inode: wireUnsigned,
  uid: wireUnsigned, mode: wireUnsigned, birthSeconds: wireUnsigned, birthNanoseconds: wireUnsigned,
});
const metadataIdentitySchema = z.strictObject({ sha256: wireDigest, bytes: positive.max(RECOVERY_NATIVE_LIMITS.metadataBytes) });
export const currentNativeFactsSchema = z.strictObject({
  profileDigest: wireDigest, hostBoot: wireUuid, uid: z.number().int().nonnegative().max(4_294_967_295),
  continuousNs: wireUnsigned, images: z.array(nativeImageSchema).min(5).max(32),
  processes: z.array(nativeProcessSchema).min(2).max(128), peer: nativePeerSchema, store: nativeStoreSchema,
  metadata: z.strictObject({ components: metadataIdentitySchema, settings: metadataIdentitySchema }),
});
export const nativeLogSpanSchema = z.strictObject({
  source: z.enum(['init', 'console']), sourceIdentity, sequence: positive,
  start: wireUnsigned, end: wireUnsigned, sha256: wireDigest,
});
const historySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.enum(['outcome', 'barrier_acceptance']), attempt: positive, sha256: wireDigest }),
]);
const receiptLinkSchema = z.strictObject({ kind: z.enum(['admission', 'armed', 'stopped', 'finished', 'outcome']), attempt: positive, sha256: wireDigest });
const nativeFactBinding = {
  format: z.literal('agenai.desktop-recovery-native-fact.v1'), engineKey: wireDigest, authorityId: wireUuid,
  generationId: wireUuid, recoveryKey: wireDigest, attempt: positive, originFrameDigest: wireDigest,
  canonicalPayloadSha256: wireDigest, claim: nativeClaimSchema,
  previousHistory: historySchema, previous: receiptLinkSchema.nullable(),
  issuer: z.strictObject({ sourceDigest: wireDigest, executableSha256: wireDigest }),
  profileDigest: wireDigest, hostBoot: wireUuid, uid: z.number().int().nonnegative().max(4_294_967_295),
  startedContinuousNs: wireUnsigned, finishedContinuousNs: wireUnsigned,
};
export const nativeFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...nativeFactBinding, kind: z.literal('admission'), facts: currentNativeFactsSchema }),
  z.strictObject({ ...nativeFactBinding, kind: z.literal('armed'),
    producers: z.array(nativeProcessSchema).min(2).max(128), watchCount: positive.max(128), deadlineContinuousNs: wireUnsigned,
    logSources: z.array(z.strictObject({ source: z.enum(['init', 'console']), sourceIdentity, initialOffset: wireUnsigned })).min(2).max(64) }),
  z.strictObject({ ...nativeFactBinding, kind: z.literal('stopped'),
    joined: z.array(nativeProcessSchema).min(2).max(128), completeCensuses: z.literal(2), endpoint: z.literal('not_serving') }),
  z.strictObject({ ...nativeFactBinding, kind: z.literal('finished'), facts: currentNativeFactsSchema,
    spans: z.array(nativeLogSpanSchema).max(RECOVERY_NATIVE_LIMITS.chunks), spanManifestSha256: wireDigest }),
  z.strictObject({ ...nativeFactBinding, kind: z.literal('outcome'), outcome: z.enum(['failed', 'interrupted', 'abandoned']),
    reason: z.enum(['producer', 'stopped_interval', 'fresh_boot', 'restoration', 'composition', 'expired', 'transport', 'storage', 'caller']),
    lastCompleted: receiptLinkSchema.nullable() }),
]);

export const nativeReceiptKindSchema = z.enum([
  'admission', 'armed', 'stopped', 'finished', 'outcome', 'barrier_acceptance',
  'member_terminal', 'final_inventory', 'generation_terminal', 'origin_archive', 'terminal_archive',
]);
export const recoveryNativeResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('opened'), initial: z.literal('existing'), ...nativeClaimSchema.shape,
    ...physicalState, pendingTemp: z.boolean() }),
  z.strictObject({ kind: z.literal('snapshot'), text: z.string(), digest: wireDigest, ...physicalState, pendingTemp: z.boolean() }),
  z.strictObject({ kind: z.literal('committed'), digest: wireDigest, ...physicalState }),
  z.strictObject({ kind: z.literal('checked'), fenced: z.boolean() }),
  z.strictObject({ kind: z.literal('cleanup') }), z.strictObject({ kind: z.literal('discarded') }),
  z.strictObject({ kind: z.literal('closed') }), z.strictObject({ kind: z.literal('bound') }),
  z.strictObject({ kind: z.literal('bound_existing'), recoveryKey: wireDigest, originFrameDigest: wireDigest, originRawDigest: wireDigest }),
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({ kind: z.literal('admission'), facts: currentNativeFactsSchema }),
  z.strictObject({ kind: z.literal('current_peer'), facts: currentNativeFactsSchema }),
  z.strictObject({ kind: z.literal('receipt'), recordKind: nativeReceiptKindSchema,
    scope: z.string().min(1).max(36).regex(/^(?:generation|[1-9][0-9]{0,15}|[a-f0-9-]{36})$/u),
    digest: wireDigest, bytes: positive.max(COORDINATOR_JOURNAL_LIMITS.framedBytes), text: z.string() }),
  z.strictObject({ kind: z.literal('log_bytes'), phase: z.enum(['baseline', 'observed']), ...nativeLogSpanSchema.shape,
    bytesBase64: z.string().max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
    done: z.boolean() }),
  z.strictObject({ kind: z.literal('metadata_bytes'), source: z.enum(['components', 'settings']),
    sha256: wireDigest, bytes: positive.max(RECOVERY_NATIVE_LIMITS.metadataBytes),
    bytesBase64: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }),
  z.strictObject({ kind: z.literal('failure'), reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    errno: z.number().int().min(0).max(65_535), claim: z.enum(['held', 'lost']) }),
]);

export type RecoveryNativeResponse = z.infer<typeof recoveryNativeResponseSchema>;
export type RecoveryNativeOpened = Extract<RecoveryNativeResponse, { kind: 'opened' }>;
export type RecoveryNativeSnapshot = Extract<RecoveryNativeResponse, { kind: 'snapshot' }>;
export type RecoveryNativeReceipt = Extract<RecoveryNativeResponse, { kind: 'receipt' }>;
export type RecoveryNativeLogBytes = Extract<RecoveryNativeResponse, { kind: 'log_bytes' }>;
export type NativeCurrentAdmissionFacts = z.infer<typeof currentNativeFactsSchema>;
export type NativeFact = z.infer<typeof nativeFactSchema>;
