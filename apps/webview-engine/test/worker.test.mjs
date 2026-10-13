import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TaskStore } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';

test('任务执行：设备任务串行，ZIP 上传完成后才成功，失败也可归档部分证据', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webview-worker-'));
  const store = new TaskStore(path.join(dir, 'tasks.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = { corpno: '001003', limits: { timeoutSeconds: 10 } };
  const one = store.create(request);
  const two = store.create(request);
  let concurrent = 0;
  let maximum = 0;
  let executions = 0;
  const storage = {
    async upload(file, key, digest) {
      assert.equal(store.get(key.split('/')[1]).status, 'uploading');
      assert.ok(
        (await readFile(file)).subarray(0, 2).equals(Buffer.from('PK')),
      );
      return { key, ...digest };
    },
  };
  const worker = new Worker({
    store,
    storage,
    config: { dataDir: dir, s3: { keyPrefix: 'tasks' } },
    async execute({ directory }) {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      executions++;
      await writeFile(
        path.join(directory, 'timeline.jsonl'),
        '{"type":"fixture-evidence"}\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrent--;
      return executions === 1
        ? { result: { pagesVisited: 1 } }
        : { error: { code: 'MODEL_FAILED', message: 'fixture failure' } };
    },
  });
  worker.wake();
  await worker.active;
  assert.equal(maximum, 1);
  const done = store.get(one.taskId);
  const failed = store.get(two.taskId);
  // Equal timestamps can choose UUID order; assess actual outcomes rather than creation order.
  assert.deepEqual([done.status, failed.status].sort(), [
    'failed',
    'succeeded',
  ]);
  assert.ok(done.artifact.sha256);
  assert.ok(failed.artifact.sha256);
});

test('上传失败时不发布成功状态或伪造下载地址', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webview-upload-'));
  const store = new TaskStore(path.join(dir, 'tasks.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const task = store.create({ limits: { timeoutSeconds: 10 } });
  const worker = new Worker({
    config: { dataDir: dir, s3: { keyPrefix: 'tasks' } },
    store,
    storage: {
      async upload() {
        throw new Error('S3 unavailable');
      },
    },
    async execute() {
      return { result: {} };
    },
  });
  worker.wake();
  await worker.active;
  assert.equal(store.get(task.taskId).status, 'failed');
  assert.equal(store.get(task.taskId).artifact, null);
  assert.equal(store.get(task.taskId).error.code, 'ARCHIVE_OR_UPLOAD_FAILED');
});
