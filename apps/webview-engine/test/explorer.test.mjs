import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedControl, validateDecision } from '../src/domain.mjs';
import { redact, safeUrl } from '../src/evidence.mjs';
import { explore } from '../src/explorer.mjs';

const config = { webviewHosts: ['example.test'], navigationLabels: ['搜索'] };
const writer = () => ({
  events: [],
  actionId: null,
  emit(type, data) {
    this.events.push({ type, data });
  },
});

test('服务端策略约束模型：拒绝写操作、域外链接和伪造控件 ID', () => {
  assert.equal(
    allowedControl(
      { tag: 'A', label: '付款', href: 'https://example.test/pay' },
      config,
    ),
    false,
  );
  assert.equal(
    allowedControl(
      { tag: 'A', label: '详情', href: 'https://evil.test' },
      config,
    ),
    false,
  );
  assert.equal(allowedControl({ tag: 'BUTTON', label: '搜索' }, config), true);
  assert.equal(
    allowedControl({ tag: 'BUTTON', label: '未知操作' }, config),
    false,
  );
  assert.throws(
    () =>
      validateDecision(
        { action: 'tap', controlId: 'invented', summary: '', reason: '' },
        [],
      ),
    /未授权/,
  );
  assert.equal(
    redact({ authorization: 'secret', nested: { password: 'secret' } }).nested
      .password,
    '[REDACTED]',
  );
  assert.ok(
    !safeUrl('https://example.test?token=secret&name=user#private').includes(
      'secret',
    ),
  );
});

test('探索循环：防止重复动作并保存最后一个预算内动作后的证据', async () => {
  const evidence = writer();
  let actions = 0;
  let snapshots = 0;
  const driver = {
    async snapshot() {
      snapshots++;
      return { url: 'https://example.test', text: 'unchanged', controls: [] };
    },
    async decide() {
      return { action: 'scroll', summary: 'page', reason: 'inspect' };
    },
    async act() {
      actions++;
    },
  };
  const task = {
    request: { objective: 'collect', limits: { maxSteps: 5, maxPages: 3 } },
  };
  const result = await explore({ task, driver, writer: evidence, config });
  assert.equal(actions, 1);
  assert.equal(result.stopReason, 'repeated-action');
  const limited = await explore({
    task: {
      request: { ...task.request, limits: { maxSteps: 1, maxPages: 3 } },
    },
    driver,
    writer: writer(),
    config,
  });
  assert.equal(limited.stopReason, 'step-budget');
  assert.equal(snapshots, 4);
});
