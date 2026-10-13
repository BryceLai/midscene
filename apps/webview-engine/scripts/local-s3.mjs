import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';

process.umask(0o077);
const compose = [
  'compose',
  '--progress',
  'quiet',
  '-f',
  'deploy/compose.s3.yml',
];
if (process.argv[2] === 'down') {
  execFileSync('docker', [...compose, 'down'], { stdio: 'inherit' });
  process.exit(0);
}
await mkdir('.dev-s3', { recursive: true, mode: 0o700 });
let credentials;
try {
  credentials = JSON.parse(await readFile('.dev-s3/credentials.json', 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  credentials = {
    accessKeyId: `midscene${randomBytes(8).toString('hex')}`,
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  await writeFile('.dev-s3/credentials.json', JSON.stringify(credentials), {
    mode: 0o600,
  });
}
await writeFile(
  '.dev-s3/s3.json',
  JSON.stringify({
    identities: [
      {
        name: 'midscene-test',
        credentials: [
          {
            accessKey: credentials.accessKeyId,
            secretKey: credentials.secretAccessKey,
          },
        ],
        actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'],
      },
    ],
  }),
  { mode: 0o600 },
);
const endpoint = 'http://127.0.0.1:28333';
const bucket = 'midscene-webview-test';
await writeFile(
  '.env.local-s3',
  `S3_ENDPOINT=${endpoint}\nS3_BUCKET=${bucket}\nAWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=${credentials.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}\nS3_FORCE_PATH_STYLE=true\nS3_KEY_PREFIX=webview-tasks\n`,
  { mode: 0o600 },
);
execFileSync('docker', [...compose, 'up', '-d'], { stdio: 'inherit' });
const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials,
  maxAttempts: 1,
});
try {
  for (let i = 0; i < 60; i++) {
    try {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (e) {
        if (e.$metadata?.httpStatusCode === 404)
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
        else throw e;
      }
      console.log(`Local S3 ready: ${endpoint}; private bucket: ${bucket}`);
      process.exitCode = 0;
      break;
    } catch (e) {
      if (i === 59) throw e;
      await delay(1000);
    }
  }
} finally {
  client.destroy();
}
