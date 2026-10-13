import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { EngineError, validateTask } from './domain.mjs';

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        chunks.length = 0;
        reject(new EngineError('BODY_TOO_LARGE', '请求体不得超过 64 KiB', 413));
      } else chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (bytes > 65536) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new EngineError('INVALID_JSON', '请求体必须为有效 JSON', 400));
      }
    });
  });
}

export function createApi({ config, store, storage, wake = () => {} }) {
  const send = (response, status, data, headers = {}) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    response.end(JSON.stringify(data));
  };
  const expected = Buffer.from(`Bearer ${config.apiToken}`);
  return createServer(async (request, response) => {
    try {
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      )
        throw new EngineError('UNAUTHORIZED', '需要有效 Bearer Token', 401);
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'POST' && pathname === '/v1/tasks') {
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers['content-type'] ?? '',
          )
        )
          throw new EngineError(
            'UNSUPPORTED_MEDIA_TYPE',
            '请使用 application/json',
            415,
          );
        const key = request.headers['idempotency-key'] ?? null;
        if (
          key !== null &&
          (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key))
        )
          throw new EngineError(
            'INVALID_IDEMPOTENCY_KEY',
            'Idempotency-Key 必须为 1 到 128 个可见 ASCII 字符',
            400,
          );
        const task = store.create(
          validateTask(await readBody(request), config),
          key,
        );
        wake();
        return send(
          response,
          202,
          {
            taskId: task.taskId,
            status: task.status,
            statusUrl: `/v1/tasks/${task.taskId}`,
          },
          { location: `/v1/tasks/${task.taskId}` },
        );
      }
      const match = pathname.match(/^\/v1\/tasks\/([a-f0-9-]{36})$/);
      if (request.method === 'GET' && match) {
        const task = store.get(match[1]);
        if (!task) throw new EngineError('TASK_NOT_FOUND', '任务不存在', 404);
        const result = task.artifact
          ? { ...task.artifact, ...(await storage.download(task.artifact.key)) }
          : null;
        return send(response, 200, {
          taskId: task.taskId,
          status: task.status,
          corpno: task.request.corpno,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          progress: task.progress,
          result,
          error: task.error,
        });
      }
      throw new EngineError('NOT_FOUND', '接口不存在', 404);
    } catch (e) {
      send(response, e instanceof EngineError ? e.status : 500, {
        error: {
          code: e instanceof EngineError ? e.code : 'INTERNAL_ERROR',
          message: e instanceof EngineError ? e.message : '服务内部错误',
        },
      });
    }
  });
}
