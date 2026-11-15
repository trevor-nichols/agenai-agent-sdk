import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSandboxRelativePath } from '@agen-ai/sandbox';
import { ToolSession } from '../src/node/broker.js';
import type { NodeProviderToolApprovalRequest, NodeProviderToolObserver, NodeProviderToolStart } from '../src/node/contracts.js';
import type { VerifiedExecutable } from '../src/node/identity.js';
import { parseToolOptions } from '../src/node/options.js';
import { createFileRestrictions } from '../src/node/restrictions.js';
import type { NodeProviderFileRestrictions, NodeProviderToolLimits } from '../src/types.js';
import { memoryHelper, type CommitScript } from './support/helper.js';
import { FAKE_PID, fakeLauncher, fakeProc, report, type ProcState } from './support/launcher.js';

const WORKSPACE = '/var/tmp/store/work';
const UNUSED_BUBBLEWRAP = Object.freeze({ path: '/nonexistent/bwrap', sha256: '0'.repeat(64), identity: 'never-launched' });

function session(files: Parameters<typeof memoryHelper>[0], setup: Readonly<{
  commits?: Readonly<Record<string, CommitScript>>; restrictions?: NodeProviderFileRestrictions; limits?: NodeProviderToolLimits; editApproval?: 'automatic' | 'host';
  bubblewrap?: VerifiedExecutable;
}> = {}) {
  const memory = memoryHelper(files, setup.commits);
  const options = parseToolOptions({
    workspace: { storeDirectory: '/var/tmp/store', workspaceDirectory: WORKSPACE }, stateParentDirectory: '/var/tmp/state',
    bubblewrapPath: '/usr/bin/bwrap', filesystemHelperPath: '/usr/local/bin/helper',
    ...(setup.restrictions ? { restrictions: setup.restrictions } : {}), ...(setup.limits ? { limits: setup.limits } : {}),
  });
  const tools = new ToolSession({ helper: memory.helper, bubblewrap: setup.bubblewrap ?? UNUSED_BUBBLEWRAP, restrictions: createFileRestrictions(options.restrictions),
    options, editApproval: setup.editApproval ?? 'automatic' });
  return { memory, tools };
}

function host(decide: (request: NodeProviderToolApprovalRequest, signal: AbortSignal) => Promise<'approved' | 'denied'> = async () => 'approved') {
  const starts: NodeProviderToolStart[] = [];
  const requests: NodeProviderToolApprovalRequest[] = [];
  const observer: NodeProviderToolObserver = {
    started: (start) => { starts.push(start); },
    approve: (request, signal) => { requests.push(request); return decide(request, signal); },
  };
  return { observer, starts, requests };
}

const call = (tools: ToolSession, observer: NodeProviderToolObserver, tool: string, input: unknown, signal = new AbortController().signal) =>
  tools.call({ tool, input, observer, signal });

test('accept-edits publishes unrestricted edits directly while protected and restricted paths still ask', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'a.txt': 'one two', sub: 'directory', 'sub/CLAUDE.md': 'rules', 'secret.txt': 'x' },
    { restrictions: { denyEdit: ['secret.txt'] } });
  const approvals = host(async () => 'denied');

  const edited = await call(tools, approvals.observer, 'edit', { file_path: `${WORKSPACE}/a.txt`, old_string: 'two', new_string: '2' });
  assert.equal(edited.status, 'completed');
  assert.deepEqual(edited.changes, [{ path: 'a.txt', change: 'modified' }]);
  assert.equal(memory.text('a.txt'), 'one 2');

  const protectedEdit = await call(tools, approvals.observer, 'write', { file_path: 'sub/CLAUDE.md', content: 'new rules' });
  assert.equal(protectedEdit.status, 'denied');
  assert.deepEqual(approvals.requests, [{ kind: 'edit', paths: ['sub/CLAUDE.md'], reason: 'restricted' }]);
  assert.equal(memory.text('sub/CLAUDE.md'), 'rules');

  const denied = await call(tools, approvals.observer, 'write', { file_path: 'secret.txt', content: 'y' });
  assert.equal(denied.status, 'denied');
  assert.equal(approvals.requests.length, 1);
  assert.equal(memory.text('secret.txt'), 'x');
  await tools.close();
});

