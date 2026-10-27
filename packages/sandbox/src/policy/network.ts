// ------------------------------------------------------------------------------------------------
//                network.ts - Canonical exact HTTPS destinations and bounded policy schema
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { SANDBOX_LIMITS } from './limits.js';

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const numericAddressLabel = /^(?:[0-9]+|0x[0-9a-f]+)$/u;

function canonicalHostname(value: string): boolean {
  const labels = value.split('.');
  return value.length <= 253 && labels.length >= 2
    && labels.every((label) => dnsLabel.test(label) && !label.startsWith('xn--'))
    && !numericAddressLabel.test(labels.at(-1) ?? '');
}

const destinationSchema = z.strictObject({
  hostname: z.string().refine(canonicalHostname, 'Expected a canonical lowercase ASCII DNS name without IP, IDN or search-name ambiguity'),
  port: z.number().int().min(1).max(65535),
});

const destinationsSchema = z.array(destinationSchema).min(1).max(SANDBOX_LIMITS.maxNetworkDestinations)
  .superRefine((destinations, context) => {
    const seen = new Set<string>();
    destinations.forEach((destination, index) => {
      const identity = `${destination.hostname}:${destination.port}`;
      if (seen.has(identity)) context.addIssue({ code: 'custom', path: [index], message: 'HTTPS destinations must be unique' });
      seen.add(identity);
    });
  }).transform((destinations) => destinations.toSorted((left, right) => left.hostname === right.hostname
    ? left.port - right.port : left.hostname < right.hostname ? -1 : 1));

export const networkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('isolated') }),
  z.strictObject({ kind: z.literal('outbound') }),
  z.strictObject({ kind: z.literal('restricted_https'), destinations: destinationsSchema }),
]);

export const networkAllowlistSupportSchema = z.union([
  z.literal(false),
  z.strictObject({ kind: z.literal('https_connect'), maxDestinations: z.literal(SANDBOX_LIMITS.maxNetworkDestinations) }),
]);
