// ------------------------------------------------------------------------------------------------
//                verify-package-publication.mjs - Immutable npm publication admission
// ------------------------------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

// ------------------------------------------------------------------------------------------------
//                Release Identity
// ------------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_WORKFLOW_PATH = ".github/workflows/release.yml";
const PUBLISH_PREDICATE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const PROVENANCE_PREDICATES = new Set([
  "https://slsa.dev/provenance/v0.2",
  "https://slsa.dev/provenance/v1",
]);
const COMPARED_MANIFEST_FIELDS = Object.freeze([
  "name",
  "version",
  "description",
  "license",
  "type",
  "main",
  "module",
  "types",
  "exports",
  "engines",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "repository",
  "homepage",
  "bugs",
  "sideEffects",
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function assertJsonEqual(actual, expected, label) {
  const actualJson = JSON.stringify(canonicalJson(actual));
  const expectedJson = JSON.stringify(canonicalJson(expected));
  if (actualJson !== expectedJson) {
    throw new Error(`${label} does not match the intended tarball manifest.`);
  }
}

function createTarballIdentity(bytes) {
  const sha512 = createHash("sha512").update(bytes).digest();
  return Object.freeze({
    integrity: `sha512-${sha512.toString("base64")}`,
    sha512: sha512.toString("hex"),
    shasum: createHash("sha1").update(bytes).digest("hex"),
  });
}

function packagePurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `${encodeURIComponent(name.split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function registryPackagePath(name) {
  return encodeURIComponent(name);
}

function attestationsPath(name, version) {
  return `${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function decodeStatement(attestation) {
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (
    envelope?.payloadType !== "application/vnd.in-toto+json"
    || typeof envelope.payload !== "string"
    || !Array.isArray(envelope.signatures)
    || envelope.signatures.length === 0
  ) {
    throw new Error(`npm attestation ${attestation?.predicateType ?? "unknown"} is incomplete.`);
  }

  try {
    return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`npm attestation ${attestation.predicateType} has an invalid statement.`, {
      cause: error,
    });
  }
}

function assertStatementSubject(statement, expected) {
  const subject = statement?.subject?.find((entry) => entry?.name === expected.purl);
  if (subject?.digest?.sha512 !== expected.sha512) {
    throw new Error(`npm attestation subject does not match ${expected.purl}.`);
  }
}

function assertPublishStatement(statement, expected) {
  if (
    statement.predicateType !== PUBLISH_PREDICATE
    || statement.predicate?.name !== expected.name
    || statement.predicate?.version !== expected.version
    || statement.predicate?.registry !== expected.registryUrl
  ) {
    throw new Error(`npm publish attestation does not match ${expected.name}@${expected.version}.`);
  }
}

function assertProvenanceStatement(statement, expected) {
  if (!PROVENANCE_PREDICATES.has(statement.predicateType)) {
    throw new Error(`npm provenance attestation uses an unsupported predicate.`);
  }

  const repositoryUrl = `https://github.com/${expected.githubRepository}`;
  if (statement.predicateType === "https://slsa.dev/provenance/v1") {
    const buildDefinition = statement.predicate?.buildDefinition;
    const workflow = buildDefinition?.externalParameters?.workflow;
    const dependencies = buildDefinition?.resolvedDependencies;
    const commitMatches = Array.isArray(dependencies) && dependencies.some((dependency) => (
      dependency?.digest?.gitCommit === expected.githubSha
    ));
    if (
      workflow?.repository !== repositoryUrl
      || workflow?.path !== expected.workflowPath
      || workflow?.ref !== expected.githubRef
      || !commitMatches
      || statement.predicate?.runDetails?.builder?.id
        !== "https://github.com/actions/runner/github-hosted"
    ) {
      throw new Error(`npm provenance does not match the expected GitHub release identity.`);
    }
    return;
  }

  const invocation = statement.predicate?.invocation;
  const configSource = invocation?.configSource;
  const environment = invocation?.environment;
  if (
    configSource?.uri !== `git+${repositoryUrl}@${expected.githubRef}`
    || configSource?.digest?.sha1 !== expected.githubSha
    || !configSource?.entryPoint?.endsWith(`/${expected.workflowPath}@${expected.githubRef}`)
    || environment?.GITHUB_REPOSITORY !== expected.githubRepository
    || environment?.GITHUB_REF !== expected.githubRef
    || environment?.GITHUB_SHA !== expected.githubSha
  ) {
    throw new Error(`npm provenance does not match the expected GitHub release identity.`);
  }
}

async function readTarballManifest(tarballPath) {
  const { stdout } = await execFileAsync(
    "tar",
    ["-xOf", tarballPath, "package/package.json"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Release tarball contains an invalid package/package.json.`, { cause: error });
  }
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function assertRegistryUrl(registryUrl, allowInsecureRegistry) {
  const url = new URL(registryUrl);
  if (!allowInsecureRegistry && url.protocol !== "https:") {
    throw new Error(`npm registry must use HTTPS.`);
  }
  return url.origin;
}

// ------------------------------------------------------------------------------------------------
//                Publication Inspection
// ------------------------------------------------------------------------------------------------

export async function inspectPackagePublication({
  tarballPath,
  npmTag,
  githubRepository,
  githubRef,
  githubSha,
  releaseRef = githubRef,
  workflowPath = DEFAULT_WORKFLOW_PATH,
  registryUrl = DEFAULT_REGISTRY_URL,
  fetchImpl = fetch,
  allowInsecureRegistry = false,
}) {
  const resolvedTarballPath = path.resolve(assertNonEmptyString(tarballPath, "Tarball path"));
  const expectedTag = assertNonEmptyString(npmTag, "npm tag");
  const expectedRepository = assertNonEmptyString(githubRepository, "GitHub repository");
  const expectedRef = assertNonEmptyString(githubRef, "GitHub ref");
  const expectedSha = assertNonEmptyString(githubSha, "GitHub SHA");
  const expectedReleaseRef = assertNonEmptyString(releaseRef, "Release ref");
  const expectedWorkflow = assertNonEmptyString(workflowPath, "Workflow path");
  if (!/^[a-f0-9]{40}$/u.test(expectedSha)) {
    throw new Error(`GitHub SHA must be a full lowercase commit identity.`);
  }
  if (!expectedRef.startsWith("refs/tags/v") && expectedRef !== "refs/heads/main") {
    throw new Error(`GitHub ref must identify a version tag or the guarded main recovery.`);
  }
  if (!expectedReleaseRef.startsWith("refs/tags/v")) {
    throw new Error(`Release ref must identify a version tag.`);
  }

  const registryOrigin = assertRegistryUrl(registryUrl, allowInsecureRegistry);
  const tarballBytes = await readFile(resolvedTarballPath);
  const tarballIdentity = createTarballIdentity(tarballBytes);
  const manifest = await readTarballManifest(resolvedTarballPath);
  const name = assertNonEmptyString(manifest.name, "Tarball package name");
  const version = assertNonEmptyString(manifest.version, "Tarball package version");
  if (expectedReleaseRef !== `refs/tags/v${version}`) {
    throw new Error(`Tarball version ${version} does not match ${expectedReleaseRef}.`);
  }

  const packumentUrl = `${registryOrigin}/${registryPackagePath(name)}`;
  const packumentResponse = await fetchImpl(packumentUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (packumentResponse.status === 404) {
    return Object.freeze({ action: "publish", name, version, ...tarballIdentity });
  }
  if (!packumentResponse.ok) {
    throw new Error(`npm packument returned HTTP ${packumentResponse.status}.`);
  }

  const packument = await packumentResponse.json();
  const published = packument?.versions?.[version];
  if (published === undefined) {
    return Object.freeze({ action: "publish", name, version, ...tarballIdentity });
  }
  if (packument?.["dist-tags"]?.[expectedTag] !== version) {
    throw new Error(
      `${name}@${version} exists but npm tag ${expectedTag} does not select that version.`,
    );
  }

  for (const field of COMPARED_MANIFEST_FIELDS) {
    assertJsonEqual(published[field], manifest[field], `${name}@${version} field ${field}`);
  }
  if (
    published?.dist?.integrity !== tarballIdentity.integrity
    || published?.dist?.shasum !== tarballIdentity.shasum
  ) {
    throw new Error(`${name}@${version} registry integrity does not match the intended tarball.`);
  }

  const publishedTarballUrl = new URL(
    assertNonEmptyString(published?.dist?.tarball, "Published tarball URL"),
  );
  if (
    (!allowInsecureRegistry && publishedTarballUrl.protocol !== "https:")
    || publishedTarballUrl.origin !== registryOrigin
  ) {
    throw new Error(`${name}@${version} tarball URL leaves the admitted npm registry.`);
  }
  const publishedTarballResponse = await fetchImpl(publishedTarballUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!publishedTarballResponse.ok) {
    throw new Error(`${name}@${version} tarball returned HTTP ${publishedTarballResponse.status}.`);
  }
  const publishedTarball = Buffer.from(await publishedTarballResponse.arrayBuffer());
  if (!publishedTarball.equals(tarballBytes)) {
    throw new Error(`${name}@${version} registry tarball bytes do not match the intended tarball.`);
  }

  const attestationUrl = `${registryOrigin}/-/npm/v1/attestations/${attestationsPath(name, version)}`;
  const attestationDocument = await fetchJson(
    fetchImpl,
    attestationUrl,
    `${name}@${version} attestations`,
  );
  const attestations = attestationDocument?.attestations;
  const publishAttestation = attestations?.find((entry) => entry?.predicateType === PUBLISH_PREDICATE);
  const provenanceAttestation = attestations?.find((entry) => (
    PROVENANCE_PREDICATES.has(entry?.predicateType)
  ));
  if (publishAttestation === undefined || provenanceAttestation === undefined) {
    throw new Error(`${name}@${version} is missing npm publish or provenance attestations.`);
  }

  const expected = Object.freeze({
    name,
    version,
    purl: packagePurl(name, version),
    sha512: tarballIdentity.sha512,
    registryUrl: registryOrigin,
    githubRepository: expectedRepository,
    githubRef: expectedRef,
    githubSha: expectedSha,
    workflowPath: expectedWorkflow,
  });
  const publishStatement = decodeStatement(publishAttestation);
  assertStatementSubject(publishStatement, expected);
  assertPublishStatement(publishStatement, expected);
  const provenanceStatement = decodeStatement(provenanceAttestation);
  assertStatementSubject(provenanceStatement, expected);
  assertProvenanceStatement(provenanceStatement, expected);

  return Object.freeze({ action: "skip", name, version, ...tarballIdentity });
}

export async function waitForPackagePublication(options) {
  const attempts = options.attempts ?? 1;
  const delayMs = options.delayMs ?? 0;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await inspectPackagePublication(options);
      if (!options.requirePresent || result.action === "skip") return result;
      lastError = new Error(`${result.name}@${result.version} is not yet published.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

// ------------------------------------------------------------------------------------------------
//                Command Line Interface
// ------------------------------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { requirePresent: false, attempts: 1, delayMs: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-present") {
      options.requirePresent = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === "--tarball") options.tarballPath = value;
    else if (argument === "--npm-tag") options.npmTag = value;
    else if (argument === "--release-ref") options.releaseRef = value;
    else if (argument === "--github-output") options.githubOutput = value;
    else if (argument === "--attempts") options.attempts = Number.parseInt(value, 10);
    else if (argument === "--delay-ms") options.delayMs = Number.parseInt(value, 10);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1 || options.attempts > 30) {
    throw new Error(`Attempts must be an integer from 1 through 30.`);
  }
  if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 10_000) {
    throw new Error(`Delay must be an integer from 0 through 10000 milliseconds.`);
  }
  return options;
}

async function main() {
  const command = parseArguments(process.argv.slice(2));
  const result = await waitForPackagePublication({
    ...command,
    githubRepository: process.env.GITHUB_REPOSITORY,
    githubRef: process.env.GITHUB_REF,
    githubSha: process.env.GITHUB_SHA,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (command.githubOutput !== undefined) {
    await appendFile(
      command.githubOutput,
      `action=${result.action}\npackage_name=${result.name}\nversion=${result.version}\nintegrity=${result.integrity}\n`,
      "utf8",
    );
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
