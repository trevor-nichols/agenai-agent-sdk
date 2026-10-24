// ------------------------------------------------------------------------------------------------
//                metadata.mjs - Admit the original tagged GitHub release artifact and run attempt
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";

export const GITHUB_API = "https://api.github.com";
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

function identifier(value, label) {
  assert.ok(typeof value === "string" && /^[1-9]\d*$/u.test(value), `${label} must be a positive integer.`);
  assert.ok(Number.isSafeInteger(Number(value)), `${label} exceeds the supported integer range.`);
  return Number(value);
}

export function parseRecoveryRequest({ artifactId, repository, githubRef, releaseRef, releaseSha }) {
  assert.equal(githubRef, "refs/heads/main", "Original artifacts are admitted only by guarded main recovery.");
  assert.ok(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), "Invalid GitHub repository.");
  assert.ok(typeof releaseRef === "string" && /^refs\/tags\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(releaseRef), "An explicit version tag is required.");
  assert.ok(typeof releaseSha === "string" && /^[a-f0-9]{40}$/u.test(releaseSha), "Invalid resolved release commit.");
  return Object.freeze({ artifactId: identifier(artifactId, "Artifact ID"), repository, releaseRef, releaseSha,
    releaseTag: releaseRef.slice("refs/tags/".length), apiRoot: `${GITHUB_API}/repos/${repository}` });
}

export function admitArtifact(metadata, expected) {
  assert.equal(metadata?.id, expected.artifactId, "Artifact ID does not match the selected artifact.");
  assert.equal(metadata.expired, false, "Original release artifact has expired.");
  const prefix = `npm-release-${expected.releaseTag}-attempt-`;
  assert.ok(typeof metadata.name === "string" && metadata.name.startsWith(prefix), "Artifact name does not identify this release.");
  const attempt = identifier(metadata.name.slice(prefix.length), "Original run attempt");
  assert.match(metadata.digest ?? "", /^sha256:[a-f0-9]{64}$/u, "Original artifact needs a SHA-256 digest.");
  assert.ok(Number.isSafeInteger(metadata.size_in_bytes) && metadata.size_in_bytes > 0
    && metadata.size_in_bytes <= MAX_ARCHIVE_BYTES, "Original artifact exceeds the 64 MiB restoration budget.");
  const apiUrl = `${expected.apiRoot}/actions/artifacts/${expected.artifactId}`;
  assert.equal(metadata.url, apiUrl, "Artifact metadata URL leaves the selected repository.");
  assert.equal(metadata.archive_download_url, `${apiUrl}/zip`, "Artifact download URL leaves the selected repository.");
  const run = metadata.workflow_run;
  assert.equal(run?.head_sha, expected.releaseSha, "Original artifact was not produced by the release commit.");
  assert.equal(run.head_branch, expected.releaseTag, "Original artifact was not produced from the version tag.");
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0, "Invalid original workflow run ID.");
  assert.ok(Number.isSafeInteger(run.repository_id) && run.repository_id > 0, "Invalid original repository ID.");
  assert.equal(run.head_repository_id, run.repository_id, "Original artifact came from a foreign head repository.");
  return Object.freeze({ id: metadata.id, attempt, runId: run.id, repositoryId: run.repository_id,
    digest: metadata.digest, size: metadata.size_in_bytes, apiUrl, metadata });
}

export function admitWorkflowRun(run, artifact, expected) {
  assert.equal(run?.id, artifact.runId, "Original workflow run ID does not match the artifact.");
  assert.equal(run.run_attempt, artifact.attempt, "Original workflow attempt does not match the artifact name.");
  assert.equal(run.repository?.full_name, expected.repository, "Original workflow repository does not match.");
  assert.equal(run.repository.id, artifact.repositoryId, "Original workflow repository identity does not match.");
  assert.equal(run.head_repository?.id, artifact.repositoryId, "Original workflow head repository does not match.");
  assert.equal(run.head_sha, expected.releaseSha, "Original workflow commit does not match the version tag.");
  assert.equal(run.head_branch, expected.releaseTag, "Original workflow ref does not match the version tag.");
  assert.equal(run.event, "workflow_dispatch", "Original artifact was not produced by the release dispatch.");
  const workflowPath = ".github/workflows/release.yml";
  assert.ok([workflowPath, `${workflowPath}@${expected.releaseTag}`, `${workflowPath}@${expected.releaseRef}`].includes(run.path), "Original artifact came from a different workflow.");
  assert.equal(run.status, "completed", "Original workflow attempt must be quiescent.");
  assert.ok(typeof run.conclusion === "string" && run.conclusion.length > 0, "Original workflow has no terminal conclusion.");
  return Object.freeze({ id: run.id, attempt: run.run_attempt, repository: expected.repository,
    repositoryId: artifact.repositoryId, headSha: run.head_sha, ref: expected.releaseRef, path: run.path,
    event: run.event, status: run.status, conclusion: run.conclusion });
}
