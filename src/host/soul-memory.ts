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
export const MAX_SOUL_MEMORIES = 20;
/** 单条记忆的最大字符数（按 Unicode 码点截断）。 */
export const MAX_SOUL_MEMORY_CHARS = 200;

const MEMORY_KINDS: readonly SoulMemoryKind[] = ['preference', 'event', 'promise', 'person', 'date', 'other'];
const MEMORY_KIND_SET = new Set<string>(MEMORY_KINDS);

/** 记忆类型 → 提示词里的中文标签。 */
const MEMORY_KIND_LABELS: Record<SoulMemoryKind, string> = {
  preference: '偏好',
  event: '事件',
  promise: '约定',
  person: '人物',
  date: '日期',
  other: '记忆',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = MAX_SOUL_MEMORY_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  const points = Array.from(trimmed);
  return points.length <= max ? trimmed : points.slice(0, max - 1).join('') + '…';
}

function isoOr(value: unknown, fallback: Date): string {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

function normalizeKind(value: unknown): SoulMemoryKind {
  return typeof value === 'string' && MEMORY_KIND_SET.has(value) ? (value as SoulMemoryKind) : 'other';
}

/** 记忆去重键：忽略大小写与多余空白；中文不受影响，英文大小写不会重复。 */
function memoryKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** 单条记忆：接受字符串或 { text/content/note, kind, at }；没有正文 → null。 */
export function normalizeSoulMemory(value: unknown, now: Date): SoulMemory | null {
  if (typeof value === 'string') {
    const body = text(value);
    return body ? { text: body, kind: 'other', at: now.toISOString() } : null;
  }
  if (!isRecord(value)) return null;
  const body = text(value.text ?? value.content ?? value.note ?? value.summary);
  if (!body) return null;
  return {
    text: body,
    kind: normalizeKind(value.kind ?? value.type),
    at: isoOr(value.at ?? value.createdAt ?? value.time, now),
  };
}

/** 数组归一化：丢弃坏条目、按正文去重、只保留最近的 MAX_SOUL_MEMORIES 条。 */
export function normalizeSoulMemories(value: unknown, now: Date): SoulMemory[] {
  if (!Array.isArray(value)) return [];
  const out: SoulMemory[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const memory = normalizeSoulMemory(item, now);
    if (!memory) continue;
    const key = memoryKey(memory.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(memory);
  }
  // 状态里可能因为旧版本/手写而超量：保留最近的 MAX_SOUL_MEMORIES 条，而不是最早那批。
  return out.slice(-MAX_SOUL_MEMORIES);
}

/** 合并已有与新增记忆：正文去重，新条目覆盖同文旧条目的 kind，保留旧时间。 */
export function mergeSoulMemories(
  existing: readonly SoulMemory[] | undefined,
  incoming: readonly SoulMemory[] | undefined,
  now: Date,
): SoulMemory[] {
  const byKey = new Map<string, SoulMemory>();
  for (const item of [...(existing ?? []), ...(incoming ?? [])]) {
    const memory = normalizeSoulMemory(item, now);
    if (!memory) continue;
    const key = memoryKey(memory.text);
    const previous = byKey.get(key);
    byKey.set(key, {
      text: previous?.text ?? memory.text,
      kind: memory.kind !== 'other' ? memory.kind : (previous?.kind ?? 'other'),
      at: previous?.at ?? memory.at,
    });
  }
  return [...byKey.values()].slice(-MAX_SOUL_MEMORIES);
}

/** 提示词里展示的记忆类型标签。 */
export function soulMemoryKindLabel(kind: SoulMemoryKind): string {
  return MEMORY_KIND_LABELS[kind] ?? MEMORY_KIND_LABELS.other;
}
