import type {
  AcpClient,
  AcpJsonObject,
  AcpJsonValue,
  AcpNotificationContext,
  AcpReverseRequestContext,
  AcpRequestOptions,
} from '@agen-ai/acp-transport';
import type { AcpHostInteractionScope } from '../host/contracts.js';
import type { AcpBoundSession } from '../host/router.js';

export interface AcpNegotiatedAgent {
  readonly protocolVersion: 1;
  readonly agentInfo?: Readonly<{ name: string; version: string }>;
  readonly agentCapabilities: AcpJsonObject;
  readonly authMethods: readonly AcpJsonValue[];
}

export interface AcpSessionIngress {
  readonly onNotification: (input: AcpNotificationContext) => void | Promise<void>;
  readonly onPermissionRequest: (input: AcpReverseRequestContext) => Promise<AcpJsonValue>;
  readonly onElicitationRequest: (input: AcpReverseRequestContext) => Promise<AcpJsonValue>;
}

export interface AcpInitializedConnection {
  readonly client: AcpClient;
  readonly negotiated: AcpNegotiatedAgent;
  readonly stopped: AbortSignal;
  readonly attachSession: (ingress: AcpSessionIngress) => () => void;
  readonly bindSession: (binding: AcpBoundSession) => void;
  readonly requestWithScope: (method: string, params: AcpJsonValue, scope: AcpHostInteractionScope, options?: AcpRequestOptions) => Promise<AcpJsonValue>;
  readonly hostElicitation?: (context: AcpReverseRequestContext) => Promise<AcpJsonValue>;
  readonly close: () => Promise<void>;
}
