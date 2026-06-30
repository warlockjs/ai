import { isIP } from "node:net";

/**
 * True when `ip` is a private, loopback, link-local, unique-local,
 * carrier-grade-NAT, unspecified, or otherwise non-public address — the
 * set an SSRF guard must refuse. Accepts IPv4 and IPv6 literals (including
 * IPv4-mapped IPv6 like `::ffff:169.254.169.254`). A non-IP string returns
 * `false` (the caller resolves hostnames via DNS first).
 *
 * The cloud-metadata endpoint `169.254.169.254` is covered by the IPv4
 * link-local range `169.254.0.0/16`.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return false;
}

/** Parse a dotted-quad into four octets, or `null` if malformed. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map(part => Number(part));
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;

  return octets as [number, number, number, number];
}

function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return true; // unparseable → refuse, fail closed

  const [a, b] = octets;

  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local + metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 (IETF/test)
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51) || // 198.51.100.0/24 test-net-2
    (a === 203 && b === 0) || // 203.0.113.0/24 test-net-3
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split("%")[0]; // drop zone id

  // IPv4-mapped / -embedded (::ffff:a.b.c.d, ::a.b.c.d) — defer to the v4
  // check on the trailing dotted-quad so an inward-mapped address is caught.
  const v4 = normalized.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    return isPrivateIpv4(v4[1]);
  }

  if (normalized === "::1" || normalized === "::") {
    return true; // loopback / unspecified
  }

  // Expand only the leading group enough to classify the reserved blocks.
  const firstGroup = normalized.split(":")[0];
  const head = firstGroup === "" ? 0 : Number.parseInt(firstGroup, 16);

  // fc00::/7 unique-local (fc.. / fd..)
  if ((head & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((head & 0xffc0) === 0xfe80) return true;

  return false;
}
