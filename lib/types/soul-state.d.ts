import type { SoulState } from '../shared/soul';
/** 状态表：按宠物 id 分桶。 */
export type SoulStateMap = Record<string, SoulState>;
/** 状态存储：读 / 写 / 路径（诊断用）。 */
export interface SoulStateStore {
    readonly path: string;
    read(): Promise<SoulStateMap>;
    write(states: SoulStateMap): Promise<void>;
}
/**
 * 造一个状态存储。
 * @param options.userRoot - 用户数据根（与 memory.json 同目录）。
 * @param options.log - 只用来记「文件坏了」这一类告警。
 */
export declare function createSoulStateStore(options: {
    userRoot: string;
    log?: {
        error?(message: string): void;
    };
}): SoulStateStore;
