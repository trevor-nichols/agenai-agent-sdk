import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import type { AcpNegotiatedAgent } from './contracts.js';
import { AcpProviderConnectionError } from './errors.js';
import type { AcpPermissionMappingSelection } from '../permissions/contracts.js';
import type { AcpSessionInteractionSelection } from '../sessionInteractions/contracts.js';

function immutableProtocolData(value: AcpJsonValue): AcpJsonValue {
  if (Array.isArray(value)) {
    const items = value.map(immutableProtocolData);
    Object.freeze(items);
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .filter((key) => key !== '_meta')
      .map((key) => [key, immutableProtocolData(value[key] as AcpJsonValue)]);
    return Object.freeze(Object.fromEntries(entries));
  }
  return value;
}

/** The transport has already validated the complete pinned initialize response. */
export function readNegotiatedAgent(
  response: AcpJsonValue,
  permissionMapping: AcpPermissionMappingSelection = { mapping: 'once-only-v1' },
  sessionInteractions?: AcpSessionInteractionSelection,
): AcpNegotiatedAgent {
  const value = response as AcpJsonObject;
  if (value.protocolVersion !== 1) {
    throw new AcpProviderConnectionError('acp_provider_version_unsupported', 'ACP wire version 1 is required.');
  }
  const info = value.agentInfo as AcpJsonObject | null | undefined;
  let agentInfo: AcpNegotiatedAgent['agentInfo'];
  if (info) {
    for (const [key, maximum] of [['name', 256], ['version', 160]] as const) {
      const text = info[key];
      if (typeof text !== 'string' || !text || text !== text.trim() || text.length > maximum || /[\p{Cc}\p{Cf}]/u.test(text)) {
        throw new AcpProviderConnectionError('acp_provider_identity_invalid', 'ACP implementation identity is invalid.');
      }
    }
    agentInfo = Object.freeze({ name: info.name as string, version: info.version as string });
  }
  let agentVersion: string | undefined;
  if (sessionInteractions?.mapping === 'grok-build-1.0.60-session-requests-v1') {
    const meta = value._meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || meta.agentVersion !== '1.0.60') {
      throw new AcpProviderConnectionError('acp_session_profile_mismatch', 'The selected session mapping requires exact initialized agentVersion 1.0.60.');
    }
    agentVersion = '1.0.60';
  }
  if (permissionMapping.mapping === 'declared-complete-consequences-v1') {
    if (agentInfo?.name !== permissionMapping.agentInfo.name || agentInfo.version !== permissionMapping.agentInfo.version) {
      throw new AcpProviderConnectionError('acp_permission_profile_mismatch', 'The initialized ACP identity does not match the selected permission profile.');
    }
  } else if (permissionMapping.mapping === 'grok-build-1.0.50-edit-remembrance-v1') {
    const meta = value._meta;
    const version = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta.agentVersion : undefined;
    if (typeof version !== 'string' || version.length > 160 || version !== version.trim()
      || /[\p{Cc}\p{Cf}]/u.test(version) || version !== '1.0.50') {
      throw new AcpProviderConnectionError('acp_permission_profile_mismatch', 'The selected Grok permission profile requires the exact initialized agentVersion 1.0.50.');
    }
    agentVersion = version;
  }
  return Object.freeze({
    protocolVersion: 1,
    ...(agentInfo ? { agentInfo } : {}),
    ...(agentVersion ? { agentVersion } : {}),
    agentCapabilities: immutableProtocolData(value.agentCapabilities ?? {}) as AcpJsonObject,
    authMethods: immutableProtocolData(value.authMethods ?? []) as readonly AcpJsonValue[],
  });
}

export function negotiatedEnvelope(negotiated: AcpNegotiatedAgent): string {
  return JSON.stringify(negotiated);
}
