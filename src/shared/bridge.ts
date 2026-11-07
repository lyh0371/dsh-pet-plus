/**
 * 通用消息接入（Webhook bridge）的共享类型与纯逻辑。
 *
 * 这里只做「配置形状 + 白名单文本解析」：浏览器设置页与宿主半侧各有一份自包含实现，
 * 宿主不 import 本目录（DSH 单文件加载约束）。两边字段名与边界必须保持一致。
 *
 * 不负责 HTTP 路由、鉴权、去重、限流或调用模型——那些在宿主半侧的 host/bridge。
 * @module dsh-pet/src/shared/bridge
 */

/** 白名单中的一条：平台 + 稳定发送者 id，可带一个只用于提示/日志的名字。 */
export interface BridgeWhitelistEntry {
  /** 平台标识（小写；例如 wechat / qq / telegram）。 */
  platform: string;
  /** 平台内稳定 id（不是昵称；昵称会变，不能当权限键）。 */
  id: string;
  /** 显示名，仅用于提示与模型上下文，不参与鉴权。 */
  name?: string;
}

/** 消息接入配置（顶层 main.bridge）。 */
export interface BridgeConfig {
  /** 总开关。关闭时入站端点直接拒绝，不解析消息。 */
  enabled: boolean;
  /** 用哪只桌宠回复（宠物 id；必须真实存在）。 */
  petId: string;
  /** 入站鉴权 token；enabled=true 时 16–256 个字符。 */
  token: string;
  /** 权限白名单：只有 platform + id 完全匹配的发送者才会触发回复。 */
  whitelist: BridgeWhitelistEntry[];
  /** 可选的出站回调地址；留空时只把回复放在 HTTP 响应里，由桥接器自己发送。 */
  replyUrl: string;
  /** 同一 messageId 的去重窗口（秒）；0 = 不去重。 */
  dedupeTtlSec: number;
  /** 每个发送者每分钟最多处理几条；0 = 不限制。 */
  rateLimitPerMin: number;
  /** 回复时是否同时写进桌宠气泡（默认 false，避免多人聊天时桌面频繁弹话）。 */
  writeSay: boolean;
  /** 是否允许群聊消息触发回复（默认 false）。 */
  allowGroups: boolean;
}

/** 内置默认值；设置页与宿主都必须从这一份语义出发。 */
export const DEFAULT_BRIDGE: BridgeConfig = {
  enabled: false,
  petId: '',
  token: '',
  whitelist: [],
  replyUrl: '',
  dedupeTtlSec: 600,
  rateLimitPerMin: 20,
  writeSay: false,
  allowGroups: false,
};

/** 白名单上限：防止一个坏配置把每次请求变成超长线性扫描。 */
export const BRIDGE_WHITELIST_MAX = 200;

/** 平台标识：只允许稳定的短标识，避免把任意文本写进日志/白名单键。 */
export const BRIDGE_PLATFORM_RE = /^[a-z0-9._-]{1,32}$/;
// eslint-disable-next-line no-control-regex -- 白名单/消息 id 必须拒绝 \x00-\x1f 控制字符，去掉匹配等于放行
const CONTROL_CHARS = /[\x00-\x1f]/;

/** 发送者 id / 消息 id 的长度上限（与宿主侧解析保持一致）。 */
export const BRIDGE_SENDER_ID_MAX = 128;
export const BRIDGE_MESSAGE_ID_MAX = 200;
export const BRIDGE_SENDER_NAME_MAX = 80;

/** 把平台名归一化成小写标识；非法返回空串。 */
export function normalizeBridgePlatform(value: unknown): string {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BRIDGE_PLATFORM_RE.test(platform) ? platform : '';
}

/** 只保留 http/https 且不带用户名密码的回调地址；非法返回空串。 */
export function normalizeBridgeReplyUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return raw;
  } catch {
    return '';
  }
}

/** 把一条白名单条目归一化；非法返回 null。 */
export function normalizeBridgeWhitelistEntry(value: unknown): BridgeWhitelistEntry | null {
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;
    // 兼容手写的 "wechat:wxid_xxx"；设置页写出的是对象。
    const sep = raw.indexOf(':');
    if (sep <= 0) return null;
    const platform = normalizeBridgePlatform(raw.slice(0, sep));
    const id = raw.slice(sep + 1).trim();
    if (!platform || !id || id.length > BRIDGE_SENDER_ID_MAX || id.includes('|') || CONTROL_CHARS.test(id)) return null;
    return { platform, id };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const platform = normalizeBridgePlatform(o.platform);
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!platform || !id || id.length > BRIDGE_SENDER_ID_MAX || id.includes('|') || CONTROL_CHARS.test(id)) return null;
  const rawName = typeof o.name === 'string' ? o.name.trim() : '';
  const name = rawName ? rawName.slice(0, BRIDGE_SENDER_NAME_MAX).replace(/\|/g, ' ').trim() : '';
  return name ? { platform, id, name } : { platform, id };
}

/** 白名单数组归一化：跳过非法项、按 platform+id 去重、限制总条数。 */
export function normalizeBridgeWhitelist(value: unknown): BridgeWhitelistEntry[] {
  if (!Array.isArray(value)) return [];
  const out: BridgeWhitelistEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = normalizeBridgeWhitelistEntry(item);
    if (!entry) continue;
    const key = entry.platform + '\u0000' + entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= BRIDGE_WHITELIST_MAX) break;
  }
  return out;
}

