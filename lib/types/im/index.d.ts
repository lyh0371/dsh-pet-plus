/**
 * 原生微信 / QQ 接入的总控（每平台多机器人）。
 *
 * 每个 bot 独立配置 mode：
 *  - pet：调用 chatWithPet，使用桌宠人格/灵魂/记忆；
 *  - session：通过 DshSessionRunner 投递到固定 DSH session，由该 session 回复。
 * @module dsh-pet/src/host/im
 */
import type { ImConfig, ImStatusView } from '../../shared/im';
import type { ImStore } from './store';
import { type WechatAttempt } from './wechat';
import type { ImLogger } from './wechat';
type ChatFn = (petId: string, text: string, opts: {
    memoryKey: string;
    writeSay: boolean;
    speaker: string;
}) => Promise<{
    ok: true;
    text: string;
    image?: string;
} | {
    ok: false;
    reason: string;
    message?: string;
}>;
export declare class NativeImManager {
    #private;
    constructor(options: {
        store: ImStore;
        getConfig: () => ImConfig;
        chat: ChatFn;
        log: ImLogger;
        ctx: unknown;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    reload(): void;
    listSessions(signal?: AbortSignal): Promise<import("../../shared/im").ImSessionSummary[]>;
    status(): ImStatusView;
    startWechatLogin(botId: string): Promise<WechatAttempt>;
    wechatLoginStatus(botId: string): WechatAttempt | null;
    cancelWechatLogin(botId: string): void;
    submitWechatVerifyCode(botId: string, code: string): WechatAttempt | null;
    logoutWechat(botId: string): Promise<void>;
    bindQq(botId: string, appId: string, appSecret: string): Promise<void>;
    logoutQq(botId: string): Promise<void>;
}
export {};
