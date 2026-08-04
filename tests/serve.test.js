import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const PORT = 8899;
const SERVER_PATH = path.resolve('start.sh');

function startServer() {
  return new Promise((resolve, reject) => {
    const serverProc = spawn(SERVER_PATH, [String(PORT)], {
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
