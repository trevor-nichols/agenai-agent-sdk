import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { within } from '../../native/configuration.mjs';
import { routeAuthority } from './authority.mjs';
import { captureData, physicalPath } from './input.mjs';
import { boundedText, control, endpoint, imageDigest, integer, keys, resources, sha256, temporaryBytes, user } from './validation.mjs';

export const advancedRows = Object.freeze(['live-files', 'preserve-internal', 'restricted-https', 'combined']);

// Admission reserves the independent diagnostic and both simultaneous marker fixtures.
const diagnosticBudget = Object.freeze({ nanoCpus: 1_000_000_000, memoryBytes: 256 * 1024 ** 2 });
const markerBudget = Object.freeze({ nanoCpus: 250_000_000, memoryBytes: 64 * 1024 ** 2 });
const specialIpv4 = Object.freeze(['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']);

function helperBudget(value) {
  keys(value, ['resources', 'temporaryBytes']); resources(value.resources); temporaryBytes(value.temporaryBytes);
}

function filesystem(value, limits) {
  keys(value, ['sourceDigest', 'configuration']); imageDigest(value.sourceDigest);
  const config = value.configuration;
  keys(config, ['imageDigest', 'protocol', 'executable', 'layout', 'user', 'resources', 'temporaryBytes', 'control']);
  imageDigest(config.imageDigest); assert.equal(config.protocol, 'agenai.sandbox.filesystem.v1');
  assert.equal(config.executable, '/usr/local/bin/agenai-sandbox-files');
  assert.equal(config.layout, 'agenai.sandbox.workspace.v1'); user(config.user); resources(config.resources);
  temporaryBytes(config.temporaryBytes); control(config.control, limits.requestMs);
}

function transfers(value, profile, options) {
  keys(value, ['hostRoots']);
  const roles = profile === 'linux-x64' ? ['controller'] : ['controller_internal', 'controller_external'];
  assert(Array.isArray(value.hostRoots) && value.hostRoots.length === roles.length, 'Profile requires exact transfer-root roles.');
  value.hostRoots.forEach((entry, index) => {
    keys(entry, ['role', 'parent']); assert.equal(entry.role, roles[index], 'Transfer-root role order differs from profile.');
    physicalPath(entry.parent);
    for (const root of [options.consumer, options.output]) assert(!within(entry.parent, root) && !within(root, entry.parent),
      'Transfer parents must be outside consumer and output roots.');
    for (const prior of value.hostRoots.slice(0, index)) assert(!within(prior.parent, entry.parent) && !within(entry.parent, prior.parent),
      'Transfer parents must be outside each other.');
  });
}

function ipv4Number(address) {
  assert.equal(isIP(address), 4, 'Numeric canonical IPv4 required.');
  return address.split('.').reduce((result, part) => result * 256 + Number(part), 0);
}
function hostname(value, label) {
  boundedText(value, 3, 253, label); const labels = value.split('.');
  assert(isIP(value) === 0 && labels.length >= 2
    && labels.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part) && !part.startsWith('xn--')),
  `${label} requires lowercase ASCII DNS labels without IDNA.`);
}

function fixtureNetwork(value) {
  keys(value, ['imageDigest', 'publicSubnet', 'publicGateway', 'hostAddress', 'publicHostname', 'publicAddress']); imageDigest(value.imageDigest);
  assert(typeof value.publicSubnet === 'string' && value.publicSubnet.endsWith('/24'), 'Canonical public IPv4 /24 required.');
  const address = value.publicSubnet.slice(0, -3), numeric = ipv4Number(address);
  assert.equal(numeric % 256, 0, 'Fixture subnet must name its /24 network address.');
  for (const cidr of specialIpv4) {
    const [excluded, prefix] = cidr.split('/'), size = 2 ** (32 - Number(prefix));
    assert(Math.floor(numeric / size) !== Math.floor(ipv4Number(excluded) / size), 'Fixture subnet overlaps static non-public coverage.');
  }
  assert.equal(value.publicGateway, `${address.split('.').slice(0, 3).join('.')}.1`, 'Fixture gateway must be subnet .1.');
  hostname(value.publicHostname, 'Fixture hostname');
  const member = ipv4Number(value.publicAddress);
  assert(member > numeric + 1 && member < numeric + 255, 'Fixture address must be a usable member of publicSubnet.');
  const host = ipv4Number(value.hostAddress);
  assert(host !== 0 && !value.hostAddress.startsWith('127.'), 'Host marker requires a non-loopback, non-unspecified IPv4 address.');
}

