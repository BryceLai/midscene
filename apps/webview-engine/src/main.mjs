import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createApi } from './api.mjs';
import { loadConfig } from './config.mjs';
import { S3Storage } from './storage.mjs';
import { TaskStore } from './store.mjs';
import { Worker } from './worker.mjs';

process.umask(0o077);
const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const store = new TaskStore(path.join(config.dataDir, 'tasks.sqlite'));
store.acquire();
store.recover();
const storage = new S3Storage(config);
const worker = new Worker({ config, store, storage });
const server = createApi({ config, store, storage, wake: () => worker.wake() });
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => {
  console.log(
    `WebView task API: http://${config.host}:${server.address().port}`,
  );
  worker.wake();
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  const stopped = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  await worker.stop();
  await stopped;
  storage.close();
  store.release();
  store.close();
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
