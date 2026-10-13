// ------------------------------------------------------------------------------------------------
//                index.ts - ACP transport package entrypoint - Dependencies: public modules
// ------------------------------------------------------------------------------------------------

export const ACP_TRANSPORT_PACKAGE_NAME = '@agen-ai/acp-transport' as const;

export * from './client.js';
export * from './errors.js';
export * from './extensions.js';
export * from './generated/protocolMetadata.js';
export * from './generated/schemaV1_23_0Metadata.js';
export * from './json.js';
export * from './limits.js';
export * from './protocol.js';
export * from './schema.js';
