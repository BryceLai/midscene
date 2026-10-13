import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/store.mjs';

test('生产入口：实际启动服务并按 S3 配置签发已完成任务的下载 URL', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webview-bootstrap-'));
  const store = new TaskStore(path.join(dir, 'tasks.sqlite'));
  const task = store.create({ startUrl: 'https://movie.example/movie.html' });
  store.update(task.taskId, {
    status: 'succeeded',
    artifact: { key: 'tasks/run.zip', bytes: 10, sha256: 'fixture-digest' },
  });
  store.close();
  const token = 'fixture-token-at-least-24-characters';
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/main.mjs', import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        ENGINE_API_TOKEN: token,
        ENGINE_HOST: '127.0.0.1',
        ENGINE_PORT: '0',
        ENGINE_DATA_DIR: dir,
        ANDROID_SERIAL: 'fixture-not-used',
        S3_BUCKET: 'private-bootstrap',
        S3_ENDPOINT: 'http://127.0.0.1:28333',
        S3_FORCE_PATH_STYLE: 'true',
        S3_URL_TTL_SECONDS: '120',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'fixture-key',
        AWS_SECRET_ACCESS_KEY: 'fixture-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  child.stderr.resume();
  t.after(async () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 5000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(
        /WebView task API: (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error('服务提前退出'));
    });
  });
  const response = await fetch(`${base}/v1/tasks/${task.taskId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const url = new URL(result.result.downloadUrl);
  assert.equal(url.origin, 'http://127.0.0.1:28333');
  assert.equal(url.pathname, '/private-bootstrap/tasks/run.zip');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
});
