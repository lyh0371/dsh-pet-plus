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
import { parseBridgeWhitelistText, formatBridgeWhitelist, type BridgeWhitelistEntry } from './bridge';
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
export declare const IM_PLATFORMS: readonly ImPlatform[];
export declare const IM_MODES: readonly ImMode[];
export declare const IM_MAX_BOTS = 20;
export declare const DEFAULT_IM: ImConfig;
/** 机器人 id 只允许稳定短标识；用于 auth / 去重 / 路由。 */
export declare function normalizeImBotId(value: unknown): string;
/** 顶层 im 归一化；兼容旧版单机器人对象。 */
export declare function normalizeImConfig(raw: unknown): ImConfig;
/** 配置段是否可写盘/可合并。 */
export declare function isValidImConfig(raw: unknown): boolean;
/** 生成一个平台内唯一的机器人 id。 */
export declare function nextImBotId(platform: ImPlatform, existing: readonly ImBotConfig[]): string;
/** 白名单文本 → 数组（与通用消息接入同一格式）。 */
export declare const parseImWhitelistText: typeof parseBridgeWhitelistText;
/** 白名单数组 → 设置页文本。 */
export declare const formatImWhitelist: typeof formatBridgeWhitelist;
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
    error?: {
        code: string;
        message: string;
    };
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
