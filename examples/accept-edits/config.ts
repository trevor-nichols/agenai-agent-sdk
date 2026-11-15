import { z } from 'zod/v4';

// Closed run configuration. Every path is absolute and canonical; nothing is defaulted from the
// developer's machine, so the same file works inside or outside a monorepo checkout.
const absolute = z.string().min(2).max(4_096).refine(
  (value) => value.startsWith('/') && !value.endsWith('/') && !value.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')
    && !/[\u0000-\u001f\u007f]/u.test(value),
  'Expected a canonical absolute path.',
);
const relative = z.string().min(1).max(1_024).refine(
  (value) => !value.startsWith('/') && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
    && !/[\u0000-\u001f\u007f\\]/u.test(value),
  'Expected a canonical workspace-relative path.',
);
const pattern = z.string().min(1).max(1_024).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const bounded = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);
const policyKind = z.enum(['host', 'provider_accept_edits', 'provider_auto_review', 'provider_bypass']);

const native = z.strictObject({
  executablePath: absolute, bubblewrapPath: absolute, filesystemHelperPath: absolute,
});
const workspace = z.strictObject({ storeDirectory: absolute, stateParentDirectory: absolute });
const restrictions = z.strictObject({
  askRead: z.array(pattern).max(64).optional(), denyRead: z.array(pattern).max(64).optional(),
  askEdit: z.array(pattern).max(64).optional(), denyEdit: z.array(pattern).max(64).optional(),
});
const approvals = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interactive') }),
  z.strictObject({
    kind: z.literal('exact'),
    commands: z.array(z.string().min(1).max(16_384)).max(32),
    edits: z.array(relative).max(64),
    reads: z.array(relative).max(64),
  }),
]);
const limits = z.strictObject({
  runMs: bounded(1_000, 3_600_000), settleMs: bounded(1_000, 600_000),
  maxOutputEvents: bounded(1, 100_000), maxOutputBytes: bounded(1_024, 64 * 1024 * 1024),
  maxToolItems: bounded(1, 1_000), cleanupAttempts: bounded(1, 5),
  commandTimeoutMs: bounded(1_000, 600_000).optional(),
});

// Native usage controls each provider enforces itself; none bounds an invoice.
const nativeLimits = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('claude'), maxBudgetUsdPerSession: z.number().positive().max(1_000).optional() }),
  z.strictObject({ provider: z.literal('opencode'),
    maxOutputTokensPerRequest: bounded(1, 256_000).optional(), maxModelStepsPerTurn: bounded(1, 1_000).optional() }),
]);

const runSchema = z.strictObject({
  format: z.literal('agenai.accept-edits-example.v1'),
  provider: z.enum(['claude', 'opencode']),
  route: z.enum(['anthropic', 'openai']),
  model: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u),
  policy: policyKind,
  native, workspace,
  restrictions: restrictions.optional(),
  credential: z.strictObject({ kind: z.literal('api_key_file'), path: absolute }),
  apiBaseUrl: z.url({ protocol: /^https?$/u }).max(2_048).optional(),
  prompt: z.string().min(1).max(16_384),
  approvals,
  limits,
  nativeLimits: nativeLimits.optional(),
}).refine((value) => value.provider === 'opencode' || value.route === 'anthropic', 'Claude uses the Anthropic API-key route.')
  .refine((value) => value.nativeLimits === undefined || value.nativeLimits.provider === value.provider, 'Native limits name the configured provider.');

export type AcceptEditsPolicyKind = z.infer<typeof policyKind>;
export type AcceptEditsApprovals = z.infer<typeof approvals>;
export type AcceptEditsConfig = Readonly<z.infer<typeof runSchema>>;
export type AcceptEditsRunConfig = Omit<AcceptEditsConfig, 'approvals'>;

export class AcceptEditsConfigError extends Error {
  readonly code = 'invalid_config';
  constructor(cause: unknown) {
    super('The accept-edits example configuration is invalid.', { cause });
    this.name = 'AcceptEditsConfigError';
  }
}

export function parseAcceptEditsConfig(value: unknown): AcceptEditsConfig {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) throw new AcceptEditsConfigError(parsed.error);
  return Object.freeze(parsed.data);
}
