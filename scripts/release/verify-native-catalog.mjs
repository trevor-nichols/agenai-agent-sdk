// A reviewed record attests the native run; this offline gate independently proves applicability.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseGuestResult } from "../../scripts/development/agent-sandbox-qualification/capabilities/catalog/protocol.mjs";
import { boundedFile, digest, inspectCatalogBindings } from "./native-catalog/bindings.mjs";
import { NATIVE_CATALOG_TUPLE } from "./native-catalog/policy.mjs";
import { verifyCatalogConfiguration } from "./native-catalog/configuration.mjs";
import { verifyRepackPayloads } from "./native-catalog/repack.mjs";

function fields(value, expected, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or unknown fields.`);
  return value;
}

function parseRecord(value, version) {
  fields(value, ["format", "version", "provenance", "tuple", "bindings", "guestResult", "host"], "Native catalog record");
  assert.equal(value.format, "agenai.native-catalog.v1");
  assert.equal(value.version, version, "Native catalog evidence has a stale version.");
  fields(value.provenance, ["kind", "runId", "observedAt", "sourceRevision", "reportSha256"], "Catalog provenance");
  assert.equal(value.provenance.kind, "native", "Synthetic catalog evidence cannot admit publication.");
  assert.match(value.provenance.runId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
  assert.match(value.provenance.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(value.provenance.reportSha256, /^[a-f0-9]{64}$/u);
  assert.equal(new Date(value.provenance.observedAt).toISOString(), value.provenance.observedAt, "Invalid catalog observation time.");
  assert.deepEqual(value.tuple, NATIVE_CATALOG_TUPLE, "Catalog native/bootstrap/helper/platform tuple differs from reviewed policy.");
  fields(value.bindings, ["archives", "payloads", "harness", "configuration", "helper"], "Catalog bindings");
  const guest = parseGuestResult(value.guestResult);
  assert.equal(guest.observation, "native", "Scripted guest results cannot admit publication.");
  assert.equal(guest.status, "passed", "Native catalog outcome is failed, fallback or unproven.");
  assert.equal(guest.refresh.status, "confirmed", "A nonempty model list does not prove remote refresh.");
  assert.equal(guest.authentication.acknowledged, true, "Native account acknowledgement is missing.");
  assert(Object.values(guest.cleanup).every((joined) => joined === true), "Native guest cleanup is incomplete.");
  const host = fields(value.host, ["freshProfile", "accessOnly", "loginOrRefresh", "modelTasks", "cleanup"], "Catalog host evidence");
  assert.equal(host.freshProfile, true); assert.equal(host.accessOnly, true); assert.equal(host.loginOrRefresh, false); assert.equal(host.modelTasks, 0);
  const cleanup = fields(host.cleanup, ["originalOwner", "nativeJoined", "readerJoined", "observersJoined", "sandboxDestroyed", "independentAbsence", "resourceCount", "absentCount"], "Catalog cleanup");
  for (const key of ["originalOwner", "nativeJoined", "readerJoined", "observersJoined", "sandboxDestroyed", "independentAbsence"]) {
    assert.equal(cleanup[key], true, `Catalog cleanup is incomplete: ${key}.`);
  }
  assert(Number.isSafeInteger(cleanup.resourceCount) && cleanup.resourceCount > 0 && cleanup.resourceCount <= 65535, "Catalog resource census is incomplete.");
  assert.equal(cleanup.absentCount, cleanup.resourceCount, "Catalog independent absence is incomplete.");
  return guest;
}

export async function verifyNativeCatalog({ repositoryRoot, releaseDirectory, releaseRef }) {
  const root = path.resolve(repositoryRoot);
  const version = JSON.parse(await boundedFile(path.join(root, "package.json"))).version;
  assert.match(version, /^\d+\.\d+\.\d+$/u, "Catalog qualification requires an exact coordinated version.");
  assert.equal(releaseRef, `refs/tags/v${version}`, "Catalog evidence does not match the release ref.");
  const recordPath = path.join(root, "qualification/native-catalog", `${version}.json`);
  const recordBytes = await boundedFile(recordPath, 512 * 1024);
  const record = JSON.parse(recordBytes), guest = parseRecord(record, version);
  verifyCatalogConfiguration(JSON.parse(await boundedFile(path.join(root, "qualification/native-catalog", `configuration-${version}.json`))));
  const actual = await inspectCatalogBindings({ repositoryRoot: root, releaseDirectory, releaseRef });
  for (const name of ["harness", "configuration", "helper"]) {
    assert.deepEqual(actual[name], record.bindings[name], `Catalog ${name} applicability is stale.`);
  }
  assert.equal(actual.helper.sourceDigest, NATIVE_CATALOG_TUPLE.helper.sourceDigest, "Shipped helper differs from the reviewed native image closure.");
  let repacked = false;
  if (!isDeepStrictEqual(actual.archives, record.bindings.archives)) {
    const pair = JSON.parse(await boundedFile(path.join(root, "qualification/native-catalog", `${version}-repack.json`)));
    fields(pair, ["format", "evidenceSha256", "purpose", "qualifiedArchives", "releaseArchives", "payloads", "qualifiedManifests"], "Catalog repack approval");
    assert.equal(pair.format, "agenai.native-catalog-repack.v1"); assert.equal(pair.purpose, "nonbehavioral_packaging");
    assert.equal(pair.evidenceSha256, digest(recordBytes), "Catalog repack selects different native evidence.");
    assert.deepEqual(pair.qualifiedArchives, record.bindings.archives, "Catalog repack lost original archive identities.");
    assert.deepEqual(pair.releaseArchives, actual.archives, "Catalog repack has stale final archive identities.");
    assert.deepEqual(pair.payloads, actual.payloads, "Catalog repack cannot override payload equality.");
    await verifyRepackPayloads({ root, releaseDirectory, version, actual: actual.payloads,
      qualified: record.bindings.payloads, manifests: pair.qualifiedManifests });
    repacked = true;
  } else {
    assert.deepEqual(actual.payloads, record.bindings.payloads, "Catalog payloads applicability is stale.");
  }
  return { proof: "reviewed-native-catalog-applicability", version, nativeRun: record.provenance.runId,
    archives: actual.archives.length, remoteRefresh: "confirmed", grok47Advertised: guest.catalog.grok47Advertised, repacked };
}

function argumentsFor(argv) {
  assert.equal(argv.length, 4, "Usage: verify-native-catalog.mjs --release-ref refs/tags/vVERSION --release-directory release");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert(["--release-ref", "--release-directory"].includes(argv[index]) && !Object.hasOwn(values, argv[index]), "Unknown or duplicate catalog argument.");
    assert(typeof argv[index + 1] === "string" && argv[index + 1].length > 0, "Missing catalog argument value.");
    values[argv[index]] = argv[index + 1];
  }
  return { releaseRef: values["--release-ref"], releaseDirectory: values["--release-directory"] };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = argumentsFor(process.argv.slice(2));
  const result = await verifyNativeCatalog({ repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)), ...options });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
