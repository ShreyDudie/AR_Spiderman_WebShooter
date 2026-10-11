// Lightweight static server for Spider-Man AR
// Phones only allow camera access on HTTPS (or localhost), so this serves HTTPS automatically
// when key.pem + cert.pem exist next to this file (or SSL_KEY / SSL_CERT env vars are set).
//
// Make a self-signed pair (or use mkcert for a trusted one):
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=spidey-ar"
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
 
const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const KEY_PATH = process.env.SSL_KEY || path.join(ROOT, 'key.pem');
const CERT_PATH = process.env.SSL_CERT || path.join(ROOT, 'cert.pem');
 
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.tflite': 'application/octet-stream',
  '.task': 'application/octet-stream',
};
 
// Never serve secrets or server internals
const BLOCKED_EXT = new Set(['.pem', '.key', '.crt', '.env']);
 
function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
 
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }
 
  let reqPath;
  try {
    reqPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
 
  const filePath = path.normalize(path.join(ROOT, reqPath));
  const rel = path.relative(ROOT, filePath);
  const inRoot = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const hidden = rel.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules');
  const ext = path.extname(filePath).toLowerCase();
 
  if (!inRoot || hidden || BLOCKED_EXT.has(ext) || rel === 'server.js') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
 
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
 
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    });
 
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
 
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}
 
let server;
let secure = false;
try {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    server = https.createServer({ key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) }, handler);
    secure = true;
  }
} catch (e) {
  console.warn('[SPIDEY AR SERVER] Could not load HTTPS certificate, falling back to HTTP:', e.message);
}
if (!server) server = http.createServer(handler);
 
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
 
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=${PORT + 1} node server.js`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
 
server.listen(PORT, '0.0.0.0', () => {
  const proto = secure ? 'https' : 'http';
  console.log('[SPIDEY AR SERVER] Running on:');
  console.log(` - Localhost:      ${proto}://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(` - Local Network:  ${proto}://${ip}:${PORT}`);
  if (!secure) {
    console.log('\n[!] Serving plain HTTP: phones will BLOCK the camera on the Local Network URL.');
    console.log('    Add key.pem + cert.pem next to server.js to enable HTTPS (see top of this file).');
  }
});