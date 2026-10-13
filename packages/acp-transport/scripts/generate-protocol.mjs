// ------------------------------------------------------------------------------------------------
//                generate-protocol.mjs - Deterministic pinned ACP v1 profile derivation
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------------------------------------
//                Immutable Inputs
// ------------------------------------------------------------------------------------------------

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = resolve(packageRoot, 'schema/v0.11.4');
const generatedPath = resolve(packageRoot, 'src/generated/protocolMetadata.ts');
const generatedJsonPath = resolve(schemaRoot, 'protocol.generated.json');
const v1_23_0SchemaRoot = resolve(packageRoot, 'schema/schema-v1.23.0');
const v1_23_0GeneratedPath = resolve(packageRoot, 'src/generated/schemaV1_23_0Metadata.ts');

const EXPECTED_FILES = Object.freeze({
  'LICENSE': 'f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221',
  'meta.json': '71036d4c70f1e964c445569c1878a513e2fadfc797161d7582224b4647669330',
  'meta.unstable.json': 'a040127bddad5cfa9b713c4553a11c78bcdca6f386868e2a3b12cc8f583bd98b',
  'provenance.json': '7f3999ee9661667535ce77390d19f2d1fd460ad9b2271ba167281c9d1d959820',
  'schema.json': '38751907a86016c73662ea2ad1ded2c8cbbdb99fe40b8368b6dd2794726be236',
  'schema.unstable.json': '5c2c4c090d4fc1ca988322f5bdcb719bab2b63c3a86447c3c2c139678ca414a2',
});

