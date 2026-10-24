// ------------------------------------------------------------------------------------------------
//                guest.mjs - Full-byte fixture verification before owned symlink/FIFO safety setup
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';

const root = process.argv.at(-1);
assert.equal(root, '/workspace/work');
const verification = JSON.parse(execFileSync('/usr/local/bin/node', ['control/guest.mjs', root], { cwd: root,
  encoding: 'utf8', maxBuffer: 16 * 1024, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/sandbox', TMPDIR: '/tmp' } }));
for (const name of ['safety', 'safety/subtree-link', 'safety/subtree-fifo']) await mkdir(`${root}/${name}`, { mode: 0o700 });
await symlink('../artifacts', `${root}/safety/ancestor`);
await symlink('../artifacts/nested/result.bin', `${root}/safety/final.bin`);
await symlink('../artifacts', `${root}/safety/root-link`);
await writeFile(`${root}/safety/subtree-link/a-good.txt`, 'A provisional regular file before a rejected link.\n', { flag: 'wx' });
await symlink('/etc/passwd', `${root}/safety/subtree-link/z-poison`);
await writeFile(`${root}/safety/subtree-fifo/a-good.txt`, 'A provisional regular file before a rejected FIFO.\n', { flag: 'wx' });
execFileSync('/usr/bin/mkfifo', [`${root}/safety/subtree-fifo/z-poison`], { stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } });
process.stdout.write(`${JSON.stringify({ verification, safety: { ancestorSymlink: true, finalSymlink: true, subtreeRootSymlink: true,
  selectedSubtreeLink: true, selectedSubtreeFifo: true }, setupProcessesJoined: true })}\n`);
