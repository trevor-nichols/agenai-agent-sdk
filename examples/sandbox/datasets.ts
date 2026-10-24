// ------------------------------------------------------------------------------------------------
//                datasets.ts - Explicit shared image data with private writable workspace owners
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sandbox, SandboxRecoveryRecord, SandboxReservation } from "@agen-ai/sandbox";
import { createDockerSandboxBackend } from "@agen-ai/sandbox-docker";
import { sandboxExampleConfiguration } from "./configuration.js";
import { failureSummary, inspectResources } from "./evidence.js";
import { isolatedSandboxRequest } from "./policy.js";

const config = await sandboxExampleConfiguration(process.env);
const datasets = config.datasets;
const fixture = config.datasetFixture;
assert(datasets && fixture, "This example requires explicit datasets and datasetFixture manifest fields.");
const datasetPath = `/datasets/${fixture.name}/${fixture.path}`;
const namespace = `sdk-example-datasets-${randomUUID()}`;
const directory = path.join(config.output, "packed-datasets");
await mkdir(config.output, { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 });
const backend = createDockerSandboxBackend({ endpoint: config.endpoint, profile: config.profile, namespace,
  imageDigest: config.imageDigest, user: config.user, spillDirectory: await realpath(directory), datasets });

const guest = `const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const[label,target,wait]=process.argv.slice(1);fs.writeFileSync('private.txt',label,{flag:'wx'});
function snapshot(phase){const bytes=fs.readFileSync(target);assert(bytes.length<=4096);
const errors=[];for(const op of[()=>fs.appendFileSync(target,'unexpected'),()=>fs.writeFileSync(target+'.new','unexpected',{flag:'wx'})]){
let code;try{op()}catch(error){code=error.code}assert.equal(code,'EROFS');errors.push(code)}
process.stdout.write(JSON.stringify({phase,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,
privateValue:fs.readFileSync('private.txt','utf8'),writeErrors:errors})+'\\n')}
snapshot('before');if(wait==='yes')process.stdin.on('end',()=>snapshot('after')).resume();`;

async function peer(sandbox: Sandbox, label: string, waiting: boolean) {
  const processOwner = sandbox.reserveProcess({ executable: "/usr/local/bin/node", args: ["-e", guest, label,
    datasetPath, waiting ? "yes" : "no"], cwd: sandbox.workspace, env: {} });
  const streams = await processOwner.start();
  const readiness: { resolve?: () => void; reject?: (error: unknown) => void } = {};
  const readinessPromise = new Promise<void>((resolve, reject) => { readiness.resolve = resolve; readiness.reject = reject; });
  assert(readiness.resolve && readiness.reject);
  const ready = { promise: readinessPromise, resolve: readiness.resolve, reject: readiness.reject };
  const read = async (source: AsyncIterable<Uint8Array>, stdout: boolean) => {
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of source) {
      length += chunk.byteLength; assert(length <= 64 * 1024); chunks.push(Buffer.from(chunk));
      if (stdout && chunk.includes(10)) ready.resolve();
    }
    if (stdout) assert(length > 0, "Dataset process closed before observation.");
    return Buffer.concat(chunks);
  };
  const output = read(streams.stdout, true); void output.catch(ready.reject);
  const done = (async () => {
    const results = await Promise.allSettled([output, read(streams.stderr, false), streams.exit]);
    const failures = results.flatMap((entry) => entry.status === "rejected" ? [entry.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Dataset process streams did not settle successfully.");
    assert(results[0].status === "fulfilled" && results[1].status === "fulfilled" && results[2].status === "fulfilled");
    assert.equal(results[1].value.length, 0); assert.deepEqual(results[2].value, { kind: "exited", code: 0 });
    return results[0].value.toString("utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
  })();
  void done.catch(ready.reject);
  return { ready: ready.promise, done, release: () => new Promise<void>((resolve, reject) => {
    streams.stdin.once("error", reject); streams.stdin.end(() => { streams.stdin.removeListener("error", reject); resolve(); });
  }) };
}

const owners: SandboxReservation[] = [];
const peers: Awaited<ReturnType<typeof peer>>[] = [];
const checkpoints: unknown[] = [];
const cleanupFailures: unknown[] = [];
const evidenceFailures: unknown[] = [];
let result: unknown;
let primaryFailure: Readonly<{ error: unknown }> | undefined;
try {
  for (const label of ["left", "right"]) owners.push(backend.reserve(isolatedSandboxRequest(), { kind: "persisted", async persist(record) {
    const file = path.join(directory, `${label}-recovery.json`);
    await writeFile(`${file}.next`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); await rename(`${file}.next`, file);
  } }));
  const left = await owners[0]!.start(); const right = await owners[1]!.start();
  assert.deepEqual(left.effective.workspaceDiskQuota, { kind: "not_requested" });
  assert.deepEqual(right.effective.workspaceDiskQuota, { kind: "not_requested" });
  peers.push(await peer(left, "left", false)); peers.push(await peer(right, "right", true));
  await Promise.all(peers.map((entry) => entry.ready));
  const leftSnapshots = await peers[0]!.done;
  await left.stop(); checkpoints.push(...await inspectResources(config.endpoint, left.recoveryRecord, "left-stop", ["compute"]));
  await owners[0]!.destroy(); checkpoints.push(...await inspectResources(config.endpoint, owners[0]!.recoveryRecord, "left-destroy-right-live"));
  await peers[1]!.release(); const rightSnapshots = await peers[1]!.done;
  assert.deepEqual(leftSnapshots, [{ phase: "before", sha256: fixture.sha256, byteLength: fixture.byteLength, privateValue: "left", writeErrors: ["EROFS", "EROFS"] }]);
  assert.deepEqual(rightSnapshots, ["before", "after"].map((phase) => ({ phase, sha256: fixture.sha256, byteLength: fixture.byteLength,
    privateValue: "right", writeErrors: ["EROFS", "EROFS"] })));
  result = { left: leftSnapshots, right: rightSnapshots, privateWorkspaceSeparation: true, physicalSharing: "not_measured" };
} catch (error) { primaryFailure = { error }; }
finally {
  for (const owner of owners) {
    try { await owner.destroy(); checkpoints.push(...await inspectResources(config.endpoint, owner.recoveryRecord, "finally-destroy")); }
    catch (error) { cleanupFailures.push(error); }
  }
  for (const entry of peers) { try { await entry.done; } catch (error) { cleanupFailures.push(error); } }
  const records: SandboxRecoveryRecord[] = owners.map((owner) => owner.recoveryRecord);
  const report = { proof: "packed-sandbox-datasets-example", namespace, endpoint: config.endpoint, profile: config.profile, datasets,
    datasetFixture: fixture, result, checkpoints, records, modelCalls: 0, credentialReads: 0,
    primaryFailure: primaryFailure ? failureSummary(primaryFailure.error) : null, cleanupFailures: cleanupFailures.map((error) => failureSummary(error)),
    evidenceFailures: evidenceFailures.map((error) => failureSummary(error)) };
  try { await writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { evidenceFailures.push(error); report.evidenceFailures = evidenceFailures.map((entry) => failureSummary(entry)); }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
if (primaryFailure || cleanupFailures.length || evidenceFailures.length) throw new AggregateError([
  ...(primaryFailure ? [primaryFailure.error] : []), ...cleanupFailures, ...evidenceFailures,
], "Shared dataset example failed; exact owners and original failures are retained in its report.");
