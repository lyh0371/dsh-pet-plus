import type { SoulCard, SoulMood, SoulRelationship, SoulStage, SoulState } from '../shared/soul';
/**
 * 把配置里的任意 JSON 归一化成灵魂卡：非法字段丢弃、字符串 trim/截断、数值夹到合法区间。
 * 没有任何有效内容 → null（调用方按「没有灵魂卡」处理，不注入任何段落）。
 */
export declare function normalizeSoulCard(raw: unknown): SoulCard | null;
/**
 * 某宠物最终生效的灵魂卡：实例级 `pets[].soul` 优先，没写 / 非法 / 空 → 回落所属条目 `soul`。
 * 与 `petPersona` 同一套「替换而非拼接」语义：两张卡同时生效会让模型收到两个内核。
 */
export declare function soulCardOf(conf: Record<string, unknown>, pet: Record<string, unknown>): SoulCard | null;
/** 灵魂色彩主色：只接受 hex；没有卡 / 非法颜色 → 返回回退色。 */
export declare function soulAccent(card: SoulCard | null | undefined, fallback?: string): string;
/** 渲染灵魂卡（稳定设定）。没有内容 → 空串。 */
export declare function renderSoulCard(card: SoulCard | null | undefined, maxChars?: number): string;
/** 渲染动态状态（此刻的情绪 / 关系 / 上次聊天）。没有状态 → 空串。 */
export declare function renderSoulState(state: SoulState | null | undefined, card?: SoulCard | null, maxChars?: number): string;
/** 灵魂卡 + 动态状态合成一段（给 /soul 预览与测试用；正式 system 由 persona 分别拼装）。 */
export declare function renderSoulPrompt(card: SoulCard | null | undefined, state: SoulState | null | undefined): string;
/** 关系阶段：由熟悉 / 信任 / 亲密 / 张力推导；数值只作为模型不可见的内部状态。 */
export declare function relationshipStage(rel: Pick<SoulRelationship, 'trust' | 'intimacy' | 'familiarity' | 'tension'>): SoulStage;
/** 情绪标签：只用于提示词里的自然语言，不暴露给用户。 */
export declare function moodLabel(mood: Pick<SoulMood, 'valence' | 'arousal' | 'energy'>, tension?: number): string;
/** 新宠物的默认状态：情绪取卡里的基线，关系取关系起点。 */
export declare function defaultSoulState(card: SoulCard | null | undefined, petId: string, now: Date): SoulState;
/**
 * 把磁盘上的任意 JSON 归一化成状态：缺字段取默认、非法数值夹回合法区间、阶段重新推导。
 * `raw` 里的 petId 不匹配也接受——状态文件按 petId 分桶，迁移/改名时保留连续性更重要。
 */
export declare function normalizeSoulState(raw: unknown, card: SoulCard | null | undefined, petId: string, now: Date): SoulState;
/** 时间衰减：情绪回落到卡里的基线，张力回落；信任 / 亲密 / 熟悉是长期量，不衰减。 */
export declare function decaySoulState(state: SoulState, card: SoulCard | null | undefined, now: Date): void;
/**
 * 一次用户发言对状态的影响：只做轻量启发式（熟悉度 + 温和/尖锐信号），不做语义抽取。
 * 失败/中断的对话不会调用它——只有生成成功并写入记忆后才推进状态。
 */
export declare function observeUserText(state: SoulState, value: string, now: Date): void;
/** 生成成功后记录最近一次对话：`chatMemoryRounds: 0` 时它是唯一的跨轮连续性锚点。 */
export declare function recordExchange(state: SoulState, userText: string, assistantText: string, now: Date): void;
