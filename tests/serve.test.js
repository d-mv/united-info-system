import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PORT = 8899;
const SERVER_PATH = path.resolve('start.sh');

function startServer(root) {
  return new Promise((resolve, reject) => {
    const serverProc = spawn(SERVER_PATH, root ? [String(PORT), root] : [String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    serverProc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(`http://localhost:${PORT}`)) {
        resolve(serverProc);
      }
    });

    serverProc.stderr.on('data', (err) => {
      console.error('Server err:', err.toString());
    });

    serverProc.on('error', reject);

    setTimeout(() => {
      resolve(serverProc);
    }, 1500);
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
    proc.kill('SIGTERM');
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
    proc.kill('SIGTERM');
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
    proc.kill('SIGTERM');
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
    proc.kill('SIGTERM');
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
    proc.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
