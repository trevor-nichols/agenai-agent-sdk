// ------------------------------------------------------------------------------------------------
//                restore-release-artifact.test.mjs - Original-byte restoration and hostile ZIP admission
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PUBLIC_PACKAGE_POLICIES } from "./package-inventory.mjs";
import { admitArtifact, admitWorkflowRun, parseRecoveryRequest } from "./artifact/metadata.mjs";
import { restoreReleaseArtifact } from "./artifact/restore.mjs";

const execFileAsync = promisify(execFile);
const expected = parseRecoveryRequest({ artifactId: "12577458147", repository: "owner/sdk", githubRef: "refs/heads/main",
  releaseRef: "refs/tags/v0.4.4", releaseSha: "9".repeat(40) });
const metadata = { id: expected.artifactId, name: "npm-release-v0.4.4-attempt-2", expired: false, size_in_bytes: 1,
  digest: `sha256:${"0".repeat(64)}`, url: `${expected.apiRoot}/actions/artifacts/${expected.artifactId}`,
  archive_download_url: `${expected.apiRoot}/actions/artifacts/${expected.artifactId}/zip`,
  workflow_run: { id: 42, repository_id: 8, head_repository_id: 8, head_branch: "v0.4.4", head_sha: expected.releaseSha } };
const run = { id: 42, run_attempt: 2, repository: { id: 8, full_name: "owner/sdk" }, head_repository: { id: 8 },
  head_sha: expected.releaseSha, head_branch: "v0.4.4", path: ".github/workflows/release.yml", event: "workflow_dispatch",
  status: "completed", conclusion: "failure" };

const fixturePython = `
import io,json,pathlib,stat,sys,tarfile,zipfile
root=pathlib.Path(sys.argv[1]);data=json.loads(sys.argv[2]);scenario=sys.argv[3]
files=[]
for index,manifest in enumerate(data['manifests']):
    packed=dict(manifest)
    if scenario=='mixed-version' and index==0: packed['version']='0.4.3'
    if scenario=='foreign-package' and index==0: packed['name']='@foreign/package'
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
        for name,payload in [('package/package.json',json.dumps(packed).encode()),('package/original.bin',bytes([index,0,255])*97)]:
            member=tarfile.TarInfo(name);member.size=len(payload);member.mode=0o644;archive.addfile(member,io.BytesIO(payload))
    name=manifest['name'].replace('@','').replace('/','-')+'-0.4.4.tgz'
    payload=buffer.getvalue();(root/'original'/name).write_bytes(payload);files.append(('release/'+name,payload))
for name in ['pnpm-lock.yaml','.agenai-export.json']:
    payload=data['taggedMetadata'][name].encode()
    if scenario=='changed-lock' and name=='pnpm-lock.yaml': payload+=b'foreign'
    if scenario=='changed-export' and name=='.agenai-export.json': payload+=b'foreign'
    files.append((name,payload))
if scenario=='missing': files.pop(0)
if scenario in ['foreign','traversal','absolute','backslash']:
    files.append(({'foreign':'unknown.txt','traversal':'../escaped','absolute':'/escaped','backslash':'release\\\\escaped'}[scenario],b'untrusted'))
with zipfile.ZipFile(root/'original.zip','w',compression=zipfile.ZIP_STORED) as archive:
    for index,(name,payload) in enumerate(files):
        member=zipfile.ZipInfo(name);member.create_system=3;member.external_attr=(stat.S_IFREG|0o644)<<16
        if scenario=='symlink' and index==0: member.external_attr=(stat.S_IFLNK|0o777)<<16;payload=b'/outside'
        archive.writestr(member,payload)
    if scenario=='duplicate': archive.writestr(files[0][0],files[0][1])
if scenario=='late-crc':
    with zipfile.ZipFile(root/'original.zip') as archive: member=archive.infolist()[-1]
    payload=bytearray((root/'original.zip').read_bytes());offset=member.header_offset+30+len(member.filename.encode())+len(member.extra);payload[offset]^=1;(root/'original.zip').write_bytes(payload)
`;

