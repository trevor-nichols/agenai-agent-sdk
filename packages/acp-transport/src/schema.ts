// ------------------------------------------------------------------------------------------------
//                schema.ts - Runtime validation against explicit pinned ACP v1 profiles
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  ACP_SCHEMA_INPUT_SHA256,
  ACP_STABLE_PROTOCOL,
  ACP_UNSTABLE_PROTOCOL,
} from './generated/protocolMetadata.js';
import {
  ACP_V1_23_0_SCHEMA_INPUT_SHA256,
  ACP_V1_23_0_STABLE_PROTOCOL,
} from './generated/schemaV1_23_0Metadata.js';
import { AcpProtocolError } from './errors.js';

// ------------------------------------------------------------------------------------------------
//                Contracts
// ------------------------------------------------------------------------------------------------

export type AcpSchemaChannel = 'stable' | 'unstable';
export type AcpSchemaProfile = 'v0.11.4' | 'schema-v1.23.0';
export type AcpProtocolSide = 'agent' | 'client' | 'protocol';
export type AcpMethodMessageKind = 'request' | 'response' | 'notification';

type MethodDefinitions = Readonly<Record<
  string,
  Readonly<Partial<Record<AcpMethodMessageKind, string>>>
>>;

export interface AcpSchemaValidator {
  readonly channel: AcpSchemaChannel;
  readonly profile: AcpSchemaProfile;
  readonly protocolVersion: 1;
  readonly hasMethod: (
    side: AcpProtocolSide,
    method: string,
    kind: AcpMethodMessageKind,
  ) => boolean;
  readonly validate: (
    side: AcpProtocolSide,
    method: string,
    kind: AcpMethodMessageKind,
    value: unknown,
  ) => void;
}

interface AcpSchemaDocument {
  readonly $schema?: string;
  readonly $defs: Readonly<Record<string, unknown>>;
}

// ------------------------------------------------------------------------------------------------
//                Pinned Input Loading
// ------------------------------------------------------------------------------------------------

const schemaCache = new Map<string, AcpSchemaDocument>();

function schemaFilename(channel: AcpSchemaChannel): 'schema.json' | 'schema.unstable.json' {
  return channel === 'stable' ? 'schema.json' : 'schema.unstable.json';
}

function loadPinnedSchema(
  channel: AcpSchemaChannel,
  profile: AcpSchemaProfile,
): AcpSchemaDocument {
  const cacheKey = `${profile}:${channel}`;
  const cached = schemaCache.get(cacheKey);
  if (cached) return cached;

  const filename = schemaFilename(channel);
  const content = readFileSync(new URL(`../schema/${profile}/${filename}`, import.meta.url));
  const actualSha256 = createHash('sha256').update(content).digest('hex');
  const expectedSha256 = profile === 'v0.11.4'
    ? ACP_SCHEMA_INPUT_SHA256[filename]
    : ACP_V1_23_0_SCHEMA_INPUT_SHA256['schema.json'];
  if (actualSha256 !== expectedSha256) {
    throw new AcpProtocolError('acp_schema_identity_mismatch', { profile, filename });
  }

  const schema = JSON.parse(content.toString('utf8')) as AcpSchemaDocument;
  if (!schema.$defs || typeof schema.$defs !== 'object') {
    throw new AcpProtocolError('acp_schema_document_invalid', { filename });
  }
  schemaCache.set(cacheKey, schema);
  return schema;
}

function selectProtocol(
  channel: AcpSchemaChannel,
  profile: AcpSchemaProfile,
) {
  if (profile !== 'v0.11.4' && profile !== 'schema-v1.23.0') {
    throw new AcpProtocolError('acp_schema_profile_unsupported');
  }
  if (
    (channel !== 'stable' && channel !== 'unstable')
    || (profile === 'schema-v1.23.0' && channel !== 'stable')
  ) {
    throw new AcpProtocolError('acp_schema_channel_unsupported', { profile });
  }
  return profile === 'schema-v1.23.0'
    ? ACP_V1_23_0_STABLE_PROTOCOL
    : channel === 'stable' ? ACP_STABLE_PROTOCOL : ACP_UNSTABLE_PROTOCOL;
}

function validationDiagnostics(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).slice(0, 8).map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
  }));
}

// ------------------------------------------------------------------------------------------------
//                Validator Factory
// ------------------------------------------------------------------------------------------------

export function createAcpSchemaValidator(
  channel: AcpSchemaChannel = 'stable',
  profile: AcpSchemaProfile = 'v0.11.4',
): AcpSchemaValidator {
  const protocol = selectProtocol(channel, profile);
  const schema = loadPinnedSchema(channel, profile);
  const methodDefinitions = (side: AcpProtocolSide): MethodDefinitions => (
    protocol.definitions[side] as MethodDefinitions
  );
  const ajv = new Ajv2020({
    allErrors: false,
    strict: false,
    validateFormats: false,
    allowUnionTypes: true,
  });
  const validators = new Map<string, ValidateFunction>();

  const definitionValidator = (definitionName: string): ValidateFunction => {
    const cached = validators.get(definitionName);
    if (cached) return cached;
    if (!(definitionName in schema.$defs)) {
      throw new AcpProtocolError('acp_schema_definition_missing', { definitionName });
    }
    const validator = ajv.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      $ref: `#/$defs/${definitionName}`,
    });
    validators.set(definitionName, validator);
    return validator;
  };

  const schemaValidator: AcpSchemaValidator = {
    channel,
    profile,
    protocolVersion: 1,
    hasMethod: (side, method, kind) => Boolean(methodDefinitions(side)[method]?.[kind]),
    validate: (side, method, kind, value) => {
      const definitionName = methodDefinitions(side)[method]?.[kind];
      if (!definitionName) {
        throw new AcpProtocolError('acp_method_not_in_pinned_schema', {
          channel,
          profile,
          side,
          kind,
          method,
        });
      }
      const validator = definitionValidator(definitionName);
      if (!validator(value)) {
        throw new AcpProtocolError('acp_method_payload_invalid', {
          channel,
          profile,
          side,
          kind,
          method,
          issues: validationDiagnostics(validator.errors),
        });
      }
      if (
        side === 'agent'
        && method === 'initialize'
        && (value as { readonly protocolVersion: number }).protocolVersion !== protocol.protocolVersion
      ) {
        throw new AcpProtocolError('acp_protocol_version_unsupported', { profile });
      }
    },
  };
  return Object.freeze(schemaValidator);
}
