import * as dns from 'dns';
import * as net from 'net';

/**
 * SSRF protection for `web_fetch` (F05).
 *
 * Rejects loopback, unspecified, RFC1918 private, link-local (including cloud
 * metadata 169.254.169.254), CGNAT, multicast/reserved IPv4 & IPv6 addresses,
 * IPv4-mapped/compatible IPv6 addresses, and re-validates DNS + IP on every
 * HTTP redirect while pinning the resolved IP on the outgoing socket.
 */

export type BlockedAddressClass =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'unspecified'
  | 'shared-private'
  | 'reserved';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    readonly addressClass: BlockedAddressClass | 'hostname' | 'protocol',
    readonly blockedTarget: string
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export const defaultDnsLookup: DnsLookupFn = async (hostname: string): Promise<ResolvedAddress[]> => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records
    .filter((entry) => entry.family === 4 || entry.family === 6)
    .map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
};

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  if (!net.isIPv4(ip)) {
    return null;
  }
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** Expands any valid IPv6 literal into 8 16-bit words. */
function expandIpv6Words(rawIp: string): number[] | null {
  const ip = rawIp.split('%')[0];
  if (!net.isIPv6(ip)) {
    return null;
  }

  let normalized = ip;
  // Convert trailing dotted-quad (e.g. ::ffff:127.0.0.1 or ::169.254.169.254) into two hex words.
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes('.')) {
    const octets = parseIpv4Octets(normalized.slice(lastColon + 1));
    if (!octets) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseSide = (side: string): number[] =>
    side ? side.split(':').filter(Boolean).map((word) => parseInt(word, 16)) : [];

  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) {
    return null;
  }
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) {
    return null;
  }
  return [...left, ...new Array(missing).fill(0), ...right];
}

function classifyIpv4Octets([a, b, c, d]: [number, number, number, number]): BlockedAddressClass | null {
  if (a === 169 && b === 254 && c === 169 && d === 254) {
    return 'metadata';
  }
  if (a === 127) {
    return 'loopback';
  }
  if (a === 0) {
    return 'unspecified';
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private';
  }
  if (a === 169 && b === 254) {
    return 'link-local';
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return 'shared-private';
  }
  if (
    (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  ) {
    return 'reserved';
  }
  return null;
}

/** Returns the blocked class if `ip` is non-public, or `null` when it is routable on the public internet. */
export function classifyBlockedIp(rawIp: string): BlockedAddressClass | null {
  const trimmed = rawIp.trim().replace(/^\[|\]$/g, '');
  const withoutZone = trimmed.split('%')[0];

  const v4 = parseIpv4Octets(withoutZone);
  if (v4) {
    return classifyIpv4Octets(v4);
  }

  const words = expandIpv6Words(withoutZone);
  if (!words) {
    return 'reserved';
  }

  const allZeroPrefix6 = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0;
  // :: (unspecified) and ::1 (loopback)
  if (allZeroPrefix6 && words[5] === 0 && words[6] === 0) {
    if (words[7] === 0) return 'unspecified';
    if (words[7] === 1) return 'loopback';
  }

  // Embedded IPv4: ::ffff:w6:w7 (IPv4-mapped), ::ffff:0:w6:w7 (IPv4-translated), ::w6:w7 (IPv4-compatible), 64:ff9b::w6:w7 (NAT64)
  const isMapped = allZeroPrefix6 && (words[5] === 0xffff || words[5] === 0);
  const isTranslated = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0xffff && words[5] === 0;
  const isNat64 = words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0;
  if (isMapped || isTranslated || isNat64) {
    const embedded: [number, number, number, number] = [
      (words[6] >> 8) & 0xff,
      words[6] & 0xff,
      (words[7] >> 8) & 0xff,
      words[7] & 0xff,
    ];
    return classifyIpv4Octets(embedded) || 'reserved';
  }

  const w0 = words[0];
  // fe80::/10 link-local (or any IPv6 literal carrying a %zone scope id)
  if ((w0 & 0xffc0) === 0xfe80 || trimmed.includes('%')) {
    return 'link-local';
  }
  // fc00::/7 Unique Local Address (fc00:: - fdff::) and fec0::/10 deprecated site-local
  if ((w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfec0) {
    return 'private';
  }
  // ff00::/8 multicast, 2001:db8::/32 documentation, 100::/64 discard
  if ((w0 & 0xff00) === 0xff00 || (w0 === 0x2001 && words[1] === 0x0db8) || (w0 === 0x0100 && words[1] === 0)) {
    return 'reserved';
  }

  return null;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

export function isBlockedHostname(rawHost: string): boolean {
  const host = rawHost.trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (!host) {
    return true;
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }
  if (host.endsWith('.localhost') || host.endsWith('.internal')) {
    return true;
  }
  return false;
}

/**
 * Validates URL scheme, hostname, and every resolved A/AAAA IP address.
 * Returns the parsed URL plus the pinned safe IP to dial so DNS rebinding
 * between lookup and socket connect is impossible.
 */
export async function validateSafeFetchUrl(
  rawUrl: string,
  lookup: DnsLookupFn = defaultDnsLookup
): Promise<{ url: URL; pinned: ResolvedAddress }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL '${rawUrl}'.`, 'protocol', rawUrl);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `Blocked URL protocol '${parsed.protocol}' in web_fetch (only http: and https: are allowed).`,
      'protocol',
      rawUrl
    );
  }

  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError('Blocked URL containing embedded credentials in web_fetch.', 'protocol', rawUrl);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    throw new SsrfBlockedError(
      `SSRF protection blocked loopback/internal host '${host}'.`,
      host === 'metadata.google.internal' || host === 'metadata' ? 'metadata' : 'loopback',
      host
    );
  }

  const literalVersion = net.isIP(host.split('%')[0]);
  if (literalVersion === 4 || literalVersion === 6) {
    const blocked = classifyBlockedIp(host);
    if (blocked) {
      throw new SsrfBlockedError(
        `SSRF protection blocked ${blocked} IP address '${host}'.`,
        blocked,
        host
      );
    }
    return {
      url: parsed,
      pinned: { address: host.split('%')[0], family: literalVersion as 4 | 6 },
    };
  }

  const records = await lookup(host);
  if (!records || records.length === 0) {
    throw new Error(`Could not resolve hostname '${host}'.`);
  }

  for (const record of records) {
    const blocked = classifyBlockedIp(record.address);
    if (blocked) {
      throw new SsrfBlockedError(
        `SSRF protection blocked '${host}' because it resolved to ${blocked} IP '${record.address}'.`,
        blocked,
        record.address
      );
    }
  }

  return { url: parsed, pinned: records[0] };
}
