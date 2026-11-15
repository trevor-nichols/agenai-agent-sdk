import { fields, invalid, text } from './data.js';

const ISSUER = 'https://auth.x.ai';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = `${ISSUER}::${CLIENT_ID}`;

/** A bounded copy only: no source-file read, write or refresh authority. */
export function captureCredential(value: unknown): Uint8Array {
  const selected = fields(value, ['kind', 'bytes']);
  if (selected.kind !== 'auth_json' || !(selected.bytes instanceof Uint8Array)
    || selected.bytes.byteLength < 1 || selected.bytes.byteLength > 65_536) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(selected.bytes)); }
  catch { invalid(); }
  const store = fields(parsed, [SCOPE]);
  const account = fields(store[SCOPE], ['key', 'auth_mode', 'create_time', 'user_id', 'expires_at', 'oidc_issuer', 'oidc_client_id'],
    ['refresh_token', 'principal_type', 'principal_id', 'team_id', 'organization_id', 'org_id', 'deployment_id',
      'email', 'first_name', 'last_name', 'profile_image_asset_id', 'team_name', 'team_role', 'organization_name',
      'organization_role', 'user_blocked_reason', 'team_blocked_reasons', 'coding_data_retention_opt_out',
      'can_administer_team', 'has_grok_code_access', 'coding_data_team', 'team_zero_data_retention']);
  const billingTeam = account.team_id == null || account.team_id === '' ? undefined : account.team_id;
  const codingDataTeam = account.coding_data_team ?? undefined;
  const blockedReasons = account.team_blocked_reasons;
  const privacyText = (input: unknown): input is string => text(input) && Buffer.byteLength(input, 'utf8') <= 4096;
  if (account.auth_mode !== 'oidc' || account.oidc_issuer !== ISSUER || account.oidc_client_id !== CLIENT_ID
    || !text(account.key) || !text(account.user_id) || !text(account.create_time)
    || !Number.isFinite(Date.parse(account.create_time)) || !text(account.expires_at)
    || !Number.isFinite(Date.parse(account.expires_at)) || Date.parse(account.expires_at) <= Date.now()
    || (account.principal_type != null && account.principal_type !== 'User' && account.principal_type !== 'Personal')
    || (account.principal_id != null && account.principal_id !== '' && account.principal_id !== account.user_id)
    || (billingTeam !== undefined && (!text(billingTeam) || billingTeam.trim() !== billingTeam
      || account.principal_type !== 'User' || account.principal_id !== account.user_id))
    || ['team_name', 'team_role', 'organization_id', 'organization_name', 'organization_role', 'org_id', 'deployment_id']
      .some((key) => account[key] != null && account[key] !== '')
    || (codingDataTeam !== undefined && (!privacyText(codingDataTeam) || codingDataTeam.trim() !== codingDataTeam))
    || ['team_zero_data_retention', 'coding_data_retention_opt_out']
      .some((key) => account[key] !== undefined && typeof account[key] !== 'boolean')
    || (blockedReasons !== undefined && (!Array.isArray(blockedReasons) || blockedReasons.length > 32
      || blockedReasons.some((reason: unknown) => !privacyText(reason))))
    || (account.refresh_token != null && !text(account.refresh_token))) invalid();
  return Buffer.from(JSON.stringify({ [SCOPE]: {
    key: account.key, auth_mode: 'oidc', create_time: account.create_time, user_id: account.user_id,
    expires_at: account.expires_at, oidc_issuer: ISSUER, oidc_client_id: CLIENT_ID,
    ...(account.principal_type == null ? {} : { principal_type: account.principal_type }),
    ...(account.principal_id == null || account.principal_id === '' ? {} : { principal_id: account.principal_id }),
    ...(billingTeam === undefined ? {} : { team_id: billingTeam }),
    ...(codingDataTeam === undefined ? {} : { coding_data_team: codingDataTeam }),
    ...(account.team_zero_data_retention === undefined ? {} : { team_zero_data_retention: account.team_zero_data_retention }),
    ...(account.coding_data_retention_opt_out === undefined ? {} : { coding_data_retention_opt_out: account.coding_data_retention_opt_out }),
    ...(blockedReasons === undefined ? {} : { team_blocked_reasons: blockedReasons }),
  } }));
}
