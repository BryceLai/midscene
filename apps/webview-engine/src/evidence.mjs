import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const secretKey =
  /authorization|cookie|token|password|passwd|secret|api.?key|mobile|phone|idcard|account|session/i;
export function safeUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()])
      url.searchParams.set(key, '[REDACTED]');
    if (url.hash) url.hash = '[REDACTED]';
    return url.href;
  } catch {
    return '[INVALID_URL]';
  }
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k) ? '[REDACTED]' : redact(v),
      ]),
    );
  if (typeof value === 'string') {
    return value
      .replace(/https?:\/\/[^\s"<>]+/g, safeUrl)
      .replace(/\b(?:sk|ghp|gho)-[\w.-]+\b/g, '[REDACTED]');
  }
  return value;
}

export class EvidenceWriter {
  constructor(file, taskId, runId) {
    this.file = file;
    this.taskId = taskId;
    this.runId = runId;
    this.actionId = null;
    this.count = 0;
  }
  emit(type, data = {}, actionId = this.actionId) {
    if (++this.count > 100000) throw new Error('证据事件超过 100000 条上限');
    appendFileSync(
      this.file,
      `${JSON.stringify({ ...redact(data), eventId: randomUUID(), taskId: this.taskId, runId: this.runId, actionId, type, collectedAt: new Date().toISOString() })}\n`,
    );
  }
}

export class NetworkCollector {
  constructor(writer) {
    this.writer = writer;
    this.contexts = new Set();
    this.requests = new WeakMap();
    this.off = [];
    this.counts = { requests: 0, responses: 0, failures: 0 };
  }
  attach(context) {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    const listen = (event, fn) => {
      context.on(event, fn);
      this.off.push(() => context.off(event, fn));
    };
    this.writer.emit('coverage', {
      source: 'webview-network',
      initialRequestsMayBeMissing: true,
      responseBodies: 'not-collected',
      nativeNetwork: 'not-observable',
    });
    listen('request', (request) => {
      const meta = {
        id: randomUUID(),
        actionId: this.writer.actionId,
        start: Date.now(),
      };
      this.requests.set(request, meta);
      this.counts.requests++;
      this.writer.emit(
        'request',
        {
          requestId: meta.id,
          url: safeUrl(request.url()),
          method: request.method(),
          resourceType: request.resourceType(),
        },
        meta.actionId,
      );
    });
    listen('response', (response) => {
      const meta = this.requests.get(response.request());
      this.counts.responses++;
      this.writer.emit(
        'response',
        {
          requestId: meta?.id ?? null,
          url: safeUrl(response.url()),
          status: response.status(),
          elapsedMs: meta ? Date.now() - meta.start : null,
        },
        meta?.actionId ?? null,
      );
    });
    listen('requestfailed', (request) => {
      const meta = this.requests.get(request);
      this.counts.failures++;
      this.writer.emit(
        'request-failed',
        {
          requestId: meta?.id ?? null,
          url: safeUrl(request.url()),
          failure: request.failure(),
        },
        meta?.actionId ?? null,
      );
    });
  }
  stop() {
    for (const off of this.off) off();
    this.off = [];
    return this.counts;
  }
}
