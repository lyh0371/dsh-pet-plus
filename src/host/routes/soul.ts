/**
 * 灵魂路由：`GET /soul`（卡 + 状态 + 实际注入文本）、`POST /soul/reflect`（手动整理记忆）、
 * `POST /soul/reset`（重置状态 / 只清记忆）、`POST /soul/event` 与 `/soul/event/remove`（关系事件）。
 *
 * 只做输入校验与结果映射：状态读写、反思与事件合并都在 chat-memory 里（同一个 soul-state.json）。
 * 业务结论一律 200（与其余动作端点一致），协议错误（方法、JSON）保留真实状态码。
 * @module dsh-pet-plus/src/host/routes/soul
 */
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 解析请求体：不是 JSON 对象 → null。 */
function parseObjectBody(body: string | undefined): Record<string, unknown> | null {
  if (body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** 灵魂领域：未命中返回 undefined，命中返回应答。 */
export async function handleSoulRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { body, method, rest, url } = input;
  if (rest !== 'soul' && !rest.startsWith('soul/')) return undefined;

  const petId = String(url.searchParams.get('pet') ?? '').trim();
  if (petId === '') return failResult('bad-request', '缺少 pet 参数');

  try {
    if (rest === 'soul') {
      if (method !== 'GET') return methodNotAllowed();
      const snapshot = await deps.soulSnapshot(petId);
      if (!snapshot.ok) return failResult('unknown-pet', '没有这只桌宠：' + petId);
      return okResult(snapshot);
    }

    if (rest === 'soul/reflect') {
      if (method !== 'POST') return methodNotAllowed();
      const outcome = await deps.reflectSoulNow(petId);
      return okResult(outcome);
    }

    if (rest === 'soul/reset') {
      if (method !== 'POST') return methodNotAllowed();
      const raw = parseObjectBody(body) ?? {};
      const scope = raw.scope === 'memories' ? 'memories' : 'state';
      await deps.resetSoul(petId, scope);
      return okResult({ ok: true, scope });
    }

    if (rest === 'soul/event') {
      if (method !== 'POST') return methodNotAllowed();
      const raw = parseObjectBody(body);
      if (raw === null) return invalidJson();
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (text === '') return failResult('bad-request', 'text 必填');
      const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
      const at = typeof raw.at === 'string' ? raw.at : undefined;
      const added = await deps.addSoulEvent(petId, text, kind, at);
      if (!added.ok) {
        return failResult(added.reason, added.reason === 'unknown-pet' ? '没有这只桌宠' : '事件内容或类型不合法');
      }
      return okResult({ ok: true });
    }

    if (rest === 'soul/event/remove') {
      if (method !== 'POST') return methodNotAllowed();
      const raw = parseObjectBody(body);
      if (raw === null) return invalidJson();
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (text === '') return failResult('bad-request', 'text 必填');
      return okResult(await deps.removeSoulEvent(petId, text));
    }

    return undefined;
  } catch (error) {
    deps.log.warn(`[dsh-pet] 灵魂读写失败：${error instanceof Error ? error.message : String(error)}`);
    return failResult('internal-error', 'dsh-pet: 灵魂读写失败');
  }
}
