import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { chooseSitePort, startSiteProxy } from '../site-proxy';
import { DESKTOP_FALLBACK_RANGE } from '../server-port';

/**
 * Published sites open on a second port: a different origin from the studio. The proxy forwards
 * that port to the same server with the Host header as the browser sent it, which is how the
 * server knows to answer only site paths there.
 */

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

describe('chooseSitePort', () => {
  it("never picks the app's own port", async () => {
    const appPort = DESKTOP_FALLBACK_RANGE[0];
    expect(await chooseSitePort(appPort, async () => true)).toBe(appPort + 1);
  });

  it('says so when nothing in the range is free', async () => {
    await expect(chooseSitePort(30011, async () => false)).rejects.toThrow(/No free port/);
  });
});

describe('startSiteProxy', () => {
  it('forwards a request unchanged, Host header included', async () => {
    const seen: { host?: string; url?: string; method?: string; body?: string } = {};
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        Object.assign(seen, { host: req.headers.host, url: req.url, method: req.method, body });
        res.writeHead(201, { 'x-from': 'app' });
        res.end('answered');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    servers.push(upstream);
    const appPort = (upstream.address() as AddressInfo).port;

    const proxy = await startSiteProxy('127.0.0.1', 0, appPort);
    servers.push(proxy);
    const sitePort = (proxy.address() as AddressInfo).port;

    const reply = await new Promise<{ status?: number; header?: string; body: string }>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: sitePort, method: 'POST', path: '/deployments/d1/?x=1' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, header: res.headers['x-from'] as string, body }));
      });
      req.end('payload');
    });

    expect(reply).toEqual({ status: 201, header: 'app', body: 'answered' });
    expect(seen).toEqual({ host: `127.0.0.1:${sitePort}`, url: '/deployments/d1/?x=1', method: 'POST', body: 'payload' });
  });

  it('drops the upstream request when the visitor goes away mid-answer', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => { upstreamClosed = r; });
    const upstream = http.createServer((req, res) => {
      res.writeHead(200);
      res.write('partial');
      // Never ends: only the visitor leaving can finish this request.
      req.socket.on('close', () => upstreamClosed());
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    servers.push(upstream);
    const proxy = await startSiteProxy('127.0.0.1', 0, (upstream.address() as AddressInfo).port);
    servers.push(proxy);

    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: (proxy.address() as AddressInfo).port, path: '/' }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
      req.end();
    });
    await closed;
  });
});
