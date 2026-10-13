import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { S3Storage } from '../src/storage.mjs';

test('S3 SDK：真实 HTTP PUT、元数据和临时 GET URL（协议 fixture，不是真实 bucket）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'webview-s3-'));
  let uploaded;
  let headers;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    uploaded = Buffer.concat(chunks);
    headers = req.headers;
    res.writeHead(200, { etag: '"fixture-etag"' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Use a dedicated test client; never consume deployment credentials.
  const storage = new S3Storage({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    bucket: 'private-fixture',
    region: 'us-east-1',
    forcePathStyle: true,
    urlTtlSeconds: 900,
    credentials: {
      accessKeyId: 'fixture-key',
      secretAccessKey: 'fixture-secret',
    },
  });
  t.after(async () => {
    storage.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'collection.zip');
  await writeFile(file, 'PK-fixture');
  const artifact = await storage.upload(file, 'tasks/job/run.zip', {
    bytes: 10,
    sha256: 'fixture-sha256',
  });
  assert.equal(artifact.key, 'tasks/job/run.zip');
  assert.ok(uploaded.includes(Buffer.from('PK-fixture')));
  assert.equal(headers['x-amz-meta-sha256'], 'fixture-sha256');
  const result = await storage.download(artifact.key);
  const url = new URL(result.downloadUrl);
  assert.equal(url.pathname, '/private-fixture/tasks/job/run.zip');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
});
