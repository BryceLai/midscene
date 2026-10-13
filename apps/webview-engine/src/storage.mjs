import { createReadStream } from 'node:fs';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class S3Storage {
  constructor(config) {
    this.config = config;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: config.credentials,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }
  async upload(file, key, { bytes, sha256 }, signal) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: bytes,
        ContentType: 'application/zip',
        Metadata: { sha256 },
        ...(this.config.encryption
          ? { ServerSideEncryption: this.config.encryption }
          : {}),
      }),
      { abortSignal: signal },
    );
    return { key, bytes, sha256, format: 'zip' };
  }
  async download(key) {
    const expiresIn = this.config.urlTtlSeconds;
    const downloadUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: 'attachment; filename="collection.zip"',
      }),
      { expiresIn },
    );
    return {
      downloadUrl,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }
  close() {
    this.client.destroy();
  }
}