function network(value, platform, limits) {
  keys(value, ['egress', 'routeAuthority', 'positive', 'fixtures']);
  keys(value.egress, ['sourceDigest', 'configuration']); imageDigest(value.egress.sourceDigest);
  const config = value.egress.configuration;
  keys(config, ['imageDigest', 'protocol', 'user', 'broker', 'relay', 'control']);
  imageDigest(config.imageDigest); assert.equal(config.protocol, 'agenai.sandbox.egress-connect.v1'); user(config.user);
  helperBudget(config.broker); helperBudget(config.relay); routeAuthority(value.routeAuthority, platform);
  control(config.control, Math.max(limits.requestMs, value.routeAuthority.commandTimeoutMs));
  const positive = value.positive;
  keys(positive, ['hostname', 'port', 'path', 'status', 'bodyBytes', 'bodySha256']);
  hostname(positive.hostname, 'Positive hostname');
  assert.equal(positive.port, 443); assert.equal(positive.status, 200);
  boundedText(positive.path, 1, 2048, 'Positive path');
  assert(positive.path.startsWith('/') && !positive.path.includes('#'), 'Positive path must start / and omit fragments.');
  integer(positive.bodyBytes, 1, 262_144, 'bodyBytes'); sha256(positive.bodySha256); fixtureNetwork(value.fixtures);
  assert.notEqual(value.fixtures.publicHostname, positive.hostname, 'Fixture DNS hostname must differ from the positive TLS hostname.');
}

function aggregateBudget(value) {
  const roles = [value.workload.resources];
  if (value.filesystem) roles.push(value.filesystem.configuration.resources);
  if (value.network) {
    roles.push(value.network.egress.configuration.broker.resources, value.network.egress.configuration.relay.resources);
    if (value.profile !== 'linux-x64') roles.push(value.network.routeAuthority.vmObserver.resources);
  }
  const fixed = value.network ? { nanoCpus: diagnosticBudget.nanoCpus + 2 * markerBudget.nanoCpus,
    memoryBytes: diagnosticBudget.memoryBytes + 2 * markerBudget.memoryBytes } : diagnosticBudget;
  const nanoCpus = roles.reduce((total, role) => total + role.cpus * 1_000_000_000, fixed.nanoCpus);
  const memoryBytes = roles.reduce((total, role) => total + role.memoryBytes, fixed.memoryBytes);
  assert(nanoCpus <= 4_000_000_000 && memoryBytes <= 4 * 1024 ** 3,
    'Simultaneous qualification roles exceed four CPUs or four GiB.');
}

export function parseCapabilityManifest(input, { row, platform, platformInput, consumer, output }) {
  const value = captureData(input);
  const sections = row === 'combined' ? ['filesystem', 'transfers', 'network']
    : row === 'live-files' ? ['filesystem'] : row === 'preserve-internal' ? ['filesystem', 'transfers'] : ['network'];
  assert(advancedRows.includes(row), 'Unknown advanced qualification row.');
  keys(value, ['format', 'platformManifestSha256', 'profile', 'workload', 'limits', 'row', ...sections]);
  assert.equal(value.format, 'agenai.sandbox-platform-capabilities.v1');
  sha256(value.platformManifestSha256);
  assert.equal(value.platformManifestSha256, platformInput.sha256, 'Capability manifest baseline SHA differs from captured platform bytes.');
  assert.equal(value.profile, platform.profile, 'Capability profile differs from the baseline manifest.');
  assert.equal(value.row, row, 'Capability row differs from the selected CLI row.');
  endpoint(platform.engine);
  if (platform.desktop !== null) assert.equal(platform.desktop.rosetta, true, 'Advanced Desktop qualification requires explicit Rosetta enablement.');
  keys(value.workload, ['user', 'resources', 'temporaryBytes']); user(value.workload.user);
  resources(value.workload.resources); temporaryBytes(value.workload.temporaryBytes);
  keys(value.limits, ['startupMs', 'requestMs', 'cleanupMs', 'scenarioMs', 'maxOutputBytes']);
  for (const [field, minimum, maximum] of [['startupMs', 1000, 60_000], ['requestMs', 1000, 30_000],
    ['cleanupMs', 1000, 30_000], ['scenarioMs', 30_000, 900_000], ['maxOutputBytes', 65_536, 4_194_304]]) {
    integer(value.limits[field], minimum, maximum, field);
  }
  assert(value.limits.scenarioMs > value.limits.startupMs + value.limits.requestMs + value.limits.cleanupMs,
    'Scenario budget must exceed startup plus request plus cleanup.');
  if (sections.includes('filesystem')) filesystem(value.filesystem, value.limits);
  if (sections.includes('transfers')) transfers(value.transfers, value.profile, { consumer, output });
  if (sections.includes('network')) network(value.network, platform, value.limits);
  aggregateBudget(value);
  return value;
}