async function fixture(t, scenario = "valid") {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenai-original-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "original"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.4.4" }));
  const manifests = PUBLIC_PACKAGE_POLICIES.map((policy) => ({ name: policy.name, version: "0.4.4", repository: { directory: policy.root } }));
  for (const [index, policy] of PUBLIC_PACKAGE_POLICIES.entries()) {
    await mkdir(path.join(root, policy.root), { recursive: true });
    await writeFile(path.join(root, policy.root, "package.json"), JSON.stringify(manifests[index]));
  }
  const taggedMetadata = { "pnpm-lock.yaml": Buffer.from("original tagged lock\n"), ".agenai-export.json": Buffer.from('{"source":"original tag"}\n') };
  await writeFile(path.join(root, ".agenai-export.json"), '{"source":"changed recovery HEAD"}\n');
  await execFileAsync("python3", ["-c", fixturePython, root,
    JSON.stringify({ manifests, taggedMetadata: Object.fromEntries(Object.entries(taggedMetadata).map(([name, bytes]) => [name, bytes.toString()])) }), scenario]);
  const archivePath = path.join(root, "original.zip");
  const bytes = await readFile(archivePath);
  const artifact = admitArtifact({ ...metadata, size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, expected);
  return { root, options: { repositoryRoot: root, archivePath, artifact,
    workflowRun: admitWorkflowRun(run, artifact, expected), expected, taggedMetadata } };
}

async function assertUnpublished(root) {
  const names = await readdir(root);
  assert.equal(names.includes("release"), false);
  assert.equal(names.includes("release-artifact-receipt.json"), false);
}

test("restores all original archive bytes from a failed publication attempt and uses tagged metadata rather than recovery HEAD", async (t) => {
  const input = await fixture(t);
  const receipt = await restoreReleaseArtifact(input.options);
  const filenames = await readdir(path.join(input.root, "original"));
  assert.equal(filenames.length, 10);
  assert.deepEqual((await readdir(path.join(input.root, "release"))).sort(), filenames.sort());
  for (const name of filenames) assert.deepEqual(await readFile(path.join(input.root, "release", name)), await readFile(path.join(input.root, "original", name)));
  assert.equal(receipt.originalWorkflowRun.conclusion, "failure");
  assert.equal(receipt.originalWorkflowRun.attempt, 2);
  assert.equal(receipt.originalArtifact.id, expected.artifactId);
  assert.equal(receipt.archives.length, 10);
  assert.deepEqual(JSON.parse(await readFile(path.join(input.root, "release-artifact-receipt.json"))), receipt);
  await assert.rejects(restoreReleaseArtifact(input.options), /destination already exists/u);
  for (const name of filenames) assert.deepEqual(await readFile(path.join(input.root, "release", name)), await readFile(path.join(input.root, "original", name)));
});

for (const [scenario, message] of [
  ["duplicate", /duplicate, missing or foreign/u], ["foreign", /duplicate, missing or foreign/u],
  ["missing", /duplicate, missing or foreign/u], ["traversal", /duplicate, missing or foreign/u],
  ["absolute", /duplicate, missing or foreign/u], ["backslash", /duplicate, missing or foreign/u],
  ["symlink", /regular files, never links/u], ["late-crc", /Bad CRC-32/u],
  ["mixed-version", /mixed version/u], ["foreign-package", /wrong package identity/u],
  ["changed-lock", /Retained pnpm-lock.yaml does not match/u], ["changed-export", /Retained .agenai-export.json does not match/u],
]) test(`rejects ${scenario} before publishing any release destination`, async (t) => {
  const input = await fixture(t, scenario);
  await assert.rejects(restoreReleaseArtifact(input.options), message);
  await assertUnpublished(input.root);
});

test("rejects an archive digest mismatch before ZIP decoding and preserves an existing caller destination", async (t) => {
  const input = await fixture(t);
  await assert.rejects(restoreReleaseArtifact({ ...input.options, artifact: { ...input.options.artifact, digest: `sha256:${"f".repeat(64)}` } }), /digest does not match/u);
  await assertUnpublished(input.root);
  await mkdir(path.join(input.root, "release"));
  await writeFile(path.join(input.root, "release", "caller-owned"), "preserve");
  await assert.rejects(restoreReleaseArtifact(input.options), /destination already exists/u);
  assert.equal(await readFile(path.join(input.root, "release", "caller-owned"), "utf8"), "preserve");
});

test("admits only matching unexpired original tagged workflow identities", () => {
  const artifact = admitArtifact(metadata, expected);
  assert.equal(admitWorkflowRun(run, artifact, expected).conclusion, "failure");
  for (const change of [
    { id: 1 }, { expired: true }, { name: "foreign-v0.4.4-attempt-2" }, { digest: "missing" },
    { archive_download_url: "https://foreign.invalid/archive.zip" },
    { workflow_run: { ...metadata.workflow_run, head_sha: "8".repeat(40) } },
    { workflow_run: { ...metadata.workflow_run, head_branch: "main" } },
    { workflow_run: { ...metadata.workflow_run, head_repository_id: 9 } },
  ]) assert.throws(() => admitArtifact({ ...metadata, ...change }, expected));
  for (const change of [
    { run_attempt: 3 }, { repository: { id: 9, full_name: "foreign/sdk" } }, { head_repository: { id: 9 } },
    { head_sha: "8".repeat(40) }, { head_branch: "main" }, { path: ".github/workflows/foreign.yml" },
    { event: "pull_request" }, { status: "in_progress" },
  ]) assert.throws(() => admitWorkflowRun({ ...run, ...change }, artifact, expected));
});

test("the CLI rejects tag-run and malformed artifact inputs before any GitHub operation", async () => {
  const script = fileURLToPath(new URL("./restore-release-artifact.mjs", import.meta.url));
  const environment = { PATH: process.env.PATH, GITHUB_REPOSITORY: expected.repository, RELEASE_REF: expected.releaseRef, RELEASE_SHA: expected.releaseSha };
  await assert.rejects(execFileAsync(process.execPath, [script, "--artifact-id", "1"], { env: { ...environment, GITHUB_REF: expected.releaseRef } }),
    (error) => /only by guarded main recovery/u.test(error.stderr));
  await assert.rejects(execFileAsync(process.execPath, [script, "--artifact-id", "1;echo unsafe"], { env: { ...environment, GITHUB_REF: "refs/heads/main" } }),
    (error) => /Artifact ID must be a positive integer/u.test(error.stderr));
});
