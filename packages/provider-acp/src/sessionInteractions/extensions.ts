import { createAcpExtensionRegistry, type AcpExtensionRegistry } from '@agen-ai/acp-transport';

import {
  GROK_FOLDER_TRUST_METHOD,
  validateNativeFolderTrustRequest,
  validateNativeFolderTrustResult,
} from './grokFolderTrust.js';
import { GROK_PLAN_REVIEW_METHOD, GROK_QUEUE_METHOD, GROK_SESSION_NOTIFICATION_METHOD,
  validateNativePlanReviewRequest, validateNativePlanReviewResult } from './grokPlanReview.js';
import type { AcpSessionInteractionSelection } from './contracts.js';

function sessionNotification(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && 'sessionId' in input && typeof input.sessionId === 'string' && input.sessionId.length > 0 && input.sessionId.length <= 256;
}

export function createSessionInteractionExtensionRegistry(selection: AcpSessionInteractionSelection): AcpExtensionRegistry {
  if (selection.mapping === 'grok-build-1.0.60-session-requests-v1') return createAcpExtensionRegistry([
    { method: GROK_PLAN_REVIEW_METHOD, direction: 'inbound_request',
      validateParams: validateNativePlanReviewRequest, validateResult: validateNativePlanReviewResult },
    { method: GROK_QUEUE_METHOD, direction: 'inbound_notification', validateParams: (input) => sessionNotification(input)
      && 'entries' in input && Array.isArray(input.entries) && input.entries.length <= 256 },
    { method: GROK_SESSION_NOTIFICATION_METHOD, direction: 'inbound_notification', validateParams: (input) => sessionNotification(input)
      && 'update' in input && input.update !== null && typeof input.update === 'object' && !Array.isArray(input.update)
      && 'sessionUpdate' in input.update && typeof input.update.sessionUpdate === 'string' },
  ]);
  return createAcpExtensionRegistry([{
    method: GROK_FOLDER_TRUST_METHOD,
    direction: 'inbound_request',
    validateParams: validateNativeFolderTrustRequest,
    validateResult: validateNativeFolderTrustResult,
  }]);
}
