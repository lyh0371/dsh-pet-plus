/**
 * 微信原生文本运行时：扫码登录、长轮询、白名单过滤、调用 pet 对话、发回文本。
 *
 * 协议实现见 ./weixin-api（文本子集，源自 dsh-im，MIT）。
 * @module dsh-pet/src/host/im/wechat
 */
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

import type { ImBotConfig } from '../../shared/im';
import type { ImStore, WechatAuth } from './store';
import {
  createWeixinApi,
  extractWeixinText,
  normalizeWeixinApiBaseUrl,
  orderWeixinMessages,
  rejectedProviderResponse,
  weixinMessageId,
  WeixinApiError,
} from './weixin-api';

export type WechatApi = ReturnType<typeof createWeixinApi>;

export interface ImInbound {
  platform: 'wechat' | 'qq';
  senderId: string;
  senderName?: string;
  text: string;
  messageId: string;
  isGroup: boolean;
}

export interface ImReplyResult {
  reply?: string;
  reason?: string;
  message?: string;
}

export type ImChat = (inbound: ImInbound) => Promise<ImReplyResult>;

export interface ImLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface WechatRuntimeStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error';
  connected: boolean;
  accountId?: string;
  ownerUserId?: string;
  lastCheckedAt?: number;
  lastError?: string;
  messagesReceived: number;
  messagesReplied: number;
}

export class WechatRuntime {
  #api: WechatApi;
  #auth: WechatAuth;
  #store: ImStore;
  #chat: ImChat;
  #log: ImLogger;
  #status: WechatRuntimeStatus = { state: 'idle', connected: false, messagesReceived: 0, messagesReplied: 0 };
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;

  constructor(options: {
    api: WechatApi;
    auth: WechatAuth;
    store: ImStore;
    getConfig: () => ImBotConfig;
    chat: ImChat;
    log: ImLogger;
  }) {
    this.#api = options.api;
    this.#auth = options.auth;
    this.#store = options.store;
    this.#chat = options.chat;
    this.#log = options.log;
  }

