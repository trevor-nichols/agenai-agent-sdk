// ------------------------------------------------------------------------------------------------
//                restore-release-artifact.mjs - Guarded original GitHub release archive restoration
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { GITHUB_API, admitArtifact, admitWorkflowRun, parseRecoveryRequest } from "./artifact/metadata.mjs";
import { restoreReleaseArtifact } from "./artifact/restore.mjs";

const execFileAsync = promisify(execFile);

async function githubJson(url, headers) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub artifact metadata returned HTTP ${response.status}.`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= 1024 * 1024, "GitHub control metadata exceeds 1 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function downloadArtifact(artifact, headers, destination) {
  const signal = AbortSignal.timeout(120_000);
  const redirect = await fetch(`${artifact.apiUrl}/zip`, { headers, redirect: "manual", signal });
  const locationHeader = redirect.headers.get("location");
  await redirect.body?.cancel();
  assert.equal(redirect.status, 302, `GitHub artifact download returned HTTP ${redirect.status}.`);
  const location = new URL(locationHeader);
  assert.ok(location.protocol === "https:" && !location.username && !location.password && !location.hash, "Invalid signed artifact download location.");
  // GitHub's one-minute signed storage URL receives no GitHub credential headers.
  const response = await fetch(location, { redirect: "error", signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Signed artifact download returned HTTP ${response.status}.`);
  }
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      assert.ok(bytes <= artifact.size, "Original artifact download exceeds its declared size.");
      yield chunk;
    }
    assert.equal(bytes, artifact.size, "Original artifact download ended before its declared size.");
  }, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
}

async function main() {
  assert.equal(process.argv.length, 4, "Usage: restore-release-artifact.mjs --artifact-id <positive integer>");
  assert.equal(process.argv[2], "--artifact-id", "Expected --artifact-id.");
  const expected = parseRecoveryRequest({ artifactId: process.argv[3], repository: process.env.GITHUB_REPOSITORY,
    githubRef: process.env.GITHUB_REF, releaseRef: process.env.RELEASE_REF, releaseSha: process.env.RELEASE_SHA });
  const root = process.cwd();
  const resolved = await execFileAsync("git", ["rev-parse", `${expected.releaseRef}^{commit}`], { cwd: root });
  assert.equal(resolved.stdout.trim(), expected.releaseSha, "Recovery tag does not resolve to the admitted commit.");
  const token = process.env.GITHUB_TOKEN;
  assert.ok(typeof token === "string" && token.length > 0 && !/[\r\n]/u.test(token), "GitHub Actions artifact read permission is required.");
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const artifact = admitArtifact(await githubJson(`${GITHUB_API}/repos/${expected.repository}/actions/artifacts/${expected.artifactId}`, headers), expected);
  const run = await githubJson(`${expected.apiRoot}/actions/runs/${artifact.runId}/attempts/${artifact.attempt}`, headers);
  const workflowRun = admitWorkflowRun(run, artifact, expected);
  const taggedMetadata = {};
  for (const name of ["pnpm-lock.yaml", ".agenai-export.json"]) {
    taggedMetadata[name] = (await execFileAsync("git", ["show", `${expected.releaseRef}:${name}`], { cwd: root, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 })).stdout;
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "agenai-artifact-download-"));
  let primary;
  try {
    const archivePath = path.join(scratch, "original.zip");
    await downloadArtifact(artifact, headers, archivePath);
    await restoreReleaseArtifact({ repositoryRoot: root, archivePath, artifact, workflowRun, expected, taggedMetadata });
    process.stdout.write(`Restored original artifact ${artifact.id} from run ${artifact.runId} attempt ${artifact.attempt}; no package was repacked.\n`);
  } catch (error) { primary = { error }; }
  try { await rm(scratch, { recursive: true }); }
  catch (error) {
    if (primary) throw new AggregateError([primary.error, error], "Artifact download and scratch cleanup failed.");
    throw error;
  }
  if (primary) throw primary.error;
}

await main();
