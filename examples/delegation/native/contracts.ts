import { isAbsolute } from 'node:path';
import { parseAgentConfigurationCatalog, parseAgentConfigurationSelectionFor } from '@agen-ai/agent-protocol';
import type { NativeLaunchCandidate, NativeFileIdentity } from './launch-contracts.js';
import { SDK_PACKAGE_NAMES, type NativeSdkIdentity, type RuntimeFile } from './identity.js';
import { validateGrokSelection, type GrokConfigurationSelection } from './grok.js';
import type { NativeGrokMapping } from './host-contracts.js';
import { parseNativeParentPermissionProof, type NativeParentPermissionProof } from './permission-contracts.js';
import { array, digest, exact, integer, NativeInputError, record, semanticDigest, textValue } from './json.js';

export interface NativeCandidate extends NativeLaunchCandidate {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly sdk: NativeSdkIdentity;
  readonly runnerFiles: readonly RuntimeFile[];
  readonly runnerDigest: string;
  readonly choice: Readonly<{ modelId: 'grok-4.3'; reasoning: 'low' }>;
  readonly credential: Readonly<{ kind: 'dotenv'; path: string; key: 'XAI_API_KEY'; sourceId: string }>;
}

export interface NativeSelection {
  readonly schemaVersion: 1;
  readonly candidateDigest: string;
  readonly discoveryDigest: string;
  readonly nativeSha256: string;
  readonly sdkDigest: string;
  readonly configuration: GrokConfigurationSelection;
  readonly mapping: NativeGrokMapping;
  readonly mappingProof: unknown;
  readonly parentPermissionProof?: NativeParentPermissionProof;
}

function hash(value: unknown): string {
  const result = textValue(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new NativeInputError('input_hash_invalid');
  return result;
}

function gitHash(value: unknown): string {
  const result = textValue(value, 40);
  if (!/^[a-f0-9]{40}$/u.test(result)) throw new NativeInputError('input_revision_invalid');
  return result;
}

function absolute(value: unknown): string {
  const result = textValue(value);
  if (!isAbsolute(result)) throw new NativeInputError('input_path_invalid');
  return result;
}

function fileIdentity(value: unknown): NativeFileIdentity {
  const input = record(value, ['bytes', 'sha256']);
  return { bytes: integer(input.bytes, 1, 268_435_456), sha256: hash(input.sha256) };
}

function fileList(value: unknown): readonly RuntimeFile[] {
  const files = array(value, 4096, (item) => {
    const input = record(item, ['path', 'bytes', 'sha256']);
    const path = textValue(input.path, 512);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new NativeInputError('input_relative_path_invalid');
    }
    return { path, bytes: integer(input.bytes, 0, 268_435_456), sha256: digest(input.sha256) };
  });
  if (!files.length || files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path)) throw new NativeInputError('input_file_inventory_invalid');
  return files;
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 512) throw new NativeInputError('dependency_graph_invalid');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [textValue(key, 512), textValue(item, 1024)]));
}

