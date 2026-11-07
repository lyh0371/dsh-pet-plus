/**
 * 人格灵魂色彩（宿主半侧，纯逻辑）：灵魂卡归一化、动态状态演化、提示词渲染。
 *
 * 设计边界：
 *  - 灵魂卡是**稳定设定**，来自配置（条目级 `soul` 或实例级 `pets[].soul`），由
 *    `soulCardOf` 做「实例覆盖 → 条目回落」；没有卡 / 卡为空 → 完全走旧人设，不注入任何新段落。
 *  - 动态状态是**连续状态**，由宿主唯一写入 `soul-state.json`；P1 记录情绪、关系与最近一次
 *    对话，P2 的反思层再把最近对话整理成长期记忆 / 挂心 / 自我叙事。
 *  - 本模块不碰 IO、不读时钟：时间由调用方传入，方便单测钉死。
 *
 * @module dsh-pet/src/host/soul
 */
import { appendSoulEvent, normalizeSoulEvents, soulEventKindLabel } from './soul-events';
import { normalizeSoulMemories, soulMemoryKindLabel } from './soul-memory';
import type {
  SoulCard,
  SoulColor,
  SoulIdentity,
  SoulLastExchange,
  SoulMood,
  SoulRelationship,
  SoulStage,
  SoulState,
  SoulTemperament,
  SoulVoice,
} from '../shared/soul';

/** 渲染后的灵魂卡上限（字符）：灵魂卡是「稳定内核」，不是第二份人设，超长只保留前面的内容。 */
const MAX_CARD_CHARS = 2600;
/** 渲染后的动态状态上限：状态要短，避免每轮都挤占上下文。 */
const MAX_STATE_CHARS = 1900;

const STAGES: readonly SoulStage[] = ['陌生', '初识', '熟悉', '亲近', '默契', '羁绊'];
const STAGE_SET = new Set<string>(STAGES);

/** 最近一次对话的锚点长度：只留足够模型接上话的短句，不把整段聊天塞进状态文件。 */
const LAST_EXCHANGE_CHARS = 300;

/** 温和 / 亲近的信号词：只做轻量启发式，不追求语义准确；语义记忆由反思层负责。 */
const WARM_RE =
  /(谢谢|感谢|喜欢你|爱你|抱抱|辛苦|晚安|早安|想你|可爱|好棒|乖|摸摸|陪你|一起|记住|别怕|我在|开心|高兴|厉害|加油|么么|亲亲|宝贝|好梦|慢慢来)/g;
/** 尖锐 / 排斥的信号词：用于让张力上升、信任下降；不把单次负向话永久写死。 */
const COLD_RE = /(滚|烦|讨厌|闭嘴|笨|废物|去死|别烦我|垃圾|恶心|傻|蠢|恨你|不想理|走开)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 从对象里按顺序取第一个非 undefined 的键：兼容 camelCase 与 snake_case 两种手写习惯。 */
function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampPercent(value: number): number {
  return clamp(value, 0, 100);
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 按 Unicode 码点截断，避免把 emoji / 代理对切成半个。 */
function truncate(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, max) : undefined;
}

/** 一个「在意 / 渴望 / 害怕」条目：字符串或 { name, note }。 */
function facetText(value: unknown, max = 200): string | undefined {
  if (typeof value === 'string') return text(value, max);
  if (!isRecord(value)) return undefined;
  const name = text(pick(value, 'name', 'label', 'key'), max);
  const note = text(pick(value, 'note', 'description', 'why'), max);
  if (name && note) return truncate(name + '：' + note, max);
  return name ?? note;
}

function textList(value: unknown, maxItems: number, maxLen = 200): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const line = facetText(item, maxLen);
    if (line) out.push(line);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

