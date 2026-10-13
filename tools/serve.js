#!/usr/bin/env node
/* ==========================================================================
   ReceiptShield — local static server
   Dependency-free. The site is plain HTML/CSS/JS with no build step, but it
   must be served over http rather than opened from the filesystem so that the
   Tesseract web worker and the OCR model download behave normally.

   Usage:  npm start [-- --port 4177]
   ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');

// A PORT of "0" or "" in the environment means "not specified" here; falling
// through to it would silently bind a random port.
function resolvePort() {
  const candidates = [
    portArg !== -1 ? argv[portArg + 1] : null,
    process.env.PORT,
  ];
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue;
    const n = Number(c);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return 4177;
}

const PORT = resolvePort();
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  // WHATWG URL rather than the deprecated url.parse(): a malformed request
  // target throws here, which is exactly the 400 case.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://' + HOST).pathname);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — not found: ' + pathname);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('ReceiptShield running at http://' + HOST + ':' + PORT + '/');
  console.log('Serving ' + ROOT);
});
