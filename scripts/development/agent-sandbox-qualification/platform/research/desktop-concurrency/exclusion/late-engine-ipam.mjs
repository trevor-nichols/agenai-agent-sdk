// Finite IPv4 selection for one unused, internal network. This does not qualify VM route authority.
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';

function range(cidr) {
  const [address, prefixText] = cidr.split('/');
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`invalid_ipv4_cidr:${cidr}`);
  const value = address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(value / size) * size;
  return { cidr, start, end: start + size - 1, prefix };
}

const overlaps = (left, right) => left.start <= right.end && right.start <= left.end;

export function selectSubnet(networks) {
  if (!Array.isArray(networks)) throw new Error('network_census_shape');
  const engineRanges = networks.flatMap((network) => (network.IPAM?.Config ?? []).flatMap((config) => {
    if (!config.Subnet) return [];
    const address = config.Subnet.split('/')[0];
    if (isIP(address) === 6) return [];
    return [{ networkId: network.Id, networkName: network.Name, ...range(config.Subnet) }];
  }));
  const command = spawnSync('/usr/sbin/netstat', ['-rn', '-f', 'inet'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (command.status !== 0) throw new Error(`host_route_census_failed:${command.stderr}`);
  const hostRanges = [];
  let inTable = false;
  for (const line of command.stdout.split('\n')) {
    const value = line.trim();
    if (value.startsWith('Destination')) { inTable = true; continue; }
    if (!inTable || !value || value === 'Internet:') continue;
    const [destination] = value.split(/\s+/u);
    if (destination === 'default') continue;
    const [address, prefix] = destination.split('/');
    const parts = address.split('.');
    if (parts.some((part) => !/^\d{1,3}$/u.test(part)) || parts.length > 4) throw new Error(`host_route_destination:${destination}`);
    const expanded = [...parts, ...Array(4 - parts.length).fill('0')].join('.');
    hostRanges.push(range(`${expanded}/${prefix ?? parts.length * 8}`));
  }
  if (!inTable) throw new Error('host_route_table_missing');
  const candidates = ['10.253.247.0/28', '10.253.247.16/28', '10.253.247.32/28', '10.253.247.48/28'];
  const observations = candidates.map((cidr) => {
    const candidate = range(cidr);
    return { ...candidate, conflicts: [...engineRanges, ...hostRanges].filter((known) => overlaps(candidate, known)) };
  });
  const selected = observations.find((candidate) => candidate.conflicts.length === 0);
  if (!selected) throw new Error('private_candidate_pool_conflicted');
  const gatewayAddress = selected.cidr.split('/')[0].split('.');
  gatewayAddress[3] = String(Number(gatewayAddress[3]) + 1);
  return { subnet: selected.cidr, gatewayAddress: gatewayAddress.join('.'), observations, engineRanges,
    hostRoutesRaw: command.stdout, defaultRoutesExcludedFromAddressOverlap: true,
    scope: 'all current Engine IPAM and Darwin IPv4 routes; no new VM observer or production network-authority claim' };
}