export function parseSdkIdentity(value: unknown): NativeSdkIdentity {
  const input = record(value, ['sourceRevision', 'nodeVersion', 'nodeSha256', 'pnpmVersion', 'pnpmSha256', 'lockfileSha256', 'packages', 'mcp']);
  const packages = array(input.packages, 7, (item) => {
    const pkg = record(item, ['name', 'version', 'sourceGitTree', 'manifestSha256', 'runtimeFiles', 'runtimeTreeSha256']);
    const name = textValue(pkg.name, 100);
    if (!SDK_PACKAGE_NAMES.includes(name as typeof SDK_PACKAGE_NAMES[number])) throw new NativeInputError('sdk_inventory_invalid');
    const files = fileList(pkg.runtimeFiles);
    const tree = digest(pkg.runtimeTreeSha256);
    if (semanticDigest(files) !== tree) throw new NativeInputError('sdk_inventory_digest_invalid');
    return { name: name as typeof SDK_PACKAGE_NAMES[number], version: exact(pkg.version, '0.4.1'), sourceGitTree: gitHash(pkg.sourceGitTree),
      manifestSha256: digest(pkg.manifestSha256), runtimeFiles: files, runtimeTreeSha256: tree };
  });
  if (packages.length !== 7 || new Set(packages.map((pkg) => pkg.name)).size !== 7) throw new NativeInputError('sdk_inventory_invalid');
  const mcp = record(input.mcp, ['version', 'rootSnapshot', 'graph', 'graphSha256', 'runtimeFiles', 'runtimeTreeSha256']);
  if (mcp.graph === null || typeof mcp.graph !== 'object' || Array.isArray(mcp.graph)
    || Object.keys(mcp.graph).length > 512) throw new NativeInputError('dependency_graph_invalid');
  const graph = Object.fromEntries(Object.entries(mcp.graph).map(([key, item]) => {
    const node = record(item, ['integrity', 'dependencies', 'optionalDependencies']);
    return [textValue(key, 1024), { integrity: node.integrity === null ? null : textValue(node.integrity, 512),
      dependencies: stringMap(node.dependencies), optionalDependencies: stringMap(node.optionalDependencies) }];
  }));
  const rootSnapshot = textValue(mcp.rootSnapshot, 1024);
  const graphSha256 = digest(mcp.graphSha256);
  const files = fileList(mcp.runtimeFiles);
  const tree = digest(mcp.runtimeTreeSha256);
  if (!Object.hasOwn(graph, rootSnapshot) || semanticDigest(graph) !== graphSha256 || semanticDigest(files) !== tree) throw new NativeInputError('dependency_graph_invalid');
  return { sourceRevision: gitHash(input.sourceRevision), nodeVersion: textValue(input.nodeVersion, 64), nodeSha256: digest(input.nodeSha256),
    pnpmVersion: textValue(input.pnpmVersion, 64), pnpmSha256: digest(input.pnpmSha256), lockfileSha256: digest(input.lockfileSha256), packages,
    mcp: { version: exact(mcp.version, '1.29.0'), rootSnapshot, graph, graphSha256, runtimeFiles: files, runtimeTreeSha256: tree } };
}

export function parseNativeCandidate(value: unknown): NativeCandidate {
  const input = record(value, ['schemaVersion', 'candidateId', 'native', 'launch', 'upstreamArtifact', 'transformation', 'sdk', 'runnerFiles', 'runnerDigest', 'choice', 'credential']);
  const native = record(input.native, ['version', 'target', 'installedCommandPath', 'inspectedExecutablePath', 'bytes', 'sha256']);
  const launch = record(input.launch, ['args']);
  const args = array(launch.args, 3, (item) => textValue(item, 100));
  if (JSON.stringify(args) !== JSON.stringify(['agent', '--no-leader', 'stdio'])) throw new NativeInputError('launch_recipe_invalid');
  const upstream = record(input.upstreamArtifact, ['url', 'bytes', 'sha256', 'decoded']);
  const decoded = record(upstream.decoded, ['bytes', 'sha256', 'magicHex']);
  const url = textValue(upstream.url);
  if (url !== 'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.50-linux-x86_64.gz') throw new NativeInputError('artifact_unapproved');
  const transformation = record(input.transformation, ['recipe', 'decoderExecutable', 'decoderExecutableSha256', 'pythonVersion', 'zlibCompileVersion', 'zlibRuntimeVersion', 'inputChunkBytes', 'outputChunkBytes', 'maxInputBytes', 'maxOutputBytes', 'plannedTimeoutMs']);
  const choice = record(input.choice, ['modelId', 'reasoning']);
  const credential = record(input.credential, ['kind', 'path', 'key', 'sourceId']);
  const runnerFiles = fileList(input.runnerFiles);
  const runnerDigest = digest(input.runnerDigest);
  if (semanticDigest(runnerFiles) !== runnerDigest) throw new NativeInputError('source_identity_drift');
  const nativeIdentity = fileIdentity({ bytes: native.bytes, sha256: native.sha256 });
  const decodedIdentity = fileIdentity({ bytes: decoded.bytes, sha256: decoded.sha256 });
  if (nativeIdentity.sha256 !== decodedIdentity.sha256 || nativeIdentity.bytes !== decodedIdentity.bytes) throw new NativeInputError('artifact_identity_drift');
  return { schemaVersion: exact(input.schemaVersion, 1), candidateId: textValue(input.candidateId, 200),
    native: { ...nativeIdentity, version: exact(native.version, '1.0.50'), target: exact(native.target, 'linux-x86_64'),
      installedCommandPath: absolute(native.installedCommandPath), inspectedExecutablePath: absolute(native.inspectedExecutablePath) },
    launch: { args }, upstreamArtifact: { ...fileIdentity({ bytes: upstream.bytes, sha256: upstream.sha256 }), url,
      decoded: { ...decodedIdentity, magicHex: exact(decoded.magicHex, '7f454c46') } },
    transformation: { recipe: exact(transformation.recipe, 'gzip-single-member-stream-v1'), decoderExecutable: absolute(transformation.decoderExecutable),
      decoderExecutableSha256: hash(transformation.decoderExecutableSha256), pythonVersion: textValue(transformation.pythonVersion, 64),
      zlibCompileVersion: textValue(transformation.zlibCompileVersion, 64), zlibRuntimeVersion: textValue(transformation.zlibRuntimeVersion, 64),
      inputChunkBytes: integer(transformation.inputChunkBytes, 1, 1_048_576), outputChunkBytes: integer(transformation.outputChunkBytes, 1, 1_048_576),
      maxInputBytes: integer(transformation.maxInputBytes, 1, 104_857_600), maxOutputBytes: integer(transformation.maxOutputBytes, 1, 268_435_456),
      plannedTimeoutMs: integer(transformation.plannedTimeoutMs, 1, 30_000) },
    sdk: parseSdkIdentity(input.sdk), runnerFiles, runnerDigest,
    choice: { modelId: exact(choice.modelId, 'grok-4.3'), reasoning: exact(choice.reasoning, 'low') },
    credential: { kind: exact(credential.kind, 'dotenv'), path: absolute(credential.path), key: exact(credential.key, 'XAI_API_KEY'), sourceId: textValue(credential.sourceId, 200) },
  };
}

