// SPDX-License-Identifier: GPL-3.0-only
// 手机号 + 短信验证码登录（passport）。登录成功后把 Cookie 交给 account 服务，
// 与扫码登录共用同一份会话/收藏/点赞/上报能力。
// 端点与错误码来自上游 hongguoTV PhoneLogin.kt 的实测记录（2026-11-03）。
'use strict';

const axios = require('axios');
const logger = require('../services/logger');
const { getAccountService } = require('./account');

const PASSPORT = 'https://security.snssdk.com';
const CODE_TYPE = '24';
// 官方 App 短信登录用固定设备表：新注册设备 + query 带 device_id 会被 passport 判 2046。
const PORTABLE_DEVICE = {
  device_id: '1905892595378490',
  iid: '1905892595382586',
  cdid: '91d56f7e-c027-4ce9-9a3c-229d59a13c3b',
  version_code: '73932', version_name: '7.3.9.32', manifest_version_code: '73932',
  update_version_code: '73932', pv_player: '73932',
};
const VERIFY_ATTEMPTS = [
  ['/passport/mobile/sms_login/', true],
  ['/passport/mobile/sms_login_only/', true],
  ['/passport/mobile/sms_login_continue/', true],
  ['/passport/mobile/validate_code/v1/', false],
  ['/passport/mobile/validate_code/v1/', true],
];
const KEEP_COOKIES = /^(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss|passport_csrf_token|passport_csrf_token_default|odin_tt|store-region|store-region-src|install_id)$/;

let pending = null;
let sendGateUntil = 0;

function fail(message, code, extra) {
  return Object.assign(new Error(message), { code: code || 'SMS_FAILED' }, extra || {});
}

function normalizeMobile(raw) {
  const text = String(raw || '').trim();
  if (!text) throw fail('请输入手机号', 'APP_INPUT');
  let cc = '86';
  let number = text;
  if (text.startsWith('+') || text.startsWith('00')) {
    const rest = text.startsWith('+') ? text.slice(1) : text.slice(2);
    cc = (rest.match(/^\d{1,3}/) || [''])[0];
    number = rest.slice(cc.length).replace(/^[\s-]+/, '');
  }
  const digits = number.replace(/\D/g, '').replace(/^0+/, '');
  if (cc === '86') {
    if (!/^1\d{10}$/.test(digits)) throw fail('大陆手机号是 1 开头的 11 位数字', 'APP_INPUT');
    return digits;
  }
  if (!/^[1-9]\d{0,2}$/.test(cc)) throw fail('区号是 1–3 位数字', 'APP_INPUT');
  if (digits.length < 4 || cc.length + digits.length > 15) throw fail('号码长度不对：区号加号码最多 15 位', 'APP_INPUT');
  return `+${cc} ${digits}`;
}

function maskMobile(value) {
  const t = String(value || '');
  return t.length <= 6 ? t : `${t.slice(0, 3)}****${t.slice(-2)}`;
}

function passportDevice() {
  return { ...require('./app-source').DEVICE, ...PORTABLE_DEVICE };
}

async function passportCall(pathName, params, form) {
  const { signPassportRequest } = require('./app-source');
  const device = passportDevice();
  const passport = { aid: '8662', app_name: 'novelread', device_platform: 'android', ...params };
  const clean = Object.fromEntries(Object.entries(passport).filter(([, v]) => String(v == null ? '' : v).length > 0));
  const body = form ? Buffer.from(require('./app-source').pythonUrlEncode(clean)) : null;
  const queryDevice = { ...device };
  delete queryDevice.device_id;
  delete queryDevice.iid;
  const values = form ? queryDevice : { ...queryDevice, ...clean };
  const signed = signPassportRequest(`${PASSPORT}${pathName}`, values, body, device);
  const res = await axios({
    url: signed.url,
    method: body ? 'POST' : 'GET',
    headers: signed.headers,
    data: body || undefined,
    timeout: 15000,
    maxRedirects: 0,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: () => true,
  });
  let parsed = null;
  try { parsed = res.data ? JSON.parse(res.data) : null; } catch (_) { parsed = null; }
  return { status: res.status, parsed, headers: res.headers || {} };
}

function collectCookies(map, setCookie) {
  const rows = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of rows) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!KEEP_COOKIES.test(name) || !value) continue;
    map[name] = value;
  }
}

