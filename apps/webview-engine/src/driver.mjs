import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PlaywrightBrowserAgent } from '@midscene/web/playwright';
import { _android as android } from 'playwright';
import { BridgeCollector } from './bridge.mjs';
import {
  EngineError,
  allowedControl,
  assertUrl,
  fingerprint,
} from './domain.mjs';
import { NetworkCollector } from './evidence.mjs';
import { explorationPrompt } from './explorer.mjs';
import { launcherCandidates } from './pages.mjs';

export class AndroidWebviewDriver {
  constructor(config, directory, writer) {
    this.config = config;
    this.directory = directory;
    this.writer = writer;
    this.agents = new Map();
    this.network = new NetworkCollector(writer);
    this.bridge = config.captureBridge ? new BridgeCollector(writer) : null;
  }
  async pages() {
    const pages = [];
    for (const view of this.device
      .webViews()
      .filter((v) => v.pkg() === 'cmb.pb')) {
      try {
        const page = await Promise.race([
          view.page(),
          delay(8000, null, { ref: false }).then(() => {
            throw new Error('连接 WebView 超时');
          }),
        ]);
        for (const p of page.context().pages())
          if (!p.isClosed() && !pages.includes(p)) pages.push(p);
      } catch {
        this.writer.emit('webview-unavailable', { pid: view.pid() });
      }
    }
    return pages;
  }
  async connect(task) {
    this.task = task;
    // WebView/CDP and ADB shell do not require installing the native UI driver.
    const devices = await android.devices({ omitDriverInstall: true });
    this.device = devices.find((d) => d.serial() === this.config.serial);
    for (const other of devices.filter((d) => d !== this.device))
      await other.close();
    if (!this.device)
      throw new EngineError('DEVICE_UNAVAILABLE', '指定 Android 设备未在线');
    this.device.setDefaultTimeout(10000);
    let initial = await this.pages();
    if (!initial.length) {
      await delay(500);
      initial = await this.pages();
    }
    const candidates = await launcherCandidates(
      initial,
      this.config.launcherUrlPrefix,
      task.request.startUrl,
    );
    if (!candidates.length)
      throw new EngineError(
        'APP_WEBVIEW_UNAVAILABLE',
        '未找到可连接的 cmb.pb WebView，请确认 APP 页面和调试状态',
      );
    if (candidates.length !== 1)
      throw new EngineError(
        'APP_ENTRY_AMBIGUOUS',
        '需要一个已打开的 cmb.pb WebView，多个页面时请配置 CMB_LAUNCHER_URL_PREFIX',
      );
    const launcher = candidates[0];
    const before = new Map();
    for (const page of initial) {
      before.set(page, await this.signature(page));
      this.network.attach(page.context());
      await this.bridge?.attach(page.context());
    }
    this.writer.emit('open-app-url', {
      mode: 'existing-app-webview',
      corpno: task.request.corpno,
      url: task.request.startUrl,
    });
    // Trigger the app's WebView navigation interception, including cmbls routes.
    await launcher
      .evaluate((url) => {
        window.location.href = url;
      }, task.request.startUrl)
      .catch((e) => {
        if (!/closed|destroyed|navigation/i.test(e.message)) throw e;
      });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const eligible = [];
      for (const page of await this.pages()) {
        try {
          assertUrl(page.url(), this.config.webviewHosts);
          if (
            task.request.expectedWebviewUrlPrefix &&
            !page.url().startsWith(task.request.expectedWebviewUrlPrefix)
          )
            continue;
          if (
            !before.has(page) ||
            before.get(page) !== (await this.signature(page))
          )
            eligible.push(page);
        } catch {}
      }
      if (eligible.length === 1) {
        await this.select(eligible[0]);
        this.writer.emit('app-entry-confirmed', {
          url: this.page.url(),
          corpno: task.request.corpno,
        });
        return;
      }
      if (eligible.length > 1)
        throw new EngineError(
          'WEBVIEW_AMBIGUOUS',
          '多个 WebView 匹配入口，请提供 expectedWebviewUrlPrefix',
        );
      await delay(500);
    }
    throw new EngineError(
      'APP_ENTRY_NOT_CONFIRMED',
      '未观察到小程序 WebView 打开；需要核实 APP 内路由和匹配规则',
    );
  }
  async signature(page) {
    return page
      .evaluate(() => `${location.href}:${performance.timeOrigin}`)
      .catch(() => `unavailable:${page.url()}`);
  }
  async select(page) {
    assertUrl(page.url(), this.config.webviewHosts);
    this.page = page;
    const context = page.context();
    this.network.attach(context);
    await this.bridge?.attach(context);
    if (!this.agents.has(context))
      this.agents.set(
        context,
        new PlaywrightBrowserAgent(context, page, {
          autoFollowNewPage: true,
          reportFileName: `webview-${this.writer.runId}-${this.agents.size}`,
        }),
      );
    this.agent = this.agents.get(context);
  }
  async refresh() {
    const active = this.agent?.activePage;
    if (active && !active.isClosed()) {
      this.page = active;
      assertUrl(active.url(), this.config.webviewHosts);
    } else {
      const available = (await this.pages()).filter((p) => {
        try {
          assertUrl(p.url(), this.config.webviewHosts);
          return true;
        } catch {
          return false;
        }
      });
      if (available.length !== 1)
        throw new EngineError(
          'WEBVIEW_LOST',
          '活动 WebView 关闭且无法唯一恢复',
        );
      await this.select(available[0]);
    }
  }
  async readSnapshot() {
    return this.page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll('a,button,[role="button"],[role="tab"]'),
      )
        .slice(0, 250)
        .map((el, i) => {
          const r = el.getBoundingClientRect();
          return {
            id: `c${i}`,
            tag: el.tagName,
            label: (el.innerText || el.getAttribute('aria-label') || '')
              .trim()
              .slice(0, 200),
            href: el.tagName === 'A' ? el.href : null,
            disabled:
              !!el.disabled || el.getAttribute('aria-disabled') === 'true',
            visible:
              r.width > 0 &&
              r.height > 0 &&
              r.top < innerHeight &&
              r.bottom > 0,
            x: Math.round(r.x),
            y: Math.round(r.y),
          };
        })
        .filter((c) => c.visible);
      return {
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 100000) ?? '',
        controls,
        viewport: { width: innerWidth, height: innerHeight },
        timeOrigin: performance.timeOrigin,
      };
    });
  }
  async snapshot(index) {
    await this.refresh();
    try {
      // A new SPA document can be discoverable before its initial UI renders.
      await this.page.waitForFunction(
        () => {
          if (document.readyState === 'loading' || !document.body) return false;
          if (document.body.innerText?.trim()) return true;
          return Array.from(document.querySelectorAll('img,canvas,svg')).some(
            (el) => {
              const rect = el.getBoundingClientRect();
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                rect.top < innerHeight &&
                rect.bottom > 0 &&
                (el.tagName !== 'IMG' || (el.complete && el.naturalWidth > 0))
              );
            },
          );
        },
        undefined,
        { timeout: 15000 },
      );
    } catch {
      throw new EngineError(
        'PAGE_NOT_READY',
        '页面在等待期限内未呈现可采集内容',
      );
    }
    // Initial SPA chrome can render before its data requests finish. A busy
    // page remains collectable, but record when this bounded settle wait expires.
    await this.page
      .waitForLoadState('networkidle', { timeout: 15000 })
      .catch(() =>
        this.writer.emit('capture-gap', {
          source: 'page-settle',
          snapshotIndex: index,
          reason: 'network-still-busy',
        }),
      );
    const state = await this.readSnapshot();
    this.lastState = state;
    const snapshots = path.join(this.directory, 'snapshots');
    await mkdir(snapshots, { recursive: true });
    const name = `${index}`.padStart(4, '0');
    // DOM and screenshots deliberately retain source evidence; the bundle is private.
    await writeFile(
      path.join(snapshots, `${name}.json`),
      JSON.stringify(state, null, 2),
    );
    await writeFile(
      path.join(snapshots, `${name}.html`),
      (await this.page.content()).slice(0, 2 * 1024 * 1024),
    );
    await this.page
      .screenshot({ path: path.join(snapshots, `${name}.png`), timeout: 20000 })
      .catch(() =>
        this.writer.emit('capture-gap', {
          source: 'screenshot',
          snapshotIndex: index,
        }),
      );
    return state;
  }
  async decide(input) {
    return this.agent.aiQuery(explorationPrompt(input));
  }
  async act(decision, control) {
    await this.refresh();
    const before = new Map();
    for (const page of await this.pages())
      before.set(page, await this.signature(page));
    if (decision.action === 'tap') {
      const current = await this.readSnapshot();
      const found = current.controls.find((c) => c.id === control.id);
      if (
        !found ||
        fingerprint(found) !== fingerprint(control) ||
        !allowedControl(found, this.config)
      )
        throw new EngineError(
          'STALE_CONTROL',
          '控件状态发生变化，停止执行旧决策',
        );
      await this.agent.aiTap(
        `点击可见的 ${control.tag} 导航控件，完整文字是“${control.label}”，位置约为 (${control.x}, ${control.y})。只点击该控件一次。`,
      );
    } else if (decision.action === 'scroll')
      await this.agent.aiScroll(undefined, {
        direction: 'down',
        scrollType: 'singleAction',
      });
    else if (decision.action === 'back')
      await this.device.shell('input keyevent 4');
    await delay(750);
    const changed = [];
    for (const page of await this.pages()) {
      try {
        assertUrl(page.url(), this.config.webviewHosts);
        if (
          !before.has(page) ||
          before.get(page) !== (await this.signature(page))
        )
          changed.push(page);
      } catch {}
    }
    if (changed.length > 1)
      throw new EngineError(
        'WEBVIEW_AMBIGUOUS',
        '一次动作改变了多个 WebView，无法确定活动页面',
      );
    if (changed.length === 1 && changed[0].context() !== this.page.context())
      await this.select(changed[0]);
    await this.refresh();
  }
  async close() {
    await delay(500); // Include late response metadata before detaching listeners.
    const counts = this.network.stop();
    const reports = [];
    try {
      await this.bridge?.stop();
      for (const agent of this.agents.values()) {
        await agent.flushReport();
        await agent.destroy();
        if (agent.reportFile)
          reports.push(path.relative(this.directory, agent.reportFile));
      }
    } finally {
      await this.device?.close();
    }
    return { network: counts, reports };
  }
}
