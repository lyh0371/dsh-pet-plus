/**
 * 原生微信 / QQ 接入（不依赖 dsh-im）的共享配置与纯逻辑。
 *
 * 每个平台可以配置多个机器人；每个机器人独立选择：
 *  - mode: 'pet'     → 由桌宠的 chatWithPet 回复；
 *  - mode: 'session' → 投递到指定的 DSH 对话 session，由该 session 回复。
 *
 * 凭据不在这里：微信 token / QQ AppSecret 存在 host 的 im-auth.json（0600）。
 * @module dsh-pet/src/shared/im
 */
import {
  normalizeBridgeWhitelist,
  normalizeBridgeWhitelistEntry,
  parseBridgeWhitelistText,
  formatBridgeWhitelist,
  type BridgeWhitelistEntry,
} from './bridge';

export type ImPlatform = 'wechat' | 'qq';
export type ImMode = 'pet' | 'session';
export type ImWhitelistEntry = BridgeWhitelistEntry;

/** 单个机器人配置。 */
export interface ImBotConfig {
  /** 平台内稳定的机器人 id；凭据、状态、去重都按它隔离。 */
  id: string;
  /** 是否启用这个机器人。 */
  enabled: boolean;
  /** 回复方式：桌宠 / DSH session。 */
  mode: ImMode;
  /** mode=pet 时用哪只桌宠。 */
  petId: string;
  /** mode=session 时投递到哪个 DSH session。 */
  sessionId: string;
  /** 权限白名单：platform + id 精确匹配才回复。 */
  whitelist: ImWhitelistEntry[];
  /** 微信登录账号本人是否自动放行；QQ 手动绑定没有 owner id 时无效。 */
  allowOwner: boolean;
  /** 是否允许群聊（QQ）。 */
  allowGroups: boolean;
  /** mode=pet 时回复是否同时写桌面气泡；session 模式不使用。 */
  writeSay: boolean;
}

/** 一个平台的机器人列表。 */
export interface ImPlatformConfig {
  bots: ImBotConfig[];
}

export interface ImConfig {
  wechat: ImPlatformConfig;
  qq: ImPlatformConfig;
}

export const IM_PLATFORMS: readonly ImPlatform[] = ['wechat', 'qq'] as const;
export const IM_MODES: readonly ImMode[] = ['pet', 'session'] as const;
export const IM_MAX_BOTS = 20;

const EMPTY_BOT: ImBotConfig = {
  id: '',
  enabled: false,
  mode: 'pet',
  petId: '',
  sessionId: '',
  whitelist: [],
  allowOwner: true,
  allowGroups: false,
  writeSay: false,
};

export const DEFAULT_IM: ImConfig = {
  wechat: { bots: [] },
  qq: { bots: [] },
};

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
}

/** 机器人 id 只允许稳定短标识；用于 auth / 去重 / 路由。 */
export function normalizeImBotId(value: unknown): string {
  const id = cleanId(value);
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : '';
}

function normalizeBot(raw: unknown, fallbackId: string): ImBotConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mode = o.mode === 'session' ? 'session' : 'pet';
  return {
    id: normalizeImBotId(o.id) || fallbackId,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : EMPTY_BOT.enabled,
    mode,
    petId: typeof o.petId === 'string' ? o.petId.trim().slice(0, 64) : '',
    sessionId: typeof o.sessionId === 'string' ? o.sessionId.trim().slice(0, 256) : '',
    whitelist: normalizeBridgeWhitelist(o.whitelist),
    allowOwner: typeof o.allowOwner === 'boolean' ? o.allowOwner : EMPTY_BOT.allowOwner,
    allowGroups: typeof o.allowGroups === 'boolean' ? o.allowGroups : EMPTY_BOT.allowGroups,
    writeSay: typeof o.writeSay === 'boolean' ? o.writeSay : EMPTY_BOT.writeSay,
  };
}

function looksLikeLegacyBot(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return 'enabled' in o || 'petId' in o || 'whitelist' in o || 'mode' in o;
}