function normalizeIdentity(value: unknown): SoulIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const identity: SoulIdentity = {};
  const oneLine = text(pick(value, 'oneLine', 'one_line'), 320);
  const species = text(pick(value, 'species', 'kind'), 120);
  const role = text(value.role, 160);
  const origin = text(value.origin, 240);
  const selfImage = text(pick(value, 'selfImage', 'self_image'), 320);
  const coreContradiction = text(pick(value, 'coreContradiction', 'core_contradiction'), 320);
  if (oneLine) identity.oneLine = oneLine;
  if (species) identity.species = species;
  if (role) identity.role = role;
  if (origin) identity.origin = origin;
  if (selfImage) identity.selfImage = selfImage;
  if (coreContradiction) identity.coreContradiction = coreContradiction;
  return Object.keys(identity).length ? identity : undefined;
}

function normalizeTraits(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = text(key, 40);
    if (!name) continue;
    let n = NaN;
    if (typeof raw === 'number') n = raw;
    else if (isRecord(raw)) n = numberOr(pick(raw, 'score', 'value', 'weight'), NaN);
    if (Number.isFinite(n)) out[name] = clampPercent(n);
    if (Object.keys(out).length >= 12) break;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeVoice(value: unknown): SoulVoice | undefined {
  if (!isRecord(value)) return undefined;
  const voice: SoulVoice = {};
  const tone = text(value.tone, 240);
  const rhythm = text(value.rhythm, 240);
  const sentenceLength = text(pick(value, 'sentenceLength', 'sentence_length'), 200);
  const vocabulary = text(value.vocabulary, 240);
  const honorific = text(value.honorific, 160);
  const humor = text(value.humor, 200);
  const avoid = textList(value.avoid, 8, 120);
  const examples = textList(value.examples, 4, 300);
  if (tone) voice.tone = tone;
  if (rhythm) voice.rhythm = rhythm;
  if (sentenceLength) voice.sentenceLength = sentenceLength;
  if (vocabulary) voice.vocabulary = vocabulary;
  if (honorific) voice.honorific = honorific;
  if (humor) voice.humor = humor;
  if (avoid) voice.avoid = avoid;
  if (examples) voice.examples = examples;
  return Object.keys(voice).length ? voice : undefined;
}

function normalizeRelationshipSeed(value: unknown): SoulCard['relationshipSeed'] {
  if (!isRecord(value)) return undefined;
  const seed: NonNullable<SoulCard['relationshipSeed']> = {};
  const stage = text(value.stage, 20);
  if (stage && STAGE_SET.has(stage)) seed.stage = stage as SoulStage;
  const trust = numberOr(value.trust, NaN);
  const intimacy = numberOr(value.intimacy, NaN);
  const respect = numberOr(value.respect, NaN);
  const tension = numberOr(value.tension, NaN);
  const familiarity = numberOr(pick(value, 'familiarity', 'familiar'), NaN);
  if (Number.isFinite(trust)) seed.trust = clampPercent(trust);
  if (Number.isFinite(intimacy)) seed.intimacy = clampPercent(intimacy);
  if (Number.isFinite(respect)) seed.respect = clampPercent(respect);
  if (Number.isFinite(tension)) seed.tension = clampPercent(tension);
  if (Number.isFinite(familiarity)) seed.familiarity = clampPercent(familiarity);
  const note = text(value.note, 240);
  if (note) seed.note = note;
  return Object.keys(seed).length ? seed : undefined;
}

function normalizeTemperament(value: unknown): SoulTemperament | undefined {
  if (!isRecord(value)) return undefined;
  const temperament: SoulTemperament = {};
  const baselineMood = text(pick(value, 'baselineMood', 'baseline_mood'), 80);
  const halfLife = numberOr(pick(value, 'moodHalfLifeHours', 'mood_half_life_hours'), NaN);
  const energy = numberOr(value.energy, NaN);
  const expressiveness = numberOr(value.expressiveness, NaN);
  if (baselineMood) temperament.baselineMood = baselineMood;
  if (Number.isFinite(halfLife)) temperament.moodHalfLifeHours = clamp(halfLife, 1, 168);
  if (Number.isFinite(energy)) temperament.energy = clampPercent(energy);
  if (Number.isFinite(expressiveness)) temperament.expressiveness = clampPercent(expressiveness);
  return Object.keys(temperament).length ? temperament : undefined;
}

function normalizeColor(value: unknown): SoulColor | undefined {
  if (!isRecord(value)) return undefined;
  const color: SoulColor = {};
  const primary = text(value.primary, 40);
  const secondary = text(value.secondary, 40);
  const glow = text(value.glow, 40);
  const shadow = text(value.shadow, 40);
  const description = text(value.description, 300);
  const motifs = text(value.motifs, 240);
  if (primary) color.primary = primary;
  if (secondary) color.secondary = secondary;
  if (glow) color.glow = glow;
  if (shadow) color.shadow = shadow;
  if (description) color.description = description;
  if (motifs) color.motifs = motifs;
  return Object.keys(color).length ? color : undefined;
}

function hasSoulContent(card: SoulCard): boolean {
  return Boolean(
    card.identity ||
    card.values?.length ||
    card.traits ||
    card.voice ||
    card.desires?.length ||
    card.fears?.length ||
    card.boundaries?.length ||
    card.relationshipSeed ||
    card.temperament ||
    card.soulColor ||
    card.examples?.length ||
    card.notes,
  );
}

/**
 * 把配置里的任意 JSON 归一化成灵魂卡：非法字段丢弃、字符串 trim/截断、数值夹到合法区间。
 * 没有任何有效内容 → null（调用方按「没有灵魂卡」处理，不注入任何段落）。
 */
export function normalizeSoulCard(raw: unknown): SoulCard | null {
  if (!isRecord(raw)) return null;
  const card: SoulCard = { version: 1 };
  const identity = normalizeIdentity(raw.identity);
  if (identity) card.identity = identity;
  const values = textList(pick(raw, 'values', 'coreValues', 'core_values'), 8);
  if (values) card.values = values;
  const traits = normalizeTraits(pick(raw, 'traits', 'personality'));
  if (traits) card.traits = traits;
  const voice = normalizeVoice(raw.voice);
  if (voice) card.voice = voice;
  const desires = textList(pick(raw, 'desires', 'wants'), 8);
  if (desires) card.desires = desires;
  const fears = textList(raw.fears, 8);
  if (fears) card.fears = fears;
  const boundaries = textList(raw.boundaries, 8);
  if (boundaries) card.boundaries = boundaries;
  const relationshipSeed = normalizeRelationshipSeed(
    pick(raw, 'relationshipSeed', 'relationship_seed', 'relationship'),
  );
  if (relationshipSeed) card.relationshipSeed = relationshipSeed;
  const temperament = normalizeTemperament(raw.temperament);
  if (temperament) card.temperament = temperament;
  const soulColor = normalizeColor(pick(raw, 'soulColor', 'soul_color', 'color'));
  if (soulColor) card.soulColor = soulColor;
  const examples = textList(raw.examples, 4, 300);
  if (examples) card.examples = examples;
  const notes = text(pick(raw, 'notes', 'note'), 600);
  if (notes) card.notes = notes;
  return hasSoulContent(card) ? card : null;
}

/**
 * 某宠物最终生效的灵魂卡：实例级 `pets[].soul` 优先，没写 / 非法 / 空 → 回落所属条目 `soul`。
 * 与 `petPersona` 同一套「替换而非拼接」语义：两张卡同时生效会让模型收到两个内核。
 */
export function soulCardOf(conf: Record<string, unknown>, pet: Record<string, unknown>): SoulCard | null {
  const own = normalizeSoulCard(pet.soul);
  if (own) return own;
  return normalizeSoulCard(conf.soul);
}

/** 灵魂色彩主色：只接受 hex；没有卡 / 非法颜色 → 返回回退色。 */
export function soulAccent(card: SoulCard | null | undefined, fallback = '#7aa7ff'): string {
  const candidates = [card?.soulColor?.primary, card?.soulColor?.glow, card?.soulColor?.secondary];
  for (const value of candidates) {
    if (typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) {
      return value.trim();
    }
  }
  return fallback;
}

/** 渲染灵魂卡（稳定设定）。没有内容 → 空串。 */
export function renderSoulCard(card: SoulCard | null | undefined, maxChars = MAX_CARD_CHARS): string {
  if (!card) return '';
  const body: string[] = [];
  const identity = card.identity;
  if (identity?.oneLine) body.push('一句话灵魂：' + identity.oneLine);
  const identityBits: string[] = [];
  if (identity?.species) identityBits.push('身份：' + identity.species);
  if (identity?.role) identityBits.push('角色：' + identity.role);
  if (identity?.origin) identityBits.push('来处：' + identity.origin);
  if (identityBits.length) body.push(identityBits.join('；'));
  if (identity?.selfImage) body.push('自我认知：' + identity.selfImage);
  if (identity?.coreContradiction) body.push('核心矛盾：' + identity.coreContradiction);
  if (card.values?.length) body.push('在意：' + card.values.join('；'));
  if (card.traits) {
    const traits = Object.entries(card.traits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, score]) => name + ' ' + Math.round(score))
      .join('、');
    if (traits) body.push('性格倾向：' + traits);
  }
  const voice = card.voice;
  if (voice) {
    const voiceBits: string[] = [];
    if (voice.tone) voiceBits.push('语气：' + voice.tone);
    if (voice.rhythm) voiceBits.push('节奏：' + voice.rhythm);
    if (voice.sentenceLength) voiceBits.push('句长：' + voice.sentenceLength);
    if (voice.vocabulary) voiceBits.push('用词：' + voice.vocabulary);
    if (voice.honorific) voiceBits.push('称呼：' + voice.honorific);
    if (voice.humor) voiceBits.push('幽默：' + voice.humor);
    if (voiceBits.length) body.push('说话方式：' + voiceBits.join('；'));
    if (voice.avoid?.length) body.push('不要：' + voice.avoid.join('；'));
    if (voice.examples?.length)
      body.push('语气示例（不要逐字照搬）：\n' + voice.examples.map((x) => '· ' + x).join('\n'));
  }
  if (card.desires?.length) body.push('渴望：' + card.desires.join('；'));
  if (card.fears?.length) body.push('害怕：' + card.fears.join('；'));
  if (card.boundaries?.length) body.push('边界：' + card.boundaries.join('；'));
  const seed = card.relationshipSeed;
  if (seed) {
    const stage = seed.stage ?? '初识';
    const bits: string[] = [];
    if (seed.trust !== undefined) bits.push('信任 ' + Math.round(seed.trust));
    if (seed.intimacy !== undefined) bits.push('亲密 ' + Math.round(seed.intimacy));
    if (seed.respect !== undefined) bits.push('尊重 ' + Math.round(seed.respect));
    if (seed.familiarity !== undefined) bits.push('熟悉 ' + Math.round(seed.familiarity));
    if (seed.tension !== undefined) bits.push('张力 ' + Math.round(seed.tension));
    body.push('关系起点：' + stage + (bits.length ? '（' + bits.join(' / ') + '）' : ''));
    if (seed.note) body.push('关系备注：' + seed.note);
  }
  const temperament = card.temperament;
  if (temperament) {
    const bits: string[] = [];
    if (temperament.baselineMood) bits.push('基线心情：' + temperament.baselineMood);
    if (temperament.energy !== undefined) bits.push('精力 ' + Math.round(temperament.energy));
    if (temperament.expressiveness !== undefined) bits.push('表达欲 ' + Math.round(temperament.expressiveness));
    if (bits.length) body.push('气质：' + bits.join('；'));
  }
  const color = card.soulColor;
  if (color) {
    const bits: string[] = [];
    if (color.primary) bits.push('主色 ' + color.primary);
    if (color.secondary) bits.push('辅色 ' + color.secondary);
    if (color.glow) bits.push('光晕 ' + color.glow);
    if (color.shadow) bits.push('阴影 ' + color.shadow);
    if (color.description) bits.push(color.description);
    if (color.motifs) bits.push('意象：' + color.motifs);
    if (bits.length) body.push('灵魂色彩：' + bits.join('；'));
  }
  if (card.examples?.length)
    body.push('对话示例（只学语气，不照抄）：\n' + card.examples.map((x) => '· ' + x).join('\n'));
  if (card.notes) body.push('补充：' + card.notes);
  if (!body.length) return '';
  const header = '【灵魂卡 · 稳定内在设定】\n' + '（以下不是台词，不要逐条复述；让它们自然影响你的判断、语气和选择。）';
  return truncate(header + '\n' + body.join('\n'), maxChars);
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

