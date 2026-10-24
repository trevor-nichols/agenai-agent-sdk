// ------------------------------------------------------------------------------------------------
//                configuration.ts - Explicit fixture and output authority
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DockerSandboxDataset, DockerSandboxProfile } from "@agen-ai/sandbox-docker";

function selectedDatasets(input: object) {
  if (!("datasets" in input) && !("datasetFixture" in input)) return undefined;
  assert("datasets" in input && Array.isArray(input.datasets) && input.datasets.length > 0 && input.datasets.length <= 32);
  const datasets: DockerSandboxDataset[] = input.datasets.map((value: unknown) => {
    assert(value !== null && typeof value === "object" && !Array.isArray(value));
    assert("name" in value && typeof value.name === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(value.name));
    assert("imageDigest" in value && typeof value.imageDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.imageDigest));
    if (!("subpath" in value)) return { name: value.name, imageDigest: value.imageDigest };
    assert(typeof value.subpath === "string" && /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(value.subpath));
    return { name: value.name, imageDigest: value.imageDigest, subpath: value.subpath };
  });
  assert("datasetFixture" in input && input.datasetFixture !== null && typeof input.datasetFixture === "object");
  const fixture = input.datasetFixture;
  assert("name" in fixture && fixture.name === "reference");
  assert("subpath" in fixture && fixture.subpath === "agenai-qualification-dataset");
  assert("path" in fixture && fixture.path === "manifest.txt");
  assert("byteLength" in fixture && typeof fixture.byteLength === "number" && Number.isSafeInteger(fixture.byteLength) && fixture.byteLength > 0 && fixture.byteLength <= 4096);
  assert("sha256" in fixture && typeof fixture.sha256 === "string" && /^[a-f0-9]{64}$/u.test(fixture.sha256));
  assert(datasets.some((entry) => entry.name === fixture.name && entry.subpath === fixture.subpath));
  return { datasets, datasetFixture: { name: fixture.name, path: fixture.path, subpath: fixture.subpath, byteLength: fixture.byteLength, sha256: fixture.sha256 } };
}

function selectedProfile(input: string | undefined): DockerSandboxProfile {
  const profile = input ?? "linux-x64";
  assert(profile === "linux-x64" || profile === "desktop-apple-virtualization-native-arm64"
    || profile === "desktop-apple-virtualization-rosetta-amd64", "AGENAI_SANDBOX_TEST_PROFILE must select an explicit supported profile.");
  return profile;
}

export async function sandboxExampleConfiguration(env: NodeJS.ProcessEnv) {
  const profile = selectedProfile(env.AGENAI_SANDBOX_TEST_PROFILE);
  const endpoint = env.AGENAI_SANDBOX_TEST_ENGINE;
  const manifestPath = env.AGENAI_SANDBOX_TEST_MANIFEST;
  const output = env.AGENAI_SANDBOX_TEST_OUTPUT;
  assert(typeof endpoint === "string" && endpoint.startsWith("unix:///"), "Explicit local AGENAI_SANDBOX_TEST_ENGINE is required.");
  assert(manifestPath && path.isAbsolute(manifestPath), "Absolute AGENAI_SANDBOX_TEST_MANIFEST is required.");
  assert(output && path.isAbsolute(output), "Absolute AGENAI_SANDBOX_TEST_OUTPUT is required.");
  assert((await stat(manifestPath)).size <= 65_536, "Sandbox fixture manifest exceeded its byte bound.");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest));
  assert("format" in manifest && manifest.format === "agenai.sandbox-docker-fixture.v1");
  assert("imageDigest" in manifest && typeof manifest.imageDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(manifest.imageDigest));
  assert("user" in manifest && manifest.user !== null && typeof manifest.user === "object");
  const user = manifest.user;
  assert("uid" in user && typeof user.uid === "number" && Number.isInteger(user.uid) && user.uid >= 1 && user.uid <= 262_143);
  assert("gid" in user && typeof user.gid === "number" && Number.isInteger(user.gid) && user.gid >= 1 && user.gid <= 262_143);
  return { endpoint, profile, imageDigest: manifest.imageDigest, user: { uid: user.uid, gid: user.gid }, output, ...selectedDatasets(manifest) };
}
