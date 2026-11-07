/**
 * 灵魂反思层（纯提示词 / 解析 / 合并逻辑）。
 *
 * 一次成功的对话后，宿主把最近对话交给模型整理成长期记忆、当前挂心与自我叙事；
 * 本模块只负责「怎么问、怎么解析、怎么合并」，不直接调用 LLM，也不碰磁盘——
 * IO 与调度在 host/index.ts，方便单测钉死模型输出不合法时的行为。
 *
 * @module dsh-pet/src/host/soul-reflection
 */
import type { SoulCard, SoulMemory, SoulRelationshipEvent, SoulState } from '../shared/soul';
import type { ChatMemoryMessage } from './chat';
/** 反思产出的结构化结果。 */
export interface SoulReflection {
    memories: SoulMemory[];
    relationshipEvents: SoulRelationshipEvent[];
    activeGoals: string[];
    selfNarrative: string;
}
/** 反思调度：至少 3 次成功对话；之后每 6 次或间隔 12 小时再整理一次。 */
export declare const SOUL_REFLECT_MIN_INTERACTIONS = 3;
export declare const SOUL_REFLECT_EVERY = 6;
export declare const SOUL_REFLECT_AFTER_HOURS = 12;
/** 解析模型输出；没有任何有效更新 → null（调用方不写状态）。 */
export declare function parseSoulReflection(raw: string, now: Date): SoulReflection | null;
/**
 * 把反思结果合并进状态：长期记忆去重合并，挂心整体替换，自我叙事非空才覆盖。
 * 关系数值不由反思层直接改——避免模型一次输出把长期关系拉坏。
 */
export declare function applySoulReflection(state: SoulState, reflection: SoulReflection, now: Date): void;
/** 是否该在本次成功对话后安排一次反思。 */
export declare function shouldReflectSoul(state: SoulState, now: Date): boolean;
/** 反思提示词：只让模型产出结构化记忆，不产出聊天回复。 */
export declare function buildSoulReflectionPrompt(card: SoulCard, state: SoulState, messages: readonly ChatMemoryMessage[]): {
    system: string;
    user: string;
};