test('edit admission refuses unreportable paths before any batch member is read or published', { timeout: 5000 }, async () => {
  const parent = 'a'.repeat(250);
  const boundary = `${parent}/${'b'.repeat(249)}`;
  const { memory, tools } = session({ [parent]: 'directory', 'a.txt': 'original' });
  const approvals = host();
  for (const invalid of [`${boundary}b`, ' notes.txt', 'notes.txt ']) {
    for (const [tool, input] of [
      ['write', { file_path: invalid, content: 'new' }],
      ['edit', { file_path: invalid, old_string: 'old', new_string: 'new' }],
      ['patch', { changes: [{ file_path: 'a.txt', content: 'changed' }, { file_path: invalid, content: 'new' }] }],
    ] as const) {
      const result = await call(tools, approvals.observer, tool, input);
      assert.deepEqual([result.status, result.refusal, result.changes], ['refused', 'invalid_input', []]);
    }
  }
  assert.deepEqual(memory.operations, []);
  assert.equal(memory.text('a.txt'), 'original');
  const accepted = await call(tools, approvals.observer, 'write', { file_path: `${WORKSPACE}/${boundary}`, content: 'at the boundary' });
  assert.deepEqual([accepted.status, accepted.changes], ['completed', [{ path: boundary, change: 'created' }]]);
  assert.equal(memory.text(boundary), 'at the boundary');
  await tools.close();
});

test('dense grep results are bounded without fencing subsequent tools', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'dense.txt': 'x\n'.repeat(150_000) });
  const result = await call(tools, host().observer, 'grep', { pattern: 'x' });
  assert.equal(result.status, 'completed');
  assert.ok(result.text.startsWith('dense.txt:1:x\ndense.txt:2:x\n'));
  assert.match(result.text, /\[results truncated at their bound\]$/u);
  assert.ok(Buffer.byteLength(result.text) <= 65_536);
  const written = await call(tools, host().observer, 'write', { file_path: 'after.txt', content: 'still usable' });
  assert.equal(written.status, 'completed');
  assert.equal(memory.text('after.txt'), 'still usable');
  await tools.close();
});

test('replacement expansion is refused before allocation or publication and leaves the session usable', { timeout: 5000 }, async (t) => {
  const original = 'a'.repeat(1_048_576);
  const { memory, tools } = session({ 'large.txt': original });
  t.after(() => tools.close());
  const refused = await call(tools, host().observer, 'edit', {
    file_path: 'large.txt', old_string: 'a', new_string: 'b'.repeat(1024), replace_all: true,
  });
  assert.deepEqual([refused.status, refused.fence, refused.changes], ['failed', undefined, []]);
  assert.match(refused.text, /new content exceeds 1048576 bytes/u);
  assert.equal(memory.text('large.txt'), original);
  assert.equal(memory.operations.some((operation) => operation.startsWith('write')), false);
  const read = await call(tools, host().observer, 'read', { file_path: 'large.txt' });
  assert.equal(read.status, 'completed');
  assert.ok(read.text.startsWith('aaaa'));
});

test('replacement limits count persisted UTF-8 bytes across replacement boundaries', async (t) => {
  for (const [original, old_string, new_string, fileBytes, expected] of [
    ['aaa', 'a', '界', 9, '界界界'],
    ['aaa', 'a', '界', 8, undefined],
    ['😀', '\ud83d', '\ud83d', 4, '😀'],
    ['😀', '\ude00', 'xxx', 4, undefined],
    ['😀', '\ude00', 'x', 4, '\ufffdx'],
  ] as const) {
    const { memory, tools } = session({ 'a.txt': original }, { limits: { fileBytes } });
    t.after(() => tools.close());
    const result = await call(tools, host().observer, 'edit', { file_path: 'a.txt', old_string, new_string, replace_all: true });
    assert.deepEqual([result.status, result.fence], [expected === undefined ? 'failed' : 'completed', undefined]);
    assert.equal(memory.text('a.txt'), expected ?? original);
    if (expected === undefined) assert.equal(memory.operations.some((operation) => operation.startsWith('write')), false);
  }
});

