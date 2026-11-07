/**
 * QQ 官方机器人文本运行时（AppID + AppSecret）。
 *
 * 使用 @tencent-connect/qqbot-nodejs 的 WebSocket 长连接；只保留私聊与群聊文本，
 * 不引入 dsh-im 的 Harness Session / 命令 / 图片文件系统。
 * @module dsh-pet/src/host/im/qq
 */
import { createHash } from 'node:crypto';
import { QQBot, type QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';

import type { ImBotConfig } from '../../shared/im';
import type { ImStore, QqAuth } from './store';
import type { ImChat, ImLogger } from './wechat';

export interface QqRuntimeStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error';
  connected: boolean;
  appId?: string;
  lastCheckedAt?: number;
  lastError?: string;
  messagesReceived: number;
  messagesReplied: number;
}

function maskAppId(appId: string): string {
  if (appId.length <= 10) return appId ? `${appId.slice(0, 3)}•••` : '';
  return `${appId.slice(0, 6)}••••${appId.slice(-4)}`;
}

export function deriveQqBotId(appId: string): string {
  return 'qq_' + createHash('sha256').update(appId).digest('hex').slice(0, 24);
}

export class QqRuntime {
  #auth: QqAuth;
  #store: ImStore;
  #chat: ImChat;
  #log: ImLogger;
  #bot: QQBot | null = null;
  #controller: AbortController | null = null;
  #run: Promise<void> | null = null;
  #botIds = new Set<string>();
  #status: QqRuntimeStatus = { state: 'idle', connected: false, messagesReceived: 0, messagesReplied: 0 };

  constructor(options: { auth: QqAuth; store: ImStore; getConfig: () => ImBotConfig; chat: ImChat; log: ImLogger }) {
    this.#auth = options.auth;
    this.#store = options.store;
    this.#chat = options.chat;
    this.#log = options.log;
  }

  status(): QqRuntimeStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    if (this.#run) return;
    this.#status = {
      ...this.#status,
      state: 'connecting',
      connected: false,
      appId: maskAppId(this.#auth.appId),
      lastError: undefined,
    };
    const controller = new AbortController();
    this.#controller = controller;
    const logger = {
      error: (...args: unknown[]) => this.#log.error(`[dsh-pet:qq] ${args.map(String).join(' ')}`),
      warn: (...args: unknown[]) => this.#log.warn(`[dsh-pet:qq] ${args.map(String).join(' ')}`),
      info: () => {},
      debug: () => {},
    };
    const bot = new QQBot({
      appId: this.#auth.appId,
      appSecret: this.#auth.appSecret,
      accountId: this.#auth.botId,
      logger,
      transport: 'websocket',
    });
    this.#bot = bot;
    this.#botIds = new Set([this.#auth.appId]);
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: unknown) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const markReady = (data: unknown): void => {
      const id = (data as { user?: { id?: unknown } } | undefined)?.user?.id;
      if (typeof id === 'string' && id.trim()) this.#botIds.add(id);
      this.#status.state = 'connected';
      this.#status.connected = true;
      this.#status.lastCheckedAt = Date.now();
      this.#status.lastError = undefined;
      readyResolve?.();
      readyResolve = null;
    };
    bot.on('ready', markReady);
    bot.on('resumed', markReady);
    bot.on('error', (error: unknown) => {
      this.#status.lastError = error instanceof Error ? error.message : String(error);
      if (!this.#status.connected) readyReject?.(error);
    });
    bot.on('message', (_ctx: unknown, message: QQBotInboundMessage) => {
      void this.#handle(message).catch((error) => {
        this.#log.error(`[dsh-pet:qq] 消息处理失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.#run = Promise.resolve()
      .then(() => bot.start(controller.signal))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.#status.state = 'error';
        this.#status.connected = false;
        this.#status.lastError = error instanceof Error ? error.message : String(error);
        readyReject?.(error);
      })
      .finally(() => {
        this.#run = null;
        if (this.#controller === controller) this.#controller = null;
        this.#status.connected = false;
        if (this.#status.state === 'connected') this.#status.state = 'idle';
      });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('QQ WebSocket 连接超时')), 20_000);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      this.#status.state = 'error';
      this.#status.connected = false;
      this.#status.lastError = error instanceof Error ? error.message : String(error);
      await this.stop();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = null;
    const bot = this.#bot;
    this.#bot = null;
    try {
      bot?.stop();
    } catch {
      // 已断线时 stop 可能抛错，忽略
    }
    await Promise.race([
      this.#run?.catch(() => undefined) ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.#run = null;
    this.#status.state = 'idle';
    this.#status.connected = false;
  }

  async #handle(message: QQBotInboundMessage): Promise<void> {
    if (!message || message.senderIsBot === true) return;
    if (message.kind !== 'c2c' && message.kind !== 'group') return;
    const isGroup = message.kind === 'group';
    if (isGroup) {
      const addressed =
        message.rawEventType === 'GROUP_AT_MESSAGE_CREATE' ||
        (Array.isArray(message.mentions) && message.mentions.some((mention) => mention?.is_you === true));
      if (!addressed) return;
    }
    const id = isGroup ? (message.groupOpenid ?? '') : message.senderId;
    const text = typeof message.content === 'string' ? message.content.replace(/<@!?[^<>\s]+>/gu, '').trim() : '';
    if (!id || !message.messageId || !text) return;
    if (this.#store.qqState(this.#auth.botId).seenMessageIds.includes(message.messageId)) return;
    this.#status.messagesReceived += 1;
    const result = await this.#chat({
      platform: 'qq',
      senderId: id,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      text,
      messageId: message.messageId,
      isGroup,
    });
    if (result.reply && this.#bot) {
      try {
        await this.#bot.sendText(message.replyTarget, result.reply);
        this.#status.messagesReplied += 1;
      } catch (error) {
        this.#log.warn(`[dsh-pet:qq] 回复发送失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#store.qqState(this.#auth.botId).seenMessageIds.push(message.messageId);
    if (this.#store.qqState(this.#auth.botId).seenMessageIds.length > 1_000) {
      this.#store
        .qqState(this.#auth.botId)
        .seenMessageIds.splice(0, this.#store.qqState(this.#auth.botId).seenMessageIds.length - 1_000);
    }
    await this.#store.saveState();
  }
}
