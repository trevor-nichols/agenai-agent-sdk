// ------------------------------------------------------------------------------------------------
//                outputDefinition.test.ts - Neutral local output definition behavior
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentProtocolValidationError,
  createAgentOutputDefinition,
  type AgentOutputSchema,
} from '../src/public/index.js';

test('output definitions own an immutable schema independent of subsequent caller edits', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string', enum: ['Ready', 'Done'] } },
    required: ['title'], additionalProperties: false,
  } satisfies AgentOutputSchema;
  const definition = createAgentOutputDefinition(schema);
  schema.properties.title.enum[0] = 'Changed';
  schema.required.push('unexpected');
  assert.deepEqual(definition.schema, {
    type: 'object', properties: { title: { type: 'string', enum: ['Ready', 'Done'] } },
    required: ['title'], additionalProperties: false,
  });
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.schema.properties.title), true);
  assert.equal(Object.isFrozen(definition.schema.required), true);
  const value = { title: 'Ready' };
  assert.deepEqual(definition.decode(value), { success: true, data: { title: 'Ready' } });
});

test('neutral definitions use the supplied decoder and preserve its explicit rejection', () => {
  const schema = {
    type: 'object', properties: { title: { type: 'string' } },
    required: ['title'], additionalProperties: false,
  } satisfies AgentOutputSchema;
  const definition = createAgentOutputDefinition(schema, (value) => {
    if (typeof value.title !== 'string' || value.title === 'Reserved') {
      return { success: false, issues: [{ code: 'reserved_title', path: ['title'], message: 'Choose another title.' }] };
    }
    return { success: true, data: { title: value.title } };
  });
  assert.deepEqual(definition.decode({ title: 'Ready' }), { success: true, data: { title: 'Ready' } });
  assert.deepEqual(definition.decode({ title: 'Reserved' }), {
    success: false, issues: [{ code: 'reserved_title', path: ['title'], message: 'Choose another title.' }],
  });
  const invalid: AgentOutputSchema = { ...schema, required: [] };
  assert.throws(() => createAgentOutputDefinition(invalid), AgentProtocolValidationError);
});