const V1_23_0_EXPECTED_FILES = Object.freeze({
  'LICENSE': 'f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221',
  'meta.json': '061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88',
  'schema.json': '3c17bd6385d90cf672d8a661fddc359d73422cf8b8ce6865213d25cfd4c0eca7',
  'provenance.json': 'f6b2efcf80c06a380bc8c50065e7b18fcbe5d7ab82e60ff7ff23fbca70c3e8e6',
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function loadPinnedFiles(root, expectedFiles) {
  const inputs = {};
  for (const [name, expected] of Object.entries(expectedFiles)) {
    const content = await readFile(resolve(root, name));
    const actual = sha256(content);
    if (actual !== expected) {
      throw new Error(`ACP input drifted: ${root}/${name} (${actual}).`);
    }
    inputs[name] = content;
  }
  return inputs;
}

// ------------------------------------------------------------------------------------------------
//                Mechanical Derivation
// ------------------------------------------------------------------------------------------------

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deriveDefinitions(schema) {
  const definitions = { agent: {}, client: {}, protocol: {} };
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
    const method = definition['x-method'];
    const side = definition['x-side'];
    if (
      typeof method !== 'string'
      || (side !== 'agent' && side !== 'client' && side !== 'protocol')
    ) continue;

    let kind;
    if (name.endsWith('Request')) kind = 'request';
    else if (name.endsWith('Response')) kind = 'response';
    else if (name.endsWith('Notification')) kind = 'notification';
    else continue;

    definitions[side][method] ??= {};
    if (definitions[side][method][kind]) {
      throw new Error(`Duplicate ACP ${side} ${method} ${kind} definition.`);
    }
    definitions[side][method][kind] = name;
  }

  for (const side of ['agent', 'client', 'protocol']) {
    definitions[side] = Object.fromEntries(
      Object.entries(definitions[side]).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return definitions;
}

function deriveProtocol(input) {
  const agentMethods = sortedUnique(Object.values(input.meta.agentMethods));
  const clientMethods = sortedUnique(Object.values(input.meta.clientMethods));
  const protocolMethods = sortedUnique(Object.values(input.meta.protocolMethods ?? {}));
  const definitions = deriveDefinitions(input.schema);

  for (const method of agentMethods) {
    if (!definitions.agent[method]) throw new Error(`Missing agent definition for ${method}.`);
  }
  for (const method of clientMethods) {
    if (!definitions.client[method]) throw new Error(`Missing client definition for ${method}.`);
  }
  for (const method of protocolMethods) {
    if (!definitions.protocol[method]) throw new Error(`Missing protocol definition for ${method}.`);
  }

  return {
    protocolVersion: input.meta.version,
    agentMethods,
    clientMethods,
    protocolMethods,
    definitions,
  };
}

function asTypeScriptLiteral(value) {
  return JSON.stringify(value, null, 2)
    .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, '$1:')
    .replace(/^/gm, '');
}

function renderPrelude(filename, sourceDescription) {
  return `// ------------------------------------------------------------------------------------------------\n`
    + `//                ${filename} - GENERATED from ${sourceDescription}\n`
    + `// ------------------------------------------------------------------------------------------------\n`
    + `// Do not edit. Run \`pnpm --filter @agen-ai/acp-transport generate\`.\n\n`
    + `function deepFreeze<T>(value: T): T {\n`
    + `  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {\n`
    + `    for (const nested of Object.values(value)) deepFreeze(nested);\n`
    + `    Object.freeze(value);\n`
    + `  }\n`
    + `  return value;\n`
    + `}\n\n`;
}

function renderTypeScript(protocol) {
  return renderPrelude(
    'protocolMetadata.ts',
    'official ACP v0.11.4 inputs',
  )
    + `export const ACP_SCHEMA_RELEASE = 'v0.11.4' as const;\n`
    + `export const ACP_PROTOCOL_VERSION = 1 as const;\n`
    + `export const ACP_SCHEMA_INPUT_SHA256 = deepFreeze(${asTypeScriptLiteral(EXPECTED_FILES)} as const);\n\n`
    + `export const ACP_STABLE_PROTOCOL = deepFreeze(${asTypeScriptLiteral(protocol.stable)} as const);\n\n`
    + `export const ACP_UNSTABLE_PROTOCOL = deepFreeze(${asTypeScriptLiteral(protocol.unstable)} as const);\n\n`
    + `export type AcpStableAgentMethod = typeof ACP_STABLE_PROTOCOL.agentMethods[number];\n`
    + `export type AcpStableClientMethod = typeof ACP_STABLE_PROTOCOL.clientMethods[number];\n`
    + `export type AcpUnstableAgentMethod = typeof ACP_UNSTABLE_PROTOCOL.agentMethods[number];\n`
    + `export type AcpUnstableClientMethod = typeof ACP_UNSTABLE_PROTOCOL.clientMethods[number];\n`
    + `export type AcpUnstableProtocolMethod = typeof ACP_UNSTABLE_PROTOCOL.protocolMethods[number];\n`;
}

function renderV1_23_0TypeScript(protocol) {
  return renderPrelude(
    'schemaV1_23_0Metadata.ts',
    'official ACP schema-v1.23.0 stable inputs',
  )
    + `export const ACP_V1_23_0_SCHEMA_RELEASE = 'schema-v1.23.0' as const;\n`
    + `export const ACP_V1_23_0_PROTOCOL_VERSION = 1 as const;\n`
    + `export const ACP_V1_23_0_SCHEMA_INPUT_SHA256 = deepFreeze(${asTypeScriptLiteral(V1_23_0_EXPECTED_FILES)} as const);\n\n`
    + `export const ACP_V1_23_0_STABLE_PROTOCOL = deepFreeze(${asTypeScriptLiteral(protocol.stable)} as const);\n\n`
    + `export type AcpV1_23_0StableAgentMethod = typeof ACP_V1_23_0_STABLE_PROTOCOL.agentMethods[number];\n`
    + `export type AcpV1_23_0StableClientMethod = typeof ACP_V1_23_0_STABLE_PROTOCOL.clientMethods[number];\n`
    + `export type AcpV1_23_0StableProtocolMethod = typeof ACP_V1_23_0_STABLE_PROTOCOL.protocolMethods[number];\n`;
}

// ------------------------------------------------------------------------------------------------
//                Drift-safe Output
// ------------------------------------------------------------------------------------------------

async function assertOrWrite(path, content, check) {
  if (!check) {
    await writeFile(path, content);
    return;
  }
  let current;
  try {
    current = await readFile(path);
  } catch {
    throw new Error(`Generated ACP output is missing: ${path}.`);
  }
  if (!current.equals(content)) {
    throw new Error(`Generated ACP output drifted: ${path}.`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const inputs = await loadPinnedFiles(schemaRoot, EXPECTED_FILES);

  const stable = deriveProtocol({
    meta: JSON.parse(inputs['meta.json'].toString('utf8')),
    schema: JSON.parse(inputs['schema.json'].toString('utf8')),
  });
  const unstable = deriveProtocol({
    meta: JSON.parse(inputs['meta.unstable.json'].toString('utf8')),
    schema: JSON.parse(inputs['schema.unstable.json'].toString('utf8')),
  });
  const protocol = {
    schemaRelease: 'v0.11.4',
    sourceTagCommit: 'e931357254ff44573294d5cee214a269e0cd6c54',
    inputs: EXPECTED_FILES,
    stable,
    unstable,
  };

  await assertOrWrite(
    generatedJsonPath,
    Buffer.from(`${JSON.stringify(protocol, null, 2)}\n`),
    check,
  );
  await assertOrWrite(generatedPath, Buffer.from(renderTypeScript(protocol)), check);

  const v1_23_0Inputs = await loadPinnedFiles(v1_23_0SchemaRoot, V1_23_0_EXPECTED_FILES);
  const v1_23_0Protocol = {
    schemaRelease: 'schema-v1.23.0',
    sourceTagCommit: '6d08f412a7a1370d3cc9a124e3be3d6acf92641e',
    inputs: V1_23_0_EXPECTED_FILES,
    stable: deriveProtocol({
      meta: JSON.parse(v1_23_0Inputs['meta.json'].toString('utf8')),
      schema: JSON.parse(v1_23_0Inputs['schema.json'].toString('utf8')),
    }),
  };
  await assertOrWrite(
    resolve(v1_23_0SchemaRoot, 'protocol.generated.json'),
    Buffer.from(`${JSON.stringify(v1_23_0Protocol, null, 2)}\n`),
    check,
  );
  await assertOrWrite(v1_23_0GeneratedPath, Buffer.from(renderV1_23_0TypeScript(v1_23_0Protocol)), check);
}

await main();
