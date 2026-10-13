// ------------------------------------------------------------------------------------------------
//                schema.test.ts - ACP schema generation and validation contract
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACP_PROTOCOL_VERSION,
  ACP_SCHEMA_RELEASE,
  ACP_STABLE_PROTOCOL,
  ACP_UNSTABLE_PROTOCOL,
  AcpProtocolError,
  createAcpSchemaValidator,
} from '../src/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('generated protocol metadata remains identical to official v0.11.4 inputs', () => {
  execFileSync(process.execPath, ['scripts/generate-protocol.mjs', '--check'], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  assert.equal(ACP_SCHEMA_RELEASE, 'v0.11.4');
  assert.equal(ACP_PROTOCOL_VERSION, 1);
  assert.ok(ACP_STABLE_PROTOCOL.agentMethods.includes('initialize'));
  assert.ok(ACP_UNSTABLE_PROTOCOL.protocolMethods.includes('$/cancel_request'));
  assert.equal(Object.isFrozen(ACP_STABLE_PROTOCOL.agentMethods), true);
  assert.equal(Object.isFrozen(ACP_UNSTABLE_PROTOCOL.definitions.agent.initialize), true);
});

test('stable and unstable method validators bind params to their exact methods', () => {
  const stable = createAcpSchemaValidator('stable');
  const unstable = createAcpSchemaValidator('unstable');

  stable.validate('agent', 'initialize', 'request', { protocolVersion: 1 });
  unstable.validate('protocol', '$/cancel_request', 'notification', { requestId: 1 });
  assert.throws(
    () => stable.validate('agent', 'initialize', 'request', { cwd: '/workspace' }),
    (error: unknown) => (
      error instanceof Error
      && 'reasonCode' in error
      && error.reasonCode === 'acp_method_payload_invalid'
    ),
  );
  assert.equal(stable.hasMethod('agent', 'session/fork', 'request'), false);
  assert.equal(unstable.hasMethod('agent', 'session/fork', 'request'), true);
});


test('modern stable methods are explicitly selected without widening legacy or unstable support', () => {
  const legacy = createAcpSchemaValidator();
  const modern = createAcpSchemaValidator('stable', 'schema-v1.23.0');
  modern.validate('agent', 'session/delete', 'request', { sessionId: 'session-1' });
  modern.validate('agent', 'session/delete', 'response', {});
  assert.throws(() => legacy.validate('agent', 'session/delete', 'request', {
    sessionId: 'session-1',
  }), (error: unknown) => error instanceof AcpProtocolError
    && error.reasonCode === 'acp_method_not_in_pinned_schema');
  assert.throws(() => modern.validate('agent', 'session/fork', 'request', {
    sessionId: 'session-1', cwd: '/workspace', mcpServers: [],
  }), (error: unknown) => error instanceof AcpProtocolError
    && error.reasonCode === 'acp_method_not_in_pinned_schema');
  assert.equal(modern.hasMethod('client', 'session/elicitation', 'request'), false);
  assert.equal(modern.hasMethod('protocol', '$/cancel_request', 'notification'), true);
  assert.equal(legacy.hasMethod('protocol', '$/cancel_request', 'notification'), false);
});

test('modern stable validates nested elicitation constraints instead of dropping malformed values', () => {
  const modern = createAcpSchemaValidator('stable', 'schema-v1.23.0');
  const form = {
    mode: 'form', message: 'Choose a name', sessionId: 'session-1',
    requestedSchema: {
      type: 'object', properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
    },
  };
  modern.validate('client', 'elicitation/create', 'request', form);
  modern.validate('client', 'elicitation/create', 'response', {
    action: 'accept', content: { name: 'AgenAI' },
  });
  assert.throws(() => modern.validate('client', 'elicitation/create', 'request', {
    ...form,
    requestedSchema: {
      ...form.requestedSchema, properties: { name: { type: 'string', minLength: 'one' } },
    },
  }), (error: unknown) => error instanceof AcpProtocolError
    && error.reasonCode === 'acp_method_payload_invalid');
});

test('boolean config selections use the modern schema while legacy retains string selection', () => {
  const selection = { sessionId: 's', configId: 'enabled', type: 'boolean', value: true };
  createAcpSchemaValidator('stable', 'schema-v1.23.0').validate(
    'agent', 'session/set_config_option', 'request', selection,
  );
  assert.throws(() => createAcpSchemaValidator('stable').validate(
    'agent', 'session/set_config_option', 'request', selection,
  ), (error: unknown) => error instanceof AcpProtocolError
    && error.reasonCode === 'acp_method_payload_invalid');
});
