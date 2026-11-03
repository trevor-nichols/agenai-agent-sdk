import { SandboxValidationError } from '@agen-ai/sandbox';
import { normalizeZodValidationError } from '@agen-ai/validation/zod';
import { z } from 'zod/v4';
import { parseDesktopCoordinatorConfiguration } from '../desktopCoordinatorOptions.js';
import type { DesktopCoordinatorConfiguration } from '../desktopCoordinatorOptions.js';
import { captureDataFields, preparedHelperSchema } from '../preparedHelperOptions.js';
import { DESKTOP_RECOVERY_PROFILE, DESKTOP_RECOVERY_PROTOCOL } from './contracts.js';
import { parseDesktopCleanupExpected } from '../desktopCoordinatorCleanup.js';
import type { DockerDesktopRecoveryControllerOptions, DockerDesktopRecoveryHelper } from './contracts.js';

const helperSchema = preparedHelperSchema(DESKTOP_RECOVERY_PROTOCOL);
export interface RecoveryOpenInput {
  readonly expectedGeneration: string;
  readonly replaceHelper?: Readonly<{ expected: DockerDesktopRecoveryHelper }>;
}
export function parseRecoveryOpenInput(input: unknown): RecoveryOpenInput {
  const context = 'Docker Desktop recovery open input';
  const fields = captureDataFields(input, ['expectedGeneration', 'replaceHelper'], context);
  const expectedGeneration = parseDesktopCleanupExpected({ expectedGeneration: fields.expectedGeneration });
  if (!expectedGeneration) throw new TypeError('Recovery open requires an expected generation.');
  if (fields.replaceHelper === undefined) return Object.freeze({ expectedGeneration });
  const replacement = captureDataFields(fields.replaceHelper, ['expected'], context);
  const expected = captureDataFields(replacement.expected, ['protocol', 'sourceDigest', 'executable'], context);
  expected.executable = captureDataFields(expected.executable, ['path', 'sha256'], context);
  const helper = helperSchema.safeParse(expected);
  if (!helper.success) throw new SandboxValidationError(normalizeZodValidationError(helperSchema, helper.error, expected));
  return Object.freeze({ expectedGeneration, replaceHelper: Object.freeze({ expected: Object.freeze({ ...helper.data,
    executable: Object.freeze(helper.data.executable) }) }) });
}
const desktopSchema = z.strictObject({
  profile: z.literal(DESKTOP_RECOVERY_PROFILE),
  applicationPath: z.literal('/Applications/Docker.app'),
});

export interface DesktopRecoveryConfiguration {
  readonly original: DesktopCoordinatorConfiguration;
  readonly helper: DockerDesktopRecoveryHelper;
  readonly desktop: DockerDesktopRecoveryControllerOptions['desktop'];
}

export function parseDesktopRecoveryConfiguration(options: unknown): DesktopRecoveryConfiguration {
  const context = 'Docker Desktop recovery configuration';
  const input = captureDataFields(options, ['original', 'helper', 'desktop'], context);
  const original = parseDesktopCoordinatorConfiguration(input.original);
  const helperInput = captureDataFields(input.helper, ['protocol', 'sourceDigest', 'executable'], context);
  helperInput.executable = captureDataFields(helperInput.executable, ['path', 'sha256'], context);
  const helper = helperSchema.safeParse(helperInput);
  if (!helper.success) throw new SandboxValidationError(normalizeZodValidationError(helperSchema, helper.error, helperInput));
  const desktopInput = captureDataFields(input.desktop, ['profile', 'applicationPath'], context);
  const desktop = desktopSchema.safeParse(desktopInput);
  if (!desktop.success) throw new SandboxValidationError(normalizeZodValidationError(desktopSchema, desktop.error, desktopInput));
  return Object.freeze({ original,
    helper: Object.freeze({ ...helper.data, executable: Object.freeze(helper.data.executable) }),
    desktop: Object.freeze(desktop.data),
  });
}