  status(): WechatRuntimeStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    if (this.#loop) return;
    this.#status = {
      ...this.#status,
      state: 'connecting',
      connected: false,
      accountId: this.#auth.accountId,
      ownerUserId: this.#auth.ownerUserId,
      lastError: undefined,
    };
    const controller = new AbortController();
    this.#controller = controller;
    try {
      await this.#api.notifyStart({ baseUrl: this.#auth.baseUrl, token: this.#auth.token, signal: controller.signal });
      if (controller.signal.aborted) return;
      this.#status.state = 'connected';
      this.#status.connected = true;
      this.#status.lastCheckedAt = Date.now();
      this.#loop = this.#run(controller.signal).finally(() => {
        this.#loop = null;
        if (this.#controller === controller) this.#controller = null;
        this.#status.connected = false;
        if (this.#status.state === 'connected') this.#status.state = 'idle';
      });
    } catch (e) {
      this.#controller = null;
      this.#status.state = 'error';
      this.#status.connected = false;
      this.#status.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
    await this.#loop?.catch(() => undefined);
    this.#loop = null;
    if (this.#status.connected || this.#status.state === 'connecting') {
      try {
        await this.#api.notifyStop({
          baseUrl: this.#auth.baseUrl,
          token: this.#auth.token,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // 断线场景下停止通知失败不影响本地关闭
      }
    }
    this.#status.state = 'idle';
    this.#status.connected = false;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await this.#api.getUpdates({
          baseUrl: this.#auth.baseUrl,
          token: this.#auth.token,
          getUpdatesBuf: this.#store.wechatState(this.#auth.botId).getUpdatesBuf,
          signal,
        });
        if (signal.aborted) return;
        const providerCode = rejectedProviderResponse(response, ['errcode', 'ret']);
        if (providerCode) {
          throw new WeixinApiError(
            providerCode === '-14' ? 'stale-token' : 'updates-rejected',
            providerCode === '-14' ? '微信登录凭据已失效，请重新扫码。' : '微信消息同步请求被拒绝。',
            { providerCode },
          );
        }
        failures = 0;
        this.#status.state = 'connected';
        this.#status.connected = true;
        this.#status.lastCheckedAt = Date.now();
        this.#status.lastError = undefined;
        for (const raw of orderWeixinMessages(Array.isArray(response.msgs) ? response.msgs : [])) {
          await this.#handle(raw).catch((error) => {
            this.#log.error(`[dsh-pet] 微信消息处理失败：${error instanceof Error ? error.message : String(error)}`);
          });
        }
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) {
          this.#store.wechatState(this.#auth.botId).getUpdatesBuf = response.get_updates_buf;
          await this.#store.saveState();
        }
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        this.#status.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof WeixinApiError && error.code === 'stale-token') {
          this.#status.state = 'error';
          this.#status.connected = false;
          return;
        }
        if (failures >= 3) {
          this.#status.state = 'error';
          this.#status.connected = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000 * 2 ** (failures - 1), 10_000)));
      }
    }
  }

  async #handle(raw: unknown): Promise<void> {
    const message = raw as {
      from_user_id?: unknown;
      context_token?: unknown;
      message_id?: unknown;
      item_list?: unknown;
    };
    const senderId = typeof message.from_user_id === 'string' ? message.from_user_id.trim() : '';
    const messageId = weixinMessageId(message);
    const text = extractWeixinText(message)?.trim() ?? '';
    if (!senderId || !messageId || !text) return;
    if (this.#store.wechatState(this.#auth.botId).seenMessageIds.includes(messageId)) return;
    this.#status.messagesReceived += 1;
    const contextToken = typeof message.context_token === 'string' ? message.context_token : undefined;
    if (contextToken) {
      this.#store.wechatState(this.#auth.botId).contextTokens[senderId] = { token: contextToken, at: Date.now() };
      await this.#store.saveState();
    }
    const result = await this.#chat({
      platform: 'wechat',
      senderId,
      text,
      messageId,
      isGroup: false,
    });
    if (result.reply) {
      try {
        await this.#api.sendText({
          baseUrl: this.#auth.baseUrl,
          token: this.#auth.token,
          toUserId: senderId,
          text: result.reply,
          contextToken: this.#store.wechatState(this.#auth.botId).contextTokens[senderId]?.token,
        });
        this.#status.messagesReplied += 1;
      } catch (error) {
        this.#log.warn(`[dsh-pet] 微信回复发送失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 不回复的白名单外消息也标为已见，避免每轮重复计数/重复调用。
    this.#store.wechatState(this.#auth.botId).seenMessageIds.push(messageId);
    if (this.#store.wechatState(this.#auth.botId).seenMessageIds.length > 1_000) {
      this.#store
        .wechatState(this.#auth.botId)
        .seenMessageIds.splice(0, this.#store.wechatState(this.#auth.botId).seenMessageIds.length - 1_000);
    }
    await this.#store.saveState();
  }
}

export interface WechatAttempt {
  botId: string;
  id: string;
  status: 'starting' | 'pending' | 'scanned' | 'needs_verification' | 'connecting' | 'connected' | 'expired' | 'failed';
  qrCodeDataUrl?: string;
  verificationUrl?: string;
  expiresAt: number;
  verificationRequired?: boolean;
  accountId?: string;
  error?: { code: string; message: string };
}

const QR_TTL_MS = 5 * 60_000;

export class WechatLogin {
  #api: WechatApi;
  #store: ImStore;
  #onAuth: (auth: WechatAuth) => Promise<void>;
  #attempt: WechatAttempt | null = null;
  #controller: AbortController | null = null;
  #qrcode = '';
  #baseUrl = 'https://ilinkai.weixin.qq.com/';
  #verifyCode = '';
  #botId: string;

  constructor(api: WechatApi, store: ImStore, botId: string, onAuth: (auth: WechatAuth) => Promise<void>) {
    this.#api = api;
    this.#store = store;
    this.#botId = botId;
    this.#onAuth = onAuth;
  }

  status(): WechatAttempt | null {
    return this.#attempt ? { ...this.#attempt } : null;
  }

  async start(): Promise<WechatAttempt> {
    this.cancel();
    const attempt: WechatAttempt = {
      botId: this.#botId,
      id: randomUUID(),
      status: 'starting',
      expiresAt: Date.now() + QR_TTL_MS,
    };
    this.#attempt = attempt;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const login = await this.#api.beginLogin({
        localTokens: this.#store.auth.wechat[this.#botId]?.token ? [this.#store.auth.wechat[this.#botId].token] : [],
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error('cancelled');
      this.#qrcode = login.qrcode;
      this.#baseUrl = 'https://ilinkai.weixin.qq.com/';
      attempt.qrCodeDataUrl = await QRCode.toDataURL(login.qrcodeUrl, { margin: 1, width: 280 });
      attempt.verificationUrl = login.qrcodeUrl;
      attempt.status = 'pending';
      void this.#loop(attempt, controller.signal);
      return { ...attempt };
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = { code: 'qr-start-failed', message: error instanceof Error ? error.message : String(error) };
      this.#controller = null;
      throw error;
    }
  }

  cancel(): void {
    this.#controller?.abort();
    this.#controller = null;
    if (this.#attempt && !['connected', 'failed', 'expired'].includes(this.#attempt.status)) {
      this.#attempt.status = 'expired';
    }
  }

  submitVerifyCode(code: string): WechatAttempt | null {
    this.#verifyCode = code.trim();
    return this.status();
  }

  async #loop(attempt: WechatAttempt, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted && Date.now() < attempt.expiresAt) {
        const response = await this.#api.pollLogin({
          qrcode: this.#qrcode,
          baseUrl: this.#baseUrl,
          verifyCode: this.#verifyCode,
          signal,
        });
        if (signal.aborted) return;
        switch (response.status) {
          case 'wait':
            attempt.status = 'pending';
            break;
          case 'scaned':
            this.#verifyCode = '';
            attempt.status = 'scanned';
            break;
          case 'need_verifycode':
            this.#verifyCode = '';
            attempt.status = 'needs_verification';
            attempt.verificationRequired = true;
            break;
          case 'verify_code_blocked':
            attempt.status = 'failed';
            attempt.error = { code: 'verification-blocked', message: '配对码多次错误，请重新生成二维码。' };
            return;
          case 'expired':
            attempt.status = 'expired';
            attempt.error = { code: 'expired', message: '二维码已过期，请重新生成。' };
            return;
          case 'scaned_but_redirect':
            if (typeof response.redirect_host === 'string' && response.redirect_host.trim()) {
              this.#baseUrl = normalizeWeixinApiBaseUrl(
                response.redirect_host.includes('://') ? response.redirect_host : `https://${response.redirect_host}`,
              );
            }
            attempt.status = 'scanned';
            break;
          case 'binded_redirect': {
            const existing = this.#store.auth.wechat[this.#botId];
            if (existing) {
              attempt.status = 'connected';
              attempt.accountId = existing.accountId;
              await this.#onAuth(existing);
            } else {
              attempt.status = 'failed';
              attempt.error = { code: 'already-bound', message: '该微信账号已绑定，但本机没有可恢复的凭据。' };
            }
            return;
          }
          case 'confirmed': {
            const token = typeof response.bot_token === 'string' ? response.bot_token.trim() : '';
            const accountId = typeof response.ilink_bot_id === 'string' ? response.ilink_bot_id.trim() : '';
            const ownerUserId = typeof response.ilink_user_id === 'string' ? response.ilink_user_id.trim() : '';
            if (!token || !accountId || !ownerUserId) {
              attempt.status = 'failed';
              attempt.error = { code: 'incomplete-login', message: '微信授权成功，但返回的账号凭据不完整。' };
              return;
            }
            attempt.status = 'connecting';
            const baseUrl = normalizeWeixinApiBaseUrl(
              typeof response.baseurl === 'string' && response.baseurl.trim() ? response.baseurl : this.#baseUrl,
            );
            const auth: WechatAuth = {
              botId: this.#botId,
              accountId,
              ownerUserId,
              token,
              baseUrl,
              connectedAt: new Date().toISOString(),
            };
            this.#store.auth.wechat[this.#botId] = auth;
            await this.#store.saveAuth();
            await this.#onAuth(auth);
            attempt.status = 'connected';
            attempt.accountId = accountId;
            attempt.verificationRequired = false;
            return;
          }
          default:
            attempt.status = 'failed';
            attempt.error = { code: 'invalid-login-status', message: '微信返回了无法识别的扫码状态。' };
            return;
        }
      }
      if (!signal.aborted && attempt.status !== 'connected') {
        attempt.status = 'expired';
        attempt.error = { code: 'expired', message: '二维码已过期，请重新生成。' };
      }
    } catch (error) {
      if (signal.aborted) return;
      attempt.status = 'failed';
      attempt.error = { code: 'login-failed', message: error instanceof Error ? error.message : String(error) };
    }
  }
}
