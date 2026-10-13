// ------------------------------------------------------------------------------------------------
//                durable.ts - Human-runnable durable setup, restart, inspection and cleanup
// ------------------------------------------------------------------------------------------------

import { DelegationOperationError } from '@agen-ai/agent-orchestration';
import { cleanup, emit, inspect, restart, setup } from './durable/commands.js';
import { scenarios, type Scenario } from './durable/state.js';

async function main(args: readonly string[]) {
  const command = args[0];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !value || !key.startsWith('--') || value.startsWith('--') || options.has(key)) throw new Error('Expected unique --name value arguments.');
    options.set(key, value);
  }
  if (command === 'setup') {
    if ([...options.keys()].some((key) => key !== '--base' && key !== '--scenario')) throw new Error('Setup accepts only --base ABS and --scenario normal|lost-ack|revoked|uncertain.');
    const scenario = options.get('--scenario') ?? 'normal';
    if (!scenarios.includes(scenario)) throw new Error('The durable example scenario is unavailable.');
    await setup(options.get('--base'), scenario as Scenario);
  } else if (command === 'restart' || command === 'inspect' || command === 'cleanup') {
    const root = options.get('--root');
    if (!root || options.size !== 1) throw new Error('Restart, inspect and cleanup require exactly --root ABS.');
    if (command === 'restart') await restart(root);
    else if (command === 'inspect') await inspect(root);
    else await cleanup(root);
  } else throw new Error('Usage: durable.ts setup [--base ABS] [--scenario normal|lost-ack|revoked|uncertain] | restart|inspect|cleanup --root ABS.');
}

try { await main(process.argv.slice(2)); }
catch (error) {
  await emit({ schemaVersion: 1, event: 'error', command: process.argv[2] ?? '',
    code: error instanceof DelegationOperationError ? error.code : 'example_failed',
    message: error instanceof Error ? error.message.slice(0, 512) : 'The durable example command failed.' });
  process.exit(1);
}
