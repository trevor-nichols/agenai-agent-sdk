// ------------------------------------------------------------------------------------------------
//                process-peer.mjs - Controlled binary guest and detached descendant - MS004 fixture
// ------------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.version !== 'v24.18.0') throw new Error('The controlled process fixture requires Node v24.18.0.');
const scenario = process.argv[2];
const marker = process.argv[3];
if (!['leader', 'descendant'].includes(scenario) || !/^agenai-ms004-descendant-[a-f0-9-]+$/u.test(marker ?? '')) {
  throw new Error('An explicit controlled process scenario and descendant marker are required.');
}
const readyPath = resolve('descendant.json');

if (scenario === 'descendant') {
  let sequence = 0;
  const heartbeat = () => {
    writeFileSync(`${readyPath}.next`, `${JSON.stringify({ marker, pid: process.pid, node: process.version, sequence: sequence++ })}\n`, { mode: 0o600 });
    renameSync(`${readyPath}.next`, readyPath);
  };
  heartbeat();
  setInterval(heartbeat, 50);
} else {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > 64 * 1024) throw new Error('The controlled binary input exceeded its fixture bound.');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  const artifact = Buffer.concat([Buffer.from([65, 82, 84, 0, 255]), input, Buffer.from([128, 10])]);
  await writeFile(resolve('artifact.bin.next'), artifact, { mode: 0o600 });
  await rename(resolve('artifact.bin.next'), resolve('artifact.bin'));
  await new Promise((resolveWrite, reject) => process.stdout.write(input, (error) => error ? reject(error) : resolveWrite()));
  await new Promise((resolveWrite, reject) => process.stderr.write(Buffer.from([254, 0, 69, 82, 82, 13, 10, 255]),
    (error) => error ? reject(error) : resolveWrite()));
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', marker], {
    detached: true, stdio: 'ignore', cwd: process.cwd(), env: { HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  descendant.unref();
  const deadline = performance.now() + 5000;
  for (;;) {
    let ready;
    try { ready = JSON.parse(await readFile(readyPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ready?.marker === marker && ready.pid === descendant.pid) break;
    if (performance.now() >= deadline) throw new Error('The detached descendant did not become ready.');
    await delay(20);
  }
  process.exitCode = 23;
}
