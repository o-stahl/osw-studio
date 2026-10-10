/**
 * The origin published sites are opened on in the desktop app.
 *
 * The app serves the studio on `http://localhost:{port}`, and its API has no session: anything
 * running on that origin can use all of it, and read the keys the studio keeps in localStorage.
 * A published site runs code the studio does not control, so it is served from a second port, which
 * is a different origin. This forwards that port to the same Next server, Host header and all, and
 * the server answers only site paths there (`lib/web/site-origin.ts`, `SITES_ORIGIN`).
 */
import * as http from 'http';
import { DESKTOP_FALLBACK_RANGE } from './server-port';

/** The first free port in the fallback range other than the app's own. */
export async function chooseSitePort(
  appPort: number,
  probe: (port: number) => Promise<boolean>,
): Promise<number> {
  for (let port = DESKTOP_FALLBACK_RANGE[0]; port <= DESKTOP_FALLBACK_RANGE[1]; port++) {
    if (port === appPort) continue;
    if (await probe(port)) return port;
  }
  throw new Error(
    `No free port for published sites in ${DESKTOP_FALLBACK_RANGE[0]}-${DESKTOP_FALLBACK_RANGE[1]}.`,
  );
}

/** Forward every request on `sitePort` to the app server, unchanged. */
export function startSiteProxy(host: string, sitePort: number, appPort: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host, port: appPort, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sitePort, host, () => resolve(server));
  });
}