export function parseGrokSelection(value: unknown): GrokConfigurationSelection {
  const input = record(value, ['modelId', 'reasoning', 'initial', 'afterModel', 'afterReasoning', 'model', 'reasoningSelection']);
  const initial = parseAgentConfigurationCatalog(input.initial);
  const afterModel = parseAgentConfigurationCatalog(input.afterModel);
  const afterReasoning = parseAgentConfigurationCatalog(input.afterReasoning);
  const selection = { modelId: textValue(input.modelId, 200), reasoning: exact(input.reasoning, 'low'), initial, afterModel, afterReasoning,
    model: parseAgentConfigurationSelectionFor(initial, input.model), reasoningSelection: parseAgentConfigurationSelectionFor(afterModel, input.reasoningSelection) };
  if (semanticDigest(value) !== semanticDigest(selection)) throw new NativeInputError('configuration_fields_invalid');
  validateGrokSelection(selection);
  return selection;
}

export function parseNativeSelection(value: unknown): NativeSelection {
  const input = record(value, ['schemaVersion', 'candidateDigest', 'discoveryDigest', 'nativeSha256', 'sdkDigest', 'configuration', 'mapping', 'mappingProof'], ['parentPermissionProof']);
  const mapping = record(input.mapping, ['mappingId', 'mappingRevision', 'modelId', 'reasoning', 'executionMode', 'proofDigest']);
  const proofDigest = digest(mapping.proofDigest);
  if (semanticDigest(input.mappingProof) !== proofDigest) throw new NativeInputError('mapping_proof_digest_invalid');
  return { schemaVersion: exact(input.schemaVersion, 1), candidateDigest: digest(input.candidateDigest), discoveryDigest: digest(input.discoveryDigest),
    nativeSha256: hash(input.nativeSha256), sdkDigest: digest(input.sdkDigest), configuration: parseGrokSelection(input.configuration),
    mapping: { mappingId: textValue(mapping.mappingId, 200), mappingRevision: integer(mapping.mappingRevision, 1, Number.MAX_SAFE_INTEGER),
      modelId: exact(mapping.modelId, 'grok-4.3'), reasoning: exact(mapping.reasoning, 'low'), executionMode: exact(mapping.executionMode, 'standard'), proofDigest }, mappingProof: input.mappingProof,
    ...(input.parentPermissionProof === undefined ? {} : { parentPermissionProof: parseNativeParentPermissionProof(input.parentPermissionProof) }) };
}
