import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Each server gets a free port (a fixed one races with the previous test's
// server still shutting down), and the tests read PORT after startServer().
let PORT = 0;
const SERVER_PATH = path.resolve('start.sh');
const READY_TIMEOUT_MS = 10000; // a cold Ruby start on a busy machine can take a few seconds

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Start start.sh and resolve once it says it is listening; reject if it exits or never does. */
async function startServer(root) {
  PORT = await freePort();
  return new Promise((resolve, reject) => {
    const serverProc = spawn(SERVER_PATH, root ? [String(PORT), root] : [String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      serverProc.kill('SIGKILL');
      reject(new Error(`start.sh did not start within ${READY_TIMEOUT_MS}ms. stderr: ${stderr}`));
    }, READY_TIMEOUT_MS);
    serverProc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(`http://localhost:${PORT}`)) {
        clearTimeout(timer);
        resolve(serverProc);
      }
    });
    serverProc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    serverProc.on('error', (err) => { clearTimeout(timer); reject(err); });
    serverProc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`start.sh exited (${code}) before it was ready. stderr: ${stderr}`));
    });
  });
}

/** Stop the server and wait until it has exited. */
function stopServer(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}

test('start.sh serves static files with correct MIME types and headers', async () => {
  const proc = await startServer();
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/docs/theme.css`, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => resolve({ response, body }));
      }).on('error', reject);
    });

    assert.strictEqual(res.response.statusCode, 200);
    assert.strictEqual(res.response.headers['content-type'], 'text/css; charset=utf-8');
    assert.strictEqual(res.response.headers['connection'], 'close');
  } finally {
    await stopServer(proc);
  }
});

test('start.sh blocks path traversal attempts', async () => {
  const proc = await startServer();
  try {
    const res = await new Promise((resolve, reject) => {
      const socket = net.connect(PORT, '127.0.0.1', () => {
        socket.write("GET /../start.sh HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      });
      let responseData = '';
      socket.on('data', chunk => responseData += chunk.toString());
      socket.on('end', () => resolve(responseData));
      socket.on('error', reject);
    });

    assert.match(res, /^HTTP\/1\.1 404 Not Found/);
  } finally {
    await stopServer(proc);
  }
});

function rawRequest(text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', chunk => data += chunk.toString());
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}
const get = (target, host = `127.0.0.1:${PORT}`) => rawRequest(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);

test('start.sh does not serve .git or other dotfiles', async () => {
  const proc = await startServer();
  try {
    for (const target of ['/.git/HEAD', '/.gitignore', '/%2egit/HEAD', '/docs/../.git/config']) {
      assert.match(await get(target), /^HTTP\/1\.1 404 Not Found/, target);
    }
    assert.match(await get('/index.html'), /^HTTP\/1\.1 200 OK/);
  } finally {
    await stopServer(proc);
  }
});

test('start.sh only answers requests addressed to localhost (DNS rebinding)', async () => {
  const proc = await startServer();
  try {
    assert.match(await get('/index.html', 'evil.example'), /^HTTP\/1\.1 403 Forbidden/);
    assert.match(await get('/index.html', `evil.example:${PORT}`), /^HTTP\/1\.1 403 Forbidden/);
    assert.match(await rawRequest('GET /index.html HTTP/1.0\r\n\r\n'), /^HTTP\/1\.1 403 Forbidden/, 'no Host header');
    for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, 'localhost']) {
      assert.match(await get('/index.html', host), /^HTTP\/1\.1 200 OK/, host);
    }
  } finally {
    await stopServer(proc);
  }
});

test('start.sh keeps + in paths literal (only form data uses + for space)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uis-serve-'));
  fs.writeFileSync(path.join(root, 'a+b.txt'), 'plus');
  fs.writeFileSync(path.join(root, 'a b.txt'), 'space');
  const proc = await startServer(root);
  try {
    assert.match(await get('/a+b.txt'), /\r\n\r\nplus$/);
    assert.match(await get('/a%2Bb.txt'), /\r\n\r\nplus$/);
    assert.match(await get('/a%20b.txt'), /\r\n\r\nspace$/);
  } finally {
    await stopServer(proc);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start.sh sends no body for HEAD, including on errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uis-serve-'));
  fs.writeFileSync(path.join(root, 'ok.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'locked.txt'), 'secret');
  fs.chmodSync(path.join(root, 'locked.txt'), 0o000); // reading it fails -> 500
  const proc = await startServer(root);
  const head = (target) => rawRequest(`HEAD ${target} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n\r\n`);
  const bodyOf = (res) => res.split('\r\n\r\n')[1];
  try {
    for (const [target, status] of [['/ok.txt', '200'], ['/missing.txt', '404'], ['/locked.txt', '500']]) {
      const res = await head(target);
      assert.match(res, new RegExp(`^HTTP/1\\.1 ${status} `), target);
      assert.strictEqual(bodyOf(res), '', `${target}: HEAD has no body`);
    }
    const post = await rawRequest(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nContent-Length: 0\r\n\r\n`);
    assert.match(post, /^HTTP\/1\.1 405 /);
    assert.strictEqual(bodyOf(post), '405 Method Not Allowed\n');
  } finally {
    await stopServer(proc);
    fs.chmodSync(path.join(root, 'locked.txt'), 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
