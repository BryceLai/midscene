import { createHash } from 'node:crypto';

export class EngineError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function hostAllowed(host, patterns) {
  return patterns.some((pattern) =>
    pattern.startsWith('*.')
      ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
      : host === pattern,
  );
}

export function assertUrl(raw, hosts) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new EngineError('INVALID_URL', 'URL 格式不正确', 400);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !hostAllowed(url.hostname, hosts)
  ) {
    throw new EngineError(
      'URL_NOT_ALLOWED',
      'URL 必须为允许域名中的 HTTPS URL',
      400,
    );
  }
  return url;
}

export function validateTask(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new EngineError('INVALID_TASK', '请求必须为 JSON 对象', 400);
  const keys = ['startUrl', 'objective', 'limits', 'expectedWebviewUrlPrefix'];
  if (Object.keys(input).some((k) => !keys.includes(k)))
    throw new EngineError('INVALID_TASK', '包含未知参数', 400);
  if (typeof input.startUrl !== 'string' || input.startUrl.length > 4096)
    throw new EngineError('INVALID_TASK', 'startUrl 必须为 URL 字符串', 400);
  const start = assertUrl(input.startUrl, config.entryHosts);
  let corpno = null;
  if (start.hostname === 'cmbls') {
    corpno = start.searchParams.get('corpno');
    if (
      start.pathname !== '/functionjump' ||
      start.searchParams.get('action') !== 'gocorpno' ||
      !/^\d{1,32}$/.test(corpno ?? '')
    ) {
      throw new EngineError(
        'INVALID_APP_ROUTE',
        'cmbls 入口需要 functionjump、action=gocorpno 和数字 corpno',
        400,
      );
    }
  }
  const objective =
    input.objective ?? '探索当前小程序中可安全浏览的页面并采集证据';
  if (typeof objective !== 'string' || objective.length > 2000)
    throw new EngineError('INVALID_TASK', 'objective 最长 2000 字符', 400);
  const supplied = input.limits ?? {};
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Array.isArray(supplied) ||
    Object.keys(supplied).some(
      (k) => !['maxSteps', 'maxPages', 'timeoutSeconds'].includes(k),
    )
  )
    throw new EngineError('INVALID_LIMITS', 'limits 参数不正确', 400);
  const limits = {};
  for (const [key, fallback, maximum] of [
    ['maxSteps', 20, 100],
    ['maxPages', 10, 50],
    ['timeoutSeconds', 600, 3600],
  ]) {
    limits[key] = supplied[key] ?? fallback;
    if (
      !Number.isInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > maximum
    )
      throw new EngineError(
        'INVALID_LIMITS',
        `${key} 必须为 1 到 ${maximum} 的整数`,
        400,
      );
  }
  let expectedWebviewUrlPrefix = input.expectedWebviewUrlPrefix ?? null;
  if (expectedWebviewUrlPrefix !== null) {
    if (
      typeof expectedWebviewUrlPrefix !== 'string' ||
      expectedWebviewUrlPrefix.length > 4096
    )
      throw new EngineError(
        'INVALID_TASK',
        'expectedWebviewUrlPrefix 必须为 URL 字符串',
        400,
      );
    expectedWebviewUrlPrefix = assertUrl(
      expectedWebviewUrlPrefix,
      config.webviewHosts,
    ).href;
  }
  return {
    startUrl: start.href,
    corpno,
    objective,
    limits,
    expectedWebviewUrlPrefix,
  };
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const dangerous =
  /购买|购票|支付|付款|转账|汇款|贷款|理财|赎回|交易|下单|提交|确认|删除|注销|退出登录|授权|签约|签署|验证码|密码|purchase|pay(?:ment)?|transfer|submit|confirm|delete|logout|authorize|trade|withdraw|checkout/i;
export function allowedControl(control, config) {
  if (!control.label || control.disabled || dangerous.test(control.label))
    return false;
  if (config.navigationLabels.includes(control.label)) return true;
  if (control.tag !== 'A' || !control.href) return false;
  try {
    const url = assertUrl(control.href, config.webviewHosts);
    return !dangerous.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

export function validateDecision(decision, controls) {
  if (
    !decision ||
    typeof decision !== 'object' ||
    typeof decision.summary !== 'string' ||
    typeof decision.reason !== 'string' ||
    !['tap', 'scroll', 'back', 'finish'].includes(decision.action)
  )
    throw new EngineError(
      'INVALID_MODEL_DECISION',
      '模型未返回有效的单步探索决策',
    );
  if (
    decision.action === 'tap' &&
    !controls.some((c) => c.id === decision.controlId)
  )
    throw new EngineError('INVALID_MODEL_DECISION', '模型选择了未授权的控件');
  return {
    action: decision.action,
    controlId: decision.action === 'tap' ? decision.controlId : null,
    summary: decision.summary.slice(0, 4000),
    reason: decision.reason.slice(0, 2000),
  };
}
