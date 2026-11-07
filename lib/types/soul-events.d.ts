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
export declare const MAX_SOUL_EVENTS = 30;
/** 单条事件的最大字符数。 */
export declare const MAX_SOUL_EVENT_CHARS = 180;
/** 单条事件：字符串或 { text/content/note/event, kind/type, at/date/time }。 */
export declare function normalizeSoulEvent(value: unknown, now: Date): SoulRelationshipEvent | null;
/** 数组归一化：坏条目丢弃、按正文去重、只保留最近 MAX_SOUL_EVENTS 条。 */
export declare function normalizeSoulEvents(value: unknown, now: Date): SoulRelationshipEvent[];
/** 追加一条事件（同文不重复），超过上限保留最近的事件。 */
export declare function appendSoulEvent(existing: readonly SoulRelationshipEvent[] | undefined, event: SoulRelationshipEvent, now: Date): SoulRelationshipEvent[];
/** 合并已有与新增事件：正文去重，旧时间优先，保留最近 MAX_SOUL_EVENTS 条。 */
export declare function mergeSoulEvents(existing: readonly SoulRelationshipEvent[] | undefined, incoming: readonly SoulRelationshipEvent[] | undefined, now: Date): SoulRelationshipEvent[];
/** 今天是否是这个日期事件的周年：按月/日匹配；尚未发生的未来日期不提醒。 */
export declare function isAnniversaryDue(event: SoulRelationshipEvent, now: Date): boolean;
/** 今天到点的日期事件；多个事件同一天时一起返回。 */
export declare function dueAnniversaryEvents(events: readonly SoulRelationshipEvent[] | undefined, now: Date): SoulRelationshipEvent[];
/** 当天提醒去重键：日期 + 事件正文；同一天新增事件会得到新键，但不会重复旧提醒。 */
export declare function anniversaryKey(events: readonly SoulRelationshipEvent[], now: Date): string;
/** 提示词里展示的事件类型标签。 */
export declare function soulEventKindLabel(kind: SoulRelationshipEventKind): string;
