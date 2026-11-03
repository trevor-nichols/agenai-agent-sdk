import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Explicit native diagnostic; never selected by the hermetic workspace lane.
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.ok(options.get('--original'));
assert.ok(options.get('--observer'));
assert.ok(options.get('--output'));
const original = resolve(options.get('--original'));
const observer = resolve(options.get('--observer'));
const output = resolve(options.get('--output'));
const endpoint = options.get('--endpoint') ?? '/nonexistent/agenai-native-fixture.sock';
const key = randomBytes(32).toString('hex');
const forbidden = '13f0b9b23b2cd1b55ddfcd910c252cb16984e9b7e1f9ed0b9073149fe87585f9';
assert.notEqual(key, forbidden);
const authority = randomUUID();
const generation = randomUUID();
const recoveryKey = randomBytes(32).toString('hex');
const root = join(homedir(), 'Library/Application Support/AgenAI/sandbox-docker/desktop-coordination-v1');
const evidence = join(root, `${key}.recovery-evidence-v1`);
const owned = [join(root, `${key}.lock`), join(root, `${key}.state`), join(root, `${key}.next`), evidence];
const children = [];
const transcript = [];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let cleaned = false;

function start(executable, args) {
  const readFault = options.get('--receipt-read-fault');
  const fault = options.get('--fault-stage') ?? (readFault ? 'receipt_read' : undefined);
  const env = executable === observer && fault ? { ...process.env,
    DYLD_INSERT_LIBRARIES: resolve(options.get('--fault-library')),
    AGENAI_TEST_FAULT_DIRECTORY: readFault === 'idle' ? join(evidence, authority, generation) : join(evidence, authority, generation, 'a0000000000000001'),
    AGENAI_TEST_FAULT_STAGE: fault, AGENAI_TEST_FAULT_MARKER: join(output, 'fault-fired'),
    AGENAI_TEST_FAULT_READ_TRIGGER: join(output, 'trigger-receipt-read'),
  } : process.env;
  const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiting = [];
  const reader = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  reader.on('line', (line) => {
    const row = JSON.parse(line);
    transcript.push({ pid: child.pid, row });
    if (waiting.length) waiting.shift()(row); else lines.push(row);
  });
  const exited = once(child, 'exit');
  const next = async () => {
    let timer;
    try {
      return await Promise.race([
        lines.length ? Promise.resolve(lines.shift()) : new Promise((accept) => waiting.push(accept)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native response deadline')), 30_000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const send = async (command, body) => {
    child.stdin.write(body === undefined ? `${command}\n` : `${command}\n${body}\n`);
    return next();
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      assert.equal((await send('CLOSE')).kind, 'closed');
      child.stdin.end();
    }
    await exited;
    assert.equal(stderr, '');
  };
  const handle = { child, next, send, close, exited };
  children.push(handle);
  return handle;
}
function verifyReceipt(row, kind, scope, text) {
  assert.equal(row.kind, 'receipt');
  assert.equal(row.recordKind, kind);
  assert.equal(row.scope, scope);
  assert.equal(row.text, text);
  const header = Buffer.alloc(512);
  header.write(`AGENAI-RECOVERY-1\n${key}\n${recoveryKey}\n${kind}\n${scope}\n${Buffer.byteLength(text)}\n${sha(text)}\n`);
  const frame = Buffer.concat([header, Buffer.from(text)]);
  assert.equal(row.digest, sha(frame));
  assert.equal(row.bytes, frame.length);
}
async function waitForOwnFile(path) {
  for (let i = 0; i < 200; i++) {
    try { await access(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((accept) => setTimeout(accept, 5));
  }
  throw new Error(`Owned publication missing: ${path}`);
}
try {
  await mkdir(output, { recursive: true });
  for (const path of owned) await assert.rejects(access(path), { code: 'ENOENT' });
  const old = start(original, ['initialize', key]);
  assert.equal((await old.next()).initial, 'required');
  const raw = JSON.stringify({ fixture: randomUUID(), authority, generation });
  assert.equal((await old.send(`COMMIT ${Buffer.byteLength(raw)}`, raw)).kind, 'committed');
  const competing = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await competing.next()).kind, 'failure');
  await competing.exited;
  await old.close();
  let current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await current.next()).kind, 'opened');
  assert.equal((await current.send('READ')).text, raw);
  if (options.get('--desktop-read-only') === 'yes') {
    for (const source of ['components', 'settings']) {
      const metadata = await current.send(`READ_METADATA ${source}`);
      assert.equal(metadata.kind, 'metadata_bytes');
      const bytes = Buffer.from(metadata.bytesBase64, 'base64');
      assert.equal(metadata.bytes, bytes.length);
      assert.equal(metadata.sha256, sha(bytes));
    }
    for (const source of ['init', 'console']) {
      const log = await current.send(`READ_LOG ${source}`);
      assert.equal(log.kind, 'log_bytes');
      assert.equal(log.phase, 'baseline');
      const bytes = Buffer.from(log.bytesBase64, 'base64');
      assert.equal(log.sha256, sha(bytes));
      assert.equal(BigInt(log.end) - BigInt(log.start), BigInt(bytes.length));
    }
    const admission = await current.send('OBSERVE_ADMISSION');
    assert.ok(admission.kind === 'admission' || (admission.kind === 'failure' && admission.claim === 'held'));
    assert.deepEqual(await current.send('CHECK'), { kind: 'checked', fenced: false });
  }
  assert.equal((await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`)).kind, 'absent');
  await assert.rejects(access(evidence), { code: 'ENOENT' });
  const originFrame = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${key}\n${sha(raw)}\n`), Buffer.from(raw)]);
  const bound = await current.send(`BIND_ORIGIN ${authority} ${generation} ${recoveryKey} ${sha(originFrame)} ${sha(raw)}`);
  assert.equal(bound.kind, 'bound_existing');
  assert.equal(bound.originFrameDigest, sha(originFrame));
  const originPath = join(evidence, authority, generation, 'origin.snapshot');
  const originIdentity = await lstat(originPath);
  const retry = options.get('--binding-retry') ?? 'all';
  if (retry === 'all' || retry === 'same') {
    assert.deepEqual(await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`), bound);
    assert.deepEqual(await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`), bound);
    assert.deepEqual(await current.send(`BIND_ORIGIN ${authority} ${generation} ${recoveryKey} ${sha(originFrame)} ${sha(raw)}`), bound);
    assert.equal((await current.send(`BIND_EXISTING ${authority} ${randomUUID()} ${sha(raw)}`)).reason, 'generation_binding_conflict');
    assert.equal((await current.send(`BIND_ORIGIN ${authority} ${generation} ${'0'.repeat(64)} ${sha(originFrame)} ${sha(raw)}`)).reason, 'origin_binding_conflict');
    assert.deepEqual(await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`), bound);
  }
  if (retry === 'all' || retry === 'fresh') {
    // Durable origin admission survives death before the first envelope COMMIT.
    current.child.kill('SIGKILL'); await current.exited;
    current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
    assert.equal((await current.next()).kind, 'opened');
    assert.deepEqual(await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`), bound);
    assert.deepEqual(await current.send(`BIND_ORIGIN ${authority} ${generation} ${recoveryKey} ${sha(originFrame)} ${sha(raw)}`), bound);
    assert.equal((await current.send('READ')).text, raw);
  }
  assert.equal((await lstat(originPath)).ino, originIdentity.ino);
  assert.deepEqual(await readFile(originPath), originFrame);
  const faultStage = options.get('--fault-stage');
  if (faultStage) {
    assert(['admission', 'armed', 'outcome'].includes(faultStage));
    const withoutArm = options.get('--fault-without-arm') === 'yes';
    if (withoutArm) assert.equal(faultStage, 'outcome');
    assert.equal((await current.send(`BIND ${authority} ${generation} ${recoveryKey} 1 ${sha(originFrame)} ${sha(raw)} none 0 ${'0'.repeat(64)}`)).kind, 'bound');
    const scope = join(evidence, authority, generation, 'a0000000000000001');
    let armed;
    if (!withoutArm) armed = await current.send('ARM');
    if (!withoutArm && faultStage !== 'outcome') {
      assert.equal(armed.kind, 'failure');
      assert.equal(armed.reason, 'receipt_publication_sync');
      await access(join(output, 'fault-fired'));
      const original = await readFile(join(scope, `${faultStage}.json`));
      await writeFile(join(output, 'published-before-retry.snapshot'), original, { flag: 'wx', mode: 0o600 });
      armed = await current.send('ARM');
      assert.equal(armed.kind, 'receipt');
      assert.equal(armed.recordKind, 'armed');
      assert.deepEqual(await readFile(join(scope, `${faultStage}.json`)), original);
    }
    if (!withoutArm) {
      assert.equal(armed.kind, 'receipt');
      assert.equal(armed.recordKind, 'armed');
      const armedFact = JSON.parse(armed.text);
      const admission = await current.send('READ_RECEIPT admission 1');
      assert.equal(admission.kind, 'receipt');
      const admissionFact = JSON.parse(admission.text);
      assert.equal(armedFact.startedContinuousNs, admissionFact.startedContinuousNs);
      assert.equal(BigInt(armedFact.deadlineContinuousNs) - BigInt(armedFact.startedContinuousNs), 600_000_000_000n);
      assert.deepEqual(armedFact.previous, { kind: 'admission', attempt: 1, sha256: admission.digest });
    }
    if (faultStage === 'armed') {
      const log = await current.send('READ_LOG init');
      assert.equal(log.kind, 'log_bytes');
      assert.equal(log.phase, 'observed');
      // A real, distinct observation failure must still fence this attempt after the join.
      assert.equal((await current.send('OBSERVE_STOPPED')).reason, 'producer_exit_unobserved');
      assert.equal((await current.send('READ_LOG init')).reason, 'producer_exit_unobserved');
    }
    let outcome = await current.send('ABANDON');
    if (faultStage === 'outcome') {
      assert.equal(outcome.reason, 'receipt_publication_sync');
      const original = await readFile(join(scope, 'outcome.json'));
      await writeFile(join(output, 'published-before-retry.snapshot'), original, { flag: 'wx', mode: 0o600 });
      assert.deepEqual(await current.send('CHECK'), { kind: 'checked', fenced: false });
      assert.equal((await current.send(`BIND ${authority} ${generation} ${recoveryKey} 2 ${sha(originFrame)} ${sha(raw)} none 0 ${'0'.repeat(64)}`)).reason, 'native_publication_pending');
      outcome = await current.send('ABANDON');
      assert.deepEqual(await readFile(join(scope, 'outcome.json')), original);
    }
    assert.equal(outcome.kind, 'receipt');
    assert.equal(outcome.recordKind, 'outcome');
    assert.deepEqual(JSON.parse(outcome.text).lastCompleted, withoutArm ? null : { kind: 'armed', attempt: 1, sha256: armed.digest });
  }
  const readFault = options.get('--receipt-read-fault');
  let storageArmed;
  if (readFault) {
    assert(['idle', 'armed', 'repeat-arm'].includes(readFault));
    if (readFault !== 'idle') {
      assert.equal((await current.send(`BIND ${authority} ${generation} ${recoveryKey} 1 ${sha(originFrame)} ${sha(raw)} none 0 ${'0'.repeat(64)}`)).kind, 'bound');
      storageArmed = await current.send('ARM');
      assert.equal(storageArmed.kind, 'receipt');
      assert.equal(storageArmed.recordKind, 'armed');
    }
  }
  const member = randomUUID();
  const decision = JSON.stringify({ kind: 'fixture_decision', value: 'exact UTF8 \u2764' });
  const published = await current.send(`SDK_DECISION member_terminal ${member} ${Buffer.byteLength(decision)}`, decision);
  verifyReceipt(published, 'member_terminal', member, decision);
  if (readFault) {
    await writeFile(join(output, 'trigger-receipt-read'), '', { flag: 'wx', mode: 0o600 });
    const command = readFault === 'repeat-arm' ? 'ARM' : readFault === 'armed' ? 'READ_RECEIPT armed 1' : `READ_RECEIPT member_terminal ${member}`;
    assert.equal((await current.send(command)).reason, 'receipt_discovery_sync');
    await access(join(output, 'fault-fired'));
    assert.deepEqual(await current.send('CHECK'), { kind: 'checked', fenced: false });
    assert.deepEqual(await current.send(command), storageArmed ?? published);
    if (storageArmed) {
      const log = await current.send('READ_LOG init');
      assert.equal(log.kind, 'log_bytes');
      assert.equal(log.phase, 'observed');
      // Real continuity failures still end acceptance after a storage-only retry.
      assert.equal((await current.send('OBSERVE_STOPPED')).reason, 'producer_exit_unobserved');
      assert.equal((await current.send('READ_LOG init')).reason, 'producer_exit_unobserved');
      assert.equal((await current.send('ABANDON')).recordKind, 'outcome');
    }
  }
  verifyReceipt(await current.send(`READ_RECEIPT member_terminal ${member}`), 'member_terminal', member, decision);
  assert.deepEqual(await current.send(`SDK_DECISION member_terminal ${member} ${Buffer.byteLength(decision)}`, decision), published);
  const conflict = await current.send(`SDK_DECISION member_terminal ${member} 2`, '{}');
  assert.equal(conflict.kind, 'failure');
  assert.equal(conflict.reason, 'receipt_conflict');
  assert.equal(conflict.claim, 'held');
  const forged = await current.send('SDK_DECISION admission 1 2', '{}');
  assert.equal(forged.reason, 'sdk_decision_kind');
  assert.equal((await current.send('SDK_DECISION barrier_acceptance 1 2', '{}')).reason, 'native_facts_unfinished');
  assert.deepEqual(await current.send('CHECK'), { kind: 'checked', fenced: false });
  await current.close();

  // The publication is complete but no canonical reference/SDK acknowledgement is consumed.
  current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await current.next()).kind, 'opened');
  assert.equal((await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`)).kind, 'bound_existing');
  const inventory = JSON.stringify({ kind: 'fixture_inventory', nonce: randomUUID() });
  current.child.stdin.write(`SDK_DECISION final_inventory generation ${Buffer.byteLength(inventory)}\n${inventory}\n`);
  await waitForOwnFile(join(evidence, authority, generation, 'final-inventory.json'));
  current.child.kill('SIGKILL');
  await current.exited;
  current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await current.next()).kind, 'opened');
  assert.equal((await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(raw)}`)).kind, 'bound_existing');
  verifyReceipt(await current.send('READ_RECEIPT final_inventory generation'), 'final_inventory', 'generation', inventory);
  const canonical = JSON.stringify({ fixture: 'changed canonical', authority, generation });
  assert.equal((await current.send(`COMMIT ${Buffer.byteLength(canonical)}`, canonical)).kind, 'committed');
  await current.close();
  current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await current.next()).kind, 'opened');
  assert.deepEqual(await current.send(`BIND_EXISTING ${authority} ${generation} ${sha(canonical)}`), bound);
  const archive = await current.send('READ_RECEIPT origin_archive generation');
  assert.equal(archive.digest, sha(originFrame));
  assert.equal(archive.text, raw);
  assert.equal((await current.send('OBSERVE_STOPPED')).reason, 'stopped_not_armed');
  const canary = join(output, 'canary');
  await writeFile(canary, 'untouched', { flag: 'wx' });
  const otherMember = randomUUID();
  await symlink(canary, join(evidence, authority, generation, `m${otherMember}.terminal.json`));
  assert.equal((await current.send(`SDK_DECISION member_terminal ${otherMember} 2`, '{}')).reason, 'receipt_open');
  assert.equal(await readFile(canary, 'utf8'), 'untouched');
  const publishedPath = join(evidence, authority, generation, `m${member}.terminal.json`);
  const stat = await lstat(publishedPath);
  assert.equal(stat.mode & 0o7777, 0o600);
  assert.equal(stat.nlink, 1);
  const damaged = await readFile(publishedPath);
  damaged[damaged.length - 1] ^= 1;
  await writeFile(publishedPath, damaged);
  assert.equal((await current.send(`READ_RECEIPT member_terminal ${member}`)).reason, 'receipt_frame');
  await current.close();

  const partialGeneration = randomUUID();
  await mkdir(join(evidence, authority, partialGeneration), { mode: 0o700 });
  current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await current.next()).kind, 'opened');
  assert.equal((await current.send(`BIND_EXISTING ${authority} ${partialGeneration} ${sha(canonical)}`)).kind, 'failure');
  await assert.rejects(access(join(evidence, authority, partialGeneration, 'admission.json')), { code: 'ENOENT' });
  await current.close();
  const partialArchiveGeneration = randomUUID();
  const partialArchiveDirectory = join(evidence, authority, partialArchiveGeneration);
  await mkdir(partialArchiveDirectory, { mode: 0o700 });
  const canonicalFrame = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${key}\n${sha(canonical)}\n`), Buffer.from(canonical)]);
  await writeFile(join(partialArchiveDirectory, 'origin.snapshot'), canonicalFrame, { flag: 'wx', mode: 0o600 });
  current = start(observer, ['--cleanup', key, '--endpoint', endpoint]);
  assert.equal((await current.next()).kind, 'opened');
  assert.equal((await current.send(`BIND_EXISTING ${authority} ${partialArchiveGeneration} ${sha(canonical)}`)).kind, 'failure');
  assert.equal((await current.send(`BIND_ORIGIN ${authority} ${partialArchiveGeneration} ${recoveryKey} ${sha(canonicalFrame)} ${sha(canonical)}`)).kind, 'failure');
  await assert.rejects(access(join(partialArchiveDirectory, 'admission.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(partialArchiveDirectory, 'origin.snapshot')), canonicalFrame);
  await current.close();
  await writeFile(join(output, 'result.json'), `${JSON.stringify({ key, authority, generation, owned, pids: children.map(({ child }) => child.pid), transcript }, null, 2)}\n`);
  console.log(`Native protocol fixtures passed; evidence ${join(output, 'result.json')}`);
} finally {
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  // Every path here was derived from this run's random key and checked absent before creation.
  for (const path of owned) await rm(path, { recursive: path === evidence, force: true });
  cleaned = true;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);
  await writeFile(join(output, 'cleanup.json'), `${JSON.stringify({ key, owned, cleaned, childPids: children.map(({ child }) => child.pid) })}\n`);
}
