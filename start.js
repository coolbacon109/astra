#!/usr/bin/env node
/*
 * Astra front router (V2 only).
 *
 * The front door is the saved Clever page, so the site reads as a school page
 * to whoever looks at it first. Astra's own landing sits behind it at /astra,
 * and that landing opens straight into the app, which is one thing now.
 * V2 (v2/server.js) runs as a child process on an internal port and is
 * never modified here - requests pass straight through.
 *
 *   /                 the saved Clever page
 *   /clever           same page (older links still point here)
 *   /clever-cloak/*   Clever page assets
 *   /astra            Astra's landing, "Help" on the Clever page comes back here
 *   /v1, /v1/*        retired: 302 to /v2
 *   everything else   V2 (app routes, api, service worker, wisp upgrades)
 */

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = __dirname;
const FRONT_PORT = Number(process.env.PORT || 6741);
/* containers (Railway etc.) must be reachable on all interfaces; local runs set HOST explicitly */
const HOST = process.env.HOST || '0.0.0.0';
const V2_PORT = Number(process.env.V2_PORT || 6742);
const LANDING_FILE = path.join(ROOT, 'index.html');
const CLEVER_FILE = path.join(ROOT, 'clever-cloak', 'Clever.html');

/* ------------------------------------------------------------------ */
/* /clever: the saved Clever page with its asset paths lifted to the   */
/* site root, plus one injected hook so pressing "Help" opens the      */
/* landing page instead of Clever's support site.                      */
/* ------------------------------------------------------------------ */

const CLEVER_HOOK = [
  '<script>(function(){',
  '  function goHome(e){',
  '    if (e) { e.preventDefault(); e.stopPropagation(); }',
  "    try { window.location.href = '/astra'; } catch (err) {}",
  '  }',
  "  document.addEventListener('click', function(e){",
  '    var t = e.target;',
  '    if (!t || !t.closest) return;',
  '    var help = t.closest(\'#menu-item-1623, a[href*="support.clever.com"]\');',
  '    if (!help) {',
  "      var c = t.closest('a, button');",
  "      if (c && /^\\s*Help\\s*$/i.test(c.textContent || '')) help = c;",
  '    }',
  '    if (help) goHome(e);',
  '  }, true);',
  '})();</script>'
].join('\n');

function cleverHtml() {
  let raw = fs.readFileSync(CLEVER_FILE, 'utf8');
  raw = raw.split('./Clever_files/').join('/clever-cloak/Clever_files/');
  raw = raw.replace(/(src|href)=("|')Clever_files\//g, '$1=$2/clever-cloak/Clever_files/');
  return raw.replace('</body>', `${CLEVER_HOOK}</body>`);
}

function serveCleverStatic(pathname, res) {
  let sub;
  try { sub = decodeURIComponent(pathname); } catch { sub = pathname; }
  sub = path.normalize(sub).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(ROOT, sub);
  if (!file.startsWith(path.join(ROOT, 'clever-cloak') + path.sep)) {
    return sendSimple(res, 403, 'forbidden');
  }
  fs.readFile(file, (e, buf) => {
    if (e) return sendSimple(res, 404, 'not found');
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.json': 'application/json; charset=utf-8'
    };
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Proxying                                                            */
/* ------------------------------------------------------------------ */

function sendSimple(res, code, msg) {
  if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

function proxyTo(req, res, targetPath) {
  const headers = Object.assign({}, req.headers);
  delete headers['accept-encoding'];
  const upstreamReq = http.request(
    { host: '127.0.0.1', port: V2_PORT, method: req.method, path: targetPath, headers },
    (up) => {
      const h = Object.assign({}, up.headers);
      delete h['transfer-encoding'];
      res.writeHead(up.statusCode, h);
      up.pipe(res);
    }
  );
  upstreamReq.on('error', (e) => {
    sendSimple(res, 502, `Astra is starting up (${String((e && e.message) || e)})`);
  });
  req.pipe(upstreamReq);
}

/* ------------------------------------------------------------------ */
/* Front server                                                        */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    return sendSimple(res, 400, 'bad request');
  }
  const p = u.pathname;
  const search = u.search || '';

  if (p === '/front-health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('astra front ok');
  }

  /* the front door: the saved Clever page, served at the root so the site
   * reads as a school page before anything else. "Help" opens the landing. */
  if (p === '/' || p === '/index.html' || p === '/clever' || p === '/clever/') {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(cleverHtml());
    } catch (e) {
      return sendSimple(res, 500, 'clever page missing');
    }
  }

  /* the landing behind the front door */
  if (p === '/astra' || p === '/astra/' || p === '/home') {
    if (p !== '/astra') {
      res.writeHead(302, { Location: '/astra' });
      return res.end();
    }
    return fs.readFile(LANDING_FILE, (e, buf) => {
      if (e) return sendSimple(res, 500, 'landing page missing');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    });
  }

  /* Clever page assets */
  if (p.startsWith('/clever-cloak/')) {
    return serveCleverStatic(p, res);
  }

  /* retired v1 entry points land on v2 */
  if (p === '/v1' || p === '/v1.html' || p.startsWith('/v1/')) {
    res.writeHead(302, { Location: `/v2${search}` });
    return res.end();
  }

  /* everything else belongs to V2 */
  return proxyTo(req, res, p + search);
});

/* websocket piping (wisp relay and chat) - straight through to V2 */
server.on('upgrade', (req, clientSocket, head) => {
  const target = req.url || '/';
  const lines = [`GET ${target} HTTP/1.1`];
  const skipRx = /^connection$|^upgrade$/i;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    if (skipRx.test(k)) continue;
    lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
  }
  if (!req.headers.host) lines.push(`Host: 127.0.0.1:${FRONT_PORT}`);
  lines.push('Connection: Upgrade');
  lines.push(`Upgrade: ${req.headers.upgrade || 'websocket'}`);

  const upstream = net.connect(V2_PORT, '127.0.0.1', () => {
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  const kill = () => {
    try { clientSocket.destroy(); } catch (e) {}
    try { upstream.destroy(); } catch (e) {}
  };
  upstream.on('error', kill);
  clientSocket.on('error', kill);
  upstream.on('close', () => { try { clientSocket.destroy(); } catch (e) {} });
  clientSocket.on('close', () => { try { upstream.destroy(); } catch (e) {} });
});

/* ------------------------------------------------------------------ */
/* Child                                                               */
/* ------------------------------------------------------------------ */

function startChild(tag, cwd, port) {
  /* on hosts with a mounted volume (ASTRA_DATA_DIR set), the child keeps
   * its stores in its own subfolder so they survive redeploys */
  const env = Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' });
  if (process.env.ASTRA_DATA_DIR) {
    const childData = path.join(process.env.ASTRA_DATA_DIR, tag);
    try { fs.mkdirSync(childData, { recursive: true }); } catch (e) {}
    env.ASTRA_DATA_DIR = childData;
  }
  const child = spawn(process.execPath, ['--max-http-header-size=131072', 'server.js'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const pipe = (stream, out) => stream.on('data', (d) => {
    const lines = String(d).split('\n').filter(Boolean);
    for (const l of lines) out.write(`[${tag}] ${l}\n`);
  });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, sig) => console.log(`[${tag}] exited code=${code} sig=${sig}`));
  return child;
}

let v2Child = null;

function shutdown() {
  try { if (v2Child) v2Child.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

v2Child = startChild('v2', path.join(ROOT, 'v2'), V2_PORT);

server.listen(FRONT_PORT, HOST, () => {
  console.log(`astra front router on http://${HOST}:${FRONT_PORT} (landing /, v2 :${V2_PORT})`);
});
