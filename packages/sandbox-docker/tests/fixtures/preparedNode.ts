// ------------------------------------------------------------------------------------------------
//                preparedNode.ts - Independent same-runtime environment baseline for process fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function preparedNodeEnvironment(runtime: { readonly executable: string; readonly platform: NodeJS.Platform }): Readonly<Record<string, string>> {
  // Linked Darwin frameworks can add startup state after exec. Compare exact values without
  // granting that exception to the SDK's explicit launch environment or other inherited inputs.
  const result = spawnSync(runtime.executable, ['-e', 'process.stdout.write(JSON.stringify({platform:process.platform,env:process.env}))'], {
    cwd: '/', env: { LANG: 'C', LC_ALL: 'C', PATH: '/nonexistent' }, encoding: 'utf8', timeout: 3000, maxBuffer: 16384,
  });
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.stderr, '');
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected independent Node environment document.');
  assert.equal(Reflect.get(value, 'platform'), runtime.platform);
  const raw: unknown = Reflect.get(value, 'env');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected independent Node environment map.');
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'string') throw new Error('Expected string environment values.');
    environment[key] = entry;
  }
  return Object.freeze(environment);
}
