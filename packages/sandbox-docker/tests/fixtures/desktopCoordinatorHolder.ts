import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type HolderPeerScenario = 'normal' | 'held_commit' | 'wrong_check' | 'malformed_check' | 'utf8_check'
  | 'oversized_check' | 'bad_read_digest' | 'bad_commit_digest' | 'unsolicited_check' | 'diagnostic_check' | 'lost_check'
  | 'truncated_check' | 'unsolicited_open' | 'missing_close';

export interface HolderPeerEvent {
  readonly event: string;
  readonly text?: string;
  readonly bytes?: number;
  readonly declaredBytes?: number;
  readonly mode?: string;
  readonly engineKey?: string;
  readonly pid?: number;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** An adversarial process peer owns framing independently of the holder transport. */
export async function coordinatorHolderPeer(scenario: HolderPeerScenario, gateExit = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agenai-coordinator-holder-')));
  const executablePath = join(directory, 'peer');
  const scriptPath = join(directory, 'peer.mjs');
  const tracePath = join(directory, 'trace.jsonl');
  const releasePath = join(directory, 'release-exit');
  const script = String.raw`
import { createHash } from 'node:crypto';
import { appendFile, stat } from 'node:fs/promises';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
const scenario = ${JSON.stringify(scenario)};
const tracePath = ${JSON.stringify(tracePath)};
const releasePath = ${JSON.stringify(releasePath)};
const gateExit = ${JSON.stringify(gateExit)};
const identity = { stateDevice: '101', stateInode: '202' };
let text = '{"initial":"original"}';
let fenced = false;
const trace = (value) => appendFile(tracePath, JSON.stringify(value) + '\n');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const write = (bytes) => new Promise((resolve, reject) => process.stdout.write(bytes, (error) => error ? reject(error) : resolve()));
const reply = (value) => write(JSON.stringify(value) + '\n');
await trace({ event: 'started', mode: process.argv[2], engineKey: process.argv[3], pid: process.pid });
const opening = Buffer.from(JSON.stringify({ kind: 'opened', initial: 'existing', rootDevice: '1', rootInode: '2',
  lockDevice: '3', lockInode: '4', ...identity, pendingTemp: false }) + '\n');
await write(opening.subarray(0, 11)); await turn();
await write(scenario === 'unsolicited_open' ? Buffer.concat([opening.subarray(11), Buffer.from('{"kind":"checked","fenced":false}\n')])
  : opening.subarray(11));
let bytes = Buffer.alloc(0);
let commitLength;
let closing = false;
async function command(line, payload) {
  if (line === 'COMMIT') {
    await trace({ event: line, text: payload.toString('utf8'), bytes: payload.length, declaredBytes: commitLength });
    text = payload.toString('utf8');
    if (scenario === 'held_commit' && !fenced) {
      fenced = true;
      await reply({ kind: 'failure', reason: 'publication_sync', errno: 5, claim: 'held' });
    } else await reply({ kind: 'committed', digest: scenario === 'bad_commit_digest' ? '0'.repeat(64) : hash(payload), ...identity });
    return;
  }
  await trace({ event: line });
  if (line === 'READ') {
    const value = Buffer.from(JSON.stringify({ kind: 'snapshot', text,
      digest: scenario === 'bad_read_digest' ? '0'.repeat(64) : hash(text), ...identity, pendingTemp: false }) + '\n');
    const split = Math.max(1, value.indexOf(Buffer.from('雪')) + 1);
    await write(value.subarray(0, split)); await turn(); await write(value.subarray(split));
  } else if (line === 'CHECK') {
    if (scenario === 'wrong_check') await reply({ kind: 'cleanup' });
    else if (scenario === 'malformed_check') await write('{oops\n');
    else if (scenario === 'utf8_check') await write(Buffer.from([0xff, 0x0a]));
    else if (scenario === 'oversized_check') await write(Buffer.alloc(6_291_593, 32));
    else if (scenario === 'diagnostic_check') process.stderr.write('unexpected native diagnostic\n');
    else if (scenario === 'truncated_check') { await write('{"kind":"checked"'); closing = true; }
    else if (scenario === 'lost_check') await reply({ kind: 'failure', reason: 'root_substituted', errno: 70, claim: 'lost' });
    else if (scenario === 'unsolicited_check') await write('{"kind":"checked","fenced":false}\n{"kind":"checked","fenced":false}\n');
    else await reply({ kind: 'checked', fenced });
  } else if (line === 'CLEANUP') await reply({ kind: 'cleanup' });
  else if (line === 'CLOSE') {
    if (scenario === 'missing_close') { closing = true; return; }
    await reply({ kind: 'closed' }); await trace({ event: 'closed_reply' });
    if (gateExit) {
      for (;;) {
        try { await stat(releasePath); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(5);
      }
    }
    closing = true;
  } else throw new Error('Unexpected peer command');
}
for await (const chunk of process.stdin) {
  bytes = Buffer.concat([bytes, chunk]);
  for (;;) {
    if (commitLength !== undefined) {
      if (bytes.length < commitLength + 1) break;
      if (bytes[commitLength] !== 10) throw new Error('Missing payload terminator');
      const payload = bytes.subarray(0, commitLength);
      bytes = bytes.subarray(commitLength + 1);
      await command('COMMIT', payload); commitLength = undefined;
    } else {
      const newline = bytes.indexOf(10); if (newline < 0) break;
      const line = bytes.subarray(0, newline).toString('ascii'); bytes = bytes.subarray(newline + 1);
      if (line.startsWith('COMMIT ')) {
        if (!/^COMMIT [1-9][0-9]*$/.test(line)) throw new Error('Invalid commit length');
        commitLength = Number(line.slice(7));
        if (commitLength > 1_048_428) throw new Error('Payload over capacity');
      } else await command(line);
    }
    if (closing) break;
  }
  if (closing) break;
}
await trace({ event: 'exiting' });
`;
  const executable = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`;
  await writeFile(scriptPath, script, { flag: 'wx', mode: 0o600 });
  await writeFile(executablePath, executable, { flag: 'wx', mode: 0o700 });
  async function events(): Promise<readonly HolderPeerEvent[]> {
    let text: string;
    try { text = await readFile(tracePath, 'utf8'); }
    catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return []; throw cause; }
    return text.trim().split('\n').filter(Boolean).map((line: string): HolderPeerEvent => JSON.parse(line));
  }
  return Object.freeze({ directory,
    executable: Object.freeze({ path: executablePath, sha256: createHash('sha256').update(executable).digest('hex') }),
    events,
    async waitFor(event: string): Promise<HolderPeerEvent> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const found = (await events()).find((entry) => entry.event === event);
        if (found) return found;
        await delay(5);
      }
      throw new Error(`Protocol peer did not reach ${event}.`);
    },
    releaseExit: () => writeFile(releasePath, ''),
    remove: () => rm(directory, { recursive: true, force: true }),
  });
}
