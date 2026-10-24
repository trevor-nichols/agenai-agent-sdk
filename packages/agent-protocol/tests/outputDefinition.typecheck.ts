// ------------------------------------------------------------------------------------------------
//                outputDefinition.typecheck.ts - Output inference comes from actual decoders
// ------------------------------------------------------------------------------------------------

import {
  createAgentOutputDefinition,
  type AgentJsonObject,
  type AgentOutputDefinition,
  type AgentOutputSchema,
} from '../src/public/index.js';
import { zodOutput } from '../src/zod/index.js';
import { z } from 'zod/v4';

const schema = {
  type: 'object', properties: { title: { type: 'string' } },
  required: ['title'], additionalProperties: false,
} satisfies AgentOutputSchema;
const plain: AgentOutputDefinition<AgentJsonObject> = createAgentOutputDefinition(schema);
const decoded = createAgentOutputDefinition(schema, (value) => typeof value.title === 'string'
  ? { success: true, data: { title: value.title } }
  : { success: false, issues: [{ code: 'invalid_title', path: ['title'], message: 'A title is required.' }] });
const zod = zodOutput(z.strictObject({ title: z.string(), labels: z.array(z.enum(['one', 'two'])).nullable() }));
const neutralInference: AgentOutputDefinition<{ title: string }> = decoded;
const zodInference: AgentOutputDefinition<{ title: string; labels: ('one' | 'two')[] | null }> = zod;

// @ts-expect-error A type parameter without an actual decoder cannot assert an output type.
createAgentOutputDefinition<{ title: string }>(schema);
// @ts-expect-error Schema-only construction retains unknown JSON property types.
const asserted: AgentOutputDefinition<{ title: string }> = createAgentOutputDefinition(schema);
const result = zod.decode({ title: 'Ready', labels: ['one'] });
if (result.success) {
  const title: string = result.data.title;
  // @ts-expect-error The actual parser output has no invented field.
  const absent = result.data.missing;
  // @ts-expect-error The actual parser output preserves its string field type.
  const number: number = result.data.title;
  void [title, absent, number];
}
void [plain, neutralInference, zodInference, asserted];
