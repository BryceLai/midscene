// Installed in the app WebView. Capture metadata only and preserve sync behavior.
function install(bindingName) {
  if (window.__cmbEngineBridge) return;
  const targets = [
    ['cmblapiBridge', 'invoke', 'h5-to-native'],
    ['cmblsExecutor', 'executeCmbls', 'h5-to-native'],
    ['cmblapi', 'callback', 'native-to-h5'],
    ['cmblapi', 'callbackWithObj', 'native-to-h5'],
    ['cmblapiObj', 'callback', 'native-to-h5'],
    ['cmblapiObj', 'callbackWithObj', 'native-to-h5'],
  ];
  const hooks = [];
  const seen = new Set();
  const send = (event) => {
    try {
      Promise.resolve(
        window[bindingName]({
          ...event,
          pageUrl: location.href,
          occurredAt: Date.now(),
        }),
      ).catch(() => {});
    } catch {}
  };
  const scan = () => {
    for (const [root, method, direction] of targets) {
      const entry = `${root}.${method}`;
      const obj = window[root];
      if (!obj || seen.has(entry)) continue;
      const original = obj[method];
      if (typeof original !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(obj, method);
      const wrapper = function (...args) {
        const callId = `${Date.now()}:${Math.random()}`;
        const start = Date.now();
        send({
          phase: 'call',
          entry,
          direction,
          callId,
          argumentCount: args.length,
        });
        try {
          const result = Reflect.apply(original, this, args);
          send({
            phase: 'return',
            entry,
            direction,
            callId,
            durationMs: Date.now() - start,
          });
          return result;
        } catch (e) {
          send({ phase: 'throw', entry, direction, callId });
          throw e;
        }
      };
      try {
        obj[method] = wrapper;
        seen.add(entry);
        if (obj[method] === wrapper) {
          hooks.push({ obj, method, original, wrapper, descriptor });
          send({ phase: 'hook-installed', entry, direction });
        } else send({ phase: 'hook-unavailable', entry, direction });
      } catch {
        seen.add(entry);
        send({ phase: 'hook-unavailable', entry, direction });
      }
    }
  };
  const timer = setInterval(scan, 250);
  window.__cmbEngineBridge = {
    stop() {
      clearInterval(timer);
      for (const h of hooks.reverse()) {
        if (h.obj[h.method] === h.wrapper) {
          if (h.descriptor)
            Object.defineProperty(h.obj, h.method, h.descriptor);
          else Reflect.deleteProperty(h.obj, h.method);
        }
      }
      Reflect.deleteProperty(window, '__cmbEngineBridge');
    },
  };
  scan();
}

export class BridgeCollector {
  constructor(writer) {
    this.writer = writer;
    this.contexts = new Set();
    this.pages = new Set();
    this.sessions = [];
    this.off = [];
    this.pending = new Set();
    this.stopped = false;
  }
  async attach(context) {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    const binding = `__cmbEngine_${this.writer.runId.replaceAll('-', '')}`;
    await context.exposeBinding(binding, (_source, event) => {
      if (!this.stopped) this.writer.emit('bridge', event, null);
    });
    const attachPage = async (page) => {
      if (this.stopped || this.pages.has(page)) return;
      this.pages.add(page);
      try {
        const session = await context.newCDPSession(page);
        const record = { page, session };
        this.sessions.push(record);
        const { identifier } = await session.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: `(${install.toString()})(${JSON.stringify(binding)})` },
        );
        record.identifier = identifier;
        await page.evaluate(install, binding);
      } catch {
        this.writer.emit('bridge', { phase: 'hook-unavailable' });
      }
    };
    const onPage = (page) => {
      const p = attachPage(page);
      this.pending.add(p);
      p.finally(() => this.pending.delete(p));
    };
    context.on('page', onPage);
    this.off.push(() => context.off('page', onPage));
    await Promise.all(context.pages().map(attachPage));
  }
  async stop() {
    this.stopped = true;
    for (const off of this.off) off();
    await Promise.all([...this.pending]);
    for (const { page, session, identifier } of this.sessions) {
      if (identifier)
        await session
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
          .catch(() => {});
      if (!page.isClosed())
        await page
          .evaluate(() => window.__cmbEngineBridge?.stop())
          .catch(() => {});
      await session.detach().catch(() => {});
    }
  }
}
