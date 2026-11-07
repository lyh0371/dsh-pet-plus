/* eslint-disable @typescript-eslint/no-explicit-any -- 微信 iLink 的协议响应是未类型化 JSON，这里用窄化断言集中处理。 */
/**
 * 微信 iLink 文本协议的最小实现（二维码登录、长轮询、发文本）。
 *
 * 协议与错误分类参考 dsh-im（MIT, Copyright (c) 2026 xmanrui）：
 * https://github.com/xmanrui/dsh-im 的 src/channels/weixin/weixin-api.mjs。
 * 本文件只保留文本消息所需路径，去掉了 dsh-im 的图片、文件、Harness Session 与命令系统。
 * @module dsh-pet/src/host/im/weixin-api
 */
import { randomBytes, randomUUID } from 'node:crypto';

export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';
export const WEIXIN_PROTOCOL_VERSION = '2.4.6';
export const DEFAULT_BOT_TYPE = '3';
export const DEFAULT_WEIXIN_MAX_MESSAGE_CHARS = 1_800;

const ILINK_APP_ID = 'bot';
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const TEXT_SEND_RETRY_DELAYS_MS = [400, 1_200];
const LOGIN_STATUSES = new Set([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'scaned_but_redirect',
  'need_verifycode',
  'verify_code_blocked',
  'binded_redirect',
]);

export class WeixinApiError extends Error {
  code: string;
  status?: number;
  providerCode?: string;

  constructor(
    code: string,
    message: string,
    options: { status?: number; providerCode?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WeixinApiError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeProviderCode(value: unknown): string | undefined {
  const code = value === undefined || value === null ? null : String(value).trim();
  return code && /^-?[A-Za-z0-9_.:-]{1,160}$/.test(code) ? code : undefined;
}

export function rejectedProviderResponse(value: unknown, fields = ['ret', 'errcode']): string | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  for (const field of fields) {
    if (o[field] !== undefined && o[field] !== 0 && o[field] !== '0') {
      return safeProviderCode(o[field]) ?? 'rejected';
    }
  }
  return null;
}

function isWeixinHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'weixin.qq.com' ||
    normalized.endsWith('.weixin.qq.com') ||
    normalized === 'wechat.com' ||
    normalized.endsWith('.wechat.com')
  );
}

export function normalizeWeixinApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinApiError('invalid-base-url', '微信服务返回了无效的连接地址。');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port !== '' && url.port !== '443')) {
    throw new WeixinApiError('untrusted-base-url', '微信服务返回了不受信任的连接地址。');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

export function normalizeWeixinQrUrl(value: unknown): string {
  const text = nonEmptyString(value);
  if (!text) throw new WeixinApiError('invalid-qr', '微信服务没有返回扫码地址。');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WeixinApiError('invalid-qr', '微信服务返回了无效的扫码地址。');
  }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname)) {
    throw new WeixinApiError('untrusted-qr', '微信服务返回了不受信任的扫码地址。');
  }
  return url.toString();
}

function commonHeaders(): Record<string, string> {
  return { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION) };
}

function authenticatedHeaders(token: string): Record<string, string> {
  return {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    Authorization: `Bearer ${token.trim()}`,
  };
}

function baseInfo(): Record<string, unknown> {
  return { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' };
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

async function requestJson(
  fetchImpl: typeof fetch,
  options: {
    method: 'GET' | 'POST';
    baseUrl: string;
    endpoint: string;
    body?: unknown;
    token?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    authenticated?: boolean;
  },
): Promise<any> {
  const trustedBase = normalizeWeixinApiBaseUrl(options.baseUrl);
  const url = new URL(options.endpoint, trustedBase);
  if (!isWeixinHost(url.hostname)) throw new WeixinApiError('untrusted-endpoint', '拒绝访问不受信任的微信服务地址。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) throw abortError(options.signal);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers: options.authenticated === false ? commonHeaders() : authenticatedHeaders(options.token ?? ''),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WeixinApiError('http-error', `微信服务请求失败（HTTP ${response.status}）。`, {
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new WeixinApiError('invalid-response', '微信服务返回了无法解析的响应。', { cause: error });
    }
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal);
    if (timedOut) throw new WeixinApiError('timeout', '微信服务请求超时。', { cause: error });
    throw error instanceof WeixinApiError
      ? error
      : new WeixinApiError('network-error', '暂时无法访问微信服务。', { cause: error });
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function requestTextSend(
  fetchImpl: typeof fetch,
  createRequest: () => Parameters<typeof requestJson>[1],
  signal?: AbortSignal,
): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJson(fetchImpl, createRequest());
    } catch (error) {
      const retryDelayMs = TEXT_SEND_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || (error as { code?: string })?.code !== 'network-error' || signal?.aborted) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      signal?.throwIfAborted?.();
    }
  }
}

function validateLoginResponse(value: unknown): any {
  if (!value || typeof value !== 'object' || !LOGIN_STATUSES.has(String((value as { status?: unknown }).status))) {
    throw new WeixinApiError('invalid-login-status', '微信服务返回了无法识别的扫码状态。');
  }
  return value;
}

export interface WeixinLoginStart {
  qrcode: string;
  qrcodeUrl: string;
}

export interface WeixinLoginStatus {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
  [key: string]: unknown;
}

export interface WeixinUpdates {
  ret?: number;
  errcode?: number;
  msgs?: unknown[];
  get_updates_buf?: string;
  [key: string]: unknown;
}

