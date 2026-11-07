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
export declare const DEFAULT_BRIDGE: BridgeConfig;
/** 白名单上限：防止一个坏配置把每次请求变成超长线性扫描。 */
export declare const BRIDGE_WHITELIST_MAX = 200;
/** 平台标识：只允许稳定的短标识，避免把任意文本写进日志/白名单键。 */
export declare const BRIDGE_PLATFORM_RE: RegExp;
/** 发送者 id / 消息 id 的长度上限（与宿主侧解析保持一致）。 */
export declare const BRIDGE_SENDER_ID_MAX = 128;
export declare const BRIDGE_MESSAGE_ID_MAX = 200;
export declare const BRIDGE_SENDER_NAME_MAX = 80;
/** 把平台名归一化成小写标识；非法返回空串。 */
export declare function normalizeBridgePlatform(value: unknown): string;
/** 只保留 http/https 且不带用户名密码的回调地址；非法返回空串。 */
export declare function normalizeBridgeReplyUrl(value: unknown): string;
/** 把一条白名单条目归一化；非法返回 null。 */
export declare function normalizeBridgeWhitelistEntry(value: unknown): BridgeWhitelistEntry | null;
/** 白名单数组归一化：跳过非法项、按 platform+id 去重、限制总条数。 */
export declare function normalizeBridgeWhitelist(value: unknown): BridgeWhitelistEntry[];
/** 配置归一化：缺失/非法字段回落默认值，保证设置页拿到的是完整对象。 */
export declare function normalizeBridgeConfig(raw: unknown): BridgeConfig;
/**
 * 设置页的就地校验（宿主还有一份更严格的同义实现）。
 * 关闭状态下允许留空；开启后必须有宠物、16–256 字符 token。
 */
export declare function isValidBridgeConfig(raw: unknown): boolean;
/** 白名单文本 → 数组。格式：每行 `platform | senderId`，可选 ` | 显示名`；# 开头为注释。 */
export declare function parseBridgeWhitelistText(text: string): {
    ok: true;
    list: BridgeWhitelistEntry[];
} | {
    ok: false;
    line: number;
    reason: 'format' | 'platform' | 'id' | 'name' | 'limit';
};
/** 白名单数组 → 设置页 textarea 文本。 */
export declare function formatBridgeWhitelist(list: BridgeWhitelistEntry[]): string;
