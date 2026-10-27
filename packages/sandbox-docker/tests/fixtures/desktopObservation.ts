// ------------------------------------------------------------------------------------------------
//                desktopObservation.ts - Independent native-wire records for Desktop owner tests
// ------------------------------------------------------------------------------------------------

const align = (value: number) => (value + 3) & ~3;
export function netlinkAttribute(type: number, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(align(payload.length + 4));
  bytes.writeUInt16LE(payload.length + 4); bytes.writeUInt16LE(type, 2); payload.copy(bytes, 4); return bytes;
}
export function netlinkRecord(type: number, header: Buffer, attributes: readonly Buffer[]): Buffer {
  const body = Buffer.concat([header, ...attributes]); const bytes = Buffer.alloc(align(body.length + 16));
  bytes.writeUInt32LE(body.length + 16); bytes.writeUInt16LE(type, 4); bytes.writeUInt16LE(2, 6); body.copy(bytes, 16); return bytes;
}
export function netlinkInteger(value: number): Buffer { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
export function desktopHostDocument() {
  return { format: 'agenai.desktop-host-network.v1', complete: true,
    host: { kernel: '25.5.0', architecture: 'arm64', osBuild: '25F80', boot: { seconds: 1793000000, microseconds: 123456 } },
    interfaces: [{ index: 7, name: 'en0', flags: 0x8863, addresses: [
      { family: 4, address: '11.55.1.22', netmask: '255.255.255.0', scopeId: 0, flags: 0, peer: null,
        broadcast: { address: '11.55.1.255', scopeId: 0 } },
    ] }],
    routes: [{ family: 4, destination: '0.0.0.0', netmask: '0.0.0.0', scopeId: 0, interfaceIndex: 7, flags: 0x803, parentFlags: 0,
      gateway: { kind: 'ip', family: 4, address: '11.55.1.1', scopeId: 0 } }],
    proxy: { status: 'safe', reasonCodes: [], scopes: 1, entries: 1 } };
}
export const desktopBridgeFixture = Object.freeze({ index: 9, gateway: '172.30.42.1', subnet: '172.30.42.0/24', prefix: 24,
  macAddress: '02:42:ac:1e:2a:01', endpointMacAddress: '02:42:00:00:00:02',
  brokerAddress: '172.30.42.2', brokerMacAddress: '02:42:ac:1e:2a:02' });

function link(index: number, name: string, flags: number, extra: readonly Buffer[]) {
  const header = Buffer.alloc(16); header.writeInt32LE(index, 4); header.writeUInt32LE(flags, 8);
  return netlinkRecord(16, header, [netlinkAttribute(3, Buffer.from(`${name}\0`)), ...extra]);
}
function ipv4(value: string) { return Buffer.from(value.split('.').map(Number)); }
function route(destination: string, prefix: number, index: number, options: { table?: number; scope?: number; type?: number; flags?: number; gateway?: string; preferred?: string } = {}) {
  const header = Buffer.from([2, prefix, 0, 0, options.table ?? 254, 2, options.scope ?? 253, options.type ?? 1, 0, 0, 0, 0]);
  header.writeUInt32LE(options.flags ?? 0, 8);
  return netlinkRecord(24, header, [netlinkAttribute(1, ipv4(destination)), netlinkAttribute(4, netlinkInteger(index)),
    ...(options.gateway ? [netlinkAttribute(5, ipv4(options.gateway))] : []),
    ...(options.preferred ? [netlinkAttribute(7, ipv4(options.preferred))] : []),
    netlinkAttribute(15, netlinkInteger(options.table ?? 254))]);
}
function linkLocalAddress(macAddress: string): Buffer {
  const mac = Buffer.from(macAddress.replaceAll(':', ''), 'hex');
  return Buffer.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, mac[0] ^ 2, mac[1], mac[2], 0xff, 0xfe, mac[3], mac[4], mac[5]]);
}
export function ipv6Route(destination: Buffer, prefix: number, index: number,
  options: { type?: number; table?: number; priority?: number; gateway?: Buffer; extra?: readonly Buffer[] } = {}): Buffer {
  const header = Buffer.from([10, prefix, 0, 0, options.table ?? 255, 2, 0, options.type ?? 4, 0, 0, 0, 0]);
  return netlinkRecord(24, header, [netlinkAttribute(1, destination), netlinkAttribute(4, netlinkInteger(index)),
    netlinkAttribute(6, netlinkInteger(options.priority ?? 0)), netlinkAttribute(15, netlinkInteger(options.table ?? 255)),
    netlinkAttribute(20, Buffer.from([0])), ...(options.gateway ? [netlinkAttribute(5, options.gateway)] : []), ...(options.extra ?? [])]);
}
export function desktopVmDocument(options: { bridgeName?: string; broker?: boolean; kernel?: string; namespace?: string;
  bridgeTsoMaxSize?: number; endpointTsoMaxSize?: number; externalTsoMaxSize?: number } = {}) {
  const links = [link(7, 'eth0', 0x11043, [netlinkAttribute(59, netlinkInteger(options.externalTsoMaxSize ?? 65536))])];
  const addresses: Buffer[] = [];
  const routes = [route('0.0.0.0', 0, 7, { scope: 0, gateway: '192.168.65.1' })];
  if (options.bridgeName) {
    links.push(link(9, options.bridgeName, options.broker ? 0x11043 : 0x1003, [
      netlinkAttribute(1, Buffer.from(desktopBridgeFixture.macAddress.replaceAll(':', ''), 'hex')),
      // Native N3 captures: Linux derives bridge TSO_MAX_SIZE from its sole attached port.
      netlinkAttribute(59, netlinkInteger(options.bridgeTsoMaxSize ?? (options.broker ? 524280 : 65536))),
      netlinkAttribute(16, Buffer.from([options.broker ? 6 : 2])), netlinkAttribute(33, Buffer.from([options.broker ? 1 : 0])),
      netlinkAttribute(18, netlinkAttribute(1, Buffer.from('bridge\0'))),
    ]));
    const header = Buffer.from([2, 24, 0x80, 0, 9, 0, 0, 0]);
    addresses.push(netlinkRecord(20, header, [netlinkAttribute(1, ipv4('172.30.42.1')), netlinkAttribute(4, ipv4('172.30.42.255'))]));
    routes.push(route('172.30.42.0', 24, 9, { flags: options.broker ? 0 : 16, preferred: '172.30.42.1' }),
      route('172.30.42.1', 32, 9, { table: 255, scope: 254, type: 2, preferred: '172.30.42.1' }),
      route('172.30.42.255', 32, 9, { table: 255, type: 3, flags: options.broker ? 0 : 16, preferred: '172.30.42.1' }));
    if (options.broker) links.push(link(10, 'veth-owned', 0x11043, [
      netlinkAttribute(1, Buffer.from(desktopBridgeFixture.endpointMacAddress.replaceAll(':', ''), 'hex')),
      netlinkAttribute(59, netlinkInteger(options.endpointTsoMaxSize ?? 524280)),
      netlinkAttribute(10, netlinkInteger(9)), netlinkAttribute(5, netlinkInteger(11)), netlinkAttribute(37, netlinkInteger(0)),
      netlinkAttribute(16, Buffer.from([6])), netlinkAttribute(33, Buffer.from([1])), netlinkAttribute(18, netlinkAttribute(1, Buffer.from('veth\0')))]));
    if (options.broker) {
      // Native N6 settled graph: four kernel IPv6 routes per owned device after DAD.
      for (const [index, mac] of [[desktopBridgeFixture.index, desktopBridgeFixture.macAddress],
        [10, desktopBridgeFixture.endpointMacAddress]] as const) {
        const address = linkLocalAddress(mac);
        addresses.push(netlinkRecord(20, Buffer.from([10, 64, 0x80, 253, index, 0, 0, 0]), [netlinkAttribute(1, address)]));
        const subnetRouter = Buffer.alloc(16); address.copy(subnetRouter, 0, 0, 8);
        const multicast = Buffer.alloc(16); multicast[0] = 0xff;
        routes.push(ipv6Route(subnetRouter, 64, index, { type: 1, table: 254, priority: 256 }),
          ipv6Route(address, 128, index, { type: 2 }), ipv6Route(subnetRouter, 128, index),
          ipv6Route(multicast, 8, index, { type: 5, priority: 256 }));
      }
    }
  }
  return { format: 'agenai.desktop-vm-network.v1', byteOrder: 'little', kernel: options.kernel ?? '6.12.54-linuxkit', architecture: 'aarch64',
    networkNamespace: options.namespace ?? 'net:[4026531992]', links: Buffer.concat(links).toString('hex'),
    addresses: Buffer.concat(addresses).toString('hex'), routes: Buffer.concat(routes).toString('hex'), complete: true };
}
