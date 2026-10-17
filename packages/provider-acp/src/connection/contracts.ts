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
import type { SessionInteractionBroker } from '../sessionInteractions/broker.js';
import type { AcpConnectionFactory } from '../contracts.js';
import type { NodeAcpExecutionOwner } from '../node/execution/owner.js';

export type AcpConnectionSource =
  | Readonly<{ kind: 'factory'; create: AcpConnectionFactory }>
  | Readonly<{ kind: 'reserved'; reserve: () => NodeAcpExecutionOwner }>;

export type AcpConnectionAcquisition =
  | Readonly<{ kind: 'factory'; create: AcpConnectionFactory }>
  | Readonly<{ kind: 'reserved'; owner: NodeAcpExecutionOwner }>;

export interface AcpNegotiatedAgent {
  readonly protocolVersion: 1;
  readonly agentInfo?: Readonly<{ name: string; version: string }>;
  /** Bounded compatibility observation retained only by the selected Grok permission profile. */
  readonly agentVersion?: string;
  readonly agentCapabilities: AcpJsonObject;
  readonly authMethods: readonly AcpJsonValue[];
}

export interface AcpSessionIngress {
  readonly joinCallbacks: () => Promise<void>;
  readonly onExtensionNotification?: (input: AcpNotificationContext) => void | Promise<void>;
  readonly onNotification: (input: AcpNotificationContext) => void | Promise<void>;
  readonly onPermissionRequest: (input: AcpReverseRequestContext) => Promise<AcpJsonValue>;
  readonly onElicitationRequest: (input: AcpReverseRequestContext) => Promise<AcpJsonValue>;
}

export interface AcpInitializedConnection {
  readonly client: AcpClient;
  readonly negotiated: AcpNegotiatedAgent;
  readonly stopped: AbortSignal;
  readonly execution?: NodeAcpExecutionOwner;
  readonly sessionInteractions?: SessionInteractionBroker;
  readonly attachSession: (ingress: AcpSessionIngress) => () => void;
  readonly bindSession: (binding: AcpBoundSession) => void;
  readonly requestWithScope: (method: string, params: AcpJsonValue, scope: AcpHostInteractionScope, options?: AcpRequestOptions) => Promise<AcpJsonValue>;
  readonly hostElicitation?: (context: AcpReverseRequestContext, observeCallback?: (work: Promise<void>) => void) => Promise<AcpJsonValue>;
  readonly close: () => Promise<void>;
}
