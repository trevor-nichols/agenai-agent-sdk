// ------------------------------------------------------------------------------------------------
//                search-child.ts - Pathological globs and selectors through real broker search
// ------------------------------------------------------------------------------------------------

import { ToolSession } from '../../src/node/broker.js';
import { parseToolOptions } from '../../src/node/options.js';
import { createFileRestrictions } from '../../src/node/restrictions.js';
import { memoryHelper } from './helper.js';

const long = 'a'.repeat(60);
const matching = `${'a'.repeat(40)}b`;
const pattern = `${'*a'.repeat(30)}b`;
const memory = memoryHelper({ [long]: 'needle', [matching]: 'needle', nested: 'directory', [`nested/${long}`]: 'needle' });
const options = parseToolOptions({
  workspace: { storeDirectory: '/var/tmp/store', workspaceDirectory: '/var/tmp/store/work' }, stateParentDirectory: '/var/tmp/state',
  bubblewrapPath: '/usr/bin/bwrap', filesystemHelperPath: '/usr/local/bin/helper', restrictions: { denyRead: [`${'*a'.repeat(30)}c`] },
});
const tools = new ToolSession({
  helper: memory.helper, bubblewrap: { path: '/nonexistent/bwrap', sha256: '0'.repeat(64), identity: 'never-launched' },
  restrictions: createFileRestrictions(options.restrictions), options, editApproval: 'automatic',
});
const observer = { started() {}, approve: async () => 'denied' as const };
const run = (tool: string, input: unknown) => tools.call({ tool, input, observer, signal: new AbortController().signal });
const glob = await run('glob', { pattern });
const grep = await run('grep', { pattern: 'needle', glob: `**/${pattern}` });
const read = await run('read', { file_path: `nested/${long}` });
await tools.close();
process.stdout.write(JSON.stringify({ glob: glob.text, grep: grep.text, read: [read.status, read.text] }));
