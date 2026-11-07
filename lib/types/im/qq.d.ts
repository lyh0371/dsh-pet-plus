import type { ImBotConfig } from '../../shared/im';
import type { ImStore, QqAuth } from './store';
import type { ImChat, ImLogger } from './wechat';
export interface QqRuntimeStatus {
    state: 'idle' | 'connecting' | 'connected' | 'error';
    connected: boolean;
    appId?: string;
    lastCheckedAt?: number;
    lastError?: string;
    messagesReceived: number;
    messagesReplied: number;
}
export declare function deriveQqBotId(appId: string): string;
export declare class QqRuntime {
    #private;
    constructor(options: {
        auth: QqAuth;
        store: ImStore;
        getConfig: () => ImBotConfig;
        chat: ImChat;
        log: ImLogger;
    });
    status(): QqRuntimeStatus;
    start(): Promise<void>;
    stop(): Promise<void>;
}
