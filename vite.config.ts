import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import pkg from './package.json' with { type: 'json' };

/**
 * Development-only proxy (browser on the Mac).
 * In the Windows app, WebView2 runs without CORS restrictions: no proxy is used.
 * HLS manifests are rewritten so that their segments also go through the proxy.
 */
function devProxy(): Plugin {
  return {
    name: 'ondes-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/__proxy', async (req, res) => {
        try {
          const target = new URL(req.url ?? '', 'http://localhost').searchParams.get('url');
          if (!target || !/^https?:\/\//i.test(target)) {
            res.statusCode = 400;
            res.end('URL invalide');
            return;
          }
          const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 Ondes/0.1' };
          if (req.headers.range) headers.range = String(req.headers.range);
          const ac = new AbortController();
          req.on('close', () => ac.abort());
          const r = await fetch(target, { headers, redirect: 'follow', signal: ac.signal });
          const type = r.headers.get('content-type') ?? '';
          const looksHls = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(new URL(r.url).pathname);
          res.statusCode = r.status;
          res.setHeader('access-control-allow-origin', '*');
          if (looksHls) {
            const text = await r.text();
            if (text.includes('#EXT-X-')) {
              const base = r.url;
              const prox = (u: string) => `/__proxy?url=${encodeURIComponent(new URL(u, base).href)}`;
              const out = text
                .split(/\r?\n/)
                .map((line) => {
                  const l = line.trim();
                  if (!l) return line;
                  if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${prox(u)}"`);
                  return prox(l);
                })
                .join('\n');
              res.setHeader('content-type', 'application/vnd.apple.mpegurl');
              res.end(out);
              return;
            }
            res.setHeader('content-type', type || 'text/plain');
            res.end(text);
            return;
          }
          const encoded = r.headers.has('content-encoding');
          r.headers.forEach((v, k) => {
            if (['content-encoding', 'transfer-encoding', 'connection', 'access-control-allow-origin'].includes(k)) return;
            if (k === 'content-length' && encoded) return;
            res.setHeader(k, v);
          });
          if (!r.body) {
            res.end();
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Readable.fromWeb(r.body as any)
            .on('error', () => res.end())
            .pipe(res);
        } catch (e) {
          if (!res.headersSent) res.statusCode = 502;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProxy()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'chrome110', chunkSizeWarningLimit: 2000 },
});