/** 渲染动态状态（此刻的情绪 / 关系 / 上次聊天）。没有状态 → 空串。 */
export function renderSoulState(
  state: SoulState | null | undefined,
  card?: SoulCard | null,
  maxChars = MAX_STATE_CHARS,
): string {
  // 没有卡就没有「基线」可对照，也不应该在旧人设里凭空多出一段状态。
  if (!state || !card) return '';
  const mood = state.mood;
  const rel = state.relationship;
  const body: string[] = [];
  const moodBits = [
    '愉悦 ' + Math.round(mood.valence),
    '唤醒 ' + Math.round(mood.arousal),
    '精力 ' + Math.round(mood.energy),
  ];
  body.push('心情：' + mood.label + '（' + moodBits.join(' / ') + (mood.cause ? '；原因：' + mood.cause : '') + '）');
  const relBits = [
    '信任 ' + Math.round(rel.trust),
    '亲密 ' + Math.round(rel.intimacy),
    '尊重 ' + Math.round(rel.respect),
    '熟悉 ' + Math.round(rel.familiarity),
    '张力 ' + Math.round(rel.tension),
  ];
  body.push('关系：' + rel.stage + '（' + relBits.join(' / ') + '；已互动 ' + rel.interactions + ' 次）');
  if (rel.note) body.push('关系备注：' + rel.note);
  if (rel.lastInteractionAt) body.push('上次互动：' + formatTime(rel.lastInteractionAt));
  if (state.lastExchange) {
    body.push('上次聊天：主人说「' + state.lastExchange.user + '」；你说「' + state.lastExchange.assistant + '」。');
  }
  if (state.memories?.length) {
    const lines = state.memories.slice(-10).map((m) => '· [' + soulMemoryKindLabel(m.kind) + '] ' + m.text);
    body.push('长期记忆（只作背景，不要逐条复述）：\n' + lines.join('\n'));
  }
  if (state.relationshipEvents?.length) {
    const lines = state.relationshipEvents
      .slice(-6)
      .map((e) => '· ' + formatTime(e.at) + ' [' + soulEventKindLabel(e.kind) + '] ' + e.text);
    body.push('关系事件（只作背景，不要逐条复述）：\n' + lines.join('\n'));
  }
  if (state.activeGoals?.length) body.push('当前挂心：' + state.activeGoals.join('；'));
  if (state.selfNarrative) body.push('自我叙事：' + state.selfNarrative);
  if (card?.temperament?.baselineMood) body.push('（基线心情：' + card.temperament.baselineMood + '）');
  const header = '【此刻的灵魂状态】\n' + '（这是连续状态，不是永久设定；不要向用户报数值，也不要机械复述。）';
  return truncate(header + '\n' + body.join('\n'), maxChars);
}