test('grep discloses files skipped by cumulative and per-file byte limits and a narrowed scan finds the match', async (t) => {
  const full = 'x'.repeat(1_048_576);
  const { memory, tools } = session({ 'a.txt': full, 'b.txt': full, 'c.txt': full, 'd.txt': full,
    'e.txt': 'needle', 'oversized.txt': `${full}needle` });
  t.after(() => tools.close());
  const result = await call(tools, host().observer, 'grep', { pattern: 'needle' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'No matches.\n[1 file(s) exceed the file byte limit]\n[1 file(s) skipped at the search byte limit]');
  assert.equal(memory.operations.includes('read e.txt'), false);
  const narrowed = await call(tools, host().observer, 'grep', { pattern: 'needle', glob: 'e.txt' });
  assert.deepEqual([narrowed.status, narrowed.text], ['completed', 'e.txt:1:needle']);
});

test('host edit policy asks once per batch with the exact paths and a denial publishes nothing', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'a.txt': 'a', 'b.txt': 'b' }, { editApproval: 'host' });
  const approvals = host(async () => 'denied');
  const result = await call(tools, approvals.observer, 'patch', { changes: [{ file_path: 'a.txt', content: 'A' }, { file_path: 'c.txt', content: 'C' }] });
  assert.equal(result.status, 'denied');
  assert.deepEqual(approvals.starts, [{ kind: 'edit', paths: ['a.txt', 'c.txt'] }]);
  assert.deepEqual(approvals.requests, [{ kind: 'edit', paths: ['a.txt', 'c.txt'], reason: 'host_policy' }]);
  assert.deepEqual([memory.text('a.txt'), memory.text('c.txt')], ['a', undefined]);
  assert.equal(memory.operations.some((operation) => operation.startsWith('write')), false);
  await tools.close();
});

test('a patch whose later member cannot apply is refused before any publication', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'a.txt': 'alpha', 'b.txt': 'beta beta' });
  const result = await call(tools, host().observer, 'patch', { changes: [
    { file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' },
    { file_path: 'b.txt', old_string: 'beta', new_string: 'BETA' },
  ] });
  assert.equal(result.status, 'failed');
  assert.match(result.text, /occurs 2 times/u);
  assert.deepEqual(result.changes, []);
  assert.equal(memory.text('a.txt'), 'alpha');
  assert.equal(tools.fence, undefined);
  await tools.close();
});

