import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const base =
  process.env.DEMO_API_URL ??
  `http://${process.env.ENGINE_HOST ?? '127.0.0.1'}:${process.env.ENGINE_PORT ?? '8080'}`;
const headers = {
  authorization: `Bearer ${process.env.ENGINE_API_TOKEN}`,
  'content-type': 'application/json',
};
const output = path.resolve(process.env.DEMO_OUTPUT_DIR ?? 'data/downloads');
await mkdir(output, { recursive: true, mode: 0o700 });
const startUrl =
  process.env.DEMO_START_URL ??
  'https://movie-cui.paas.cmbchina.com/movie.html?_urlrefer=menu&showtopbar=false&DeviceType=E&Version=14.4.5&SystemVersion=11&behavior_entryid=stp003008';
const submitted = await fetch(`${base}/v1/tasks`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    startUrl,
    objective:
      '浏览当前电影列表，向下滚动一次以采集更多可见内容，然后结束。只收集浏览信息。',
    limits: { maxSteps: 2, maxPages: 3, timeoutSeconds: 180 },
  }),
});
const created = await submitted.json();
if (!submitted.ok) throw new Error(JSON.stringify(created));
console.log(`Task created: ${created.taskId}`);
let previous;
const deadline = Date.now() + 360000;
while (Date.now() < deadline) {
  const response = await fetch(`${base}/v1/tasks/${created.taskId}`, {
    headers,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  if (result.status !== previous) {
    console.log(`Task status: ${result.status}`);
    previous = result.status;
  }
  if (['succeeded', 'failed'].includes(result.status)) {
    // Save status evidence without retaining the temporary signed query string.
    await writeFile(
      path.join(output, `${created.taskId}.json`),
      JSON.stringify(
        {
          ...result,
          result: result.result
            ? { ...result.result, downloadUrl: '[TEMPORARY_URL_OMITTED]' }
            : null,
        },
        null,
        2,
      ),
    );
    if (result.result) {
      const download = await fetch(result.result.downloadUrl);
      if (!download.ok) throw new Error(`下载失败：HTTP ${download.status}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== result.result.sha256)
        throw new Error('下载文件的 SHA-256 与任务结果不匹配');
      const file = path.join(output, `${created.taskId}.zip`);
      await writeFile(file, bytes, { mode: 0o600 });
      console.log(`Downloaded and checksum verified: ${file}`);
    }
    if (result.status === 'failed') {
      console.log(`Task error: ${JSON.stringify(result.error)}`);
      process.exitCode = 1;
    }
    break;
  }
  await delay(2000);
}
if (!['succeeded', 'failed'].includes(previous))
  throw new Error('等待任务结果超时；任务仍可通过查询 API 跟踪');
