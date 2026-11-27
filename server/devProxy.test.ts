import assert from 'node:assert/strict';
import { createServer as createHttpServer, request } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createServer } from 'vite';
import config from '../vite.config.ts';

test('Vite API proxy preserves LAN Host, Origin and authentication for backend validation', async () => {
  const backend = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const apiProxy = config.server?.proxy?.['/api'];
    assert.ok(apiProxy && typeof apiProxy !== 'string', 'Use explicit proxy options to preserve Host');
    const port = (backend.address() as { port: number }).port;
    vite = await createServer({
      configFile: false,
      plugins: [],
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '0.0.0.0', port: 0, strictPort: true, hmr: false, watch: null,
        proxy: { '/api': { ...apiProxy, target: 'http://127.0.0.1:' + port } } },
    });
    await vite.listen();
    const vitePort = (vite.httpServer!.address() as { port: number }).port;
    const host = '192.168.1.42:' + vitePort;
    const authorization = 'Basic ZGF0YWZvcmdlOnRlc3Q=';
    for (const origin of ['http://' + host, 'https://foreign.example']) {
      // Use node:http: fetch can replace a manually supplied Host header.
      const response = await new Promise<{ status: number | undefined; data: unknown }>((resolve, reject) => {
        const req = request('http://127.0.0.1:' + vitePort + '/api/health', {
          method: 'POST', headers: { Host: host, Origin: origin, Authorization: authorization },
        }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch (error) { reject(error); } });
          res.on('error', reject);
        });
        req.on('error', reject); req.end();
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.data, { host, origin, authorization });
    }
  } finally {
    await vite?.close();
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }
});