for (const [approval, setup] of [
  ['host', { editApproval: 'host' }],
  ['edit restriction', { restrictions: { askEdit: ['b.txt'] } }],
] as const) {
  for (const scenario of ['preserve user save', 'missing old text', 'patch precondition'] as const) {
    test(`${approval} edits prepare current contents after approval: ${scenario}`, async (t) => {
      const { memory, tools } = session({ 'a.txt': 'alpha', 'b.txt': 'old\n' }, setup);
      t.after(() => tools.close());
      const saved = scenario === 'preserve user save' ? 'old\nuser save\n' : 'user save\n';
      const approvals = host(async () => {
        // A caller saves the file while the broker waits for an approval decision.
        const written = await memory.helper.client.writeFile(parseSandboxRelativePath('b.txt'),
          (async function* () { yield Buffer.from(saved); })(),
          { mode: 'replace', signal: new AbortController().signal, chunkBytes: 65_536, quotas: {} });
        assert.equal(written.kind, 'completed');
        return 'approved';
      });
      const edit = { file_path: 'b.txt', old_string: 'old', new_string: 'new' };
      const result = scenario === 'patch precondition'
        ? await call(tools, approvals.observer, 'patch', { changes: [{ file_path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' }, edit] })
        : await call(tools, approvals.observer, 'edit', edit);
      assert.equal(approvals.requests.length, 1);
      assert.equal(result.fence, undefined);
      assert.equal(memory.text('a.txt'), 'alpha');
      if (scenario === 'preserve user save') {
        assert.equal(result.status, 'completed');
        assert.equal(memory.text('b.txt'), 'new\nuser save\n');
      } else {
        assert.equal(result.status, 'failed');
        assert.match(result.text, /old_string was not found/u);
        assert.deepEqual(result.changes, []);
        assert.equal(memory.text('b.txt'), saved);
      }
    });
  }
}

for (const [script, fence] of [['changed', 'publication_changed'], ['published_uncertain', 'publication_uncertain']] as const) {
  test(`a ${script} publication keeps its known effect, stops the batch and fences later effects`, { timeout: 5000 }, async () => {
    const { memory, tools } = session({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }, { commits: { 'b.txt': script } });
    const approvals = host();
    const result = await call(tools, approvals.observer, 'patch', { changes: [
      { file_path: 'a.txt', content: 'A' }, { file_path: 'b.txt', content: 'B' }, { file_path: 'c.txt', content: 'C' },
    ] });
    assert.equal(result.status, 'failed');
    assert.equal(result.fence, fence);
    assert.deepEqual(result.changes, [{ path: 'a.txt', change: 'modified' }, { path: 'b.txt', change: 'modified' }]);
    assert.match(result.text, /1 later change\(s\) were not attempted/u);
    assert.equal(memory.text('c.txt'), 'c');

    const operations = memory.operations.length;
    const later = await call(tools, approvals.observer, 'read', { file_path: 'a.txt' });
    assert.equal(later.status, 'refused');
    assert.equal(later.fence, fence);
    assert.equal(memory.operations.length, operations);
    assert.deepEqual(approvals.starts.length, 1);
    await tools.close();
  });
}

test('a lost commit acknowledgement is an unknown publication that fences the session and its cleanup', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'a.txt': 'a' }, { commits: { 'a.txt': 'lost' } });
  const result = await call(tools, host().observer, 'write', { file_path: 'a.txt', content: 'A' });
  assert.equal(result.fence, 'publication_unknown');
  assert.deepEqual(result.changes, []);
  assert.match(result.text, /publication is uncertain/u);
  assert.equal(memory.text('a.txt'), 'A');
  await assert.rejects(tools.close(), /helper did not close/u);
  await assert.rejects(tools.close(), /helper did not close/u);
  assert.equal(memory.closes, 2);
});

test('every command waits for exact host approval and a denial or oversized command runs nothing', { timeout: 5000 }, async () => {
  const { tools } = session({});
  const approvals = host(async () => 'denied');
  const command = 'printf "%s" "$(cat a.txt)" > b.txt && rm -rf build';
  const denied = await call(tools, approvals.observer, 'bash', { command });
  assert.equal(denied.status, 'denied');
  assert.deepEqual(approvals.requests, [{ kind: 'command', command }]);
  assert.equal(denied.command, undefined);

  const oversized = await call(tools, approvals.observer, 'bash', { command: 'x'.repeat(16_385) });
  assert.equal(oversized.status, 'refused');
  assert.equal(approvals.requests.length, 1);
  assert.equal(tools.fence, undefined);
  await tools.close();
});

for (const [tool, input] of [['bash', { command: 'echo hi' }], ['write', { file_path: 'a.txt', content: 'A' }]] as const) {
  test(`a cancellation that lands once the ${tool} approval is delivered still performs no effect`, { timeout: 5000 }, async () => {
    const { memory, tools } = session({ 'a.txt': 'a' }, { editApproval: 'host' });
    const turn = new AbortController();
    const approvals = host(async (_request, signal) => {
      signal.addEventListener('abort', () => turn.abort(), { once: true });
      return 'approved';
    });
    const result = await call(tools, approvals.observer, tool, input, turn.signal);
    assert.deepEqual([result.status, result.fence, result.command, result.changes], ['canceled', undefined, undefined, []]);
    assert.equal(approvals.requests.length, 1);
    assert.equal(memory.text('a.txt'), 'a');
    assert.equal(memory.operations.some((operation) => operation.startsWith('write')), false);
    await tools.close();
  });
}

test('unknown tools and inputs with unrecognized fields are refused before they start', { timeout: 5000 }, async () => {
  const { tools } = session({ 'a.txt': 'a' });
  const approvals = host();
  const unknown = await call(tools, approvals.observer, 'WebFetch', { url: 'https://example.com' });
  const extra = await call(tools, approvals.observer, 'bash', { command: 'sleep 9', run_in_background: true });
  assert.deepEqual([unknown.status, unknown.tool, extra.status, extra.tool], ['refused', null, 'refused', null]);
  assert.match(extra.text, /run_in_background|Unrecognized/u);
  assert.deepEqual([approvals.starts, approvals.requests], [[], []]);
  await tools.close();
});

test('read restrictions withhold search results and ask before a direct read', { timeout: 5000 }, async () => {
  const { tools } = session({
    'a.ts': 'needle', 'link.ts': 'symlink', src: 'directory', 'src/b.ts': 'hay needle', 'src/c.md': 'needle',
    'private.ts': 'needle', 'ask.ts': 'needle',
  }, { restrictions: { denyRead: ['private.ts'], askRead: ['ask.ts'] } });
  const approvals = host(async () => 'denied');

  const globbed = await call(tools, approvals.observer, 'glob', { pattern: '*.ts' });
  assert.deepEqual(globbed.text.split('\n'), ['a.ts', 'src/b.ts', '[2 restricted file(s) withheld]', '[1 link, special or unlistable entries not followed]']);
  const grepped = await call(tools, approvals.observer, 'grep', { pattern: 'needle', path: 'src', glob: '*.ts' });
  assert.deepEqual(grepped.text.split('\n'), ['src/b.ts:1:hay needle']);
  assert.equal(approvals.requests.length, 0);

  const asked = await call(tools, approvals.observer, 'read', { file_path: 'ask.ts' });
  const blocked = await call(tools, approvals.observer, 'read', { file_path: 'private.ts' });
  const outside = await call(tools, approvals.observer, 'read', { file_path: '/etc/passwd' });
  assert.deepEqual([asked.status, blocked.status, outside.status], ['denied', 'denied', 'refused']);
  assert.deepEqual(approvals.requests, [{ kind: 'read', path: 'ask.ts' }]);
  await tools.close();
});

test('an edit of a read-protected file asks before its contents are inspected, so a denied guess discloses nothing', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'secret.txt': 'sensitive-token' }, { restrictions: { askRead: ['secret.txt'] } });
  const denying = host(async () => 'denied');
  const guesses = [];
  for (const old_string of ['wrong-guess', 'sensitive-token']) {
    guesses.push(await call(tools, denying.observer, 'edit', { file_path: 'secret.txt', old_string, new_string: 'replaced' }));
  }
  assert.deepEqual(guesses.map((result) => [result.status, result.text]), [
    ['denied', 'Edit not performed: the host denied it.'], ['denied', 'Edit not performed: the host denied it.'],
  ]);
  assert.deepEqual(denying.requests, [
    { kind: 'edit', paths: ['secret.txt'], reason: 'restricted' }, { kind: 'edit', paths: ['secret.txt'], reason: 'restricted' },
  ]);
  assert.equal(memory.operations.includes('read secret.txt'), false);

  const approving = host();
  const approved = await call(tools, approving.observer, 'edit', { file_path: 'secret.txt', old_string: 'wrong-guess', new_string: 'replaced' });
  assert.deepEqual([approved.status, approved.text], ['failed', 'Edit not applied: secret.txt: old_string was not found.']);
  assert.equal(approving.requests.length, 1);
  assert.equal(memory.text('secret.txt'), 'sensitive-token');
  await tools.close();
});

