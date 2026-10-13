import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pack } from './archive.mjs';

export function runTaskProcess({
  task,
  config,
  directory,
  runId,
  progress,
  signal,
  processFile = new URL('./task-process.mjs', import.meta.url),
}) {
  return new Promise((resolve) => {
    const child = fork(processFile, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env,
      execArgv: [],
    });
    let result;
    let expired = false;
    const kill = () => {
      expired = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    const timer = setTimeout(kill, task.request.limits.timeoutSeconds * 1000);
    child.on('message', (message) => {
      if (message.type === 'progress') progress(message.progress);
      if (message.type === 'result') result = message;
    });
    child.once('error', () => {
      result = {
        error: { code: 'WORKER_START_FAILED', message: '无法启动任务进程' },
      };
    });
    child.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(
        expired
          ? {
              error: {
                code: 'TASK_TIMEOUT',
                message: '任务超过时间上限或服务关闭，探索进程已终止',
              },
            }
          : (result ?? {
              error: { code: 'WORKER_EXITED', message: '探索进程异常结束' },
            }),
      );
    });
    child.send({
      task,
      config: { ...config, apiToken: undefined },
      directory,
      runId,
    });
  });
}

export class Worker {
  constructor({
    store,
    storage,
    config,
    execute = runTaskProcess,
    archive = pack,
  }) {
    Object.assign(this, { store, storage, config, execute, archive });
    this.active = null;
    this.stopping = false;
    this.controller = new AbortController();
  }
  wake() {
    if (this.active || this.stopping) return;
    this.active = this.drain().finally(() => {
      this.active = null;
    });
  }
  async drain() {
    while (!this.stopping) {
      const task = this.store.next();
      if (!task) return;
      const runId = randomUUID();
      const base = path.join(this.config.dataDir, 'tasks', task.taskId);
      const directory = path.join(base, runId);
      let outcome;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        this.store.update(task.taskId, {
          status: 'running',
          progress: { runId },
        });
        outcome = await this.execute({
          task,
          config: this.config,
          directory,
          runId,
          signal: this.controller.signal,
          progress: (progress) =>
            this.store.update(task.taskId, {
              progress: { runId, ...progress },
            }),
        });
        this.store.update(task.taskId, { status: 'packaging' });
        const manifest = {
          schemaVersion: 1,
          taskId: task.taskId,
          runId,
          corpno: task.request.corpno,
          completedAt: new Date().toISOString(),
          exploration: outcome.result ?? null,
          capture: outcome.capture ?? null,
          error: outcome.error ?? null,
          limitations: [
            '仅采集可调试 WebView 中可观察的数据',
            '初始网络请求可能早于监听安装',
            '不采集请求/响应正文及认证头',
            'JSBridge 仅为可包装入口的元数据，不代表完整双向覆盖',
            'DOM、截图和 Midscene 报告可能包含个人信息，压缩包必须存储于私有 bucket',
            '单机、单设备协调器；中断探索不自动重放',
          ],
        };
        await writeFile(
          path.join(directory, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
        );
        await writeFile(
          path.join(directory, 'README.md'),
          `# WebView collection\n\nTask: ${task.taskId}\nRun: ${runId}\n\nStart with manifest.json, timeline.jsonl and snapshots/. Midscene replay reports are under midscene/report/.\n\n${manifest.limitations.map((s) => `- ${s}`).join('\n')}\n`,
        );
        const file = path.join(base, `${runId}.zip`);
        const digest = await this.archive(directory, file);
        this.store.update(task.taskId, { status: 'uploading' });
        const key = `${this.config.s3.keyPrefix}/${task.taskId}/${runId}.zip`;
        const uploadSignal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(120000),
        ]);
        const artifact = await this.storage.upload(
          file,
          key,
          digest,
          uploadSignal,
        );
        this.store.update(task.taskId, {
          status: outcome.error ? 'failed' : 'succeeded',
          artifact,
          error: outcome.error ?? null,
        });
      } catch (e) {
        this.store.update(task.taskId, {
          status: 'failed',
          error: {
            code: outcome
              ? 'ARCHIVE_OR_UPLOAD_FAILED'
              : (e.code ?? 'WORKER_FAILED'),
            message: outcome
              ? '归档或上传失败；本地证据仍保留'
              : '任务执行失败',
            explorationError: outcome?.error ?? null,
          },
        });
      }
    }
  }
  async stop() {
    this.stopping = true;
    this.controller.abort();
    await this.active;
  }
}
