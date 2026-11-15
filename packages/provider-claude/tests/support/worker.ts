// ------------------------------------------------------------------------------------------------
//                worker.ts - The real worker process over the scripted SDK stand-in, in a private directory
// ------------------------------------------------------------------------------------------------

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeProviderToolDefinitions } from '@agen-ai/provider-tools/node';
import { startWorker } from '../../dist/node/process.js';
import { WORKER_PROTOCOL } from '../../dist/node/protocol.js';

const SDK = pathToFileURL(new URL('./scripted-sdk.mjs', import.meta.url).pathname).href;

/** The configured model names the scripted SDK's script. */
export async function launch(script: string, limits: Readonly<{ maxBudgetUsd?: number }> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-worker-test-'));
  const temporary = join(directory, 'tmp');
  await mkdir(temporary);
  const started = startWorker({
    directory, home: directory, temporary,
    configure: {
      type: 'configure', protocol: WORKER_PROTOCOL, sdkEntry: SDK, executable: '/bin/false', cwd: directory, model: script, maxTurns: 4, ...limits,
      environment: {}, tools: nodeProviderToolDefinitions().map((definition) => ({ ...definition, inputSchema: { ...definition.inputSchema } })),
    },
  });
  return { directory, temporary, started, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
