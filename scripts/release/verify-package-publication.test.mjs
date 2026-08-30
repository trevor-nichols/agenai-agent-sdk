// ------------------------------------------------------------------------------------------------
//                verify-package-publication.test.mjs - Immutable npm admission tests
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectPackagePublication } from "./verify-package-publication.mjs";

// ------------------------------------------------------------------------------------------------
//                Fixtures
// ------------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const REGISTRY_URL = "http://registry.test";
const GITHUB_REPOSITORY = "trevor-nichols/agenai-agent-sdk";
const GITHUB_REF = "refs/tags/v0.2.0";
const GITHUB_SHA = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST = Object.freeze({
  name: "@agen-ai/validation",
  version: "0.2.0",
  description: "Validation contracts.",
  license: "MIT",
  type: "module",
  main: "./dist/index.js",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  engines: { node: ">=22.0.0" },
  dependencies: { zod: "4.4.3" },
  repository: {
    type: "git",
    url: "git+https://github.com/trevor-nichols/agenai-agent-sdk.git",
    directory: "packages/validation",
  },
  homepage: "https://github.com/trevor-nichols/agenai-agent-sdk#readme",
  bugs: { url: "https://github.com/trevor-nichols/agenai-agent-sdk/issues" },
  sideEffects: false,
  files: ["dist", "README.md", "LICENSE"],
});

async function createTarball(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenai-release-verifier-"));
  t.after(async () => {
    await execFileAsync("find", [root, "-depth", "-delete"]);
  });
  const packageRoot = path.join(root, "package");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  await writeFile(path.join(packageRoot, "dist/index.js"), "export const ok = true;\n");
  const tarballPath = path.join(root, "agen-ai-validation-0.2.0.tgz");
  await execFileAsync("tar", ["-czf", tarballPath, "-C", root, "package"]);
  const bytes = await readFile(tarballPath);
  return Object.freeze({
    tarballPath,
    bytes,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha512: createHash("sha512").update(bytes).digest("hex"),
    shasum: createHash("sha1").update(bytes).digest("hex"),
  });
}

function createAttestation(predicateType, statement) {
  return {
    predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3",
      verificationMaterial: {},
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "fixture" }],
      },
    },
  };
}

function publicationFixture(tarball, overrides = {}) {
  const subject = [{
    name: "pkg:npm/%40agen-ai/validation@0.2.0",
    digest: { sha512: tarball.sha512 },
  }];
  const publishPredicate = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
  const provenancePredicate = "https://slsa.dev/provenance/v1";
  const packument = {
    "dist-tags": { beta: "0.2.0", latest: "0.1.0" },
    versions: {
      "0.2.0": {
        ...MANIFEST,
        dist: {
          integrity: tarball.integrity,
          shasum: tarball.shasum,
          tarball: `${REGISTRY_URL}/tarballs/validation-0.2.0.tgz`,
        },
      },
    },
  };
  const attestations = [
    createAttestation(publishPredicate, {
      _type: "https://in-toto.io/Statement/v0.1",
      subject,
      predicateType: publishPredicate,
      predicate: {
        name: MANIFEST.name,
        version: MANIFEST.version,
        registry: REGISTRY_URL,
      },
    }),
    createAttestation(provenancePredicate, {
      _type: "https://in-toto.io/Statement/v1",
      subject,
      predicateType: provenancePredicate,
      predicate: {
        buildDefinition: {
          buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
          externalParameters: {
            workflow: {
              ref: GITHUB_REF,
              repository: `https://github.com/${GITHUB_REPOSITORY}`,
              path: ".github/workflows/release.yml",
            },
          },
          resolvedDependencies: [{
            uri: `git+https://github.com/${GITHUB_REPOSITORY}@${GITHUB_REF}`,
            digest: { gitCommit: GITHUB_SHA },
          }],
        },
        runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
      },
    }),
  ];
  return {
    packument: Object.hasOwn(overrides, "packument") ? overrides.packument : packument,
    publishedBytes: overrides.publishedBytes ?? tarball.bytes,
    attestations: overrides.attestations ?? attestations,
  };
}

function fixtureFetch(fixture) {
  return async (input) => {
    const url = String(input);
    if (url === `${REGISTRY_URL}/%40agen-ai%2Fvalidation`) {
      if (fixture.packument === null) return new Response("not found", { status: 404 });
      return Response.json(fixture.packument);
    }
    if (url === `${REGISTRY_URL}/tarballs/validation-0.2.0.tgz`) {
      return new Response(fixture.publishedBytes);
    }
    if (url === `${REGISTRY_URL}/-/npm/v1/attestations/%40agen-ai%2Fvalidation@0.2.0`) {
      return Response.json({ attestations: fixture.attestations });
    }
    return new Response("unexpected", { status: 500 });
  };
}

function inspect(tarball, fixture) {
  return inspectPackagePublication({
    tarballPath: tarball.tarballPath,
    npmTag: "beta",
    githubRepository: GITHUB_REPOSITORY,
    githubRef: GITHUB_REF,
    githubSha: GITHUB_SHA,
    registryUrl: REGISTRY_URL,
    fetchImpl: fixtureFetch(fixture),
    allowInsecureRegistry: true,
  });
}

// ------------------------------------------------------------------------------------------------
//                Admission Behavior
// ------------------------------------------------------------------------------------------------

test("admits publication when the immutable version is absent", async (t) => {
  const tarball = await createTarball(t);
  const result = await inspect(tarball, publicationFixture(tarball, { packument: null }));
  assert.equal(result.action, "publish");
  assert.equal(result.integrity, tarball.integrity);
});

test("skips only an exact tagged publication with matching provenance", async (t) => {
  const tarball = await createTarball(t);
  const result = await inspect(tarball, publicationFixture(tarball));
  assert.deepEqual(
    { action: result.action, name: result.name, version: result.version },
    { action: "skip", name: MANIFEST.name, version: MANIFEST.version },
  );
});

test("rejects an immutable registry integrity mismatch", async (t) => {
  const tarball = await createTarball(t);
  const fixture = publicationFixture(tarball);
  fixture.packument.versions[MANIFEST.version].dist.integrity = "sha512-wrong";
  await assert.rejects(() => inspect(tarball, fixture), /registry integrity does not match/u);
});

test("rejects a normalized manifest mismatch", async (t) => {
  const tarball = await createTarball(t);
  const fixture = publicationFixture(tarball);
  fixture.packument.versions[MANIFEST.version].dependencies = { zod: "4.4.2" };
  await assert.rejects(() => inspect(tarball, fixture), /field dependencies/u);
});

test("rejects a version not selected by the requested tag", async (t) => {
  const tarball = await createTarball(t);
  const fixture = publicationFixture(tarball);
  fixture.packument["dist-tags"].beta = "0.1.0";
  await assert.rejects(() => inspect(tarball, fixture), /tag beta does not select/u);
});

test("rejects provenance from another commit", async (t) => {
  const tarball = await createTarball(t);
  const fixture = publicationFixture(tarball);
  const provenance = fixture.attestations.find((entry) => (
    entry.predicateType === "https://slsa.dev/provenance/v1"
  ));
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
  );
  statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "f".repeat(40);
  provenance.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  await assert.rejects(() => inspect(tarball, fixture), /expected GitHub release identity/u);
});

test("rejects a missing provenance attestation", async (t) => {
  const tarball = await createTarball(t);
  const fixture = publicationFixture(tarball);
  fixture.attestations = fixture.attestations.filter((entry) => (
    entry.predicateType === "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
  ));
  await assert.rejects(() => inspect(tarball, fixture), /missing npm publish or provenance/u);
});
