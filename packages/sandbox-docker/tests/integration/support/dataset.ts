// ------------------------------------------------------------------------------------------------
//                dataset.ts - Explicit small image dataset fixture and owned guest observations
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import type { Sandbox } from '@agen-ai/sandbox';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import type { DockerSandboxDataset } from '@agen-ai/sandbox-docker';
import { collectBytes, openSuite } from './common.js';

export interface DatasetFixture {
  readonly name: string;
  readonly subpath: string;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

function data(value: unknown): Record<string, unknown> {
  const isData = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
  assert(isData(value));
  return value;
}

export function selectedDataset(input: unknown) {
  const manifest = data(input);
  const value = data(manifest.datasetFixture);
  assert.equal(value.name, 'reference');
  assert.equal(value.subpath, 'agenai-qualification-dataset');
  assert.equal(value.path, 'manifest.txt');
  assert(typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 4096);
  assert(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256));
  assert(typeof manifest.imageDigest === 'string');
  const fixture: DatasetFixture = { name: value.name, subpath: value.subpath, path: value.path, byteLength: value.byteLength, sha256: value.sha256 };
  const datasets: readonly DockerSandboxDataset[] = [{ name: fixture.name, imageDigest: manifest.imageDigest, subpath: fixture.subpath }];
  assert.deepEqual(manifest.datasets, datasets, 'Dataset proof requires the explicit exact fixture attachment selection.');
  return { fixture, datasets };
}

export function datasetBackend(suite: Awaited<ReturnType<typeof openSuite>>, datasets: readonly DockerSandboxDataset[]) {
  return createDockerSandboxBackend({ endpoint: suite.endpoint, profile: suite.profile, namespace: suite.namespace,
    imageDigest: suite.imageDigest, spillDirectory: suite.spillDirectory, user: suite.user, datasets });
}

const guest = `
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const [label,waiting,target]=process.argv.slice(1);assert(/^[a-z-]+$/.test(label));
fs.writeFileSync('private.txt',label,{flag:'wx'});fs.writeFileSync('exclusive-'+label,label,{flag:'wx'});
function snapshot(phase){
 const bytes=fs.readFileSync(target);assert(bytes.length<=4096);const failures=[];
 for(const [operation,perform]of [['append',()=>fs.appendFileSync(target,'unexpected')],['create',()=>fs.writeFileSync(target+'.new','unexpected',{flag:'wx'})]]){
  let code;try{perform()}catch(error){code=error.code}assert.equal(code,'EROFS');failures.push({operation,code});
 }
 const value={phase,byteLength:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
  fileMode:fs.statSync(target).mode&511,directoryMode:fs.statSync(require('node:path').dirname(target)).mode&511,
  privateValue:fs.readFileSync('private.txt','utf8'),privateNames:fs.readdirSync('.').sort(),writeFailures:failures};
 process.stdout.write(JSON.stringify(value)+'\\n');
}
snapshot('before-sibling-cleanup');
if(waiting==='yes')process.stdin.on('end',()=>snapshot('after-sibling-cleanup')).resume();
`;

export interface DatasetSnapshot {
  readonly phase: 'before-sibling-cleanup' | 'after-sibling-cleanup';
  readonly byteLength: number;
  readonly sha256: string;
  readonly fileMode: number;
  readonly directoryMode: number;
  readonly privateValue: string;
  readonly privateNames: readonly string[];
  readonly writeFailures: readonly { operation: string; code: string }[];
}

export function checkDatasetSnapshot(input: unknown, fixture: DatasetFixture, label: string, phase: DatasetSnapshot['phase']): asserts input is DatasetSnapshot {
  assert.deepEqual(input, { phase, byteLength: fixture.byteLength, sha256: fixture.sha256, fileMode: 0o666, directoryMode: 0o777,
    privateValue: label, privateNames: [`exclusive-${label}`, 'private.txt'],
    writeFailures: [{ operation: 'append', code: 'EROFS' }, { operation: 'create', code: 'EROFS' }] });
}

export async function startDatasetPeer(sandbox: Sandbox, fixture: DatasetFixture, label: string, waiting = false) {
  const reservation = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['-e', guest, label, waiting ? 'yes' : 'no',
    `/datasets/${fixture.name}/${fixture.path}`], cwd: sandbox.workspace, env: {} });
  const streams = await reservation.start();
  const ready = Promise.withResolvers<unknown>();
  const stdout = (async () => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let announced = false;
    for await (const chunk of streams.stdout) {
      assert(chunk instanceof Uint8Array); length += chunk.byteLength;
      assert(length <= 64 * 1024, 'Dataset peer exceeded its controlled output bound.'); chunks.push(Buffer.from(chunk));
      if (!announced) {
        const bytes = Buffer.concat(chunks); const end = bytes.indexOf(10);
        if (end >= 0) { ready.resolve(JSON.parse(bytes.subarray(0, end).toString('utf8'))); announced = true; }
      }
    }
    assert(announced, 'Dataset peer closed before its first complete observation.');
    return Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
  })();
  void stdout.catch(ready.reject);
  const done = (async () => {
    const results = await Promise.allSettled([stdout, collectBytes(streams.stderr), streams.exit]);
    const failures = results.flatMap((entry) => entry.status === 'rejected' ? [entry.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Dataset peer streams did not all settle successfully.');
    assert(results[0].status === 'fulfilled' && results[1].status === 'fulfilled' && results[2].status === 'fulfilled');
    return [results[0].value, results[1].value, results[2].value] as const;
  })();
  void done.catch(() => {});
  return { ready: ready.promise, done, release() {
    return new Promise<void>((resolve, reject) => { streams.stdin.once('error', reject); streams.stdin.end(() => {
      streams.stdin.removeListener('error', reject); resolve();
    }); });
  } };
}