function describe(parsed) {
  const data = parsed && parsed.data;
  if (!data) return '';
  const text = String(data.description || '').trim();
  const code = Number(data.error_code || 0);
  if (!text) return '';
  return code ? `${text}（错误码 ${code}）` : text;
}

async function sendCode(rawMobile) {
  const wait = Math.ceil((sendGateUntil - Date.now()) / 1000);
  if (wait > 0) throw fail(`平台提示操作过于频繁，请至少等待 ${wait} 秒后再试`, 'RATE_LIMIT', { retryAfter: wait });
  const mobile = normalizeMobile(rawMobile);
  const reply = await passportCall('/passport/mobile/send_code/v1/', { mobile, type: CODE_TYPE }, false);
  const data = (reply.parsed && reply.parsed.data) || {};
  const errorCode = Number(data.error_code || 0);
  if (data.verify_center_decision_conf) {
    throw fail('平台要求先完成滑块验证，短信登录暂不可用，请改用扫码登录', 'VERIFY_REQUIRED');
  }
  if (errorCode === 7) {
    const retry = Math.max(60, Number(data.retry_time || 60));
    sendGateUntil = Date.now() + retry * 1000;
    throw fail(`平台提示操作过于频繁（错误码 7），请 ${retry} 秒后再试`, 'RATE_LIMIT', { retryAfter: retry });
  }
  if (reply.status !== 200 || !reply.parsed || reply.parsed.message !== 'success') {
    throw fail(describe(reply.parsed) || `验证码没有发出去（HTTP ${reply.status}）`, 'SEND_FAILED', { errorCode });
  }
  const ticket = String(data.mobile_ticket || '');
  if (!ticket) throw fail('平台没有返回验证码凭据，请稍后重试', 'SEND_FAILED');
  const cookies = {};
  collectCookies(cookies, reply.headers['set-cookie']);
  pending = { mobile, ticket, cookies };
  logger.info('Account', `短信验证码已发送 ${maskMobile(mobile)}`);
  return { mobile: maskMobile(data.mobile || mobile), retryAfter: Number(data.retry_time || 60) || 60 };
}

async function verify(code) {
  if (!pending) throw fail('请先获取验证码', 'NO_PENDING');
  const value = String(code || '').trim();
  if (!/^\d{4,8}$/.test(value)) throw fail('请输入 4–8 位短信验证码', 'APP_INPUT');
  let ticket = pending.ticket;
  const cookies = { ...pending.cookies };
  let lastError = null;
  for (const [pathName, form] of VERIFY_ATTEMPTS) {
    const reply = await passportCall(pathName, { mobile: pending.mobile, code: value, type: CODE_TYPE, mobile_ticket: ticket }, form);
    collectCookies(cookies, reply.headers['set-cookie']);
    if (cookies.sessionid) break;
    const data = (reply.parsed && reply.parsed.data) || {};
    const errorCode = Number(data.error_code || 0);
    if (errorCode === 7) {
      const retry = Math.max(60, Number(data.retry_time || 60));
      sendGateUntil = Date.now() + retry * 1000;
      throw fail(`平台提示操作过于频繁（错误码 7），请 ${retry} 秒后再试`, 'RATE_LIMIT', { retryAfter: retry });
    }
    if (data.mobile_ticket) ticket = String(data.mobile_ticket);
    if (errorCode === 0 || errorCode === 1) {
      if (errorCode === 1) lastError = fail('登录会话已过期，请重新获取验证码（错误码 1）', 'SESSION_EXPIRED');
      continue;
    }
    if (errorCode === 1203) {
      pending = null;
      throw fail(describe(reply.parsed) || '错误次数过多或验证码已过期，请重新获取验证码（错误码 1203）', 'CODE_EXPIRED');
    }
    if (errorCode === 1002 || errorCode === 1003) {
      lastError = fail(describe(reply.parsed) || `验码参数未被接受（错误码 ${errorCode}）`, 'VERIFY_PARAM', { errorCode });
      continue;
    }
    throw fail(describe(reply.parsed) || `验证码校验失败（错误码 ${errorCode}）`, 'VERIFY_FAILED', { errorCode });
  }
  if (!cookies.sessionid) throw lastError || fail('登录没有成功，平台没有下发登录态', 'NO_SESSION');
  const mobileMasked = maskMobile(pending.mobile);
  pending = null;
  const status = await getAccountService().adoptSession(cookies, mobileMasked);
  logger.info('Account', '短信登录成功，已接管账号会话');
  return status;
}

module.exports = { sendCode, verify, normalizeMobile, maskMobile };
