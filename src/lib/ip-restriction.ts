/**
 * IP Restriction Module (Edge Runtime Compatible)
 * Issue #332: Access control by IP address/CIDR range
 *
 * CONSTRAINT: This module must be Edge Runtime compatible.
 * Do NOT import Node.js-specific modules (net, dns, os, fs, etc.).
 *
 * [S3-006] CLI build compatibility constraint:
 * ip-restriction.ts is NOT directly imported from src/cli/.
 * CLI sets CM_ALLOWED_IPS via process.env only; IP restriction logic
 * runs server-side (middleware.ts / ws-server.ts).
 *
 * [S2-004] Difference from auth.ts:
 * auth.ts silently disables on invalid hash (storedTokenHash = undefined).
 * ip-restriction.ts uses fail-fast (throw) on invalid CIDR because
 * silently ignoring security config errors would create a security hole.
 */

// --- Internal constants (unexported) [S1-002] ---
// Integrated into this module; no external references needed (YAGNI).

const IPV4_MAPPED_IPV6_PREFIX = '::ffff:';
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const MAX_IPV4_PREFIX_LENGTH = 32;

/** [S4-002] DoS prevention: upper limit on CIDR entry count */
const MAX_ALLOWED_IP_ENTRIES = 256;

/** [S4-005] Input validation: max length per entry ('255.255.255.255/32' = 18 chars) */
const MAX_CIDR_ENTRY_LENGTH = 18;

// --- Exported type ---

/** CIDR range represented as network/mask pair */
export interface CidrRange {
  /** Network address (32-bit unsigned integer) */
  network: number;
  /** Subnet mask (32-bit unsigned integer) */
  mask: number;
}

// --- Module-scope initialization [S1-003] ---
// Following auth.ts storedTokenHash pattern: read env once at module load.
// Placed before functions that depend on these values for clarity.

const allowedIpsEnv = process.env.CM_ALLOWED_IPS?.trim() || '';

// [S4-006] CM_TRUST_PROXY value validation:
// 'true' is the only value that enables proxy trust. Other non-empty values
// (e.g., 'TRUE', '1', 'yes') fall back to safe default (no proxy trust),
// and a warning is emitted to help operators detect configuration mistakes.
const trustProxyEnv = process.env.CM_TRUST_PROXY?.trim() || '';
if (trustProxyEnv !== '' && trustProxyEnv !== 'true' && trustProxyEnv !== 'false') {
  console.warn(
    `[IP-RESTRICTION] CM_TRUST_PROXY has unexpected value: "${trustProxyEnv}". ` +
    'Only "true" (lowercase) enables proxy trust.'
  );
}

/** Whether CM_TRUST_PROXY is strictly 'true' */
const trustProxy = trustProxyEnv === 'true';

// --- Pure functions ---

/**
 * Parse an IPv4 address string into a 32-bit unsigned integer.
 * Returns null if the format is invalid or any octet is out of range.
 */
function ipToInt(ip: string): number | null {
  const match = ip.match(IPV4_PATTERN);
  if (!match) return null;

  const octets = [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    parseInt(match[4], 10),
  ];

  for (const octet of octets) {
    if (octet < 0 || octet > 255) return null;
  }

  // Use unsigned right shift (>>> 0) to ensure unsigned 32-bit integer
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * IPv4-mapped IPv6 address (::ffff:x.x.x.x) normalization.
 * Returns the IPv4 portion if mapped, otherwise returns as-is.
 */
export function normalizeIp(ip: string): string {
  if (!ip) return '';
  const lower = ip.toLowerCase();
  if (lower.startsWith(IPV4_MAPPED_IPV6_PREFIX)) {
    return ip.substring(IPV4_MAPPED_IPV6_PREFIX.length);
  }
  return ip;
}

/**
 * Parse CM_ALLOWED_IPS environment variable string into CidrRange array.
 * Throws Error on invalid CIDR format (fail-fast).
 *
 * [S4-002] Throws when entry count exceeds MAX_ALLOWED_IP_ENTRIES (256).
 * Large CIDR entry counts cause parse delay and per-request OR-loop
 * performance degradation.
 *
 * [S4-005] Throws when any entry exceeds MAX_CIDR_ENTRY_LENGTH (18 chars).
 * IPv4 CIDR maximum is '255.255.255.255/32' (18 chars); longer input is
 * rejected before regex matching.
 *
 * @throws {Error} Invalid IP address or CIDR format
 * @throws {Error} Entry count exceeds MAX_ALLOWED_IP_ENTRIES (256)
 * @throws {Error} Individual entry exceeds MAX_CIDR_ENTRY_LENGTH (18 chars)
 */
export function parseAllowedIps(envValue: string): CidrRange[] {
  const trimmed = envValue.trim();
  if (trimmed.length === 0) return [];

  const entries = trimmed.split(',').map(e => e.trim()).filter(e => e.length > 0);

  // [S4-002] DoS prevention: entry count upper limit
  if (entries.length > MAX_ALLOWED_IP_ENTRIES) {
    throw new Error(
      `CM_ALLOWED_IPS: too many entries (${entries.length}). Maximum is ${MAX_ALLOWED_IP_ENTRIES}.`
    );
  }

  const ranges: CidrRange[] = [];

  for (const entry of entries) {
    // [S4-005] Entry length validation (before regex)
    if (entry.length > MAX_CIDR_ENTRY_LENGTH) {
      throw new Error(
        `CM_ALLOWED_IPS: entry "${entry}" exceeds maximum length of ${MAX_CIDR_ENTRY_LENGTH} characters.`
      );
    }

    // Try CIDR format first (x.x.x.x/N)
    const cidrMatch = entry.match(IPV4_CIDR_PATTERN);
    if (cidrMatch) {
      const octets = [
        parseInt(cidrMatch[1], 10),
        parseInt(cidrMatch[2], 10),
        parseInt(cidrMatch[3], 10),
        parseInt(cidrMatch[4], 10),
      ];
      const prefix = parseInt(cidrMatch[5], 10);

      for (const octet of octets) {
        if (octet < 0 || octet > 255) {
          throw new Error(`CM_ALLOWED_IPS: invalid octet in "${entry}". Octets must be 0-255.`);
        }
      }

      if (prefix < 0 || prefix > MAX_IPV4_PREFIX_LENGTH) {
        throw new Error(
          `CM_ALLOWED_IPS: invalid prefix length in "${entry}". Must be 0-${MAX_IPV4_PREFIX_LENGTH}.`
        );
      }

      const network = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
      // Create mask: for prefix=24, mask = 0xFFFFFF00
      // For prefix=0, mask = 0x00000000
      const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);

      ranges.push({ network: (network & mask) >>> 0, mask });
      continue;
    }

    // Try plain IP format (x.x.x.x -> treat as /32)
    const ipMatch = entry.match(IPV4_PATTERN);
    if (ipMatch) {
      const octets = [
        parseInt(ipMatch[1], 10),
        parseInt(ipMatch[2], 10),
        parseInt(ipMatch[3], 10),
        parseInt(ipMatch[4], 10),
      ];

      for (const octet of octets) {
        if (octet < 0 || octet > 255) {
          throw new Error(`CM_ALLOWED_IPS: invalid octet in "${entry}". Octets must be 0-255.`);
        }
      }

      const network = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
      const mask = 0xFFFFFFFF >>> 0;

      ranges.push({ network, mask });
      continue;
    }

    // Neither valid IP nor valid CIDR
    throw new Error(`CM_ALLOWED_IPS: invalid entry "${entry}". Expected IPv4 address or CIDR notation.`);
  }

  return ranges;
}

