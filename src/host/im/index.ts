/**
 * 原生微信 / QQ 接入的总控（每平台多机器人）。
 *
 * 每个 bot 独立配置 mode：
 *  - pet：调用 chatWithPet，使用桌宠人格/灵魂/记忆；
 *  - session：通过 DshSessionRunner 投递到固定 DSH session，由该 session 回复。
 * @module dsh-pet/src/host/im
 */
import type {
  ImBotConfig,
  ImBotStatusView,
  ImConfig,
  ImLoginAttemptView,
  ImPlatform,
  ImStatusView,
} from '../../shared/im';
import type { ImStore, QqAuth, WechatAuth } from './store';
import { createWeixinApi } from './weixin-api';
import { WechatLogin, WechatRuntime, type WechatAttempt } from './wechat';
import { QqRuntime } from './qq';
import type { ImInbound, ImLogger } from './wechat';
import { DshSessionRunner } from './session';

type ChatFn = (
  petId: string,
  text: string,
  opts: { memoryKey: string; writeSay: boolean; speaker: string },
) => Promise<{ ok: true; text: string; image?: string } | { ok: false; reason: string; message?: string }>;

function maskId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}••${value.slice(-4)}`;
}

function platformName(platform: ImPlatform): string {
  return platform === 'wechat' ? '微信' : 'QQ';
}

function idleStatus(bot: ImBotConfig): ImBotStatusView {
  return {
    id: bot.id,
    enabled: bot.enabled,
    mode: bot.mode,
    connected: false,
    state: 'idle',
    messagesReceived: 0,
    messagesReplied: 0,
  };
}

export class NativeImManager {
  #store: ImStore;
  #getConfig: () => ImConfig;
  #chat: ChatFn;
  #log: ImLogger;
  #session: DshSessionRunner;
  #wechatApi = createWeixinApi();
  #wechatLogins = new Map<string, WechatLogin>();
  #wechatRuntimes = new Map<string, WechatRuntime>();
  #qqRuntimes = new Map<string, QqRuntime>();
  #started = false;

  constructor(options: { store: ImStore; getConfig: () => ImConfig; chat: ChatFn; log: ImLogger; ctx: unknown }) {
    this.#store = options.store;
    this.#getConfig = options.getConfig;
    this.#chat = options.chat;
    this.#log = options.log;
    this.#session = new DshSessionRunner(options.ctx);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#store.load();
    this.#sync();
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const login of this.#wechatLogins.values()) login.cancel();
    this.#wechatLogins.clear();
    await Promise.allSettled([...this.#wechatRuntimes.values()].map((runtime) => runtime.stop()));
    this.#wechatRuntimes.clear();
    await Promise.allSettled([...this.#qqRuntimes.values()].map((runtime) => runtime.stop()));
    this.#qqRuntimes.clear();
  }

  reload(): void {
    this.#sync();
  }

  async listSessions(signal?: AbortSignal) {
    return this.#session.listSessions(signal);
  }

  status(): ImStatusView {
    const config = this.#getConfig();
    const wechatBots = [...config.wechat.bots];
    const qqBots = [...config.qq.bots];
    const wechatIds = new Set(wechatBots.map((bot) => bot.id));
    const qqIds = new Set(qqBots.map((bot) => bot.id));
    // 新加的机器人可能还没点「保存」，但已经扫码/绑定；把内存里的连接也列出来，
    // 设置页才能显示二维码/连接状态。保存后由正式配置取代这些临时条目。
    for (const id of [
      ...this.#wechatLogins.keys(),
      ...this.#wechatRuntimes.keys(),
      ...Object.keys(this.#store.auth.wechat),
    ]) {
      if (!wechatIds.has(id)) wechatBots.push(this.#temporaryBot(id));
    }
    for (const id of [...this.#qqRuntimes.keys(), ...Object.keys(this.#store.auth.qq)]) {
      if (!qqIds.has(id)) qqBots.push(this.#temporaryBot(id));
    }
    return {
      wechat: { bots: wechatBots.map((bot) => this.#wechatStatus(bot)) },
      qq: { bots: qqBots.map((bot) => this.#qqStatus(bot)) },
    };
  }

  #temporaryBot(id: string): ImBotConfig {
    return {
      id,
      enabled: false,
      mode: 'pet',
      petId: '',
      sessionId: '',
      whitelist: [],
      allowOwner: true,
      allowGroups: false,
      writeSay: false,
    };
  }

  async startWechatLogin(botId: string): Promise<WechatAttempt> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(botId)) throw new Error('机器人 id 非法');
    this.#wechatLogins.get(botId)?.cancel();
    const login = new WechatLogin(this.#wechatApi, this.#store, botId, async (auth) => {
      await this.#startWechat(botId, auth);
    });
    this.#wechatLogins.set(botId, login);
    return login.start();
  }

  wechatLoginStatus(botId: string): WechatAttempt | null {
    return this.#wechatLogins.get(botId)?.status() ?? null;
  }

  cancelWechatLogin(botId: string): void {
    this.#wechatLogins.get(botId)?.cancel();
    this.#wechatLogins.delete(botId);
  }

  submitWechatVerifyCode(botId: string, code: string): WechatAttempt | null {
    return this.#wechatLogins.get(botId)?.submitVerifyCode(code) ?? null;
  }

  async logoutWechat(botId: string): Promise<void> {
    this.cancelWechatLogin(botId);
    const runtime = this.#wechatRuntimes.get(botId);
    this.#wechatRuntimes.delete(botId);
    await runtime?.stop().catch(() => undefined);
    await this.#store.clearAuth('wechat', botId);
    await this.#store.clearState('wechat', botId);
  }

  async bindQq(botId: string, appId: string, appSecret: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(botId)) throw new Error('机器人 id 非法');
    const id = appId.trim();
    const secret = appSecret.trim();
    if (!id || !secret) throw new Error('QQ AppID 和 AppSecret 都必填');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('QQ AppID 格式不正确');
    if (secret.length > 512) throw new Error('QQ AppSecret 过长');
    const auth: QqAuth = {
      botId,
      appId: id,
      appSecret: secret,
      ownerUserOpenid: '',
      connectedAt: new Date().toISOString(),
    };
    this.#store.auth.qq[botId] = auth;
    await this.#store.saveAuth();
    await this.#startQq(botId, auth);
  }

  async logoutQq(botId: string): Promise<void> {
    const runtime = this.#qqRuntimes.get(botId);
    this.#qqRuntimes.delete(botId);
    await runtime?.stop().catch(() => undefined);
    await this.#store.clearAuth('qq', botId);
    await this.#store.clearState('qq', botId);
  }

  #findBot(platform: ImPlatform, botId: string): ImBotConfig | undefined {
    return this.#getConfig()[platform].bots.find((bot) => bot.id === botId);
  }

  #wechatStatus(bot: ImBotConfig): ImBotStatusView {
    const runtime = this.#wechatRuntimes.get(bot.id)?.status();
    const auth = this.#store.auth.wechat[bot.id];
    const login = this.#wechatLogins.get(bot.id)?.status() ?? null;
    const base = idleStatus(bot);
    return {
      ...base,
      connected: runtime?.connected === true,
      state: runtime?.state ?? 'idle',
      ...(maskId(auth?.accountId) ? { account: maskId(auth?.accountId) } : {}),
      ...(maskId(auth?.ownerUserId) ? { owner: maskId(auth?.ownerUserId) } : {}),
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      messagesReceived: runtime?.messagesReceived ?? 0,
      messagesReplied: runtime?.messagesReplied ?? 0,
      ...(login ? { login: login as unknown as ImLoginAttemptView } : {}),
    };
  }

  #qqStatus(bot: ImBotConfig): ImBotStatusView {
    const runtime = this.#qqRuntimes.get(bot.id)?.status();
    const base = idleStatus(bot);
    return {
      ...base,
      connected: runtime?.connected === true,
      state: runtime?.state ?? 'idle',
      ...(runtime?.appId ? { appId: runtime.appId } : {}),
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      messagesReceived: runtime?.messagesReceived ?? 0,
      messagesReplied: runtime?.messagesReplied ?? 0,
    };
  }

  #sync(): void {
    if (!this.#started) return;
    const config = this.#getConfig();
    this.#syncPlatform('wechat', config.wechat.bots);
    this.#syncPlatform('qq', config.qq.bots);
  }

  #syncPlatform(platform: ImPlatform, bots: ImBotConfig[]): void {
    const ids = new Set(bots.map((bot) => bot.id));
    if (platform === 'wechat') {
      for (const [id, runtime] of this.#wechatRuntimes) {
        if (!ids.has(id) || !bots.find((bot) => bot.id === id)?.enabled) {
          this.#wechatRuntimes.delete(id);
          void runtime.stop().catch(() => undefined);
        }
      }
      for (const [id, login] of this.#wechatLogins) {
        if (!ids.has(id)) {
          login.cancel();
          this.#wechatLogins.delete(id);
        }
      }
      for (const bot of bots) {
        if (!bot.enabled || this.#wechatRuntimes.has(bot.id)) continue;
        const auth = this.#store.auth.wechat[bot.id];
        if (auth) {
          void this.#startWechat(bot.id, auth).catch((error) => {
            this.#log.warn(
              `[dsh-pet] 微信 ${bot.id} 连接失败：${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }
      return;
    }
    for (const [id, runtime] of this.#qqRuntimes) {
      if (!ids.has(id) || !bots.find((bot) => bot.id === id)?.enabled) {
        this.#qqRuntimes.delete(id);
        void runtime.stop().catch(() => undefined);
      }
    }
    for (const bot of bots) {
      if (!bot.enabled || this.#qqRuntimes.has(bot.id)) continue;
      const auth = this.#store.auth.qq[bot.id];
      if (auth) {
        void this.#startQq(bot.id, auth).catch((error) => {
          this.#log.warn(`[dsh-pet] QQ ${bot.id} 连接失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  async #startWechat(botId: string, auth: WechatAuth): Promise<void> {
    await this.#wechatRuntimes
      .get(botId)
      ?.stop()
      .catch(() => undefined);
    const runtime = new WechatRuntime({
      api: this.#wechatApi,
      auth,
      store: this.#store,
      getConfig: () => this.#findBot('wechat', botId) ?? ({ enabled: false } as never),
      chat: (inbound) => this.#handle(botId, inbound),
      log: this.#log,
    });
    this.#wechatRuntimes.set(botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      if (this.#wechatRuntimes.get(botId) === runtime) this.#wechatRuntimes.delete(botId);
      await runtime.stop().catch(() => undefined);
      throw error;
    }
  }

  async #startQq(botId: string, auth: QqAuth): Promise<void> {
    await this.#qqRuntimes
      .get(botId)
      ?.stop()
      .catch(() => undefined);
    const runtime = new QqRuntime({
      auth,
      store: this.#store,
      getConfig: () => this.#findBot('qq', botId) ?? ({ enabled: false } as never),
      chat: (inbound) => this.#handle(botId, inbound),
      log: this.#log,
    });
    this.#qqRuntimes.set(botId, runtime);
    try {
      await runtime.start();
    } catch (error) {
      if (this.#qqRuntimes.get(botId) === runtime) this.#qqRuntimes.delete(botId);
      await runtime.stop().catch(() => undefined);
      throw error;
    }
  }

  async #handle(botId: string, inbound: ImInbound): Promise<{ reply?: string; reason?: string; message?: string }> {
    const platform = inbound.platform;
    const config = this.#findBot(platform, botId);
    if (!config || !config.enabled) return { reason: 'bot-disabled' };
    if (inbound.isGroup && !config.allowGroups) return { reason: 'group-not-allowed' };
    if (!this.#allowed(platform, botId, config, inbound)) return { reason: 'not-whitelisted' };
    if (config.mode === 'session') {
      if (!config.sessionId.trim()) return { reason: 'session-required' };
      try {
        const reply = await this.#session.ask(config.sessionId, inbound.text);
        return { reply };
      } catch (error) {
        return { reason: 'session-error', message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!config.petId.trim()) return { reason: 'pet-required' };
    const speaker = `${platformName(platform)}·${inbound.senderName || inbound.senderId}`;
    const result = await this.#chat(config.petId, inbound.text, {
      memoryKey: `im:${platform}:${botId}:${inbound.senderId}`,
      writeSay: config.writeSay,
      speaker,
    });
    if (!result.ok) return { reason: result.reason, ...(result.message ? { message: result.message } : {}) };
    return { reply: result.text };
  }

  #allowed(platform: ImPlatform, botId: string, config: ImBotConfig, inbound: ImInbound): boolean {
    if (config.whitelist.some((entry) => entry.platform === platform && entry.id === inbound.senderId)) return true;
    if (!config.allowOwner) return false;
    const owner =
      platform === 'wechat' ? this.#store.auth.wechat[botId]?.ownerUserId : this.#store.auth.qq[botId]?.ownerUserOpenid;
    return Boolean(owner && owner === inbound.senderId);
  }
}
