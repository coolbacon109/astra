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
const V2_RETRY_MS = 250;
const V2_RETRIES = 40;
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

/* Shown only if the app really is not up after the retries. It keeps the Clever
 * tab and reloads itself, so a visitor sees a page loading rather than an error. */
function sendStartingPage(res) {
  if (res.headersSent) return res.end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end([
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Clever</title>',
    '<link rel="icon" href="/clever-cloak/Clever_files/favicon-32.png">',
    '<meta http-equiv="refresh" content="3">',
    '<style>html,body{height:100%;margin:0;background:#0b0b10;color:#e7e7ee;',
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;",
    'align-items:center;justify-content:center}.c{width:min(360px,84vw);text-align:center}',
    '.b{height:3px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:14px}',
    '.b i{display:block;height:100%;width:40%;border-radius:99px;background:#8ea0ff;',
    'animation:s 1.1s ease-in-out infinite}@keyframes s{0%{transform:translateX(-60%)}',
    '100%{transform:translateX(260%)}}p{color:#9a9aa8;font-size:13px;margin:10px 0 0}</style>',
    '</head><body><div class="c"><div>Astra is starting</div>',
    '<p>This page reloads itself in a second.</p><div class="b"><i></i></div></div></body></html>'
  ].join(''));
}

function proxyTo(req, res, targetPath, attempt = 0) {
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
  upstreamReq.on('error', () => {
    if (res.writableEnded) return;
    /* The app is a child process. While it is booting, or right after a restart,
     * a request can arrive before it is listening. Wait for it instead of
     * answering with an error page. */
    const retryable = req.method === 'GET' || req.method === 'HEAD';
    if (retryable && attempt < V2_RETRIES) {
      ensureV2();
      setTimeout(() => proxyTo(req, res, targetPath, attempt + 1), V2_RETRY_MS);
      return;
    }
    if (targetPath.startsWith('/api/')) {
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'Astra is starting, try again in a moment.' }));
    }
    sendStartingPage(res);
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
  if (p === '/clever-cloak/Clever.html') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
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

let v2Child = null;
let v2Restarts = 0;
let shuttingDown = false;

/* The app binds every interface, so it is reachable the same way whether it
 * runs here, in a container, or on a machine someone else connects to. */
function startChild(tag, cwd, port) {
  /* on hosts with a mounted volume (ASTRA_DATA_DIR set), the child keeps
   * its stores in its own subfolder so they survive redeploys */
  const env = Object.assign({}, process.env, { PORT: String(port), HOST: '0.0.0.0' });
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

/* Start the app if it is not running, and bring it back if it stops. The front
 * router keeps serving the page and its assets the whole time, so the site never
 * falls back to a bare error while the app comes back up. */
function ensureV2() {
  if (v2Child || shuttingDown) return v2Child;
  const startedAt = Date.now();
  const child = startChild('v2', path.join(ROOT, 'v2'), V2_PORT);
  v2Child = child;
  child.on('exit', (code, sig) => {
    if (v2Child === child) v2Child = null;
    if (shuttingDown) return;
    /* a child that stayed up for a while is not crash looping; start the
     * backoff from the beginning again */
    if (Date.now() - startedAt > 30000) v2Restarts = 0;
    const delay = Math.round(Math.min(10000, 400 * Math.pow(1.7, v2Restarts++)));
    console.log(`[v2] restarting in ${delay}ms (exit code=${code} sig=${sig})`);
    setTimeout(ensureV2, delay);
  });
  return child;
}

function shutdown() {
  shuttingDown = true;
  try { if (v2Child) v2Child.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

ensureV2();

server.listen(FRONT_PORT, HOST, () => {
  console.log(`astra front router on http://${HOST}:${FRONT_PORT} (landing /, v2 :${V2_PORT})`);
});
