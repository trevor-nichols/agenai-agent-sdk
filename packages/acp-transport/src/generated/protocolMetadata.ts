// ------------------------------------------------------------------------------------------------
//                protocolMetadata.ts - GENERATED from official ACP v0.11.4 inputs
// ------------------------------------------------------------------------------------------------
// Do not edit. Run `pnpm --filter @agen-ai/acp-transport generate`.

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const ACP_SCHEMA_RELEASE = 'v0.11.4' as const;
export const ACP_PROTOCOL_VERSION = 1 as const;
export const ACP_SCHEMA_INPUT_SHA256 = deepFreeze({
  LICENSE: "f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221",
  "meta.json": "71036d4c70f1e964c445569c1878a513e2fadfc797161d7582224b4647669330",
  "meta.unstable.json": "a040127bddad5cfa9b713c4553a11c78bcdca6f386868e2a3b12cc8f583bd98b",
  "provenance.json": "7f3999ee9661667535ce77390d19f2d1fd460ad9b2271ba167281c9d1d959820",
  "schema.json": "38751907a86016c73662ea2ad1ded2c8cbbdb99fe40b8368b6dd2794726be236",
  "schema.unstable.json": "5c2c4c090d4fc1ca988322f5bdcb719bab2b63c3a86447c3c2c139678ca414a2"
} as const);

export const ACP_STABLE_PROTOCOL = deepFreeze({
  protocolVersion: 1,
  agentMethods: [
    "authenticate",
    "initialize",
    "session/cancel",
    "session/list",
    "session/load",
    "session/new",
    "session/prompt",
    "session/set_config_option",
    "session/set_mode"
  ],
  clientMethods: [
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
  protocolMethods: [],
  definitions: {
    agent: {
      authenticate: {
        request: "AuthenticateRequest",
        response: "AuthenticateResponse"
      },
      initialize: {
        request: "InitializeRequest",
        response: "InitializeResponse"
      },
      "session/cancel": {
        notification: "CancelNotification"
      },
      "session/list": {
        request: "ListSessionsRequest",
        response: "ListSessionsResponse"
      },
      "session/load": {
        request: "LoadSessionRequest",
        response: "LoadSessionResponse"
      },
      "session/new": {
        request: "NewSessionRequest",
        response: "NewSessionResponse"
      },
      "session/prompt": {
        request: "PromptRequest",
        response: "PromptResponse"
      },
      "session/set_config_option": {
        request: "SetSessionConfigOptionRequest",
        response: "SetSessionConfigOptionResponse"
      },
      "session/set_mode": {
        request: "SetSessionModeRequest",
        response: "SetSessionModeResponse"
      }
    },
    client: {
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
    protocol: {}
  }
} as const);

export const ACP_UNSTABLE_PROTOCOL = deepFreeze({
  protocolVersion: 1,
  agentMethods: [
    "authenticate",
    "document/didChange",
    "document/didClose",
    "document/didFocus",
    "document/didOpen",
    "document/didSave",
    "initialize",
    "logout",
    "nes/accept",
    "nes/close",
    "nes/reject",
    "nes/start",
    "nes/suggest",
    "session/cancel",
    "session/close",
    "session/fork",
    "session/list",
    "session/load",
    "session/new",
    "session/prompt",
    "session/resume",
    "session/set_config_option",
    "session/set_mode",
    "session/set_model"
  ],
  clientMethods: [
    "fs/read_text_file",
    "fs/write_text_file",
    "session/elicitation",
    "session/elicitation/complete",
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
        request: "AuthenticateRequest",
        response: "AuthenticateResponse"
      },
      "document/didChange": {
        notification: "DidChangeDocumentNotification"
      },
      "document/didClose": {
        notification: "DidCloseDocumentNotification"
      },
      "document/didFocus": {
        notification: "DidFocusDocumentNotification"
      },
      "document/didOpen": {
        notification: "DidOpenDocumentNotification"
      },
      "document/didSave": {
        notification: "DidSaveDocumentNotification"
      },
      initialize: {
        request: "InitializeRequest",
        response: "InitializeResponse"
      },
      logout: {
        request: "LogoutRequest",
        response: "LogoutResponse"
      },
      "nes/accept": {
        notification: "AcceptNesNotification"
      },
      "nes/close": {
        request: "CloseNesRequest",
        response: "CloseNesResponse"
      },
      "nes/reject": {
        notification: "RejectNesNotification"
      },
      "nes/start": {
        request: "StartNesRequest",
        response: "StartNesResponse"
      },
      "nes/suggest": {
        request: "SuggestNesRequest",
        response: "SuggestNesResponse"
      },
      "session/cancel": {
        notification: "CancelNotification"
      },
      "session/close": {
        request: "CloseSessionRequest",
        response: "CloseSessionResponse"
      },
      "session/fork": {
        request: "ForkSessionRequest",
        response: "ForkSessionResponse"
      },
      "session/list": {
        request: "ListSessionsRequest",
        response: "ListSessionsResponse"
      },
      "session/load": {
        request: "LoadSessionRequest",
        response: "LoadSessionResponse"
      },
      "session/new": {
        request: "NewSessionRequest",
        response: "NewSessionResponse"
      },
      "session/prompt": {
        request: "PromptRequest",
        response: "PromptResponse"
      },
      "session/resume": {
        request: "ResumeSessionRequest",
        response: "ResumeSessionResponse"
      },
      "session/set_config_option": {
        request: "SetSessionConfigOptionRequest",
        response: "SetSessionConfigOptionResponse"
      },
      "session/set_mode": {
        request: "SetSessionModeRequest",
        response: "SetSessionModeResponse"
      },
      "session/set_model": {
        request: "SetSessionModelRequest",
        response: "SetSessionModelResponse"
      }
    },
    client: {
      "fs/read_text_file": {
        request: "ReadTextFileRequest",
        response: "ReadTextFileResponse"
      },
      "fs/write_text_file": {
        request: "WriteTextFileRequest",
        response: "WriteTextFileResponse"
      },
      "session/elicitation": {
        request: "ElicitationRequest",
        response: "ElicitationResponse"
      },
      "session/elicitation/complete": {
        notification: "ElicitationCompleteNotification"
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

export type AcpStableAgentMethod = typeof ACP_STABLE_PROTOCOL.agentMethods[number];
export type AcpStableClientMethod = typeof ACP_STABLE_PROTOCOL.clientMethods[number];
export type AcpUnstableAgentMethod = typeof ACP_UNSTABLE_PROTOCOL.agentMethods[number];
export type AcpUnstableClientMethod = typeof ACP_UNSTABLE_PROTOCOL.clientMethods[number];
export type AcpUnstableProtocolMethod = typeof ACP_UNSTABLE_PROTOCOL.protocolMethods[number];
