import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

test('the worker channel names each request still awaiting its supervisor receipt', async () => {
  const program = `import { controllerChannel } from ${JSON.stringify(new URL('./channel.mjs', import.meta.url).href)};
    const channel = controllerChannel(5000, 8);
    const answered = channel.request('observation', {}); const awaited = channel.request('checkpoint', {});
    void awaited.catch(() => {});
    await answered; process.send({ kind: 'outstanding', value: channel.outstanding() }); channel.close();`;
  const child = fork('--input-type=module', ['-e', program], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let outstanding;
  child.on('message', (message) => {
    if (message.kind === 'observation') child.send({ kind: 'reply', id: message.id, value: null });
    if (message.kind === 'outstanding') outstanding = message.value;
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(outstanding, [{ id: 2, kind: 'checkpoint' }]);
});
