// ------------------------------------------------------------------------------------------------
//                errors.ts - Stable ACP client failures - Dependencies: none
// ------------------------------------------------------------------------------------------------

export class AcpClientError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AcpClientError';
  }
}

export class AcpProtocolError extends AcpClientError {
  constructor(
    reasonCode: string,
    diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(reasonCode, 'The ACP peer violated the pinned protocol contract.', diagnostics);
    this.name = 'AcpProtocolError';
  }
}

export class AcpRequestError extends AcpClientError {
  constructor(
    reasonCode: string,
    readonly requestId: string | number,
    diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(reasonCode, 'The ACP request did not complete successfully.', diagnostics);
    this.name = 'AcpRequestError';
  }
}

export class AcpRemoteError extends AcpRequestError {
  constructor(
    requestId: string | number,
    readonly code: number,
    readonly remoteMessage: string,
    readonly data?: unknown,
  ) {
    super('acp_remote_error', requestId, { code });
    this.name = 'AcpRemoteError';
  }
}

export class AcpRpcHandlerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcHandlerError';
  }
}
