import { createAcpExtensionRegistry, type AcpExtensionRegistry } from '@agen-ai/acp-transport';

import {
  GROK_FOLDER_TRUST_METHOD,
  validateNativeFolderTrustRequest,
  validateNativeFolderTrustResult,
} from './grokFolderTrust.js';

export function createSessionInteractionExtensionRegistry(): AcpExtensionRegistry {
  return createAcpExtensionRegistry([{
    method: GROK_FOLDER_TRUST_METHOD,
    direction: 'inbound_request',
    validateParams: validateNativeFolderTrustRequest,
    validateResult: validateNativeFolderTrustResult,
  }]);
}
