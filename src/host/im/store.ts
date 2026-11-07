/**
 * 原生微信 / QQ 接入的本地持久化（支持每平台多个机器人）。
 *
 * - im-auth.json：按 botId 保存登录凭据，0600；
 * - im-state.json：按 botId 保存长轮询游标 / context_token / 去重 id，0600。
 * 两份都不进入 main-config.jsonc，也不会打日志。
 * @module dsh-pet/src/host/im/store
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface WechatAuth {
  botId: string;
  accountId: string;
  ownerUserId: string;
  token: string;
  baseUrl: string;
  connectedAt: string;
}

export interface QqAuth {
  botId: string;
  appId: string;
  appSecret: string;
  ownerUserOpenid: string;
  connectedAt: string;
}

export interface ImAuth {
  version: 2;
  wechat: Record<string, WechatAuth>;
  qq: Record<string, QqAuth>;
}

export interface ImStateBot {
  getUpdatesBuf: string;
  seenMessageIds: string[];
  contextTokens: Record<string, { token: string; seq?: string; at: number }>;
}

export interface ImState {
  version: 2;
  wechat: Record<string, ImStateBot>;
  qq: Record<string, { seenMessageIds: string[] }>;
}

function emptyBot(): ImStateBot {
  return { getUpdatesBuf: '', seenMessageIds: [], contextTokens: {} };
}

function safeString(value: unknown, max = 4096): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeBotId(value: unknown): string {
  const id = safeString(value, 64);
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : '';
}

function normalizeWechatAuth(raw: unknown): WechatAuth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const botId = safeBotId(o.botId);
  const accountId = safeString(o.accountId, 256);
  const ownerUserId = safeString(o.ownerUserId, 256);
  const token = safeString(o.token, 4096);
  if (!botId || !accountId || !ownerUserId || !token) return null;
  return {
    botId,
    accountId,
    ownerUserId,
    token,
    baseUrl: safeString(o.baseUrl, 2048) || 'https://ilinkai.weixin.qq.com/',
    connectedAt: safeString(o.connectedAt, 64) || new Date().toISOString(),
  };
}

function normalizeQqAuth(raw: unknown): QqAuth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const botId = safeBotId(o.botId);
  const appId = safeString(o.appId, 128);
  const appSecret = safeString(o.appSecret, 512);
  const ownerUserOpenid = safeString(o.ownerUserOpenid, 256);
  if (!botId || !appId || !appSecret) return null;
  return {
    botId,
    appId,
    appSecret,
    ownerUserOpenid,
    connectedAt: safeString(o.connectedAt, 64) || new Date().toISOString(),
  };
}

function normalizeAuth(raw: unknown): ImAuth {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const wechat: Record<string, WechatAuth> = {};
  const qq: Record<string, QqAuth> = {};
  const w = o.wechat;
  if (w && typeof w === 'object' && !Array.isArray(w)) {
    // v2：{ botId: auth }；v1：单个 auth 对象。
    const entries = 'token' in (w as Record<string, unknown>) ? { 'wechat-1': w } : (w as Record<string, unknown>);
    for (const [key, value] of Object.entries(entries)) {
      const auth = normalizeWechatAuth(value);
      if (auth) {
        auth.botId = safeBotId(key) || auth.botId;
        wechat[auth.botId] = auth;
      }
    }
  }
  const q = o.qq;
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    const entries = 'appSecret' in (q as Record<string, unknown>) ? { 'qq-1': q } : (q as Record<string, unknown>);
    for (const [key, value] of Object.entries(entries)) {
      const auth = normalizeQqAuth(value);
      if (auth) {
        auth.botId = safeBotId(key) || auth.botId;
        qq[auth.botId] = auth;
      }
    }
  }
  return { version: 2, wechat, qq };
}

function normalizeState(raw: unknown): ImState {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const wechat: Record<string, ImStateBot> = {};
  const qq: Record<string, { seenMessageIds: string[] }> = {};
  const w = o.wechat;
  if (w && typeof w === 'object' && !Array.isArray(w)) {
    const entries =
      'getUpdatesBuf' in (w as Record<string, unknown>) ? { 'wechat-1': w } : (w as Record<string, unknown>);
    for (const [id, value] of Object.entries(entries)) {
      const botId = safeBotId(id);
      if (!botId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      const contexts: ImStateBot['contextTokens'] = {};
      const rawContexts =
        v.contextTokens && typeof v.contextTokens === 'object' ? (v.contextTokens as Record<string, unknown>) : {};
      for (const [sender, entry] of Object.entries(rawContexts).slice(-1000)) {
        const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        const token = safeString(e.token, 4096);
        if (!sender || !token) continue;
        contexts[sender] = {
          token,
          ...(safeString(e.seq, 64) ? { seq: safeString(e.seq, 64) } : {}),
          at: Number.isFinite(Number(e.at)) ? Number(e.at) : Date.now(),
        };
      }
      wechat[botId] = {
        getUpdatesBuf: safeString(v.getUpdatesBuf, 4096),
        seenMessageIds: Array.isArray(v.seenMessageIds)
          ? v.seenMessageIds
              .map((x) => safeString(x, 256))
              .filter(Boolean)
              .slice(-1000)
          : [],
        contextTokens: contexts,
      };
    }
  }
  const q = o.qq;
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    const entries = 'seenMessageIds' in (q as Record<string, unknown>) ? { 'qq-1': q } : (q as Record<string, unknown>);
    for (const [id, value] of Object.entries(entries)) {
      const botId = safeBotId(id);
      if (!botId || !value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      qq[botId] = {
        seenMessageIds: Array.isArray(v.seenMessageIds)
          ? v.seenMessageIds
              .map((x) => safeString(x, 256))
              .filter(Boolean)
              .slice(-1000)
          : [],
      };
    }
  }
  return { version: 2, wechat, qq };
}

export class ImStore {
  readonly authPath: string;
  readonly statePath: string;
  auth: ImAuth = { version: 2, wechat: {}, qq: {} };
  state: ImState = { version: 2, wechat: {}, qq: {} };
  #queue: Promise<void> = Promise.resolve();

  constructor(userRoot: string) {
    this.authPath = join(userRoot, 'im-auth.json');
    this.statePath = join(userRoot, 'im-state.json');
  }

  async load(): Promise<void> {
    try {
      this.auth = normalizeAuth(JSON.parse(await readFile(this.authPath, 'utf8')));
    } catch (e) {
      if ((e as { code?: string })?.code !== 'ENOENT') this.auth = { version: 2, wechat: {}, qq: {} };
    }
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.statePath, 'utf8')));
    } catch (e) {
      if ((e as { code?: string })?.code !== 'ENOENT') this.state = { version: 2, wechat: {}, qq: {} };
    }
  }

  wechatState(botId: string): ImStateBot {
    return (this.state.wechat[botId] ??= emptyBot());
  }

  qqState(botId: string): { seenMessageIds: string[] } {
    return (this.state.qq[botId] ??= { seenMessageIds: [] });
  }

  async saveAuth(): Promise<void> {
    await this.#write(this.authPath, this.auth);
  }

  async saveState(): Promise<void> {
    await this.#write(this.statePath, this.state);
  }

  async clearAuth(platform: 'wechat' | 'qq', botId: string): Promise<void> {
    delete this.auth[platform][botId];
    await this.saveAuth();
  }

  async clearState(platform: 'wechat' | 'qq', botId: string): Promise<void> {
    if (platform === 'wechat') delete this.state.wechat[botId];
    else delete this.state.qq[botId];
    await this.saveState();
  }

  #write(path: string, value: unknown): Promise<void> {
    const operation = this.#queue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(temp, path);
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

/** 删除文件；不存在视为成功。 */
export async function removeIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as { code?: string })?.code !== 'ENOENT') throw e;
  }
}