test('a command whose namespace report is invalid stays an unsettled owner: later effects fence and close cannot succeed', { timeout: 20_000 }, async (t) => {
  const launcher = await fakeLauncher(t, { info: '{"child-pid": 41' });
  const { memory, tools } = session({ 'a.txt': 'a' }, { bubblewrap: launcher.executable });
  const result = await call(tools, host().observer, 'bash', { command: 'echo hi' });
  assert.deepEqual([result.fence, result.command?.joined], ['command_unjoined', false]);
  assert.equal((await call(tools, host().observer, 'read', { file_path: 'a.txt' })).status, 'refused');
  await assert.rejects(tools.close(), { code: 'namespace_unavailable' });
  await assert.rejects(tools.close(), { code: 'namespace_unavailable' });
  assert.equal(memory.closes, 1);
});

for (const observed of ['unreadable', 'malformed'] as const satisfies readonly ProcState[]) {
  test(`a namespace observation that is ${observed} is not a join: the session fences until disappearance is confirmed`, { timeout: 30_000 }, async (t) => {
    const states = new Map<number, ProcState>([[FAKE_PID, observed]]);
    fakeProc(t, states);
    const launcher = await fakeLauncher(t, { info: report(FAKE_PID) });
    const { memory, tools } = session({ 'a.txt': 'a' }, { bubblewrap: launcher.executable });
    const result = await call(tools, host().observer, 'bash', { command: 'echo hi' });
    assert.deepEqual([result.status, result.fence, result.command?.joined], ['failed', 'command_unjoined', false]);
    assert.equal((await call(tools, host().observer, 'write', { file_path: 'a.txt', content: 'A' })).status, 'refused');
    await assert.rejects(tools.close(), { code: 'namespace_unavailable' });
    states.set(FAKE_PID, 'gone');
    await tools.close();
    await tools.close();
    assert.deepEqual([memory.closes, memory.text('a.txt')], [1, 'a']);
  });
}

