/* eslint-disable @typescript-eslint/no-explicit-any -- DSH typert gateway / session event 形状由宿主提供，这里集中窄化。 */
/**
 * DSH 对话 session 模式的轻量客户端。
 *
 * 不经过 dsh-im：直接通过当前 Host 的 typertGateway 投递 `session.prompt`，
 * 监听 `session/event` 收集这次 turn 的最终 assistant 文本。
 *
 * 文本聚合逻辑参考 dsh-im（MIT, Copyright (c) 2026 xmanrui）的
 * AssistantTextAccumulator / accumulateFinalAssistantText。
 * @module dsh-pet/src/host/im/session
 */
import { randomUUID } from 'node:crypto';

import type { ImSessionSummary } from '../../shared/im';

export interface SessionAskOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Pending {
  rpcId: string;
  sessionId: string;
  targetTurn: number | null;
  openTurn: number | null;
  text: AssistantTextAccumulator;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

function textFromContent(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** 按 step/index 聚合 assistant 文本；工具调用后清掉之前的过程文本。 */
class AssistantTextAccumulator {
  #steps = new Map<number, Map<number, string>>();
  #legacy = '';

  clear(): void {
    this.#steps.clear();
    this.#legacy = '';
  }

  appendDelta(step: unknown, index: unknown, text: unknown): void {
    if (typeof text !== 'string' || !text) return;
    const s = Number.isSafeInteger(step) ? Number(step) : 0;
    const i = Number.isSafeInteger(index) ? Number(index) : 0;
    this.#legacy = '';
    const parts = this.#steps.get(s) ?? new Map<number, string>();
    parts.set(i, (parts.get(i) ?? '') + text);
    this.#steps.set(s, parts);
  }

  setCanonical(step: unknown, text: unknown): void {
    if (typeof text !== 'string' || !text.trim()) return;
    if (!Number.isSafeInteger(step)) {
      this.#steps.clear();
      this.#legacy = text.trim();
      return;
    }
    this.#legacy = '';
    this.#steps.set(Number(step), new Map([[0, text.trim()]]));
  }

  get text(): string {
    if (this.#steps.size === 0) return this.#legacy;
    return [...this.#steps.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, parts]) =>
        [...parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, value]) => value)
          .join('\n')
          .trim(),
      )
      .filter(Boolean)
      .join('\n\n');
  }
}

export class DshSessionRunner {
  #gateway: any;
  #peer: any;
  #pending = new Map<string, Pending>();
  #queues = new Map<string, Promise<unknown>>();
  #disposeEvent: (() => void) | undefined;

