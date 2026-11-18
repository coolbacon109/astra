#!/usr/bin/env node
/*
 * Astra front router.
 *
 * Chooser landing at "/", V1 under "/v1/", V2 owns everything else.
 * V1 (server.js here) and V2 (v2/server.js) run as child processes on
 * internal ports and are never modified - all /v1 prefixing happens here
 * while responses fly through.
 *
 *   /            landing (index.html)
 *   /v1, /v1/    V1 app (v1.html, paths rewritten to /v1/*)
 *   /v1/sw.js    V1 unified service worker, rewritten for /v1 scope
 *   /v2, /v2r..  V2 (deep link chips map to V2 routes)
 *   everything else -> V2
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
const V1_PORT = Number(process.env.V1_PORT || 6740);
const V2_PORT = Number(process.env.V2_PORT || 6742);
const LANDING_FILE = path.join(ROOT, 'index.html');

/* ------------------------------------------------------------------ */
/* V1 body transform                                                   */
/* ------------------------------------------------------------------ */

/* Path literals that belong to V1 and must live under /v1 when the
 * browser asks for them through the front router. Boundary anchored so
 * remote URLs like https://site/api/x are never touched, and so escaped
 * regex literals like /\/scramjet\// are never touched either. */
const V1_PATH_RX = /(^|[^\w/.\\:-])\/(api|uv|scramjet|scram|baremux|wisp|assets|clever-cloak|3to1s93ve|proxy|epoxy|libcurl)\b(?![-\w])/gm;

function v1PrefixPaths(code) {
  return code.replace(V1_PATH_RX, (m, pre, word) => `${pre}/v1/${word}`);
}

