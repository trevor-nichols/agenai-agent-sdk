import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RecoveryNativeOwner, RecoveryNativeError } from '../src/node/desktopRecovery/native/owner.js';
import { openPreparedExecutable } from '../src/node/preparedExecutable.js';
import { prepareDockerDesktopRecoveryHelper, readDesktopRecoverySourceDigest } from '../src/node/desktopRecovery/preparation.js';
import { PREVIOUS_RECOVERY_PROFILE, PREVIOUS_RECOVERY_SOURCE } from '../src/network/desktop/coordinator/administrativeRecovery/helperSuccession.js';

const engineKey = 'a'.repeat(64);
const authorityId = '11111111-1111-4111-8111-111111111111';
const generationId = '22222222-2222-4222-8222-222222222222';
const recoveryKey = 'b'.repeat(64);
const originDigest = 'c'.repeat(64);
const rawDigest = 'd'.repeat(64);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const toolchain = { compiler: { path: '/offline/never-run-clang', sha256: '1'.repeat(64) },
  sdk: { path: '/offline/MacOSX.sdk', version: '26.5' }, deploymentTarget: '14.0' };

test('recovery preparation publishes fixed verifiable source bytes and a repeatable offline recipe in a fresh namespace', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agenai-recovery-preparation-')));
  const directory = join(parent, 'context');
  try {
    const result = await prepareDockerDesktopRecoveryHelper({ directory, toolchain });
    assert.equal(result.protocol, 'agenai.desktop-recovery-observer.v1');
    assert.equal(await readDesktopRecoverySourceDigest(), result.sourceDigest);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const asset of result.files) {
      const bytes = await readFile(join(directory, asset.path));
      assert.equal(hash(bytes), asset.sha256);
      assert.equal((await stat(join(directory, asset.path))).mode & 0o777, 0o600);
    }
    assert.equal(result.sourceDigest, `sha256:${hash(JSON.stringify(result.files))}`);
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, result);
    const recipe: unknown = JSON.parse(await readFile(join(directory, 'commands.json'), 'utf8'));
    assert.equal(Reflect.get(Object(recipe), 'compilerSha256'), toolchain.compiler.sha256);
    assert.deepEqual(Reflect.get(Object(recipe), 'sdk'), toolchain.sdk);
    const compiles = result.commands.filter((command) => command.executable === toolchain.compiler.path
      && command.arguments.includes('-o'));
    assert.equal(compiles.length, 2);
    assert.deepEqual(compiles[0], compiles[1]);
    assert(!compiles[0]?.arguments.includes('native/desktop/coordinator/main.c'));
    assert(compiles[0]?.arguments.some((argument) => argument === `-DAGENAI_RECOVERY_SOURCE_DIGEST="${result.sourceDigest.slice(7)}"`));
    await assert.rejects(stat(join(directory, result.executable)), { code: 'ENOENT' });
    await assert.rejects(prepareDockerDesktopRecoveryHelper({ directory, toolchain }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), result);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('recovery preparation rejects unknown authority selectors and accessors before reserving a directory', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agenai-recovery-preparation-')));
  try {
    const directory = join(parent, 'context');
    const alternate = { directory, toolchain, authorityRoot: '/alternate' };
    await assert.rejects(prepareDockerDesktopRecoveryHelper(alternate), { name: 'SandboxValidationError' });
    let entered = false;
    const accessor = { directory, toolchain };
    Object.defineProperty(accessor, 'directory', { enumerable: true, get() { entered = true; return directory; } });
    await assert.rejects(prepareDockerDesktopRecoveryHelper(accessor), TypeError);
    assert.equal(entered, false);
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

type PeerCase = 'absent' | 'archive' | 'wrong_frame' | 'wrong_scope' | 'bad_chunk' | 'issuer_cutoff';
async function withNativePeer(scenario: PeerCase,
  use: (owner: RecoveryNativeOwner, commands: () => Promise<string[]>, losses: RecoveryNativeError[], verifyExecutable: () => Promise<void>) => Promise<void>,
  closeControl?: { allowed: boolean; failure: Error }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agenai-recovery-native-')));
  const path = join(directory, 'observer');
  const scriptPath = join(directory, 'peer.mjs');
  const tracePath = join(directory, 'trace.json');
  const text = '{"immutable":"original"}';
  const originalFrame = Buffer.concat([Buffer.from(`AGENAI-SNAPSHOT-1\n${engineKey}\n${hash(text)}\n`), Buffer.from(text)]);
  const script = `
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const scenario = ${JSON.stringify(scenario)};
const tracePath = ${JSON.stringify(tracePath)};
const commands = [];
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
reply({kind:'opened',initial:'existing',rootDevice:'1',rootInode:'2',lockDevice:'3',lockInode:'4',stateDevice:'5',stateInode:'6',pendingTemp:false});
let pending='';
for await(const chunk of process.stdin){
  pending+=chunk.toString();
  let index;
  while((index=pending.indexOf('\\n'))!==-1){
    const command=pending.slice(0,index);pending=pending.slice(index+1);commands.push(command);await writeFile(tracePath,JSON.stringify(commands));
    if(command.startsWith('BIND_EXISTING ')) reply(scenario==='absent'?{kind:'absent'}:{kind:'bound_existing',recoveryKey:${JSON.stringify(recoveryKey)},originFrameDigest:${JSON.stringify(originDigest)},originRawDigest:${JSON.stringify(rawDigest)}});
    else if(command==='READ_RECEIPT origin_archive generation')reply({kind:'receipt',recordKind:'origin_archive',scope:scenario==='wrong_scope'?'1':'generation',digest:scenario==='wrong_frame'?'0'.repeat(64):${JSON.stringify(hash(originalFrame))},bytes:${originalFrame.length},text:${JSON.stringify(text)}});
    else if(scenario==='issuer_cutoff'&&command.startsWith('READ_RECEIPT outcome ')){
      const attempt=Number(command.split(' ').at(-1));
      const fact={format:'agenai.desktop-recovery-native-fact.v1',kind:'outcome',engineKey:${JSON.stringify(engineKey)},authorityId:${JSON.stringify(authorityId)},
        generationId:${JSON.stringify(generationId)},recoveryKey:${JSON.stringify(recoveryKey)},attempt,originFrameDigest:${JSON.stringify(originDigest)},canonicalPayloadSha256:${JSON.stringify(rawDigest)},
        claim:{rootDevice:'1',rootInode:'2',lockDevice:'3',lockInode:'4'},previousHistory:{kind:'none'},previous:null,lastCompleted:null,
        issuer:{sourceDigest:attempt===1?${JSON.stringify(PREVIOUS_RECOVERY_SOURCE.slice(7))}:'e'.repeat(64),executableSha256:attempt===1?'1'.repeat(64):hash(await readFile(${JSON.stringify(path)}))},
        profileDigest:attempt===1?${JSON.stringify(PREVIOUS_RECOVERY_PROFILE.slice(7))}:'f'.repeat(64),hostBoot:'33333333-3333-4333-8333-333333333333',uid:501,
        startedContinuousNs:'1',finishedContinuousNs:'2',outcome:'abandoned',reason:'caller'};
      const text=JSON.stringify(fact),body=Buffer.from(text),header=Buffer.alloc(512);
      header.write('AGENAI-RECOVERY-1\\n'+fact.engineKey+'\\n'+fact.recoveryKey+'\\noutcome\\n'+attempt+'\\n'+body.length+'\\n'+hash(body)+'\\n');
      const frame=Buffer.concat([header,body]);reply({kind:'receipt',recordKind:'outcome',scope:String(attempt),digest:hash(frame),bytes:frame.length,text});
    }
    else if(command==='READ_LOG init')reply({kind:'log_bytes',phase:'observed',source:'init',sourceIdentity:'file-1',sequence:1,start:'12',end:'16',sha256:'0'.repeat(64),bytesBase64:'dGVzdA==',done:true});
    else if(command==='CLOSE'){reply({kind:'closed'});process.exitCode=0;break;}
    else throw Error('Unexpected command');
  }
  if(commands.at(-1)==='CLOSE')break;
}

`;
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(scriptPath, script, { mode: 0o600 });
  const executableBytes = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`;
  await writeFile(path, executableBytes, { mode: 0o700 });
  const executable = { path, sha256: hash(executableBytes) };
  const prepared = await openPreparedExecutable(executable);
  const losses: RecoveryNativeError[] = [];
  const executableOwner = closeControl === undefined ? prepared : { identity: prepared.identity,
    verify: (signal?: AbortSignal) => prepared.verify(signal),
    async close() { if (!closeControl.allowed) throw closeControl.failure; await prepared.close(); } };
  const owner = new RecoveryNativeOwner(path, engineKey, '/qualified/docker.sock', executableOwner,
    { protocol: 'agenai.desktop-recovery-observer.v1', sourceDigest: `sha256:${'e'.repeat(64)}`, executable },
    `sha256:${'f'.repeat(64)}`, (error) => losses.push(error));
  try {
    await owner.opened;
    await use(owner, async () => JSON.parse(await readFile(tracePath, 'utf8')), losses, () => prepared.verify());
  } finally {
    if (closeControl !== undefined) closeControl.allowed = true;
    await owner.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

test('explicit close retry joins only the retained prepared descriptor after native exit and preserves the original failed close', async () => {
  const control = { allowed: false, failure: new Error('Prepared descriptor close did not acknowledge.') };
  await withNativePeer('archive', async (owner, commands, _losses, verifyExecutable) => {
    assert.equal(owner.closeJoined, false);
    await assert.rejects(owner.close(), (cause) => cause === control.failure);
    await verifyExecutable();
    assert.equal(owner.closeJoined, false, 'A lost claim must retain an executable descriptor whose close failed.');
    const nativeCommands = await commands();
    assert.deepEqual(nativeCommands, ['CLOSE']);
    control.allowed = true;
    await assert.rejects(owner.close(), (cause) => cause === control.failure);
    await assert.rejects(verifyExecutable(), { code: 'EBADF' });
    assert.equal(owner.closeJoined, true);
    assert.deepEqual(await commands(), nativeCommands, 'Descriptor retry must not re-enter the closed native protocol.');
  }, control);
});

test('fresh native discovery uses only non-creating BIND_EXISTING and reads the exact original archive without an attempt or Docker admission', async () => {
  for (const scenario of ['absent', 'archive'] as const) {
    await withNativePeer(scenario, async (owner, commands, losses) => {
      const binding = await owner.rebindExistingGeneration(authorityId, generationId, `sha256:${rawDigest}`);
      if (scenario === 'absent') assert.deepEqual(binding, { kind: 'absent' });
      else {
        assert.deepEqual(binding, { kind: 'bound_existing', recoveryKey: `sha256:${recoveryKey}`,
          originFrameDigest: `sha256:${originDigest}`, originRawDigest: `sha256:${rawDigest}` });
        const archive = await owner.readReceipt({ kind: 'origin_archive', scope: 'generation' });
        assert.equal(archive?.kind, 'archive'); assert.equal(archive?.text, '{"immutable":"original"}');
        assert.equal(archive?.ref.scope, 'transaction');
      }
      const observed = await commands();
      assert.deepEqual(observed, [`BIND_EXISTING ${authorityId} ${generationId} ${rawDigest}`,
        ...(scenario === 'archive' ? ['READ_RECEIPT origin_archive generation'] : [])]);
      assert.equal(owner.claimed, true); assert.deepEqual(losses, []);
    });
  }
});

for (const scenario of ['wrong_frame', 'wrong_scope', 'bad_chunk'] as const) {
  test(`recovery native boundary fences ${scenario} before any bytes or receipt can grant authority`, async () => {
    await withNativePeer(scenario, async (owner, _commands, losses) => {
      await owner.rebindExistingGeneration(authorityId, generationId, `sha256:${rawDigest}`);
      await assert.rejects(scenario === 'bad_chunk' ? owner.readObservedBytes('init')
        : owner.readReceipt({ kind: 'origin_archive', scope: 'generation' }), RecoveryNativeError);
      assert.equal(owner.claimed, false); assert.equal(losses.length, 1);
      await assert.rejects(owner.close(), (error) => error === losses[0]);
    });
  });
}

test('native receipt reads bind exactly one expected historical or current issuer at the selected attempt', async () => {
  await withNativePeer('issuer_cutoff', async (owner) => {
    await owner.rebindExistingGeneration(authorityId, generationId, `sha256:${rawDigest}`);
    const previous = { helper: { protocol: 'agenai.desktop-recovery-observer.v1' as const, sourceDigest: PREVIOUS_RECOVERY_SOURCE,
      executable: { path: '/original/previous-observer', sha256: '1'.repeat(64) } }, profileDigest: PREVIOUS_RECOVERY_PROFILE };
    await assert.rejects(owner.readReceipt({ kind: 'outcome', scope: 1 }), { reason: 'receipt_binding' });
    const old = await owner.readReceipt({ kind: 'outcome', scope: 1 }, undefined, previous);
    assert(old?.kind === 'native'); assert.equal(old.fact.issuer.sourceDigest, PREVIOUS_RECOVERY_SOURCE.slice(7));
    const current = await owner.readReceipt({ kind: 'outcome', scope: 2 });
    assert(current?.kind === 'native'); assert.equal(current.fact.issuer.sourceDigest, 'e'.repeat(64));
    await assert.rejects(owner.readReceipt({ kind: 'outcome', scope: 2 }, undefined, previous), { reason: 'receipt_binding' });
    assert.equal(owner.claimed, true);
  });
});
