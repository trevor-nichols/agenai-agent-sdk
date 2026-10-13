// ------------------------------------------------------------------------------------------------
//                standardSessionOperations.ts - Typed stable ACP session invocation facade
// ------------------------------------------------------------------------------------------------

import type { AcpClient, AcpRequestOptions } from './clientContracts.js';
import type { AcpJsonObject, AcpJsonValue } from './json.js';

// ------------------------------------------------------------------------------------------------
//                Pinned Standard Parameter Contracts
// ------------------------------------------------------------------------------------------------

type AcpStableAgentMethod = (
  typeof import('./generated/protocolMetadata.js').ACP_STABLE_PROTOCOL
)['agentMethods'][number];
type AcpStandardObject<T extends object> = AcpJsonObject & Readonly<T>;

export type AcpStandardProtocolVersion =
  typeof import('./generated/protocolMetadata.js').ACP_PROTOCOL_VERSION;
export type AcpStandardMeta = AcpJsonObject | null;
export type AcpStandardRole = 'assistant' | 'user';

export type AcpStandardImplementation = AcpStandardObject<{
  name: string;
  version: string;
  title?: string | null;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardFileSystemCapabilities = AcpStandardObject<{
  readTextFile?: boolean;
  writeTextFile?: boolean;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardClientCapabilities = AcpStandardObject<{
  fs?: AcpStandardFileSystemCapabilities;
  terminal?: boolean;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardInitializeParams = AcpStandardObject<{
  protocolVersion: AcpStandardProtocolVersion;
  clientCapabilities?: AcpStandardClientCapabilities;
  clientInfo?: AcpStandardImplementation | null;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardHttpHeader = AcpStandardObject<{
  name: string;
  value: string;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardEnvironmentVariable = AcpStandardObject<{
  name: string;
  value: string;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardHttpMcpServer = AcpStandardObject<{
  type: 'http';
  name: string;
  url: string;
  headers: AcpStandardHttpHeader[];
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardSseMcpServer = AcpStandardObject<{
  type: 'sse';
  name: string;
  url: string;
  headers: AcpStandardHttpHeader[];
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardStdioMcpServer = AcpStandardObject<{
  name: string;
  command: string;
  args: string[];
  env: AcpStandardEnvironmentVariable[];
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardMcpServer =
  | AcpStandardHttpMcpServer
  | AcpStandardSseMcpServer
  | AcpStandardStdioMcpServer;

type AcpStandardSessionBaseParams = AcpStandardObject<{
  cwd: string;
  mcpServers: AcpStandardMcpServer[];
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardNewSessionParams = AcpStandardSessionBaseParams;

export type AcpStandardLoadSessionParams = AcpStandardSessionBaseParams & Readonly<{
  sessionId: string;
}>;

export type AcpStandardAnnotations = AcpStandardObject<{
  audience?: AcpStandardRole[] | null;
  lastModified?: string | null;
  priority?: number | null;
  _meta?: AcpStandardMeta;
}>;

type AcpStandardContentBase = AcpStandardObject<{
  annotations?: AcpStandardAnnotations | null;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardTextContent = AcpStandardContentBase & Readonly<{
  type: 'text';
  text: string;
}>;

export type AcpStandardImageContent = AcpStandardContentBase & Readonly<{
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string | null;
}>;

export type AcpStandardAudioContent = AcpStandardContentBase & Readonly<{
  type: 'audio';
  data: string;
  mimeType: string;
}>;

export type AcpStandardResourceLink = AcpStandardContentBase & Readonly<{
  type: 'resource_link';
  name: string;
  uri: string;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  title?: string | null;
}>;

export type AcpStandardTextResourceContents = AcpStandardObject<{
  text: string;
  uri: string;
  mimeType?: string | null;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardBlobResourceContents = AcpStandardObject<{
  blob: string;
  uri: string;
  mimeType?: string | null;
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardEmbeddedResource = AcpStandardContentBase & Readonly<{
  type: 'resource';
  resource: AcpStandardTextResourceContents | AcpStandardBlobResourceContents;
}>;

export type AcpStandardContentBlock =
  | AcpStandardTextContent
  | AcpStandardImageContent
  | AcpStandardAudioContent
  | AcpStandardResourceLink
  | AcpStandardEmbeddedResource;

export type AcpStandardPromptParams = AcpStandardObject<{
  sessionId: string;
  prompt: AcpStandardContentBlock[];
  _meta?: AcpStandardMeta;
}>;

export type AcpStandardCancelParams = AcpStandardObject<{
  sessionId: string;
  _meta?: AcpStandardMeta;
}>;

// ------------------------------------------------------------------------------------------------
//                Standard Operation Capability
// ------------------------------------------------------------------------------------------------

export interface AcpStandardSessionOperations {
  readonly initialize: (
    params: AcpStandardInitializeParams,
    options?: AcpRequestOptions,
  ) => Promise<AcpJsonValue>;
  readonly newSession: (
    params: AcpStandardNewSessionParams,
    options?: AcpRequestOptions,
  ) => Promise<AcpJsonValue>;
  readonly loadSession: (
    params: AcpStandardLoadSessionParams,
    options?: AcpRequestOptions,
  ) => Promise<AcpJsonValue>;
  readonly prompt: (
    params: AcpStandardPromptParams,
    options?: AcpRequestOptions,
  ) => Promise<AcpJsonValue>;
  readonly cancel: (params: AcpStandardCancelParams) => Promise<void>;
}

const STANDARD_METHODS = Object.freeze({
  initialize: 'initialize',
  newSession: 'session/new',
  loadSession: 'session/load',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
} as const satisfies Readonly<
  Record<keyof AcpStandardSessionOperations, AcpStableAgentMethod>
>);

export function createAcpStandardSessionOperations(
  client: AcpClient,
): AcpStandardSessionOperations {
  const operations: AcpStandardSessionOperations = {
    initialize: (params, options) => client.request(
      STANDARD_METHODS.initialize,
      params,
      options,
    ),
    newSession: (params, options) => client.request(
      STANDARD_METHODS.newSession,
      params,
      options,
    ),
    loadSession: (params, options) => client.request(
      STANDARD_METHODS.loadSession,
      params,
      options,
    ),
    prompt: (params, options) => client.request(
      STANDARD_METHODS.prompt,
      params,
      options,
    ),
    cancel: (params) => client.notify(STANDARD_METHODS.cancel, params),
  };
  return Object.freeze(operations);
}
