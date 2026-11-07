/**
 * 长期记忆条目的归一化与合并（纯逻辑，不碰 IO / 时钟）。
 *
 * 记忆来自反思层：模型只负责抽取「以后还有用」的事实、偏好、约定、人物和日期；
 * 这里负责把任意模型输出/磁盘 JSON 收窄成稳定形状，去重、截断、限量，避免脏数据
 * 无限制挤占提示词。
 *
 * @module dsh-pet/src/host/soul-memory
 */
import type { SoulMemory, SoulMemoryKind } from '../shared/soul';
/** 状态文件里最多保留多少条长期记忆；渲染时还会再截取最近若干条。 */
export declare const MAX_SOUL_MEMORIES = 20;
/** 单条记忆的最大字符数（按 Unicode 码点截断）。 */
export declare const MAX_SOUL_MEMORY_CHARS = 200;
/** 单条记忆：接受字符串或 { text/content/note, kind, at }；没有正文 → null。 */
export declare function normalizeSoulMemory(value: unknown, now: Date): SoulMemory | null;
/** 数组归一化：丢弃坏条目、按正文去重、只保留最近的 MAX_SOUL_MEMORIES 条。 */
export declare function normalizeSoulMemories(value: unknown, now: Date): SoulMemory[];
/** 合并已有与新增记忆：正文去重，新条目覆盖同文旧条目的 kind，保留旧时间。 */
export declare function mergeSoulMemories(existing: readonly SoulMemory[] | undefined, incoming: readonly SoulMemory[] | undefined, now: Date): SoulMemory[];
/** 提示词里展示的记忆类型标签。 */
export declare function soulMemoryKindLabel(kind: SoulMemoryKind): string;
