/**
 * 灵魂状态的落盘：`<userRoot>/soul-state.json`，结构 `{ version: 1, states: { <petId>: SoulState } }`。
 *
 * 只存「连续性状态」（情绪 / 关系 / 长期记忆 / 关系事件 / 上次聊天），不存完整聊天记录——
 * 完整记录仍在 memory.json。解析失败按空状态继续：一条坏文件不该让桌宠不能说话。
 * @module dsh-pet-plus/src/host/soul-state
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
export function createSoulStateStore(options: {
  userRoot: string;
  log?: { error?(message: string): void };
}): SoulStateStore {
  const path = join(options.userRoot, 'soul-state.json');
  return {
    path,
    async read(): Promise<SoulStateMap> {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return {};
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        const states = parsed.states;
        if (!states || typeof states !== 'object' || Array.isArray(states)) return {};
        return states as SoulStateMap;
      } catch (error) {
        options.log?.error?.(
          `dsh-pet: 灵魂状态文件无法解析（本次从默认状态开始）：${path}（${
            error instanceof Error ? error.message : String(error)
          }）`,
        );
        return {};
      }
    },
    async write(states: SoulStateMap): Promise<void> {
      await mkdir(options.userRoot, { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, states }, null, 2), 'utf8');
    },
  };
}
