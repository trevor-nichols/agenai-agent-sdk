import { captureSandboxRecipeFields } from '../credentials/index.js';

/** Reuse the selected native account, omitting key/cloud credentials from the same source store. */
export function selectCursorAccount(input: unknown): Readonly<{ accessToken: string; refreshToken: string }> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const fields = captureSandboxRecipeFields(input, ['accessToken', 'refreshToken'], Object.keys(input));
  if (!token(fields.accessToken) || !token(fields.refreshToken)) invalid();
  return { accessToken: fields.accessToken, refreshToken: fields.refreshToken };
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.length > 0 && !/[\u0000\r\n]/u.test(value);
}
function invalid(): never { throw new TypeError('Select a native Cursor account with access and refresh tokens.'); }
