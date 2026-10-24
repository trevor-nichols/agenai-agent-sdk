// ------------------------------------------------------------------------------------------------
//                outputDefinition.ts - Explicit Zod output authoring and actual local decoding
// ------------------------------------------------------------------------------------------------

import { normalizeValidationIssues } from '@agen-ai/validation';
import * as core from 'zod/v4/core';

import { createAgentOutputDefinition, type AgentOutputDefinition } from '../structuredOutput/definition.js';
import { StructuredOutputIssues } from '../structuredOutput/issues.js';
import { emitZodOutputSchema } from './outputSchema.js';

export function zodOutput<S extends core.$ZodType>(schema: S): AgentOutputDefinition<core.output<S>> {
  return createAgentOutputDefinition(emitZodOutputSchema(schema), (value) => {
    const parsed = core.safeParse(schema, value);
    if (parsed.success) return { success: true, data: parsed.data };
    const bounded = new StructuredOutputIssues();
    for (const issue of parsed.error.issues) {
      if (bounded.full) break;
      for (const normalized of normalizeValidationIssues([issue], value)) {
        bounded.add(normalized.code, normalized.message, normalized.path);
      }
    }
    return { success: false, issues: bounded.issues };
  });
}
