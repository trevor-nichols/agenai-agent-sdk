// ------------------------------------------------------------------------------------------------
//                sdk.ts - Resolve this package's exact Claude Agent SDK dependency for the worker
// ------------------------------------------------------------------------------------------------

import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLAUDE_AGENT_SDK_VERSION, CLAUDE_CODE_VERSION } from '../index.js';

export class NodeClaudeSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NodeClaudeSdkError';
  }
}

/**
 * Resolves the SDK from this package's own dependency closure, never from the worker's directory,
 * and proves the exact SDK and Claude Code tuple before any worker starts.
 */
export async function resolveClaudeSdk(): Promise<string> {
  let entry: string;
  try {
    entry = await realpath(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
  } catch (cause) {
    throw new NodeClaudeSdkError('The Claude Agent SDK dependency is not installed.', { cause });
  }
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')); } catch (cause) {
    throw new NodeClaudeSdkError('The Claude Agent SDK manifest is unreadable.', { cause });
  }
  const fields = manifest as Readonly<Record<string, unknown>> | null;
  if (fields?.name !== '@anthropic-ai/claude-agent-sdk' || fields.version !== CLAUDE_AGENT_SDK_VERSION
    || fields.claudeCodeVersion !== CLAUDE_CODE_VERSION) {
    throw new NodeClaudeSdkError(`The installed Claude Agent SDK is not ${CLAUDE_AGENT_SDK_VERSION} for Claude Code ${CLAUDE_CODE_VERSION}.`);
  }
  return pathToFileURL(entry).href;
}