/** 配置归一化：缺失/非法字段回落默认值，保证设置页拿到的是完整对象。 */
export function normalizeBridgeConfig(raw: unknown): BridgeConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const token = typeof o.token === 'string' ? o.token.trim().slice(0, 256) : '';
  const petId = typeof o.petId === 'string' ? o.petId.trim().slice(0, 64) : '';
  const dedupeRaw = Number(o.dedupeTtlSec);
  const rateRaw = Number(o.rateLimitPerMin);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_BRIDGE.enabled,
    petId,
    token,
    whitelist: normalizeBridgeWhitelist(o.whitelist),
    replyUrl: normalizeBridgeReplyUrl(o.replyUrl),
    dedupeTtlSec:
      Number.isFinite(dedupeRaw) && dedupeRaw >= 0 && dedupeRaw <= 86_400
        ? Math.floor(dedupeRaw)
        : DEFAULT_BRIDGE.dedupeTtlSec,
    rateLimitPerMin:
      Number.isFinite(rateRaw) && rateRaw >= 0 && rateRaw <= 120 ? Math.floor(rateRaw) : DEFAULT_BRIDGE.rateLimitPerMin,
    writeSay: typeof o.writeSay === 'boolean' ? o.writeSay : DEFAULT_BRIDGE.writeSay,
    allowGroups: typeof o.allowGroups === 'boolean' ? o.allowGroups : DEFAULT_BRIDGE.allowGroups,
  };
}

/**
 * 设置页的就地校验（宿主还有一份更严格的同义实现）。
 * 关闭状态下允许留空；开启后必须有宠物、16–256 字符 token。
 */
export function isValidBridgeConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return false;
  if (o.petId !== undefined && (typeof o.petId !== 'string' || o.petId.trim().length > 64)) return false;
  if (o.token !== undefined && (typeof o.token !== 'string' || o.token.trim().length > 256)) return false;
  if (o.whitelist !== undefined) {
    if (!Array.isArray(o.whitelist)) return false;
    if (o.whitelist.length > BRIDGE_WHITELIST_MAX) return false;
    for (const item of o.whitelist) {
      if (!normalizeBridgeWhitelistEntry(item)) return false;
    }
  }
  if (o.replyUrl !== undefined) {
    if (typeof o.replyUrl !== 'string') return false;
    if (o.replyUrl.trim() && !normalizeBridgeReplyUrl(o.replyUrl)) return false;
  }
  for (const key of ['dedupeTtlSec', 'rateLimitPerMin'] as const) {
    if (o[key] === undefined) continue;
    const n = Number(o[key]);
    const max = key === 'dedupeTtlSec' ? 86_400 : 120;
    if (!Number.isFinite(n) || n < 0 || n > max) return false;
  }
  if (o.writeSay !== undefined && typeof o.writeSay !== 'boolean') return false;
  if (o.allowGroups !== undefined && typeof o.allowGroups !== 'boolean') return false;
  const enabled = o.enabled === true;
  if (enabled) {
    const petId = typeof o.petId === 'string' ? o.petId.trim() : '';
    const token = typeof o.token === 'string' ? o.token.trim() : '';
    if (!petId || token.length < 16) return false;
  }
  return true;
}

/** 白名单文本 → 数组。格式：每行 `platform | senderId`，可选 ` | 显示名`；# 开头为注释。 */
export function parseBridgeWhitelistText(
  text: string,
):
  | { ok: true; list: BridgeWhitelistEntry[] }
  | { ok: false; line: number; reason: 'format' | 'platform' | 'id' | 'name' | 'limit' } {
  const list: BridgeWhitelistEntry[] = [];
  const seen = new Set<string>();
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    let parts = raw.split('|').map((s) => s.trim());
    if (parts.length === 1) {
      // 兼容 "wechat:wxid_xxx"：只在没有竖线时按第一个冒号切。
      const sep = raw.indexOf(':');
      if (sep <= 0) return { ok: false, line: i + 1, reason: 'format' };
      parts = [raw.slice(0, sep).trim(), raw.slice(sep + 1).trim()];
    }
    if (parts.length < 2 || parts.length > 3) return { ok: false, line: i + 1, reason: 'format' };
    const platform = normalizeBridgePlatform(parts[0]);
    if (!platform) return { ok: false, line: i + 1, reason: 'platform' };
    const id = parts[1];
    if (!id || id.length > BRIDGE_SENDER_ID_MAX || CONTROL_CHARS.test(id)) {
      return { ok: false, line: i + 1, reason: 'id' };
    }
    const name = parts[2] ?? '';
    if (name.length > BRIDGE_SENDER_NAME_MAX || CONTROL_CHARS.test(name)) {
      return { ok: false, line: i + 1, reason: 'name' };
    }
    const key = platform + '\u0000' + id;
    if (seen.has(key)) continue;
    if (list.length >= BRIDGE_WHITELIST_MAX) return { ok: false, line: i + 1, reason: 'limit' };
    seen.add(key);
    list.push(name ? { platform, id, name } : { platform, id });
  }
  return { ok: true, list };
}

/** 白名单数组 → 设置页 textarea 文本。 */
export function formatBridgeWhitelist(list: BridgeWhitelistEntry[]): string {
  return list
    .map((entry) => [entry.platform, entry.id, entry.name ?? ''].join(' | ').replace(/\s+\|\s*$/, ''))
    .join('\n');
}
