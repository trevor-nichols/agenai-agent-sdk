// ------------------------------------------------------------------------------------------------
//                schemaV1_23_0Metadata.ts - GENERATED from official ACP schema-v1.23.0 stable inputs
// ------------------------------------------------------------------------------------------------
// Do not edit. Run `pnpm --filter @agen-ai/acp-transport generate`.

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const ACP_V1_23_0_SCHEMA_RELEASE = 'schema-v1.23.0' as const;
export const ACP_V1_23_0_PROTOCOL_VERSION = 1 as const;
export const ACP_V1_23_0_SCHEMA_INPUT_SHA256 = deepFreeze({
  LICENSE: "f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221",
  "meta.json": "061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88",
  "schema.json": "3c17bd6385d90cf672d8a661fddc359d73422cf8b8ce6865213d25cfd4c0eca7",
  "provenance.json": "f6b2efcf80c06a380bc8c50065e7b18fcbe5d7ab82e60ff7ff23fbca70c3e8e6"
} as const);

export const ACP_V1_23_0_STABLE_PROTOCOL = deepFreeze({
  protocolVersion: 1,
  agentMethods: [
    "authenticate",
    "initialize",
    "logout",
    "session/cancel",
    "session/close",
    "session/delete",
    "session/list",
    "session/load",
    "session/new",
    "session/prompt",
    "session/resume",
    "session/set_config_option",
    "session/set_mode"
  ],
  clientMethods: [
    "elicitation/complete",
    "elicitation/create",
    "fs/read_text_file",
    "fs/write_text_file",
    "session/request_permission",
    "session/update",
    "terminal/create",
    "terminal/kill",
    "terminal/output",
    "terminal/release",
    "terminal/wait_for_exit"
  ],
  protocolMethods: [
    "$/cancel_request"
  ],
  definitions: {
    agent: {
      authenticate: {
        response: "AuthenticateResponse",
        request: "AuthenticateRequest"
      },
      initialize: {
        response: "InitializeResponse",
        request: "InitializeRequest"
      },
      logout: {
        response: "LogoutResponse",
        request: "LogoutRequest"
      },
      "session/cancel": {
        notification: "CancelNotification"
      },
      "session/close": {
        response: "CloseSessionResponse",
        request: "CloseSessionRequest"
      },
      "session/delete": {
        response: "DeleteSessionResponse",
        request: "DeleteSessionRequest"
      },
      "session/list": {
        response: "ListSessionsResponse",
        request: "ListSessionsRequest"
      },
      "session/load": {
        response: "LoadSessionResponse",
        request: "LoadSessionRequest"
      },
      "session/new": {
        response: "NewSessionResponse",
        request: "NewSessionRequest"
      },
      "session/prompt": {
        response: "PromptResponse",
        request: "PromptRequest"
      },
      "session/resume": {
        response: "ResumeSessionResponse",
        request: "ResumeSessionRequest"
      },
      "session/set_config_option": {
        response: "SetSessionConfigOptionResponse",
        request: "SetSessionConfigOptionRequest"
      },
      "session/set_mode": {
        response: "SetSessionModeResponse",
        request: "SetSessionModeRequest"
      }
    },
    client: {
      "elicitation/complete": {
        notification: "CompleteElicitationNotification"
      },
      "elicitation/create": {
        request: "CreateElicitationRequest",
        response: "CreateElicitationResponse"
      },
      "fs/read_text_file": {
        request: "ReadTextFileRequest",
        response: "ReadTextFileResponse"
      },
      "fs/write_text_file": {
        request: "WriteTextFileRequest",
        response: "WriteTextFileResponse"
      },
      "session/request_permission": {
        request: "RequestPermissionRequest",
        response: "RequestPermissionResponse"
      },
      "session/update": {
        notification: "SessionNotification"
      },
      "terminal/create": {
        request: "CreateTerminalRequest",
        response: "CreateTerminalResponse"
      },
      "terminal/kill": {
        request: "KillTerminalRequest",
        response: "KillTerminalResponse"
      },
      "terminal/output": {
        request: "TerminalOutputRequest",
        response: "TerminalOutputResponse"
      },
      "terminal/release": {
        request: "ReleaseTerminalRequest",
        response: "ReleaseTerminalResponse"
      },
      "terminal/wait_for_exit": {
        request: "WaitForTerminalExitRequest",
        response: "WaitForTerminalExitResponse"
      }
    },
    protocol: {
      "$/cancel_request": {
        notification: "CancelRequestNotification"
      }
    }
  }
} as const);

export type AcpV1_23_0StableAgentMethod = typeof ACP_V1_23_0_STABLE_PROTOCOL.agentMethods[number];
export type AcpV1_23_0StableClientMethod = typeof ACP_V1_23_0_STABLE_PROTOCOL.clientMethods[number];
export type AcpV1_23_0StableProtocolMethod = typeof ACP_V1_23_0_STABLE_PROTOCOL.protocolMethods[number];
