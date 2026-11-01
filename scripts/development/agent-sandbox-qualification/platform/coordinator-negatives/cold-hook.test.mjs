import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { joinOriginalChild } from './child.mjs';

test('cold preload preserves actual HTTP responses and natural child exit while retaining a complete trace', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coordinator-cold-hook-'));
  const socket = join(directory, 'e.sock'), trace = join(directory, 'trace.jsonl'), observed = [];
  const server = http.createServer((request, response) => { observed.push([request.method, request.url]); response.writeHead(201); response.end('{"Id":"original"}'); });
  await new Promise((resolve) => server.listen(socket, resolve));
  const program = 'import http from "node:http";import {spawn} from "node:child_process";'
    + 'await new Promise((resolve,reject)=>{const r=http.request({socketPath:process.env.AGENAI_COLD_ENGINE_SOCKET,path:"/v1.52/containers/create?name=original",method:"POST",agent:false},s=>{let b="";s.on("data",c=>b+=c);s.on("end",()=>{if(s.statusCode!==201||b!==\'{"Id":"original"}\')reject(new Error(b));else resolve();});});r.on("error",reject);r.end("{}");});'
    + 'await new Promise(resolve=>{const c=spawn(process.execPath,["-e","process.exit(0)"],{stdio:"ignore"});c.once("close",resolve);});';
  try {
    const result = await joinOriginalChild({ command: process.execPath,
      args: ['--import', fileURLToPath(new URL('./cold-hook.mjs', import.meta.url)), '--input-type=module', '-e', program],
      cwd: directory, env: { PATH: '/usr/bin:/bin', AGENAI_COLD_ENGINE_SOCKET: socket, AGENAI_COLD_HTTP_TRACE: trace },
      output: directory, async onSpawn() {} });
    assert.equal(result.code, 0, await readFile(join(directory, 'controller-stderr.log'), 'utf8'));
    assert.deepEqual(observed, [['POST', '/v1.52/containers/create?name=original']]);
    const history = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(history.at(-1).complete, true); assert.equal(history.at(-1).requests, 1);
    assert.equal(Buffer.from(history.find(({ kind }) => kind === 'response').bodyBase64, 'base64').toString('utf8'), '{"Id":"original"}');
    assert.equal(history.filter(({ kind }) => kind === 'child_close').length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); }
});
