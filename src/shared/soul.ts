/**
 * 人格灵魂色彩：跨端共享的类型与纯展示辅助。
 *
 * 这里只放「两端都要认识」的结构（配置里的 soul 卡、host 写回的 soul 状态）以及一个不依赖
 * Node/DOM 的颜色取值函数；归一化、状态演化与提示词渲染都在宿主半侧
 * `src/host/soul.ts`，避免浏览器包把宿主逻辑一起打进来。
 *
 * @module dsh-pet/src/shared/soul
 */

/** 灵魂卡里的一个「在意 / 渴望 / 害怕」条目：字符串或带说明的对象。 */
export type SoulFacet = string | { name?: string; note?: string; description?: string };

/** 灵魂卡的身份段。 */
export interface SoulIdentity {
  /** 一句话灵魂（最长约 300 字）：比人设更短、更像这个角色的「内核」。 */
  oneLine?: string;
  /** 种类 / 形态。 */
  species?: string;
  /** 在主人生活里的角色。 */
  role?: string;
  /** 来处 / 背景。 */
  origin?: string;
  /** 自我认知：它怎么看自己。 */
  selfImage?: string;
  /** 核心矛盾：让角色立起来的那组拉扯。 */
  coreContradiction?: string;
}

/** 说话方式。 */
export interface SoulVoice {
  tone?: string;
  rhythm?: string;
  sentenceLength?: string;
  vocabulary?: string;
  honorific?: string;
  humor?: string;
  /** 明确不要出现的东西（客服腔、说教、复述设定……）。 */
  avoid?: string[];
  /** 语气示例：只给模型看，不要逐字照搬。 */
  examples?: string[];
}

/** 关系起点。 */
export interface SoulRelationshipSeed {
  stage?: SoulStage;
  trust?: number;
  intimacy?: number;
  respect?: number;
  tension?: number;
  familiarity?: number;
  note?: string;
}

/** 气质 / 基线情绪。 */
export interface SoulTemperament {
  baselineMood?: string;
  /** 情绪回落到基线的半衰期（小时），默认 12。 */
  moodHalfLifeHours?: number;
  energy?: number;
  expressiveness?: number;
}

/** 灵魂色彩：主色用于对话窗描边 / 光晕，其余字段进入提示词。 */
export interface SoulColor {
  primary?: string;
  secondary?: string;
  glow?: string;
  shadow?: string;
  description?: string;
  motifs?: string;
}

/** 一只宠物的灵魂卡（配置项 `soul`）。所有字段都可选，但至少要有一项有内容才会生效。 */
export interface SoulCard {
  version?: number;
  identity?: SoulIdentity;
  values?: SoulFacet[];
  /** 性格倾向：名称 → 0–100 的强度。 */
  traits?: Record<string, number>;
  voice?: SoulVoice;
  desires?: SoulFacet[];
  fears?: SoulFacet[];
  boundaries?: string[];
  relationshipSeed?: SoulRelationshipSeed;
  temperament?: SoulTemperament;
  soulColor?: SoulColor;
  /** 少量对话示例（最多 4 条），用于钉住语气。 */
  examples?: string[];
  /** 自由补充：不想塞进固定字段的设定。 */
  notes?: string;
}

/** 关系阶段（由信任 / 亲密 / 熟悉 / 张力推导，不直接让模型改）。 */
export type SoulStage = '陌生' | '初识' | '熟悉' | '亲近' | '默契' | '羁绊';

/** 此刻的情绪。 */
export interface SoulMood {
  label: string;
  /** 愉悦度：-100（很糟）… 100（很好） */
  valence: number;
  /** 唤醒度：0（安静）… 100（兴奋） */
  arousal: number;
  /** 精力：0（困倦）… 100（充沛） */
  energy: number;
  /** 情绪由什么引起（只给模型看的短句）。 */
  cause?: string;
  updatedAt: string;
}

/** 此刻的关系状态。 */
export interface SoulRelationship {
  stage: SoulStage;
  trust: number;
  intimacy: number;
  respect: number;
  tension: number;
  familiarity: number;
  /** 累计互动次数（只增不减）。 */
  interactions: number;
  lastInteractionAt: string | null;
  note?: string;
}

/** 最近一次对话：`chatMemoryRounds: 0` 时的连续性锚点。 */
export interface SoulLastExchange {
  user: string;
  assistant: string;
  at: string;
}

/** 长期记忆条目：由反思层从对话中抽取，跨会话注入。 */
export type SoulMemoryKind = 'preference' | 'event' | 'promise' | 'person' | 'date' | 'other';

export interface SoulMemory {
  text: string;
  kind: SoulMemoryKind;
  at: string;
}

/** 关系事件类型：第一次、阶段里程碑、约定、冲突 / 和好、日期、礼物等。 */
export type SoulRelationshipEventKind =
  'first' | 'milestone' | 'promise' | 'conflict' | 'repair' | 'date' | 'gift' | 'other';

/** 一条关系事件：关系时间线上的节点，和「长期记忆」分开存。 */
export interface SoulRelationshipEvent {
  text: string;
  kind: SoulRelationshipEventKind;
  at: string;
}

/** 宿主写回的动态灵魂状态（soul-state.json 的单个宠物分桶）。 */
export interface SoulState {
  version: 1;
  petId: string;
  mood: SoulMood;
  relationship: SoulRelationship;
  /** 最近一次对话（截断后的短句，不是完整记忆）。 */
  lastExchange?: SoulLastExchange;
  /** 长期记忆（反思层抽取，最多 20 条；跨会话注入提示词）。 */
  memories?: SoulMemory[];
  /** 关系事件时间线（最多 30 条；反思层 + 阶段变化写入）。 */
  relationshipEvents?: SoulRelationshipEvent[];
  /** 当前挂心的事（最多 5 条；由反思层更新）。 */
  activeGoals?: string[];
  /** 自我叙事（由反思层更新）。 */
  selfNarrative?: string;
  lastReflectionAt?: string | null;
  /** 最近一次纪念日提醒的去重键（日期 + 事件正文），跨重启避免当天重复提醒。 */
  lastAnniversaryReminder?: string;
  updatedAt: string;
}

/** 灵魂色彩主色：只接受 hex，避免把任意 CSS 注入到对话窗样式里。 */
export function soulAccentColor(card: SoulCard | null | undefined, fallback = '#7aa7ff'): string {
  // 设置页里可能还是手写的 snake_case 卡（保存前不归一化），这里一并认。
  const raw = card as (SoulCard & { soul_color?: { primary?: unknown; glow?: unknown; secondary?: unknown } }) | null;
  const color = raw?.soulColor ?? raw?.soul_color;
  const candidates = [color?.primary, color?.glow, color?.secondary];
  for (const value of candidates) {
    if (typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) {
      return value.trim();
    }
  }
  return fallback;
}
