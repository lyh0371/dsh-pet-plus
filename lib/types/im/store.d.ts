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
    contextTokens: Record<string, {
        token: string;
        seq?: string;
        at: number;
    }>;
}
export interface ImState {
    version: 2;
    wechat: Record<string, ImStateBot>;
    qq: Record<string, {
        seenMessageIds: string[];
    }>;
}
export declare class ImStore {
    #private;
    readonly authPath: string;
    readonly statePath: string;
    auth: ImAuth;
    state: ImState;
    constructor(userRoot: string);
    load(): Promise<void>;
    wechatState(botId: string): ImStateBot;
    qqState(botId: string): {
        seenMessageIds: string[];
    };
    saveAuth(): Promise<void>;
    saveState(): Promise<void>;
    clearAuth(platform: 'wechat' | 'qq', botId: string): Promise<void>;
    clearState(platform: 'wechat' | 'qq', botId: string): Promise<void>;
}
/** 删除文件；不存在视为成功。 */
export declare function removeIfExists(path: string): Promise<void>;
