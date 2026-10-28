#!/usr/bin/env node
/**
 * Minimal static dev server with live reload, started by the scripted agent
 * in place of `npm run dev`. CSS changes are swapped in place like Vite's HMR,
 * so a browser preview restyles without a flash; other changes reload.
 *
 * The page polls for changes rather than holding a stream open, so reloads get
 * through Komla's SSH preview forwarding without depending on stream flushing.
 *
 * Usage: node dev-server.mjs <dir> <port>
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [root, port] = [path.resolve(process.argv[2] ?? '.'), Number(process.argv[3] ?? 4321)];
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};
const CLIENT = `<script>
(() => {
  let seen = null;
  const swapStyles = () => {
    for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
      const next = link.cloneNode();
      next.href = link.href.split('?')[0] + '?t=' + Date.now();
      next.onload = () => link.remove();
      link.after(next);
    }
  };
  const poll = async () => {
    try {
      const change = await (await fetch('/__changes', { cache: 'no-store' })).json();
      if (seen !== null && change.version !== seen) {
        if (change.kind !== 'css') return location.reload();
        swapStyles();
      }
      seen = change.version;
    } catch {}
    setTimeout(poll, 150);
  };
  poll();
})();
</script>`;

let change = { version: 0, kind: 'css' };
fs.watch(root, (_event, file) => {
  change = { version: change.version + 1, kind: String(file).endsWith('.css') ? 'css' : 'reload' };
});

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__changes') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(change));
      return;
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    let body = fs.readFileSync(file);
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    if (type === 'text/html') body = body.toString().replace('</body>', `${CLIENT}</body>`);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  })
  .listen(port, '127.0.0.1');

// Started detached, so it outlives the agent unless it notices it is gone, and
// would keep the port from the next recording.
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1000);
