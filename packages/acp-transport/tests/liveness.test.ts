import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/liveness.ts', import.meta.url));

for (const [scenario, behavior] of [
  ['deadline', 'settles an unanswered request at its deadline'],
  ['reverse-drain', 'finishes shutdown when a reverse handler never settles'],
  ['notification-drain', 'finishes shutdown when a notification handler never settles'],
  ['response', 'releases request and shutdown timers after a response'],
  ['remote-error', 'releases request and shutdown timers after a remote error'],
  ['abort', 'releases request and shutdown timers after cancellation'],
  ['dispose', 'releases request and shutdown timers after disposal'],
] as const) {
  test(`with no other event-loop handles, the client ${behavior}`, async () => {
    // A parent-side timeout bounds a hang without keeping the child's event loop alive.
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', fixture, scenario], {
      timeout: 10_000,
      maxBuffer: 64 * 1_024,
    });
    assert.equal(stdout.trim(), 'settled');
  });
}
