import type { ImBotConfig } from '../../shared/im';
import type { ImStore, WechatAuth } from './store';
import { createWeixinApi } from './weixin-api';
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
export declare class WechatRuntime {
    #private;
    constructor(options: {
        api: WechatApi;
        auth: WechatAuth;
        store: ImStore;
        getConfig: () => ImBotConfig;
        chat: ImChat;
        log: ImLogger;
    });
    status(): WechatRuntimeStatus;
    start(): Promise<void>;
    stop(): Promise<void>;
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
    error?: {
        code: string;
        message: string;
    };
}
export declare class WechatLogin {
    #private;
    constructor(api: WechatApi, store: ImStore, botId: string, onAuth: (auth: WechatAuth) => Promise<void>);
    status(): WechatAttempt | null;
    start(): Promise<WechatAttempt>;
    cancel(): void;
    submitVerifyCode(code: string): WechatAttempt | null;
}
