// ------------------------------------------------------------------------------------------------
//                protocol.ts - Fixed same-process credential bootstrap protocol
// ------------------------------------------------------------------------------------------------

export const SANDBOX_CREDENTIAL_PROTOCOL = 'agenai.sandbox-credential-bootstrap.v1';
export const SANDBOX_CREDENTIAL_DIRECTORY = '/home/sandbox/.agenai-credentials';
export const SANDBOX_CREDENTIAL_EXECUTABLE = 'agenai-credential-bootstrap';
export const SANDBOX_CREDENTIAL_MAGIC = 'AGC1';
export const SANDBOX_CREDENTIAL_HELLO = 'AGC1 HELLO\n';
export const SANDBOX_CREDENTIAL_PREPARED = 'AGC1 PREPARED\n';
export const SANDBOX_CREDENTIAL_HEADER_BYTES = 12;
export const SANDBOX_CREDENTIAL_MAX_NAME_BYTES = 64;
export const SANDBOX_CREDENTIAL_MAX_BYTES = 65_536;