/**
 * Check if an IP address is allowed by any of the given CIDR ranges.
 * Multiple ranges are evaluated with OR logic (match any = allowed).
 */
export function isIpAllowed(ip: string, ranges: CidrRange[]): boolean {
  if (ranges.length === 0) return false;

  const normalized = normalizeIp(ip);
  const ipInt = ipToInt(normalized);
  if (ipInt === null) return false;

  for (const range of ranges) {
    if ((ipInt & range.mask) >>> 0 === range.network) {
      return true;
    }
  }

  return false;
}

/**
 * Get client IP from request headers.
 *
 * [S1-004] Request parsing responsibility - separate from CIDR matching
 * (isIpAllowed). These are different responsibilities: request parsing vs
 * IP range evaluation. If proxy-related settings grow (e.g., trusted proxies
 * list via CM_TRUSTED_PROXIES), consider splitting to a separate module
 * (e.g., request-ip.ts).
 *
 * [S4-001] WARNING: When CM_TRUST_PROXY=true, the leftmost IP from
 * X-Forwarded-For is used. An attacker can inject arbitrary IPs at the
 * front of the header. The reverse proxy MUST overwrite X-Forwarded-For
 * with the client IP it received (trusted proxy sets the client IP it
 * received as the first entry). If the proxy does not do this correctly,
 * IP restriction bypass is possible.
 * Future extension: introduce CM_TRUSTED_PROXIES for a trusted proxy IP
 * list and switch to rightmost-non-trusted-IP extraction.
 *
 * @param headers - Request headers with get() method
 * @returns Client IP string or null
 */
export function getClientIp(headers: {
  get(name: string): string | null;
}): string | null {
  if (trustProxy) {
    // Trust X-Forwarded-For when CM_TRUST_PROXY=true
    const xff = headers.get('x-forwarded-for');
    if (xff) {
      const firstIp = xff.split(',')[0].trim();
      if (firstIp) return firstIp;
    }
  }

  // Default: use X-Real-IP (set by server.ts from socket.remoteAddress)
  return headers.get('x-real-ip') || null;
}

// [S1-001] Module-level cache of parsed ranges
// Shared by middleware.ts and ws-server.ts via getAllowedRanges()
const cachedRanges: CidrRange[] = allowedIpsEnv.length > 0
  ? parseAllowedIps(allowedIpsEnv)
  : [];

/**
 * Return the cached allowed CIDR ranges.
 * Parsed once at module initialization from CM_ALLOWED_IPS.
 *
 * [S1-001] Use this instead of calling parseAllowedIps() each time.
 * DRY cache strategy unified for HTTP and WebSocket layers.
 */
export function getAllowedRanges(): CidrRange[] {
  return cachedRanges;
}

/**
 * Check if IP restriction is enabled.
 *
 * [S1-003] Uses module-scope captured allowedIpsEnv (not process.env).
 * Ensures cache consistency with getAllowedRanges().
 */
export function isIpRestrictionEnabled(): boolean {
  return allowedIpsEnv.length > 0;
}
