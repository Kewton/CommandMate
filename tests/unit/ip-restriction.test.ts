/**
 * Unit Tests: IP Restriction Module
 * Issue #332: IP address/CIDR restriction
 *
 * Tests cover:
 * - parseAllowedIps(): parsing and validation of CIDR strings
 * - isIpAllowed(): CIDR matching logic (OR judgment)
 * - normalizeIp(): IPv4-mapped IPv6 normalization
 * - isIpRestrictionEnabled(): module-scope env capture
 * - getClientIp(): request header IP extraction
 * - getAllowedRanges(): cached ranges retrieval
 *
 * [S3-001] Test pattern: vi.resetModules() for module-scope variable re-initialization
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('IP Restriction Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.CM_ALLOWED_IPS;
    delete process.env.CM_TRUST_PROXY;
  });

  // ============================================================
  // parseAllowedIps()
  // ============================================================

  describe('parseAllowedIps', () => {
    it('should parse a single IP as /32 CIDR', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.1');
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toHaveProperty('network');
      expect(ranges[0]).toHaveProperty('mask');
    });

    it('should parse a CIDR range', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24');
      expect(ranges).toHaveLength(1);
    });

    it('should parse multiple comma-separated entries', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24,10.0.0.0/8');
      expect(ranges).toHaveLength(2);
    });

    it('should handle /0 (match all)', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('0.0.0.0/0');
      expect(ranges).toHaveLength(1);
    });

    it('should handle /32 (single IP via CIDR)', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.1/32');
      expect(ranges).toHaveLength(1);
    });

    it('should handle entries with whitespace', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps(' 192.168.1.0/24 , 10.0.0.0/8 ');
      expect(ranges).toHaveLength(2);
    });

    it('should throw on invalid IP format', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      expect(() => parseAllowedIps('not-an-ip')).toThrow();
    });

    it('should throw on invalid CIDR with octet > 255', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      expect(() => parseAllowedIps('999.999.999.999/24')).toThrow();
    });

    it('should throw on invalid prefix length > 32', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      expect(() => parseAllowedIps('192.168.1.0/33')).toThrow();
    });

    it('should throw on negative prefix length', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      expect(() => parseAllowedIps('192.168.1.0/-1')).toThrow();
    });

    it('should return empty array for empty string', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('');
      expect(ranges).toEqual([]);
    });

    it('should return empty array for whitespace-only string', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('   ');
      expect(ranges).toEqual([]);
    });

    it('should throw when entry count exceeds MAX_ALLOWED_IP_ENTRIES (256)', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      const entries = Array.from({ length: 257 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`).join(',');
      expect(() => parseAllowedIps(entries)).toThrow(/256/);
    });

    it('should throw when individual entry exceeds MAX_CIDR_ENTRY_LENGTH (18)', async () => {
      const { parseAllowedIps } = await import('../../src/lib/ip-restriction');
      // 19 characters - longer than max '255.255.255.255/32' (18 chars)
      expect(() => parseAllowedIps('1234567890123456789')).toThrow();
    });
  });

  // ============================================================
  // isIpAllowed()
  // ============================================================

  describe('isIpAllowed', () => {
    it('should return true for exact IP match (/32)', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.1/32');
      expect(isIpAllowed('192.168.1.1', ranges)).toBe(true);
    });

    it('should return true for IP within CIDR /24 range', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24');
      expect(isIpAllowed('192.168.1.100', ranges)).toBe(true);
    });

    it('should return false for IP outside CIDR range', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24');
      expect(isIpAllowed('192.168.2.1', ranges)).toBe(false);
    });

    it('should return true for IP matching any CIDR in OR judgment', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24,10.0.0.0/8');
      expect(isIpAllowed('10.0.0.1', ranges)).toBe(true);
    });

    it('should return true for any IP with /0 range', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('0.0.0.0/0');
      expect(isIpAllowed('1.2.3.4', ranges)).toBe(true);
    });

    it('should return false for mismatched /32 range', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.2/32');
      expect(isIpAllowed('192.168.1.1', ranges)).toBe(false);
    });

    it('should return false for empty ranges', async () => {
      const { isIpAllowed } = await import('../../src/lib/ip-restriction');
      expect(isIpAllowed('192.168.1.1', [])).toBe(false);
    });

    it('should handle IPv4-mapped IPv6 address', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24');
      expect(isIpAllowed('::ffff:192.168.1.1', ranges)).toBe(true);
    });

    it('should return false for invalid IP address format', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('192.168.1.0/24');
      expect(isIpAllowed('not-an-ip', ranges)).toBe(false);
    });

    it('should handle /16 subnet correctly', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('172.16.0.0/16');
      expect(isIpAllowed('172.16.255.255', ranges)).toBe(true);
      expect(isIpAllowed('172.17.0.0', ranges)).toBe(false);
    });

    it('should handle /8 subnet correctly', async () => {
      const { parseAllowedIps, isIpAllowed } = await import('../../src/lib/ip-restriction');
      const ranges = parseAllowedIps('10.0.0.0/8');
      expect(isIpAllowed('10.255.255.255', ranges)).toBe(true);
      expect(isIpAllowed('11.0.0.0', ranges)).toBe(false);
    });
  });

  // ============================================================
  // normalizeIp()
  // ============================================================

  describe('normalizeIp', () => {
    it('should return IPv4 address unchanged', async () => {
      const { normalizeIp } = await import('../../src/lib/ip-restriction');
      expect(normalizeIp('192.168.1.1')).toBe('192.168.1.1');
    });

    it('should strip ::ffff: prefix from IPv4-mapped IPv6', async () => {
      const { normalizeIp } = await import('../../src/lib/ip-restriction');
      expect(normalizeIp('::ffff:192.168.1.1')).toBe('192.168.1.1');
    });

    it('should handle uppercase ::FFFF: prefix', async () => {
      const { normalizeIp } = await import('../../src/lib/ip-restriction');
      expect(normalizeIp('::FFFF:192.168.1.1')).toBe('192.168.1.1');
    });

    it('should return pure IPv6 address unchanged', async () => {
      const { normalizeIp } = await import('../../src/lib/ip-restriction');
      expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    });

    it('should return empty string for empty input', async () => {
      const { normalizeIp } = await import('../../src/lib/ip-restriction');
      expect(normalizeIp('')).toBe('');
    });
  });

  // ============================================================
  // isIpRestrictionEnabled()
  // ============================================================

  describe('isIpRestrictionEnabled', () => {
    it('should return false when CM_ALLOWED_IPS is not set', async () => {
      delete process.env.CM_ALLOWED_IPS;
      const { isIpRestrictionEnabled } = await import('../../src/lib/ip-restriction');
      expect(isIpRestrictionEnabled()).toBe(false);
    });

    it('should return true when CM_ALLOWED_IPS is set', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      const { isIpRestrictionEnabled } = await import('../../src/lib/ip-restriction');
      expect(isIpRestrictionEnabled()).toBe(true);
    });

    it('should return false when CM_ALLOWED_IPS is whitespace only', async () => {
      process.env.CM_ALLOWED_IPS = '   ';
      const { isIpRestrictionEnabled } = await import('../../src/lib/ip-restriction');
      expect(isIpRestrictionEnabled()).toBe(false);
    });
  });

  // ============================================================
  // getAllowedRanges()
  // ============================================================

  describe('getAllowedRanges', () => {
    it('should return empty array when CM_ALLOWED_IPS is not set', async () => {
      delete process.env.CM_ALLOWED_IPS;
      const { getAllowedRanges } = await import('../../src/lib/ip-restriction');
      expect(getAllowedRanges()).toEqual([]);
    });

    it('should return cached CidrRange array when CM_ALLOWED_IPS is set', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24,10.0.0.0/8';
      const { getAllowedRanges } = await import('../../src/lib/ip-restriction');
      const ranges = getAllowedRanges();
      expect(ranges).toHaveLength(2);
      expect(ranges[0]).toHaveProperty('network');
      expect(ranges[0]).toHaveProperty('mask');
    });

    it('should return the same cached reference on multiple calls', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/24';
      const { getAllowedRanges } = await import('../../src/lib/ip-restriction');
      const first = getAllowedRanges();
      const second = getAllowedRanges();
      expect(first).toBe(second);
    });
  });

  // ============================================================
  // getClientIp()
  // ============================================================

  describe('getClientIp', () => {
    it('should return X-Real-IP when CM_TRUST_PROXY is not set', async () => {
      delete process.env.CM_TRUST_PROXY;
      const { getClientIp } = await import('../../src/lib/ip-restriction');
      const headers = {
        get: (name: string) => {
          if (name.toLowerCase() === 'x-real-ip') return '1.2.3.4';
          return null;
        },
      };
      expect(getClientIp(headers)).toBe('1.2.3.4');
    });

    it('should return X-Forwarded-For first IP when CM_TRUST_PROXY=true', async () => {
      process.env.CM_TRUST_PROXY = 'true';
      const { getClientIp } = await import('../../src/lib/ip-restriction');
      const headers = {
        get: (name: string) => {
          if (name.toLowerCase() === 'x-forwarded-for') return '1.2.3.4, 5.6.7.8';
          if (name.toLowerCase() === 'x-real-ip') return '9.9.9.9';
          return null;
        },
      };
      expect(getClientIp(headers)).toBe('1.2.3.4');
    });

    it('should return X-Real-IP when CM_TRUST_PROXY=true but X-Forwarded-For is absent', async () => {
      process.env.CM_TRUST_PROXY = 'true';
      const { getClientIp } = await import('../../src/lib/ip-restriction');
      const headers = {
        get: (name: string) => {
          if (name.toLowerCase() === 'x-real-ip') return '1.2.3.4';
          return null;
        },
      };
      expect(getClientIp(headers)).toBe('1.2.3.4');
    });

    it('should return null when no relevant headers are present', async () => {
      delete process.env.CM_TRUST_PROXY;
      const { getClientIp } = await import('../../src/lib/ip-restriction');
      const headers = {
        get: () => null,
      };
      expect(getClientIp(headers)).toBeNull();
    });

    it('should use X-Real-IP when CM_TRUST_PROXY=false (explicit)', async () => {
      process.env.CM_TRUST_PROXY = 'false';
      const { getClientIp } = await import('../../src/lib/ip-restriction');
      const headers = {
        get: (name: string) => {
          if (name.toLowerCase() === 'x-forwarded-for') return '1.2.3.4';
          if (name.toLowerCase() === 'x-real-ip') return '5.6.7.8';
          return null;
        },
      };
      expect(getClientIp(headers)).toBe('5.6.7.8');
    });
  });

  // ============================================================
  // Module-level fail-fast (invalid CIDR at module load)
  // ============================================================

  describe('fail-fast on invalid CIDR at module load', () => {
    it('should throw on module import when CM_ALLOWED_IPS has invalid CIDR', async () => {
      process.env.CM_ALLOWED_IPS = '999.999.999.999/24';
      await expect(async () => {
        await import('../../src/lib/ip-restriction');
      }).rejects.toThrow();
    });

    it('should throw on module import when CM_ALLOWED_IPS has invalid prefix length', async () => {
      process.env.CM_ALLOWED_IPS = '192.168.1.0/33';
      await expect(async () => {
        await import('../../src/lib/ip-restriction');
      }).rejects.toThrow();
    });
  });

  // ============================================================
  // CM_TRUST_PROXY value validation
  // ============================================================

  describe('CM_TRUST_PROXY value validation', () => {
    it('should warn on unexpected CM_TRUST_PROXY value', async () => {
      process.env.CM_TRUST_PROXY = 'TRUE';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await import('../../src/lib/ip-restriction');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('CM_TRUST_PROXY has unexpected value')
      );
      warnSpy.mockRestore();
    });

    it('should not warn for CM_TRUST_PROXY=true', async () => {
      process.env.CM_TRUST_PROXY = 'true';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await import('../../src/lib/ip-restriction');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('CM_TRUST_PROXY has unexpected value')
      );
      warnSpy.mockRestore();
    });

    it('should not warn for CM_TRUST_PROXY=false', async () => {
      process.env.CM_TRUST_PROXY = 'false';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await import('../../src/lib/ip-restriction');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('CM_TRUST_PROXY has unexpected value')
      );
      warnSpy.mockRestore();
    });

    it('should not warn when CM_TRUST_PROXY is not set', async () => {
      delete process.env.CM_TRUST_PROXY;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await import('../../src/lib/ip-restriction');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('CM_TRUST_PROXY has unexpected value')
      );
      warnSpy.mockRestore();
    });
  });
});
