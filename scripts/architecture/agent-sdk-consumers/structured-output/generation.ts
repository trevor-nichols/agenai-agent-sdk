import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import {
  createAgentOutputDefinition, parseAgentConfigurationRevisionId, parseAgentSessionId, parseAgentTurnId,
  type AgentJsonObject,
} from '@agen-ai/agent-protocol';
import { zodOutput } from '@agen-ai/agent-protocol/zod';
import type { ValidatedMaterializedAgentProviderInstance } from '@agen-ai/agent-runtime';
import { generateObject } from '@agen-ai/agent-runtime/generation';

const titleOutput = zodOutput(z.object({ title: z.string() }).strict());
assert.deepEqual(titleOutput.schema, {
  type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false,
});
assert.deepEqual(titleOutput.decode({ title: 'Installed definition' }), {
  success: true, data: { title: 'Installed definition' },
});
assert.throws(() => zodOutput(z.object({ titles: z.array(z.string()).min(1) }).strict()));
assert.throws(() => zodOutput(z.object({ title: z.string().min(1) }).strict()));

// Compilation uses installed declarations, including negative inference controls.
async function verifyGenerationTypes(instance: ValidatedMaterializedAgentProviderInstance) {
  const input = {
    instance,
    session: {
      sessionId: parseAgentSessionId('installed-generation-types'), workingDirectory: '/consumer',
      configuration: { kind: 'managed' as const, revision: parseAgentConfigurationRevisionId('installed-config') },
    },
    turn: {
      turnId: parseAgentTurnId('installed-generation-turn'), interactionMode: 'default' as const,
      parts: [{ type: 'text' as const, text: 'Generate a title.' }],
    },
  };
  const typed = await generateObject({ ...input, output: titleOutput });
  const title: string = typed.value.title;
  // @ts-expect-error The actual Zod decoder yields a string.
  const wrongType: number = typed.value.title;
  // @ts-expect-error A nonexistent field cannot be invented by generation.
  const wrongField: string = typed.value.subtitle;
  const plain = await generateObject({ ...input, output: createAgentOutputDefinition(titleOutput.schema) });
  const json: AgentJsonObject = plain.value;
  // @ts-expect-error Schema-only definitions carry no asserted field-specific TypeScript type.
  const unprovenTitle: string = plain.value.title;
  // @ts-expect-error A generic output type requires an actual decoder.
  createAgentOutputDefinition<{ invented: boolean }>(titleOutput.schema);
  void [title, wrongType, wrongField, json, unprovenTitle];
}
void verifyGenerationTypes;
process.stdout.write(JSON.stringify({ proof: 'packed-generation-definitions', inferred: 'title:string', schemaOnly: 'json-object' }) + '\n');
