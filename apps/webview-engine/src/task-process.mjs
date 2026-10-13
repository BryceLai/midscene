// Keep device/model calls in a process that can be killed at the task deadline.
process.on('disconnect', () => process.exit(1));
process.once('message', async ({ task, config, directory, runId }) => {
  let driver;
  let writer;
  let result;
  let error;
  let capture;
  try {
    process.env.MIDSCENE_RUN_DIR = `${directory}/midscene`;
    const { EvidenceWriter } = await import('./evidence.mjs');
    const { AndroidWebviewDriver } = await import('./driver.mjs');
    const { explore } = await import('./explorer.mjs');
    writer = new EvidenceWriter(
      `${directory}/timeline.jsonl`,
      task.taskId,
      runId,
    );
    driver = new AndroidWebviewDriver(config, directory, writer);
    await driver.connect(task);
    result = await explore({
      task,
      driver,
      writer,
      config,
      progress: (progress) => process.send?.({ type: 'progress', progress }),
    });
  } catch (e) {
    error = {
      code: e.code ?? 'EXPLORATION_FAILED',
      message: e.code ? e.message : '探索执行失败；请检查私有采集日志',
    };
    const { writeFile } = await import('node:fs/promises');
    let detail = String(e.stack ?? e.message);
    for (const [key, value] of Object.entries(process.env)) {
      if (/TOKEN|SECRET|KEY/.test(key) && value.length > 8)
        detail = detail.replaceAll(value, '[REDACTED]');
    }
    await writeFile(
      `${directory}/execution-error.json`,
      JSON.stringify({ code: error.code, detail }, null, 2),
    ).catch(() => {});
    try {
      writer?.emit('execution-error', { code: error.code });
    } catch {}
  } finally {
    try {
      capture = await driver?.close();
    } catch {
      error ??= {
        code: 'FINALIZATION_FAILED',
        message: '报告或设备会话未能正常结束',
      };
    }
    process.send?.({ type: 'result', result, error, capture }, () =>
      process.exit(error ? 1 : 0),
    );
  }
});
