import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTaskProcess } from '../src/worker.mjs';

test('任务超时会终止整个探索子进程，不留下后台操作', async () => {
  let pid;
  const result = await runTaskProcess({
    task: { request: { limits: { timeoutSeconds: 1 } } },
    config: {},
    directory: '',
    runId: 'fixture',
    progress: (p) => {
      pid = p.pid;
    },
    processFile: new URL('./fixtures/hanging-process.mjs', import.meta.url),
  });
  assert.equal(result.error.code, 'TASK_TIMEOUT');
  assert.ok(pid);
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === 'ESRCH',
  );
});
