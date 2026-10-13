import path from 'node:path';
import { EngineError } from './domain.mjs';

export function loadConfig(env = process.env) {
  const split = (value) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (!env.ENGINE_API_TOKEN || env.ENGINE_API_TOKEN.length < 24)
    throw new EngineError('CONFIG_ERROR', 'ENGINE_API_TOKEN 至少 24 字符');
  if (!env.S3_BUCKET)
    throw new EngineError('CONFIG_ERROR', '请配置私有 S3_BUCKET');
  if (!env.ANDROID_SERIAL)
    throw new EngineError('CONFIG_ERROR', '请配置 ANDROID_SERIAL');
  const webviewHosts = split(env.CMB_WEBVIEW_HOSTS ?? '*.cmbchina.com');
  if (!webviewHosts.length)
    throw new EngineError('CONFIG_ERROR', 'CMB_WEBVIEW_HOSTS 不能为空');
  const port = Number(env.ENGINE_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new EngineError('CONFIG_ERROR', 'ENGINE_PORT 不正确');
  const urlTtlSeconds = Number(env.S3_URL_TTL_SECONDS ?? 900);
  if (
    !Number.isInteger(urlTtlSeconds) ||
    urlTtlSeconds < 60 ||
    urlTtlSeconds > 3600
  )
    throw new EngineError(
      'CONFIG_ERROR',
      'S3_URL_TTL_SECONDS 必须为 60 到 3600',
    );
  return {
    apiToken: env.ENGINE_API_TOKEN,
    host: env.ENGINE_HOST ?? '127.0.0.1',
    port,
    dataDir: path.resolve(env.ENGINE_DATA_DIR ?? './data'),
    serial: env.ANDROID_SERIAL,
    webviewHosts,
    entryHosts: ['cmbls', ...webviewHosts],
    launcherUrlPrefix: env.CMB_LAUNCHER_URL_PREFIX ?? null,
    navigationLabels: split(env.CMB_NAVIGATION_LABELS ?? ''),
    captureBridge: env.CMB_CAPTURE_BRIDGE === 'true',
    s3: {
      bucket: env.S3_BUCKET,
      region: env.AWS_REGION ?? 'us-east-1',
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      keyPrefix: (env.S3_KEY_PREFIX ?? 'webview-tasks').replace(
        /^\/+|\/+$/g,
        '',
      ),
      urlTtlSeconds,
      encryption: env.S3_ENCRYPTION || undefined,
    },
  };
}
