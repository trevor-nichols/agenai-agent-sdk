// ------------------------------------------------------------------------------------------------
//                format-three-producer.mjs - Original V10 format-three writer evidence
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [consumerRoot, root, output, sourceCommit] = process.argv.slice(2);
if (!consumerRoot || !root || !output || !sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
  throw new Error('An original installed consumer, fresh store, output directory and verified full source commit are required.');
}
const packageManifest = (name) => join(consumerRoot, 'node_modules', name, 'package.json');
const entrypoint = (name) => join(consumerRoot, 'node_modules', name,
  JSON.parse(readFileSync(packageManifest(name), 'utf8')).exports['.'].import);
const load = (name) => import(pathToFileURL(entrypoint(name)).href);
const protocol = await load('@agen-ai/agent-protocol');
const old = await load('@agen-ai/agent-orchestration');
assert.equal(protocol.AGENT_PROTOCOL_VERSION, 10);
assert.equal(old.createInMemoryDelegationStore().contractVersion, 3);
assert.equal(statfsSync(root).type, 0xEF53);
const exampleRoot = join(consumerRoot, 'examples/delegation');
const { openSqliteDelegationStore } = await import(pathToFileURL(join(exampleRoot, 'sqlite/index.ts')).href);
const { createReferenceHost, input, parent } = await import(pathToFileURL(join(exampleRoot, 'fixtures/host.ts')).href);
const opened = openSqliteDelegationStore({ root });
let offerRequest;
const requested = new Promise((resolve) => { offerRequest = resolve; });
const reference = await createReferenceHost({ root, onRequest: offerRequest, execution: (session, _context, turn) => session.startTurn(turn) });
const coordinator = await old.createDelegationCoordinator({ host: reference.host, store: opened.store, limits: opened.store.limits });
let id;
try {
  const client = await coordinator.bindParent({ scope: parent });
  const admitted = await client.spawn({ operationId: randomUUID(), target: reference.target.reference, expectedPolicyRevision: 1, input });
  const request = await requested;
  assert.equal(request.request.requestKind, 'approval');
  const option = request.request.options.find((candidate) => candidate.decision === 'approved'
    && candidate.persistence === 'once' && candidate.scope.kind === 'exact_action');
  assert.ok(option);
  const operationId = randomUUID();
  const receipt = await coordinator.resolveRequest({ handle: request.handle, operationId,
    resolution: { requestKind: 'approval', requestId: request.request.requestId, disposition: 'selected', optionId: option.optionId } });
  assert.equal(receipt.status, 'delivered');
  const settled = await client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.status, 'settled');
  assert.deepEqual(settled.task.runs.items[0].outcome, { kind: 'succeeded', result: { text: 'Deterministic fake output.', truncated: false, references: [] } });
  const retained = await opened.store.read({ kind: 'operation', parent, operationId });
  assert.equal(retained.kind, 'operation');
  assert.equal(retained.operation.disposition, 'delivered');
  id = { taskId: admitted.taskId, runId: admitted.runId, operationId };
} finally {
  assert.equal((await coordinator.dispose({ mode: 'drain', timeoutMs: 1_000 })).status, 'closed');
  await reference.registry.dispose();
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const database = new DatabaseSync(join(root, 'task.sqlite'), { readOnly: true });
const owner = new DatabaseSync(join(root, 'owner.sqlite'), { readOnly: true });
const schema = (connection) => connection.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
const header = (connection) => ({ applicationId: connection.prepare('PRAGMA application_id').get().application_id,
  userVersion: connection.prepare('PRAGMA user_version').get().user_version });
const taskSchema = schema(database);
const fixture = { runtime: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform }, ids: [id],
  taskHeader: header(database), taskSchema, ownerHeader: header(owner), ownerSchema: schema(owner),
  tables: taskSchema.filter((entry) => entry.type === 'table').map(({ name, sql }) => ({ name, sql,
    rows: database.prepare(`SELECT * FROM ${name}`).all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value instanceof Uint8Array ? { blob: value[0] === 0 ? '' : Buffer.from(value).toString('utf8').trimEnd(),
        bytes: value.byteLength, empty: value[0] === 0, sha256: sha256(value) } : value]))) })) };
assert.equal(fixture.taskHeader.userVersion, 3);
database.close(); owner.close();
mkdirSync(output, { recursive: false, mode: 0o700 });
const fixtureBytes = `${JSON.stringify(fixture, null, 2)}\n`;
writeFileSync(join(output, 'retained-v3.json'), fixtureBytes);
const consumer = JSON.parse(readFileSync(join(consumerRoot, 'package.json'), 'utf8'));
const packages = Object.entries(consumer.dependencies).filter(([name]) => name.startsWith('@agen-ai/')).map(([name, archive]) => {
  const path = archive.slice('file:'.length);
  const manifest = packageManifest(name);
  return { name, version: JSON.parse(readFileSync(manifest, 'utf8')).version, tarball: path.split('/').at(-1),
    tarballSha256: sha256(readFileSync(path)), manifestSha256: sha256(readFileSync(manifest)), entrypointSha256: sha256(readFileSync(entrypoint(name))) };
});
const sourceFiles = [];
for (const directory of ['sqlite', 'fixtures']) for (const file of readdirSync(join(exampleRoot, directory), { withFileTypes: true })) {
  if (file.isFile() && file.name.endsWith('.ts') && (directory === 'sqlite' || file.name === 'host.ts')) {
    const path = join(exampleRoot, directory, file.name);
    sourceFiles.push({ file: relative(exampleRoot, path), sha256: sha256(readFileSync(path)) });
  }
}
writeFileSync(join(output, 'provenance.json'), `${JSON.stringify({ method: 'Original MS001 installed V10 consumer and unchanged reference sources committed a real precise approval delivery and terminal success through the public coordinator. No native vendor or migration ran.',
  verifiedReferenceSourceCommit: sourceCommit, sourceCommitScope: 'The listed reference TypeScript source files were independently byte-compared with this git object. Installed package identity is recorded separately by exact bytes; no package build-commit field was retained.',
  producer: 'fixtures/history/format-three-producer.mjs',
  protocolVersion: 10, storeContractVersion: 3, taskFormat: 3, runtime: { ...fixture.runtime, filesystem: '0xef53' },
  fixtureSha256: sha256(fixtureBytes), producerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), packages, sourceFiles }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, taskFormat: 3, protocolVersion: 10, runtime: fixture.runtime, fixtureSha256: sha256(fixtureBytes) })}\n`);