/* In-app jumps to root paths must stay inside the V1 space. */
function v1LocationFixes(code) {
  let out = code;
  out = out.replace(/(location\.replace\(\s*(['"]))\/(?!v1\b|\/)/g, '$1/v1/');
  out = out.replace(/(location\.assign\(\s*(['"]))\/(?!v1\b|\/)/g, '$1/v1/');
  out = out.replace(/(location\.href\s*=\s*(['"]))\/(?!v1\b|\/)/g, '$1/v1/');
  return out;
}

function v1TransformFull(code) {
  let out = v1PrefixPaths(code);
  /* service worker registration: script + scope both move under /v1 */
  out = out.replace(
    /(serviceWorker\.register\(\s*)(['"])\/(?:v1\/)?(sw|astra-sw)\.js\2/g,
    (m, a, q, w) => `${a}${q}/v1/${w}.js${q}`
  );
  out = out.replace(
    /(serviceWorker\.register\(\s*['"]\/v1\/(?:sw|astra-sw)\.js['"]\s*,\s*\{\s*scope:\s*)(['"])\/\2/g,
    (m, a, q) => `${a}${q}/v1/${q}`
  );
  out = v1LocationFixes(out);
  return out;
}

function v1TransformLite(code) {
  return v1PrefixPaths(code);
}

function isTransformablePath(p) {
  if (p === '/v1.html' || p === '/sw.js' || p === '/astra-sw.js') return true;
  if (p.startsWith('/robloxcookie')) return true;
  if (
    p.startsWith('/uv/') ||
    p.startsWith('/scram/') ||
    p.startsWith('/baremux/') ||
    p.startsWith('/3to1s93ve/') ||
    p.startsWith('/epoxy/') ||
    p.startsWith('/libcurl')
  ) return true;
  return false;
}

function needsFullTransform(p) {
  return p === '/v1.html' || p.startsWith('/robloxcookie') || p.startsWith('/3to1s93ve/');
}

const transformCache = new Map(); /* key -> { at, out } */
const TRANSFORM_TTL = 30000;

function transformFor(key, full, original) {
  const hit = transformCache.get(key);
  if (hit && Date.now() - hit.at < TRANSFORM_TTL) return hit.out;
  const out = full ? v1TransformFull(original) : v1TransformLite(original);
  transformCache.set(key, { at: Date.now(), out });
  if (transformCache.size > 40) {
    transformCache.delete(transformCache.keys().next().value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cookie separation: both apps answer as "astra_session", so on this  */
/* shared origin the front router renames them per side.               */
/* ------------------------------------------------------------------ */

function rewriteCookieHeader(raw, side) {
  if (!raw) return raw;
  const keep = side === 'v1' ? 'astra_v1_session' : 'astra_v2_session';
  const drop = side === 'v1' ? 'astra_v2_session' : 'astra_v1_session';
  const parts = String(raw).split(';').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq).trim();
    if (name === drop) continue;
    if (name === keep) { out.push(`astra_session=${part.slice(eq + 1)}`); continue; }
    out.push(part);
  }
  return out.join('; ');
}

function rewriteSetCookies(headers, side) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  const rename = side === 'v1' ? 'astra_v1_session=' : 'astra_v2_session=';
  const fix = (s) => String(s).replace(/^astra_session=/, rename);
  headers['set-cookie'] = Array.isArray(sc) ? sc.map(fix) : fix(sc);
}

/* ------------------------------------------------------------------ */
/* Proxying                                                            */
/* ------------------------------------------------------------------ */

function sendSimple(res, code, msg) {
  if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

function proxyTo(port, req, res, targetPath, opts) {
  opts = opts || {};
  const side = port === V1_PORT ? 'v1' : 'v2';
  const headers = Object.assign({}, req.headers);
  delete headers['accept-encoding'];
  if (headers.cookie) headers.cookie = rewriteCookieHeader(headers.cookie, side);

  const upstreamReq = http.request(
    { host: '127.0.0.1', port, method: req.method, path: targetPath, headers },
    (up) => {
      const h = Object.assign({}, up.headers);
      rewriteSetCookies(h, side);
      if (
        side === 'v1' &&
        typeof h.location === 'string' &&
        h.location.startsWith('/') &&
        !/^\/v[12](\/|\?|$)/.test(h.location)
      ) {
        h.location = `/v1${h.location}`;
      }
      const ct = String(h['content-type'] || '');

      if (opts.transform && up.statusCode === 200 && isTransformableCT(ct)) {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        up.on('data', (c) => {
          size += c.length;
          if (size > 12e6) { tooBig = true; try { up.destroy(); } catch {} }
          else chunks.push(c);
        });
        up.on('end', () => {
          if (tooBig) return sendSimple(res, 502, 'upstream body too large');
          let original;
          try { original = Buffer.concat(chunks).toString('utf8'); } catch (e) {
            return sendSimple(res, 502, 'unreadable upstream body');
          }
          const out = transformFor(opts.cacheKey || targetPath.split('?')[0], !!opts.full, original);
          const buf = Buffer.from(out, 'utf8');
          h['content-length'] = String(buf.length);
          delete h['content-encoding'];
          delete h['transfer-encoding'];
          h['x-astra-front'] = 'v1';
          res.writeHead(up.statusCode, h);
          res.end(buf);
        });
        up.on('error', () => { try { res.destroy(); } catch {} });
        return;
      }

      delete h['transfer-encoding'];
      res.writeHead(up.statusCode, h);
      up.pipe(res);
    }
  );

  upstreamReq.on('error', (e) => {
    sendSimple(res, 502, `Astra ${side} is starting up (${String((e && e.message) || e)})`);
  });
  req.pipe(upstreamReq);
}

function isTransformableCT(ct) {
  return /^(text\/html|application\/javascript|text\/javascript|application\/x-javascript)\b/i.test(ct || '');
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

  /* landing */
  if (p === '/' || p === '/index.html') {
    return fs.readFile(LANDING_FILE, (e, buf) => {
      if (e) return sendSimple(res, 500, 'landing page missing');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    });
  }

  /* V2 deep links from the landing chips */
  if (/^\/v2[a-z0-9]*$/i.test(p)) {
    const key = p.slice(3).toLowerCase();
    const v2map = {
      '': '/', h: '/', a: '/ai', b: '/b', g: '/g', c: '/chat',
      an: '/a', mu: '/music', mv: '/m', r: '/roblox', s: '/s',
      ad: '/admin', admin: '/admin'
    };
    const target = Object.prototype.hasOwnProperty.call(v2map, key) ? v2map[key] : '/';
    return proxyTo(V2_PORT, req, res, target + search);
  }

  /* V1 entry */
  if (p === '/v1' || p === '/v1.html') {
    res.writeHead(302, { Location: `/v1/${search}` });
    return res.end();
  }
  if (p === '/v1/') {
    return proxyTo(V1_PORT, req, res, `/v1.html${search}`, {
      transform: true, full: true, cacheKey: '/v1.html'
    });
  }
  if (p.startsWith('/v1/')) {
    const sp = p.slice(3);
    const full = needsFullTransform(sp);
    const tf = full || isTransformablePath(sp);
    return proxyTo(V1_PORT, req, res, sp + search, {
      transform: tf, full, cacheKey: sp.split('?')[0]
    });
  }

  /* bare V1 namespaces: links the V1 shim and launcher generate at
   * runtime keep working straight through */
  if (/^\/(scramjet\/|uv\/|scram\/|baremux\/|3to1s93ve\/|proxy(\?|$)|clever-cloak\/|epoxy\/|libcurl)/.test(p)) {
    return proxyTo(V1_PORT, req, res, p + search);
  }

  /* everything else belongs to V2 */
  return proxyTo(V2_PORT, req, res, p + search);
});

/* websocket piping (wisp relay) - strip /v1 when present, always to V1 */
server.on('upgrade', (req, clientSocket, head) => {
  let target = req.url || '/';
  if (target === '/v1' || target.startsWith('/v1/')) target = target.slice(3) || '/';
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

  const upstream = net.connect(V1_PORT, '127.0.0.1', () => {
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
/* Children                                                            */
/* ------------------------------------------------------------------ */

function startChild(tag, cwd, port) {
  const child = spawn(process.execPath, ['--max-http-header-size=131072', 'server.js'], {
    cwd,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }),
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

let v1Child = null;
let v2Child = null;

function shutdown() {
  try { if (v1Child) v1Child.kill(); } catch (e) {}
  try { if (v2Child) v2Child.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

v1Child = startChild('v1', ROOT, V1_PORT);
v2Child = startChild('v2', path.join(ROOT, 'v2'), V2_PORT);

server.listen(FRONT_PORT, HOST, () => {
  console.log(`astra front router on http://${HOST}:${FRONT_PORT} (landing /, v1 :${V1_PORT}, v2 :${V2_PORT})`);
});