function normalizePlatform(raw: unknown, platform: ImPlatform): ImPlatformConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(o.bots)
    ? o.bots
    : looksLikeLegacyBot(raw)
      ? [raw] // 旧版单机器人配置：自动迁移成一条
      : [];
  const bots: ImBotConfig[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length && bots.length < IM_MAX_BOTS; i += 1) {
    const bot = normalizeBot(list[i], `${platform}-${i + 1}`);
    if (!bot.id || seen.has(bot.id)) continue;
    seen.add(bot.id);
    bots.push(bot);
  }
  return { bots };
}

/** 顶层 im 归一化；兼容旧版单机器人对象。 */
export function normalizeImConfig(raw: unknown): ImConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    wechat: normalizePlatform(o.wechat, 'wechat'),
    qq: normalizePlatform(o.qq, 'qq'),
  };
}

/** 配置段是否可写盘/可合并。 */
export function isValidImConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  for (const platform of IM_PLATFORMS) {
    const value = o[platform];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const p = value as Record<string, unknown>;
    // 旧版单机器人对象也允许写（读取侧会迁移）。
    const list = Array.isArray(p.bots) ? p.bots : looksLikeLegacyBot(value) ? [value] : null;
    if (!list || list.length > IM_MAX_BOTS) return false;
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const bot = item as Record<string, unknown>;
      const id = normalizeImBotId(bot.id);
      if (p.bots !== undefined && !id) return false;
      if (id && seen.has(id)) return false;
      if (id) seen.add(id);
      if (bot.mode !== undefined && bot.mode !== 'pet' && bot.mode !== 'session') return false;
      if (bot.enabled !== undefined && typeof bot.enabled !== 'boolean') return false;
      if (bot.petId !== undefined && (typeof bot.petId !== 'string' || bot.petId.trim().length > 64)) return false;
      if (bot.sessionId !== undefined && (typeof bot.sessionId !== 'string' || bot.sessionId.trim().length > 256))
        return false;
      if (bot.allowOwner !== undefined && typeof bot.allowOwner !== 'boolean') return false;
      if (bot.allowGroups !== undefined && typeof bot.allowGroups !== 'boolean') return false;
      if (bot.writeSay !== undefined && typeof bot.writeSay !== 'boolean') return false;
      if (bot.whitelist !== undefined) {
        if (!Array.isArray(bot.whitelist)) return false;
        for (const entry of bot.whitelist) {
          if (!normalizeBridgeWhitelistEntry(entry)) return false;
        }
      }
      if (bot.enabled === true) {
        const mode = bot.mode === 'session' ? 'session' : 'pet';
        if (mode === 'session' && !(typeof bot.sessionId === 'string' && bot.sessionId.trim())) return false;
        if (mode === 'pet' && !(typeof bot.petId === 'string' && bot.petId.trim())) return false;
      }
    }
  }
  return true;
}

/** 生成一个平台内唯一的机器人 id。 */
export function nextImBotId(platform: ImPlatform, existing: readonly ImBotConfig[]): string {
  const used = new Set(existing.map((bot) => bot.id));
  for (let i = 1; i <= 99; i += 1) {
    const id = `${platform}-${i}`;
    if (!used.has(id)) return id;
  }
  return `${platform}-${Date.now().toString(36)}`;
}

/** 白名单文本 → 数组（与通用消息接入同一格式）。 */
export const parseImWhitelistText = parseBridgeWhitelistText;
/** 白名单数组 → 设置页文本。 */
export const formatImWhitelist = formatBridgeWhitelist;
export type ImWhitelistParseResult = ReturnType<typeof parseBridgeWhitelistText>;

/** 设置页展示的 DSH session 摘要。 */
export interface ImSessionSummary {
  sessionId: string;
  title?: string;
  cwd?: string;
  running?: boolean;
}

/** 设置页展示的登录尝试（host 只返回公开字段，不含 token）。 */
export interface ImLoginAttemptView {
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

export interface ImBotStatusView {
  id: string;
  enabled: boolean;
  mode: ImMode;
  connected: boolean;
  state: string;
  account?: string;
  owner?: string;
  appId?: string;
  lastError?: string;
  messagesReceived: number;
  messagesReplied: number;
  login?: ImLoginAttemptView | null;
}

export interface ImPlatformStatusView {
  bots: ImBotStatusView[];
}

/** GET /im/status 的公开形态。 */
export interface ImStatusView {
  wechat: ImPlatformStatusView;
  qq: ImPlatformStatusView;
}
