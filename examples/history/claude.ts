// ------------------------------------------------------------------------------------------------
//                Explicit Claude local-history invocation with structural CLI output
// ------------------------------------------------------------------------------------------------

import { isAbsolute } from 'node:path';
import { createClaudeHistory } from '@agen-ai/agent-history/claude';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { browseHistory } from './browse.js';
import { summarizeHistory } from './summary.js';

const usage = 'Provide --config-home /absolute/path --project /absolute/path --temporary-root /absolute/path'
  + ' --resource-launcher /absolute/path [--conversation-id native-id].';

function argumentsFor(argv: readonly string[]) {
  const names = ['config-home', 'project', 'temporary-root', 'resource-launcher', 'conversation-id'];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || !names.includes(flag.slice(2))
      || values.has(flag.slice(2)) || value === undefined || value.startsWith('--')) throw new Error(usage);
    values.set(flag.slice(2), value);
  }
  const path = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || !isAbsolute(value) || value.includes('\0')) throw new Error(usage);
    return value;
  };
  const conversationId = values.get('conversation-id');
  return {
    configHome: path('config-home'),
    projectPath: path('project'),
    temporaryRoot: path('temporary-root'),
    resourceLauncher: path('resource-launcher'),
    conversationId: conversationId === undefined ? undefined : parseAgentProviderConversationId(conversationId),
  };
}

const config = argumentsFor(process.argv.slice(2));
const history = await createClaudeHistory({
  sourceId: 'example-explicit-claude-project',
  generation: 'explicit-config-v1',
  configHome: config.configHome,
  scope: { kind: 'project', projectPath: config.projectPath, worktrees: 'excluded' },
  includeProgrammatic: true,
  resources: {
    kind: 'linux-prlimit', executable: config.resourceLauncher, temporaryRoot: config.temporaryRoot,
  },
});
const result = await browseHistory(history, {
  selectConversation: (conversation) => config.conversationId === undefined
    || conversation.ref.conversationId === config.conversationId,
  pageSize: 1,
  maxPages: 32,
});
process.stdout.write(`${JSON.stringify(summarizeHistory(result), null, 2)}\n`);
