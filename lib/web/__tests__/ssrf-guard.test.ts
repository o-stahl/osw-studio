import { describe, it, expect } from 'vitest';
import { isBlockedHostname, isPrivateIp, assertPublicUrl } from '../ssrf-guard';

describe('isPrivateIp', () => {
  it('blocks loopback, private, link-local, metadata', () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.255',
                       '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('allows public IPs', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
  it('does not misclassify 172.32/173 as private', () => {
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    expect(isPrivateIp('173.0.0.1')).toBe(false);
  });
  it('blocks non-canonical IPv6 loopback and embedded-IPv4 forms', () => {
    for (const ip of [
      '0:0:0:0:0:0:0:1',           // expanded ::1
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '::ffff:7f00:1',             // IPv4-mapped 127.0.0.1 in hex
      '::ffff:a00:1',              // IPv4-mapped 10.0.0.1 in hex
      '::ffff:127.0.0.1',          // IPv4-mapped dotted (already-ish covered, keep)
      '::127.0.0.1',               // IPv4-compatible loopback
      '::ffff:c0a8:1',             // IPv4-mapped 192.168.0.1
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });
  it('blocks special-purpose IPv4 ranges', () => {
    for (const ip of ['192.0.0.8', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.255.255.250',
                       '240.0.0.1', '255.255.255.255']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['198.20.0.1', '192.0.1.1', '223.255.255.255']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it('checks the IPv4 address inside NAT64 and 6to4 addresses', () => {
    expect(isPrivateIp('64:ff9b::7f00:1')).toBe(true);       // NAT64 of 127.0.0.1
    expect(isPrivateIp('64:ff9b::a9fe:a9fe')).toBe(true);    // NAT64 of 169.254.169.254
    expect(isPrivateIp('64:ff9b::808:808')).toBe(false);     // NAT64 of 8.8.8.8
    expect(isPrivateIp('2002:7f00:1::1')).toBe(true);        // 6to4 of 127.0.0.1
    expect(isPrivateIp('2002:808:808::1')).toBe(false);      // 6to4 of 8.8.8.8
  });
  it('blocks the local-use NAT64 prefix, which never leads to the public internet', () => {
    for (const ip of ['64:ff9b:1::808:808', '64:ff9b:1:ffff::1']) expect(isPrivateIp(ip), ip).toBe(true);
    expect(isPrivateIp('64:ff9b:2::1')).toBe(false);
  });
  it('blocks IPv6 multicast and site-local', () => {
    for (const ip of ['ff02::1', 'ff05::2', 'fec0::1']) expect(isPrivateIp(ip), ip).toBe(true);
  });
  it('still allows public IPv6', () => {
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost and .local/.internal names', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('foo.local')).toBe(true);
    expect(isBlockedHostname('svc.internal')).toBe(true);
  });
  it('allows normal hostnames', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/scheme/i);
    await expect(assertPublicUrl('ftp://x')).rejects.toThrow(/scheme/i);
  });
  it('rejects a hostname that resolves to a private ip', async () => {
    await expect(assertPublicUrl('http://evil.test', { resolve: async () => ['10.0.0.5'] }))
      .rejects.toThrow(/private/i);
  });
  it('accepts a public host', async () => {
    await expect(assertPublicUrl('https://example.com', { resolve: async () => ['93.184.216.34'] }))
      .resolves.toMatchObject({ hostname: 'example.com' });
  });
});
