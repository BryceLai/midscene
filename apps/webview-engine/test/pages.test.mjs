import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launcherCandidates } from '../src/pages.mjs';

const page = (url, visibility = 'visible') => ({
  url: () => url,
  evaluate: async () => visibility,
});
const startUrl = 'https://movie.example/movie.html';

test('WebView 入口：相同 URL 的历史页面中选择唯一可见页面', async () => {
  const foreground = page(startUrl);
  const background = page(startUrl, 'hidden');
  const blank = page('data:text/html,<html></html>', 'hidden');
  assert.deepEqual(
    await launcherCandidates([background, blank, foreground], null, startUrl),
    [foreground],
  );
  assert.deepEqual(
    await launcherCandidates([background, foreground], startUrl, startUrl),
    [foreground],
  );
});

test('WebView 入口：可见性不明确时保留歧义，遵守显式入口前缀', async () => {
  const first = page(startUrl);
  const second = page(startUrl);
  assert.equal(
    (await launcherCandidates([first, second], null, startUrl)).length,
    2,
  );
  const hidden = page(startUrl, 'hidden');
  const unknown = page(startUrl, null);
  assert.equal(
    (await launcherCandidates([hidden, unknown], null, startUrl)).length,
    2,
  );
  const launcher = page('file:///launcher.html', 'hidden');
  assert.deepEqual(
    await launcherCandidates([first, launcher], 'file:///launcher', startUrl),
    [launcher],
  );
});