  constructor(ctx: any) {
    try {
      this.#gateway = ctx?.typertGateway ?? (typeof ctx?.get === 'function' ? ctx.get('typertGateway') : undefined);
    } catch {
      this.#gateway = undefined;
    }
    try {
      const connection = ctx?.connection ?? (typeof ctx?.get === 'function' ? ctx.get('connection') : undefined);
      this.#peer =
        typeof connection?.createPeer === 'function'
          ? connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
          : undefined;
    } catch {
      this.#peer = undefined;
    }
    if (typeof ctx?.on === 'function') {
      const dispose = ctx.on('session/event', (session: any, event: any) => this.#onEvent(session, event), {
        global: true,
      });
      this.#disposeEvent = typeof dispose === 'function' ? dispose : undefined;
    }
    ctx?.effect?.(() => () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.reject(new Error('DSH session runner disposed'));
      }
      this.#pending.clear();
      this.#disposeEvent?.();
      this.#peer?.dispose?.();
    });
  }

  get available(): boolean {
    return typeof this.#gateway?.invoke === 'function';
  }

  async listSessions(signal?: AbortSignal): Promise<ImSessionSummary[]> {
    if (!this.available) throw new Error('当前 Host 没有 session 网关');
    const result = await this.#gateway.invoke({
      namespace: 'session',
      method: 'list',
      args: { _request: {} },
      ...(signal ? { signal } : {}),
      ...(this.#peer ? { peer: this.#peer } : {}),
    });
    const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
    return items
      .map((item: any) => ({
        sessionId: typeof item?.sessionId === 'string' ? item.sessionId : '',
        ...(typeof item?.title === 'string' ? { title: item.title } : {}),
        ...(typeof item?.cwd === 'string' ? { cwd: item.cwd } : {}),
        ...(typeof item?.running === 'boolean' ? { running: item.running } : {}),
      }))
      .filter((item: ImSessionSummary) => item.sessionId);
  }

  ask(sessionId: string, text: string, options: SessionAskOptions = {}): Promise<string> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#ask(sessionId, text, options));
    this.#queues.set(sessionId, next);
    void next
      .finally(() => {
        if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId);
      })
      .catch(() => undefined);
    return next;
  }

  async #ask(sessionId: string, text: string, options: SessionAskOptions): Promise<string> {
    if (!this.available) throw new Error('当前 Host 没有 session 网关');
    if (!sessionId.trim()) throw new Error('sessionId 必填');
    if (!text.trim()) throw new Error('消息为空');
    options.signal?.throwIfAborted();
    const rpcId = `dsh-pet-im-${randomUUID()}`;
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? options.timeoutMs! : 600_000;
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        rpcId,
        sessionId,
        targetTurn: null,
        openTurn: null,
        text: new AssistantTextAccumulator(),
        resolve,
        reject,
        timer: setTimeout(() => this.#finish(pending, new Error('DSH session 回复超时')), timeoutMs),
        cleanup: () => undefined,
      };
      const onAbort = (): void => this.#finish(pending, new Error('DSH session 请求已取消'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      pending.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      this.#pending.set(rpcId, pending);
      void this.#gateway
        .invoke({
          namespace: 'session',
          method: 'prompt',
          args: {
            request: {
              requestId: rpcId,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
          },
          ...(options.signal ? { signal: options.signal } : {}),
          ...(this.#peer ? { peer: this.#peer } : {}),
        })
        .catch((error: unknown) => this.#finish(pending, error));
    });
  }

  #onEvent(session: any, event: any): void {
    const sessionId = typeof session === 'string' ? session : session?.id;
    if (typeof sessionId !== 'string' || !event || typeof event !== 'object') return;
    const pending = [...this.#pending.values()].find((entry) => entry.sessionId === sessionId);
    if (!pending) return;
    const turn = event.data?.turn;
    if (event.type === 'turn/start' && Number.isSafeInteger(turn)) {
      pending.openTurn = turn;
      return;
    }
    if (event.type === 'user/message' && event.data?.source?.rpcId === pending.rpcId) {
      pending.targetTurn = Number.isSafeInteger(turn) ? turn : pending.openTurn;
      return;
    }
    if (pending.targetTurn === null || turn !== pending.targetTurn) return;
    if (event.type === 'tool/call') {
      pending.text.clear();
      return;
    }
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
      pending.text.appendDelta(event.data.step, event.data.chunk.index, event.data.chunk.text);
      return;
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      const text = textFromContent(content);
      if (!text || (Array.isArray(content) && content.some((part: any) => part?.type === 'tool-call'))) {
        pending.text.clear();
      } else {
        pending.text.setCanonical(event.data.step, text);
      }
      return;
    }
    if (event.type === 'turn/end' && turn === pending.targetTurn) {
      const answer = pending.text.text.trim();
      if (!answer) this.#finish(pending, new Error('DSH session 没有返回 assistant 文本'));
      else this.#finish(pending, null, answer);
    }
  }

  #finish(pending: Pending, error: unknown, answer?: string): void {
    if (this.#pending.get(pending.rpcId) !== pending) return;
    this.#pending.delete(pending.rpcId);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (error) pending.reject(error);
    else pending.resolve(answer ?? '');
  }
}