/** 灵魂卡 + 动态状态合成一段（给 /soul 预览与测试用；正式 system 由 persona 分别拼装）。 */
export function renderSoulPrompt(card: SoulCard | null | undefined, state: SoulState | null | undefined): string {
  return [renderSoulCard(card), renderSoulState(state, card)].filter(Boolean).join('\n\n');
}

/** 关系阶段：由熟悉 / 信任 / 亲密 / 张力推导；数值只作为模型不可见的内部状态。 */
export function relationshipStage(
  rel: Pick<SoulRelationship, 'trust' | 'intimacy' | 'familiarity' | 'tension'>,
): SoulStage {
  const score = rel.familiarity * 0.45 + rel.trust * 0.3 + rel.intimacy * 0.25 - rel.tension * 0.15;
  if (score < 10) return '陌生';
  if (score < 25) return '初识';
  if (score < 45) return '熟悉';
  if (score < 65) return '亲近';
  if (score < 82) return '默契';
  return '羁绊';
}

/** 情绪标签：只用于提示词里的自然语言，不暴露给用户。 */
export function moodLabel(mood: Pick<SoulMood, 'valence' | 'arousal' | 'energy'>, tension = 0): string {
  if (tension >= 60) return '紧绷';
  if (mood.energy <= 20) return '困倦';
  if (mood.valence >= 45 && mood.arousal >= 60) return '兴奋';
  if (mood.valence >= 25) return '开心';
  if (mood.valence >= 5) return '愉快';
  if (mood.valence > -15) return '平静';
  if (mood.valence > -40) return '低落';
  return '难过';
}

