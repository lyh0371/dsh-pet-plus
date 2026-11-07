export declare const WEIXIN_QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
export declare const WEIXIN_PROTOCOL_VERSION = "2.4.6";
export declare const DEFAULT_BOT_TYPE = "3";
export declare const DEFAULT_WEIXIN_MAX_MESSAGE_CHARS = 1800;
export declare class WeixinApiError extends Error {
    code: string;
    status?: number;
    providerCode?: string;
    constructor(code: string, message: string, options?: {
        status?: number;
        providerCode?: string;
        cause?: unknown;
    });
}
export declare function rejectedProviderResponse(value: unknown, fields?: string[]): string | null;
export declare function normalizeWeixinApiBaseUrl(value: string): string;
export declare function normalizeWeixinQrUrl(value: unknown): string;
export interface WeixinLoginStart {
    qrcode: string;
    qrcodeUrl: string;
}
export interface WeixinLoginStatus {
    status: string;
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
    redirect_host?: string;
    [key: string]: unknown;
}
export interface WeixinUpdates {
    ret?: number;
    errcode?: number;
    msgs?: unknown[];
    get_updates_buf?: string;
    [key: string]: unknown;
}
export declare function createWeixinApi({ fetchImpl }?: {
    fetchImpl?: typeof fetch;
}): Readonly<{
    beginLogin({ localTokens, botType, signal, }?: {
        localTokens?: string[];
        botType?: string;
        signal?: AbortSignal;
    }): Promise<WeixinLoginStart>;
    pollLogin({ qrcode, baseUrl, verifyCode, signal, }: {
        qrcode: string;
        baseUrl?: string;
        verifyCode?: string;
        signal?: AbortSignal;
    }): Promise<WeixinLoginStatus>;
    getUpdates({ baseUrl, token, getUpdatesBuf, timeoutMs, signal, }: {
        baseUrl: string;
        token: string;
        getUpdatesBuf?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<WeixinUpdates>;
    sendText({ baseUrl, token, toUserId, text, contextToken, signal, }: {
        baseUrl: string;
        token: string;
        toUserId: string;
        text: string;
        contextToken?: string;
        signal?: AbortSignal;
    }): Promise<any>;
    notifyStart({ baseUrl, token, signal, }: {
        baseUrl: string;
        token: string;
        signal?: AbortSignal;
    }): Promise<any>;
    notifyStop({ baseUrl, token, signal, }: {
        baseUrl: string;
        token: string;
        signal?: AbortSignal;
    }): Promise<any>;
}>;
export declare function extractWeixinText(message: unknown): string | null;
export declare function weixinMessageId(message: unknown): string;
export declare function splitWeixinText(text: string, maxChars?: number): string[];
export declare function orderWeixinMessages(messages: unknown[]): unknown[];
