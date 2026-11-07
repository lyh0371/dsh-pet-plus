/**
 * 关系事件时间线：第一次、阶段里程碑、约定、冲突 / 和好、日期、礼物等。
 *
 * 与长期记忆分开：记忆回答「主人是什么样的人」，事件回答「我们之间发生过什么」。
 * 这里只做归一化、去重、限量与合并，不碰 IO / 时钟；阶段变化由 observeUserText 写入，
 * 反思层也可以补充事件。
 *
 * @module dsh-pet/src/host/soul-events
 */
import type { SoulRelationshipEvent, SoulRelationshipEventKind } from '../shared/soul';

/** 状态文件里最多保留多少条关系事件。 */
export const MAX_SOUL_EVENTS = 30;
/** 单条事件的最大字符数。 */
export const MAX_SOUL_EVENT_CHARS = 180;

const EVENT_KINDS: readonly SoulRelationshipEventKind[] = [
  'first',
  'milestone',
  'promise',
  'conflict',
  'repair',
  'date',
  'gift',
  'other',
];
const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);

const EVENT_KIND_LABELS: Record<SoulRelationshipEventKind, string> = {
  first: '第一次',
  milestone: '里程碑',
  promise: '约定',
  conflict: '别扭',
  repair: '和好',
  date: '日期',
  gift: '礼物',
  other: '事件',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = MAX_SOUL_EVENT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  const points = Array.from(trimmed);
  return points.length <= max ? trimmed : points.slice(0, max - 1).join('') + '…';
}

function isoOr(value: unknown, fallback: Date): string {
  if (typeof value === 'string') {
    // 纯日期按本地中午解释：直接 new Date('YYYY-MM-DD') 是 UTC 零点，
    // 在负时区会落到前一天，纪念日会提前/延后一天。
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12)
      : new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

function normalizeKind(value: unknown): SoulRelationshipEventKind {
  return typeof value === 'string' && EVENT_KIND_SET.has(value) ? (value as SoulRelationshipEventKind) : 'other';
}

function eventKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** 单条事件：字符串或 { text/content/note/event, kind/type, at/date/time }。 */
export function normalizeSoulEvent(value: unknown, now: Date): SoulRelationshipEvent | null {
  if (typeof value === 'string') {
    const body = text(value);
    return body ? { text: body, kind: 'other', at: now.toISOString() } : null;
  }
  if (!isRecord(value)) return null;
  const body = text(value.text ?? value.content ?? value.note ?? value.event ?? value.summary);
  if (!body) return null;
  return {
    text: body,
    kind: normalizeKind(value.kind ?? value.type),
    at: isoOr(value.at ?? value.date ?? value.time ?? value.createdAt, now),
  };
}

/** 数组归一化：坏条目丢弃、按正文去重、只保留最近 MAX_SOUL_EVENTS 条。 */
export function normalizeSoulEvents(value: unknown, now: Date): SoulRelationshipEvent[] {
  if (!Array.isArray(value)) return [];
  const out: SoulRelationshipEvent[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const event = normalizeSoulEvent(item, now);
    if (!event) continue;
    const key = eventKey(event.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out.slice(-MAX_SOUL_EVENTS);
}

/** 追加一条事件（同文不重复），超过上限保留最近的事件。 */
export function appendSoulEvent(
  existing: readonly SoulRelationshipEvent[] | undefined,
  event: SoulRelationshipEvent,
  now: Date,
): SoulRelationshipEvent[] {
  return mergeSoulEvents(existing, [event], now);
}

/** 合并已有与新增事件：正文去重，旧时间优先，保留最近 MAX_SOUL_EVENTS 条。 */
export function mergeSoulEvents(
  existing: readonly SoulRelationshipEvent[] | undefined,
  incoming: readonly SoulRelationshipEvent[] | undefined,
  now: Date,
): SoulRelationshipEvent[] {
  const byKey = new Map<string, SoulRelationshipEvent>();
  for (const item of [...(existing ?? []), ...(incoming ?? [])]) {
    const event = normalizeSoulEvent(item, now);
    if (!event) continue;
    const key = eventKey(event.text);
    const previous = byKey.get(key);
    byKey.set(key, {
      text: previous?.text ?? event.text,
      kind: event.kind !== 'other' ? event.kind : (previous?.kind ?? 'other'),
      at: previous?.at ?? event.at,
    });
  }
  return [...byKey.values()].slice(-MAX_SOUL_EVENTS);
}

/** 今天是否是这个日期事件的周年：按月/日匹配；尚未发生的未来日期不提醒。 */
export function isAnniversaryDue(event: SoulRelationshipEvent, now: Date): boolean {
  if (event.kind !== 'date') return false;
  const date = new Date(event.at);
  if (Number.isNaN(date.getTime())) return false;
  if (date.getFullYear() > now.getFullYear()) return false;
  return date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

/** 今天到点的日期事件；多个事件同一天时一起返回。 */
export function dueAnniversaryEvents(
  events: readonly SoulRelationshipEvent[] | undefined,
  now: Date,
): SoulRelationshipEvent[] {
  return (events ?? []).filter((event) => isAnniversaryDue(event, now));
}

/** 当天提醒去重键：日期 + 事件正文；同一天新增事件会得到新键，但不会重复旧提醒。 */
export function anniversaryKey(events: readonly SoulRelationshipEvent[], now: Date): string {
  const day =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0');
  return (
    day +
    '|' +
    events
      .map((event) => event.text)
      .sort()
      .join('|')
  );
}

/** 提示词里展示的事件类型标签。 */
export function soulEventKindLabel(kind: SoulRelationshipEventKind): string {
  return EVENT_KIND_LABELS[kind] ?? EVENT_KIND_LABELS.other;
}