/** 新宠物的默认状态：情绪取卡里的基线，关系取关系起点。 */
export function defaultSoulState(card: SoulCard | null | undefined, petId: string, now: Date): SoulState {
  const seed = card?.relationshipSeed;
  const baseline = card?.temperament?.baselineMood?.trim() || '平静';
  const energy = clampPercent(card?.temperament?.energy ?? 65);
  const relationship: SoulRelationship = {
    stage: seed?.stage ?? '初识',
    trust: clampPercent(seed?.trust ?? 20),
    intimacy: clampPercent(seed?.intimacy ?? 10),
    respect: clampPercent(seed?.respect ?? 30),
    tension: clampPercent(seed?.tension ?? 0),
    familiarity: clampPercent(seed?.familiarity ?? 10),
    interactions: 0,
    lastInteractionAt: null,
  };
  // 卡片显式写了关系起点就尊重它；没写才按数值推导（首次互动后由 observeUserText 重算）。
  relationship.stage = seed?.stage ?? relationshipStage(relationship);
  const mood: SoulMood = {
    label: baseline,
    valence: 0,
    arousal: 30,
    energy,
    updatedAt: now.toISOString(),
  };
  return {
    version: 1,
    petId,
    mood,
    relationship,
    memories: [],
    relationshipEvents: [],
    activeGoals: [],
    selfNarrative: '',
    lastReflectionAt: null,
    lastAnniversaryReminder: '',
    updatedAt: now.toISOString(),
  };
}

