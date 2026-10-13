import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApi } from '../src/api.mjs';
import { TaskStore } from '../src/store.mjs';

const config = {
  apiToken: 'test-token-with-at-least-24-characters',
  entryHosts: ['cmbls', 'example.test'],
  webviewHosts: ['example.test'],
};
const request = {
  startUrl:
    'https://cmbls/functionjump?action=gocorpno&corpno=001003&cmb_app_trans_parms_start=here',
};

test('任务 API：认证、原生入口、幂等、状态查询、上传完成后签发下载地址', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webview-api-'));
  const store = new TaskStore(path.join(dir, 'tasks.sqlite'));
  let signed = 0;
  const server = createApi({
    config,
    store,
    storage: {
      async download(key) {
        signed++;
        return {
          downloadUrl: `https://storage.test/${key}?signature=${signed}`,
          expiresAt: new Date().toISOString(),
        };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, key = 'job-001') =>
    fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(`${base}/v1/tasks`)).status, 401);
  const created = await post(request);
  assert.equal(created.status, 202);
  const task = await created.json();
  assert.equal(task.status, 'queued');
  assert.equal((await (await post(request)).json()).taskId, task.taskId);
  assert.equal(
    (await post({ ...request, objective: 'different' })).status,
    409,
  );
  assert.equal(
    (await post({ startUrl: 'https://evil.test' }, 'invalid-url')).status,
    400,
  );
  assert.equal(
    (await post({ ...request, limits: { maxSteps: 101 } }, 'invalid-limit'))
      .status,
    400,
  );
  assert.equal(
    (
      await post(
        { startUrl: request.startUrl.replace('001003', 'bad') },
        'invalid-route',
      )
    ).status,
    400,
  );
  const query = () =>
    fetch(`${base}/v1/tasks/${task.taskId}`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
  const queued = await (await query()).json();
  assert.equal(queued.result, null);
  assert.equal(queued.corpno, '001003');
  assert.equal(signed, 0);
  store.update(task.taskId, {
    status: 'succeeded',
    artifact: { key: 'tasks/collection.zip', bytes: 100, sha256: 'digest' },
  });
  const done = await (await query()).json();
  assert.equal(done.status, 'succeeded');
  assert.match(done.result.downloadUrl, /signature=1$/);
  assert.match(
    (await (await query()).json()).result.downloadUrl,
    /signature=2$/,
  );
});

test('SQLite：重启恢复排队任务，中断任务明确失败，单机协调器排他', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webview-store-'));
  const file = path.join(dir, 'tasks.sqlite');
  const first = new TaskStore(file);
  const queued = first.create(request);
  const running = first.create(request);
  first.update(running.taskId, { status: 'running' });
  first.close();
  const store = new TaskStore(file);
  t.after(async () => {
    store.release();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  store.acquire();
  assert.throws(() => store.acquire(), /已有运行中的/);
  store.recover();
  assert.equal(store.get(queued.taskId).status, 'queued');
  assert.equal(store.get(running.taskId).error.code, 'WORKER_INTERRUPTED');
});