export function createWeixinApi({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  return Object.freeze({
    async beginLogin({
      localTokens = [],
      botType = DEFAULT_BOT_TYPE,
      signal,
    }: { localTokens?: string[]; botType?: string; signal?: AbortSignal } = {}): Promise<WeixinLoginStart> {
      const tokens = [...new Set(localTokens.map(nonEmptyString).filter(Boolean))].slice(-10);
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl: WEIXIN_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: tokens },
        timeoutMs: 10_000,
        signal,
        authenticated: false,
      });
      const qrcode = nonEmptyString((response as { qrcode?: unknown })?.qrcode);
      const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
      if (providerCode) throw new WeixinApiError('qr-request-rejected', '微信服务拒绝了二维码申请。', { providerCode });
      if (!qrcode) throw new WeixinApiError('invalid-qr', '微信服务没有返回二维码令牌。');
      return {
        qrcode,
        qrcodeUrl: normalizeWeixinQrUrl((response as { qrcode_img_content?: unknown }).qrcode_img_content),
      };
    },

    async pollLogin({
      qrcode,
      baseUrl = WEIXIN_QR_BASE_URL,
      verifyCode,
      signal,
    }: {
      qrcode: string;
      baseUrl?: string;
      verifyCode?: string;
      signal?: AbortSignal;
    }): Promise<WeixinLoginStatus> {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      if (nonEmptyString(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(String(verifyCode).trim())}`;
      const response = await requestJson(fetchImpl, {
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal,
        authenticated: false,
      });
      return validateLoginResponse(response) as WeixinLoginStatus;
    },

    async getUpdates({
      baseUrl,
      token,
      getUpdatesBuf = '',
      timeoutMs,
      signal,
    }: {
      baseUrl: string;
      token: string;
      getUpdatesBuf?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<WeixinUpdates> {
      try {
        return (await requestJson(fetchImpl, {
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
          token,
          timeoutMs: timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
          signal,
        })) as WeixinUpdates;
      } catch (error) {
        if (error instanceof WeixinApiError && error.code === 'timeout') {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        }
        throw error;
      }
    },

    async sendText({
      baseUrl,
      token,
      toUserId,
      text,
      contextToken,
      signal,
    }: {
      baseUrl: string;
      token: string;
      toUserId: string;
      text: string;
      contextToken?: string;
      signal?: AbortSignal;
    }): Promise<any> {
      const recipient = nonEmptyString(toUserId);
      const content = nonEmptyString(text);
      if (!recipient || !content) throw new TypeError('toUserId and text are required');
      const providerMessageIds: string[] = [];
      for (const chunk of splitWeixinText(content)) {
        const clientId = `dsh-weixin-${randomUUID()}`;
        providerMessageIds.push(clientId);
        const response = await requestTextSend(
          fetchImpl,
          () => ({
            method: 'POST',
            baseUrl,
            endpoint: 'ilink/bot/sendmessage',
            token,
            signal,
            body: {
              msg: {
                from_user_id: '',
                to_user_id: recipient,
                client_id: clientId,
                message_type: 2,
                message_state: 2,
                item_list: [{ type: 1, text_item: { text: chunk } }],
                ...(nonEmptyString(contextToken) ? { context_token: String(contextToken).trim() } : {}),
              },
              base_info: baseInfo(),
            },
          }),
          signal,
        );
        const sendRejection = rejectedProviderResponse(response);
        if (sendRejection) {
          throw new WeixinApiError('send-rejected', '微信服务拒绝了回复消息。', { providerCode: sendRejection });
        }
      }
      return { providerMessageIds };
    },

    async notifyStart({
      baseUrl,
      token,
      signal,
    }: {
      baseUrl: string;
      token: string;
      signal?: AbortSignal;
    }): Promise<any> {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        token,
        signal,
        timeoutMs: 10_000,
        body: { base_info: baseInfo() },
      });
      const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
      if (providerCode)
        throw new WeixinApiError(providerCode === '-14' ? 'stale-token' : 'start-rejected', '微信账号连接启动失败。', {
          providerCode,
        });
      return response;
    },

    async notifyStop({
      baseUrl,
      token,
      signal,
    }: {
      baseUrl: string;
      token: string;
      signal?: AbortSignal;
    }): Promise<any> {
      const response = await requestJson(fetchImpl, {
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        token,
        signal,
        timeoutMs: 10_000,
        body: { base_info: baseInfo() },
      });
      const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
      if (providerCode) throw new WeixinApiError('stop-rejected', '微信服务未确认停止通知。', { providerCode });
      return response;
    },
  });
}

export function extractWeixinText(message: unknown): string | null {
  const items = (message as { item_list?: unknown })?.item_list;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const i = item as { type?: unknown; text_item?: { text?: unknown }; voice_item?: { text?: unknown } };
    if (i?.type === 1 && typeof i.text_item?.text === 'string') {
      const text = i.text_item.text.trim();
      if (text) return text;
    }
    if (i?.type === 3 && typeof i.voice_item?.text === 'string') {
      const text = i.voice_item.text.trim();
      if (text) return text;
    }
  }
  return null;
}

export function weixinMessageId(message: unknown): string {
  const m = message as { message_id?: unknown; client_id?: unknown };
  if (m?.message_id !== undefined && m.message_id !== null) return String(m.message_id);
  return nonEmptyString(m?.client_id) ?? '';
}

export function splitWeixinText(text: string, maxChars = DEFAULT_WEIXIN_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function orderWeixinMessages(messages: unknown[]): unknown[] {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const fields = ['seq', 'create_time_ms'];
  const field = fields.find((f) =>
    messages.every((m) => {
      const v = (m as Record<string, unknown>)?.[f];
      return (
        (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)))
      );
    }),
  );
  if (!field) return messages;
  return messages
    .map((message, index) => ({ message, index, order: Number((message as Record<string, unknown>)[field]) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((x) => x.message);
}
