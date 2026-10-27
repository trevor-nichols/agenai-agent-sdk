import assert from 'node:assert/strict';
import { until } from '../../../engine.mjs';
import { header, positive, ready } from './installed.mjs';
import { identified } from './resources.mjs';

export function destinations(context) {
  const targets = context.fixtures.targets();
  return [{ hostname: context.config.capabilities.network.positive.hostname, port: 443 },
    { hostname: context.config.capabilities.network.fixtures.publicHostname, port: 443 },
    { hostname: 'host.docker.internal', port: targets.specialHost.port }];
}
export async function restricted(run, context, options = {}) {
  return ready(run, context, { destinations: destinations(context), ...options });
}
async function settledCounters(context) {
  return until(async () => { const counts = await context.fixtures.census();
    return Object.values(counts).every((entry) => entry.active === 0) ? counts : false;
  }, context.config.capabilities.limits.requestMs, 'Independent marker controls remain entered.');
}
export async function prove(run, context, opened, target, kind = 'tcp') {
  const result = await context.fixtures.probeBroker(run, opened.entry, { kind, ...target, reply: true });
  assert.equal(result.bytes, target.marker, 'Independent control did not retrieve the exact forbidden marker.');
  await run.observe({ kind: 'independent-broker-namespace-marker-control', transport: kind, target, result });
  await settledCounters(context); return result;
}
export async function denied(run, context, opened, target, command, status) {
  const before = await settledCounters(context);
  const result = await opened.session.request(command);
  const after = await settledCounters(context);
  await run.observe({ kind: 'native-forbidden-attempt', target, command, result, countersBefore: before, countersAfter: after });
  if (status === undefined) assert.equal(result.ok, false, JSON.stringify(result));
  else { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.status, status); }
  assert.deepEqual(after, before, 'A forbidden listener observed a new connection, request or datagram.');
  return result;
}
async function targetDenials(run, context, names) {
  const opened = await restricted(run, context); const targets = context.fixtures.targets();
  for (const name of names) {
    const target = targets[name]; assert(target, `Missing exact marker target ${name}.`);
    await prove(run, context, opened, target);
    await denied(run, context, opened, target, { kind: 'tcp', ...target });
    const authority = `${target.host}:${target.port}`;
    await denied(run, context, opened, target, { kind: 'proxy', header: header(authority) }, 403);
  }
  return opened;
}
function noExternalIpv6Routes(facts) {
  assert.equal(typeof facts.ipv6Route, 'string'); assert(Buffer.byteLength(facts.ipv6Route) <= 16 * 1024);
  const lines = facts.ipv6Route.trim().split('\n').filter(Boolean); assert(lines.length <= 256);
  const routes = lines.map((line) => {
    const row = /^([a-f0-9]{32}) ([a-f0-9]{2}) ([a-f0-9]{32}) ([a-f0-9]{2}) ([a-f0-9]{32}) ([a-f0-9]{8}) ([a-f0-9]{8}) ([a-f0-9]{8}) ([a-f0-9]{8})\s+(\S{1,15})$/u.exec(line);
    assert(row, 'Malformed bounded guest IPv6 route observation.');
    const route = { destination: row[1], prefix: Number.parseInt(row[2], 16), source: row[3], sourcePrefix: Number.parseInt(row[4], 16),
      nextHop: row[5], metric: Number.parseInt(row[6], 16), flags: Number.parseInt(row[9], 16), interface: row[10] };
    assert(route.prefix <= 128 && route.sourcePrefix <= 128);
    if (route.flags & 1) assert(route.interface === 'lo' && route.destination === '00000000000000000000000000000001'
      && route.prefix === 128 && route.source === '00000000000000000000000000000000' && route.sourcePrefix === 0
      && route.nextHop === '00000000000000000000000000000000', 'Guest acquired an UP IPv6 route outside its namespace-local loopback.');
    return route;
  });
  return routes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function connectivityCases(context) {
  return [
    ['baseline-isolated-no-helper', async (run) => {
      const opened = await ready(run, context, { kind: 'isolated', egress: false });
      assert.deepEqual(opened.owner.recoveryRecord.resources.map(({ role }) => role), ['compute', 'storage', 'export']);
      const response = await opened.session.request({ kind: 'tcp', ...context.fixtures.targets().host });
      await run.observe({ kind: 'isolated-without-prepared-egress-roles', response }); assert.equal(response.ok, false);
    }],
    ['baseline-outbound-marker-controls', async (run) => {
      const opened = await ready(run, context, { kind: 'outbound', egress: false });
      assert(!opened.owner.recoveryRecord.resources.some(({ role }) => role.startsWith('egress_') || role === 'route_observer'));
      const tls = await opened.session.request({ kind: 'tls', ...context.config.capabilities.network.positive, direct: true });
      await run.observe({ kind: 'outbound-positive-tls-control', tls }); assert.equal(tls.ok, true);
      assert.equal(tls.result.authorized, true); assert.equal(tls.result.bodySha256, context.config.capabilities.network.positive.bodySha256);
      for (const target of [context.fixtures.targets().host, context.fixtures.targets().specialHost, context.fixtures.targets().vmHost]) {
        const answer = await opened.session.request({ kind: 'tcp', ...target });
        await run.observe({ kind: 'outbound-positive-marker-control', target, answer });
        assert.equal(answer.ok, true, JSON.stringify(answer)); assert.equal(answer.result.bytes, target.marker);
      }
    }],
    ['verified-tls-exact-body', async (run) => {
      const opened = await restricted(run, context);
      await run.observe({ kind: 'verified-connect-tls-exact-body', result: await positive(opened, context) });
      await context.fixtures.captureBootstrap(run, opened);
    }],
    ['restricted-process-isolation', async (run) => {
      const opened = await restricted(run, context); const facts = opened.facts;
      assert.equal(facts.route.trim().split('\n').length, 1); assert.equal(facts.socketVisible, 'ENOENT');
      assert.deepEqual(facts.proxyEnvironment, []);
      const records = opened.owner.recoveryRecord.resources;
      assert.equal(opened.owner.recoveryRecord.backendRevision, `engine-1.52-v6-${context.config.profile}`);
      for (const role of ['egress_broker', 'egress_relay', 'route_observer']) {
        const resource = identified(opened.owner.recoveryRecord, role);
        const actual = (await context.engine.request('GET', `/containers/${resource.identity.id}/json`)).data;
        assert.equal(actual.Config.User, '1000:1000'); assert.equal(actual.HostConfig.Privileged, false);
        assert.deepEqual(actual.HostConfig.CapDrop, ['ALL']); assert.equal(actual.HostConfig.PidMode, '');
        if (role === 'route_observer') { assert.equal(actual.HostConfig.NetworkMode, 'host'); assert.equal(actual.Mounts.length, 0); }
        else assert.equal(actual.Mounts.length, 1);
        await run.observe({ kind: 'installed-helper-role-readback', role, actual });
      }
      assert(records.some(({ role }) => role === 'egress_socket'));
      assert(!records.some(({ role }) => role === 'filesystem'));
    }],
    ['connect-unlisted-and-canonical-forms', async (run) => {
      const hostname = context.config.capabilities.network.positive.hostname;
      const alias = context.config.capabilities.network.fixtures.publicHostname;
      const opened = await restricted(run, context, { destinations: destinations(context).filter((entry) => entry.hostname !== alias) });
      const target = context.fixtures.targets().sibling; await prove(run, context, opened, target);
      const actualDns = await context.fixtures.probeBroker(run, opened.entry, { kind: 'lookup', hostname: alias });
      assert.deepEqual({ ipv4: [...actualDns.ipv4].sort(), ipv6: actualDns.ipv6 }, { ipv4: [target.host], ipv6: [] });
      const policy = await context.fixtures.brokerPolicy(opened.entry); assert(!policy.configuration.destinations.some(({ hostname: name }) => name === alias));
      await denied(run, context, opened, { ...target, scope: 'Reachable same DNS name omitted from this owner policy' },
        { kind: 'proxy', header: header(`${alias}:443`) }, 403);
      assert.equal(opened.owner.state.kind, 'ready');
      await run.observe({ kind: 'reachable-fixture-name-omitted-from-actual-policy', hostname: alias, actualDns, policy });
      const authorities = ['unlisted.invalid:443', '2130706433:443', '127.1:443', '0177.0.0.1:443', '0x7f000001:443',
        '[::1]:443', '[::ffff:127.0.0.1]:443', `${hostname}:0443`, `${hostname}.:443`, `${hostname.toUpperCase()}:443`,
        `user@${hostname}:443`, `${hostname}:443/path`, 'xn--example.test:443'];
      const wires = [...authorities.map(header),
        `GET https://${hostname}/ HTTP/1.1\r\nHost: ${hostname}\r\n\r\n`,
        `CONNECT ${hostname}:443 HTTP/2.0\r\nHost: ${hostname}:443\r\n\r\n`,
        `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: unlisted.invalid:443\r\n\r\n`,
        `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nContent-Length: 1\r\n\r\n`,
        `CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nHost: ${hostname}:443\r\n\r\n`];
      for (const wire of wires) await denied(run, context, opened, { scope: 'CONNECT syntax or undeclared destination' }, { kind: 'proxy', header: wire }, 403);
      await run.observe({ kind: 'redirect-scope', nativeHttp302: false,
        primaryProof: 'Deterministic broker wire cases require separate admission of the redirected CONNECT destination.' });
    }],
    ['host-and-special-host-reachable-denials', (run) => targetDenials(run, context, ['host', 'specialHost'])],
    ['vm-gateway-reachable-denials', async (run) => {
      const opened = await targetDenials(run, context, ['vmHost', 'gateway']);
      const hostname = 'gateway.docker.internal';
      const resolution = await context.fixtures.probeBroker(run, opened.entry, { kind: 'lookup', hostname });
      const policy = await context.fixtures.brokerPolicy(opened.entry);
      assert(!policy.configuration.destinations.some((entry) => entry.hostname === hostname));
      const target = { host: hostname, port: context.fixtures.targets().vmHost.port,
        scope: 'DNS and unlisted CONNECT only; reachable-service isolation and direct transport unexercised.' };
      const response = await denied(run, context, opened, target, { kind: 'proxy', header: header(`${hostname}:${target.port}`) }, 403);
      await run.observe({ kind: 'special-gateway-dns-and-unlisted-connect-only', hostname, resolution, response,
        excludedCidrs: policy.configuration.excludedCidrs, ownerState: opened.owner.state,
        directTransport: 'unexercised', reachableServiceIsolation: 'unexercised', brokerDialPermitted: false });
      assert.equal(opened.owner.state.kind, 'ready');
    }],
    ['public-numbered-sibling-reachable-denials', (run) => targetDenials(run, context, ['sibling', 'siblingMarker'])],
    ['allowed-dns-public-local-denied', async (run) => {
      const opened = await restricted(run, context); const target = context.fixtures.targets().sibling;
      await prove(run, context, opened, target);
      const hostname = context.config.capabilities.network.fixtures.publicHostname;
      const actual = await context.fixtures.probeBroker(run, opened.entry, { kind: 'lookup', hostname });
      assert.deepEqual({ ipv4: [...actual.ipv4].sort(), ipv6: actual.ipv6 }, { ipv4: [target.host], ipv6: [] });
      const policy = await context.fixtures.brokerPolicy(opened.entry);
      assert(policy.configuration.destinations.some((entry) => entry.hostname === hostname && entry.port === 443));
      assert(policy.configuration.excludedCidrs.includes(context.config.capabilities.network.fixtures.publicSubnet));
      const result = await denied(run, context, opened, target,
        { kind: 'proxy', header: header(`${hostname}:443`) }, 403);
      const afterDns = await context.fixtures.probeBroker(run, opened.entry, { kind: 'lookup', hostname });
      assert.deepEqual({ ipv4: [...afterDns.ipv4].sort(), ipv6: afterDns.ipv6 }, { ipv4: [target.host], ipv6: [] });
      assert.equal(opened.owner.state.kind, 'ready', 'An authority fence cannot substitute for broker address-admission denial.');
      await run.observe({ kind: 'allowlisted-name-resolved-to-observed-public-local-marker', hostname, actual, afterDns, policy, result, ownerState: opened.owner.state,
        scope: 'Independent native namespace DNS observations, configured public-local exclusion and refusal; no correlated internal broker DNS-reason receipt.' });
    }],
    ['direct-no-proxy-tcp-udp', async (run) => {
      const opened = await restricted(run, context);
      for (const target of Object.values(context.fixtures.targets())) {
        await prove(run, context, opened, target);
        await denied(run, context, opened, target, { kind: 'tcp', ...target });
      }
      const target = { ...context.fixtures.targets().siblingMarker, port: 8080 };
      await prove(run, context, opened, target, 'udp');
      await denied(run, context, opened, target, { kind: 'udp', ...target });
    }],
    ['ipv6-unsupported-no-bypass', async (run) => {
      const opened = await restricted(run, context);
      const before = noExternalIpv6Routes(opened.facts);
      await run.observe({ kind: 'guest-ipv6-no-external-route-before', facts: opened.facts, routes: before,
        scope: 'Observed network-none guest routes; no reachable IPv6 listener or service-isolation claim.',
        directFormsUnexercised: ['::1', '::ffff:127.0.0.1', 'fe80::1'] });
      for (const address of ['::1', '::ffff:127.0.0.1', 'fe80::1', '2001:db8::1', '2606:4700::1111']) {
        const target = { host: address, port: 443, scope: 'Proxy IPv6 address-form refusal; direct transport unexercised for local/mapped/unscoped forms.' };
        await denied(run, context, opened, target, { kind: 'proxy', header: header(`[${address}]:443`) }, 403);
      }
      for (const host of ['2001:db8::1', '2606:4700::1111']) for (const kind of ['tcp-connect', 'udp-send']) {
        const command = { kind, host, port: 443, ...(kind === 'udp-send' ? { probe: 'owned-ipv6-no-route-control' } : {}) };
        const result = await opened.session.request(command);
        await run.observe({ kind: 'native-ipv6-no-route-attempt', command, result,
          scope: 'Native transport reports no route to an external IPv6 form; no application-response timeout inference.' });
        assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, 'ENETUNREACH', JSON.stringify(result));
      }
      const afterFacts = await opened.session.request({ kind: 'facts' }); assert.equal(afterFacts.ok, true, JSON.stringify(afterFacts));
      const after = noExternalIpv6Routes(afterFacts.result);
      await run.observe({ kind: 'guest-ipv6-no-external-route-after', facts: afterFacts.result, routes: after });
      assert.deepEqual(after, before); assert.equal(opened.owner.state.kind, 'ready');
    }],
  ];
}