function isoOr(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/**
 * 把磁盘上的任意 JSON 归一化成状态：缺字段取默认、非法数值夹回合法区间、阶段重新推导。
 * `raw` 里的 petId 不匹配也接受——状态文件按 petId 分桶，迁移/改名时保留连续性更重要。
 */
export function normalizeSoulState(
  raw: unknown,
  card: SoulCard | null | undefined,
  petId: string,
  now: Date,
): SoulState {
  const fallback = defaultSoulState(card, petId, now);
  if (!isRecord(raw)) return fallback;
  const moodRaw = isRecord(raw.mood) ? raw.mood : undefined;
  const relRaw = isRecord(raw.relationship) ? raw.relationship : undefined;
  const mood: SoulMood = {
    label: text(moodRaw?.label, 40) ?? fallback.mood.label,
    valence: clamp(numberOr(moodRaw?.valence, fallback.mood.valence), -100, 100),
    arousal: clampPercent(numberOr(moodRaw?.arousal, fallback.mood.arousal)),
    energy: clampPercent(numberOr(moodRaw?.energy, fallback.mood.energy)),
    updatedAt: isoOr(pick(moodRaw, 'updatedAt', 'updated_at'), fallback.mood.updatedAt),
  };
  const cause = text(moodRaw?.cause, 160);
  if (cause) mood.cause = cause;
  const relationship: SoulRelationship = {
    stage: fallback.relationship.stage,
    trust: clampPercent(numberOr(relRaw?.trust, fallback.relationship.trust)),
    intimacy: clampPercent(numberOr(relRaw?.intimacy, fallback.relationship.intimacy)),
    respect: clampPercent(numberOr(relRaw?.respect, fallback.relationship.respect)),
    tension: clampPercent(numberOr(relRaw?.tension, fallback.relationship.tension)),
    familiarity: clampPercent(numberOr(relRaw?.familiarity, fallback.relationship.familiarity)),
    interactions: Math.max(0, Math.floor(numberOr(relRaw?.interactions, 0))),
    lastInteractionAt: isoOrNull(pick(relRaw, 'lastInteractionAt', 'last_interaction_at')),
  };
  const stageRaw = text(relRaw?.stage, 20);
  relationship.stage = stageRaw && STAGE_SET.has(stageRaw) ? (stageRaw as SoulStage) : relationshipStage(relationship);
  const note = text(relRaw?.note, 240);
  if (note) relationship.note = note;
  const state: SoulState = {
    version: 1,
    petId,
    mood,
    relationship,
    memories: normalizeSoulMemories(raw.memories, now),
    relationshipEvents: normalizeSoulEvents(raw.relationshipEvents, now),
    activeGoals: textList(pick(raw, 'activeGoals', 'active_goals'), 5, 200) ?? [],
    selfNarrative: text(pick(raw, 'selfNarrative', 'self_narrative'), 600) ?? '',
    lastReflectionAt: isoOrNull(pick(raw, 'lastReflectionAt', 'last_reflection_at')),
    lastAnniversaryReminder: text(pick(raw, 'lastAnniversaryReminder', 'last_anniversary_reminder'), 400) ?? '',
    updatedAt: isoOr(pick(raw, 'updatedAt', 'updated_at'), now.toISOString()),
  };
  const exchangeRaw = pick(raw, 'lastExchange', 'last_exchange');
  if (isRecord(exchangeRaw)) {
    const user = text(exchangeRaw.user, LAST_EXCHANGE_CHARS);
    const assistant = text(exchangeRaw.assistant, LAST_EXCHANGE_CHARS);
    const at = isoOrNull(exchangeRaw.at);
    if (user && assistant && at) state.lastExchange = { user, assistant, at };
  }
  return state;
}

/** 时间衰减：情绪回落到卡里的基线，张力回落；信任 / 亲密 / 熟悉是长期量，不衰减。 */
export function decaySoulState(state: SoulState, card: SoulCard | null | undefined, now: Date): void {
  const updated = Date.parse(state.updatedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(updated) || nowMs <= updated) return;
  const hours = (nowMs - updated) / 3_600_000;
  if (hours < 0.01) return;
  const halfLife = clamp(numberOr(card?.temperament?.moodHalfLifeHours, 12), 1, 168);
  const factor = Math.pow(0.5, hours / halfLife);
  const baselineValence = 0;
  const baselineArousal = 30;
  const baselineEnergy = clampPercent(card?.temperament?.energy ?? 65);
  state.mood.valence = clamp(baselineValence + (state.mood.valence - baselineValence) * factor, -100, 100);
  state.mood.arousal = clampPercent(baselineArousal + (state.mood.arousal - baselineArousal) * factor);
  state.mood.energy = clampPercent(baselineEnergy + (state.mood.energy - baselineEnergy) * factor);
  state.relationship.tension = clampPercent(state.relationship.tension * factor);
  state.mood.label = moodLabel(state.mood, state.relationship.tension);
  state.mood.updatedAt = now.toISOString();
  state.updatedAt = now.toISOString();
}

function countMatches(value: string, re: RegExp): number {
  return value.match(re)?.length ?? 0;
}

/**
 * 一次用户发言对状态的影响：只做轻量启发式（熟悉度 + 温和/尖锐信号），不做语义抽取。
 * 失败/中断的对话不会调用它——只有生成成功并写入记忆后才推进状态。
 */
export function observeUserText(state: SoulState, value: string, now: Date): void {
  const message = value.trim();
  if (!message) return;
  const iso = now.toISOString();
  const rel = state.relationship;
  const wasFirst = rel.interactions === 0;
  const previousStage = rel.stage;
  // 老状态没有关系事件时间线：下一次互动时补一条里程碑，避免 UI 永远是空的。
  if (!state.relationshipEvents?.length && rel.interactions > 0) {
    state.relationshipEvents = appendSoulEvent(
      state.relationshipEvents,
      { text: '和主人已经聊过 ' + rel.interactions + ' 次', kind: 'milestone', at: iso },
      now,
    );
  }
  rel.interactions += 1;
  rel.familiarity = clampPercent(rel.familiarity + 1.2 + Math.min(Array.from(message).length / 200, 0.8));
  rel.lastInteractionAt = iso;
  const warm = countMatches(message, WARM_RE);
  const cold = countMatches(message, COLD_RE);
  if (warm > 0) {
    const n = Math.min(warm, 3);
    rel.trust = clampPercent(rel.trust + 1.0 * n);
    rel.intimacy = clampPercent(rel.intimacy + 0.8 * n);
    state.mood.valence = clamp(state.mood.valence + 4 * n, -100, 100);
    state.mood.arousal = clampPercent(state.mood.arousal + 2 * n);
    state.mood.cause = cold > 0 ? '刚才的对话又暖又刺' : '被主人温柔对待';
  } else if (cold > 0) {
    const n = Math.min(cold, 3);
    rel.trust = clampPercent(rel.trust - 1.4 * n);
    rel.intimacy = clampPercent(rel.intimacy - 0.6 * n);
    rel.tension = clampPercent(rel.tension + 4 * n);
    state.mood.valence = clamp(state.mood.valence - 5 * n, -100, 100);
    state.mood.energy = clampPercent(state.mood.energy - 2 * n);
    state.mood.cause = '刚才的对话有点刺';
  } else {
    state.mood.valence = clamp(state.mood.valence + 1, -100, 100);
    state.mood.arousal = clampPercent(state.mood.arousal + 1);
    state.mood.cause = '和主人聊了几句';
  }
  rel.stage = relationshipStage(rel);
  if (wasFirst) {
    state.relationshipEvents = appendSoulEvent(
      state.relationshipEvents,
      { text: '第一次和主人说话', kind: 'first', at: iso },
      now,
    );
  }
  if (rel.stage !== previousStage) {
    state.relationshipEvents = appendSoulEvent(
      state.relationshipEvents,
      { text: '关系进入「' + rel.stage + '」', kind: 'milestone', at: iso },
      now,
    );
  }
  state.mood.label = moodLabel(state.mood, rel.tension);
  state.mood.updatedAt = iso;
  state.updatedAt = iso;
}

/** 生成成功后记录最近一次对话：`chatMemoryRounds: 0` 时它是唯一的跨轮连续性锚点。 */
export function recordExchange(state: SoulState, userText: string, assistantText: string, now: Date): void {
  const user = text(userText, LAST_EXCHANGE_CHARS);
  const assistant = text(assistantText, LAST_EXCHANGE_CHARS);
  if (!user || !assistant) return;
  const exchange: SoulLastExchange = { user, assistant, at: now.toISOString() };
  state.lastExchange = exchange;
  state.updatedAt = now.toISOString();
}
