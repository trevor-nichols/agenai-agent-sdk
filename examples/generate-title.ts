import {
  createAgentOutputDefinition,
  parseAgentConfigurationRevisionId,
  parseAgentSessionId,
  parseAgentTurnId,
} from '@agen-ai/agent-protocol';
import type { ValidatedMaterializedAgentProviderInstance } from '@agen-ai/agent-runtime';
import { AgentGenerationError, generateObject } from '@agen-ai/agent-runtime/generation';

const titleOutput = createAgentOutputDefinition({
  type: 'object',
  properties: { title: { type: 'string', minLength: 1, maxLength: 80 } },
  required: ['title'],
  additionalProperties: false,
}, (value) => typeof value.title === 'string'
  ? { success: true, data: { title: value.title } }
  : { success: false, issues: [{ code: 'title_required', path: ['title'], message: 'A title is required.' }] });

// The application chooses the instance, credentials and native tool/sandbox policy.
// A title prompt does not disable provider tools. Use an appropriately restricted instance.
export async function generateAndSaveTitle(input: Readonly<{
  instance: ValidatedMaterializedAgentProviderInstance;
  conversationId: string;
  firstPrompt: string;
  workingDirectory: string;
  saveTitle: (conversationId: string, title: string) => Promise<void>;
  signal?: AbortSignal;
}>): Promise<{ kind: 'saved'; title: string } | { kind: 'unsupported' }> {
  try {
    const result = await generateObject({
      instance: input.instance,
      session: {
        sessionId: parseAgentSessionId(`title:${input.conversationId}`),
        workingDirectory: input.workingDirectory,
        configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('title:configuration:1') },
      },
      turn: {
        turnId: parseAgentTurnId(`title:${input.conversationId}:1`),
        interactionMode: 'default',
        parts: [{ type: 'text', text: `Create a short conversation title for this first prompt:\n${input.firstPrompt}` }],
      },
      output: titleOutput,
      timeoutMs: 30_000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      // No onRequest means unexpected human/tool approvals fail as interaction_required.
    });
    // The session is closed here. Persistence and presentation transforms belong to the app.
    await input.saveTitle(input.conversationId, result.value.title);
    return { kind: 'saved', title: result.value.title };
  } catch (error) {
    if (error instanceof AgentGenerationError && error.code === 'unsupported') return { kind: 'unsupported' };
    // Retain AgentGenerationCleanupError and its retryCleanup handle at the application boundary.
    throw error;
  }
}
