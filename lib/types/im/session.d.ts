import type { ImSessionSummary } from '../../shared/im';
export interface SessionAskOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export declare class DshSessionRunner {
    #private;
    constructor(ctx: any);
    get available(): boolean;
    listSessions(signal?: AbortSignal): Promise<ImSessionSummary[]>;
    ask(sessionId: string, text: string, options?: SessionAskOptions): Promise<string>;
}