test('cancellation withdraws a pending approval without an effect and the queue stays bounded', { timeout: 5000 }, async () => {
  const { memory, tools } = session({ 'a.txt': 'a' }, { editApproval: 'host', limits: { pendingCalls: 2 } });
  let withdrawn: AbortSignal | undefined;
  const approvals = host((_request, signal) => { withdrawn = signal; return new Promise(() => {}); });
  const turn = new AbortController();
  const pending = call(tools, approvals.observer, 'write', { file_path: 'a.txt', content: 'A' }, turn.signal);
  const queued = call(tools, approvals.observer, 'read', { file_path: 'a.txt' }, turn.signal);
  const overflow = await call(tools, approvals.observer, 'read', { file_path: 'a.txt' });
  assert.equal(overflow.status, 'refused');
  assert.match(overflow.text, /too many/u);

  await new Promise((resolve) => setImmediate(resolve));
  turn.abort();
  const [first, second] = await Promise.all([pending, queued]);
  assert.deepEqual([first.status, second.status], ['canceled', 'canceled']);
  assert.equal(withdrawn?.aborted, true);
  assert.equal(memory.text('a.txt'), 'a');
  await tools.idle();
  assert.equal((await call(tools, approvals.observer, 'read', { file_path: 'a.txt' })).text, 'a');
  await tools.close();
  assert.equal((await call(tools, approvals.observer, 'read', { file_path: 'a.txt' })).status, 'refused');
});

test('every refusal the tools decide carries its category, and a host decision carries none', { timeout: 5000 }, async () => {
  const { tools } = session({ 'a.txt': 'a', 'secret.txt': 's', 'guarded.txt': 'g' },
    { restrictions: { denyEdit: ['secret.txt'], denyRead: ['secret.txt'], askEdit: ['guarded.txt'] } });
  const approvals = host(async () => 'denied');
  const rows: Array<[string, unknown, string, string | undefined, boolean]> = [
    ['write', { file_path: '/etc/passwd', content: 'x' }, 'refused', 'outside_workspace', false],
    ['patch', { changes: [{ file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }] },
      'refused', 'outside_workspace', false],
    ['grep', { pattern: 'x', path: '/etc' }, 'refused', 'outside_workspace', false],
    ['write', { file_path: 'sub/../a.txt', content: 'x' }, 'refused', 'invalid_input', false],
    ['write', { file_path: 'a.txt', content: 'x', extra: true }, 'refused', 'invalid_input', false],
    ['unknown_tool', {}, 'refused', 'invalid_input', false],
    ['write', { file_path: 'secret.txt', content: 'x' }, 'denied', 'restricted', true],
    ['read', { file_path: 'secret.txt' }, 'denied', 'restricted', true],
    ['write', { file_path: 'guarded.txt', content: 'x' }, 'denied', undefined, true],
    ['read', { file_path: 'missing.txt' }, 'failed', undefined, true],
  ];
  for (const [tool, input, status, refusal, started] of rows) {
    const before = approvals.starts.length;
    const result = await call(tools, approvals.observer, tool, input);
    assert.deepEqual([result.status, result.refusal, approvals.starts.length > before], [status, refusal, started], `${tool} ${JSON.stringify(input)}`);
  }
  await tools.close();
  assert.equal((await call(tools, approvals.observer, 'read', { file_path: 'a.txt' })).refusal, 'unavailable');
});
