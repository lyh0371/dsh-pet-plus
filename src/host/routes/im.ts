/**
 * 消息接入路由：`/im/status`、`/im/sessions`、微信扫码登录与注销、QQ 绑定与注销、`/im/reload`。
 *
 * 只做参数校验与结果映射；连接、登录状态机与收发都在 `../im`（NativeImManager）。
 * 凭据（微信 token / QQ AppSecret）不经过这里，只落 `im-auth.json`。
 * @module dsh-pet-plus/src/host/routes/im
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

/** 机器人 id：与 ImStore 的落盘键同一套字符集。 */
const BOT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** 消息接入领域：未命中返回 undefined，命中返回应答。 */
export async function handleImRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { body, method, rest, url, signal } = input;
  if (rest !== 'im' && !rest.startsWith('im/')) return undefined;
  const im = deps.im;
  const bot = String(url.searchParams.get('bot') ?? '').trim();

  try {
    if (rest === 'im/status') {
      if (method !== 'GET') return methodNotAllowed();
      return okResult(im.status());
    }

    if (rest === 'im/sessions') {
      if (method !== 'GET') return methodNotAllowed();
      try {
        return okResult({ ok: true, sessions: await im.listSessions(signal) });
      } catch (error) {
        return okResult({ ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }

    if (rest === 'im/reload') {
      if (method !== 'POST') return methodNotAllowed();
      im.reload();
      return okResult({ ok: true });
    }

    if (rest === 'im/wechat/login') {
      if (!BOT_ID.test(bot)) return failResult('bad-request', 'bot 必填且只能用字母数字与 . _ -');
      if (method === 'GET') {
        const status = im.wechatLoginStatus(bot);
        return okResult(status === null ? { ok: false, reason: 'no-login' } : { ok: true, login: status });
      }
      if (method !== 'POST') return methodNotAllowed();
      const attempt = await im.startWechatLogin(bot);
      return okResult({ ok: true, login: attempt });
    }

    if (rest === 'im/wechat/login/cancel') {
      if (method !== 'POST') return methodNotAllowed();
      if (!BOT_ID.test(bot)) return failResult('bad-request', 'bot 必填');
      im.cancelWechatLogin(bot);
      return okResult({ ok: true });
    }

    if (rest === 'im/wechat/verify') {
      if (method !== 'POST') return methodNotAllowed();
      if (!BOT_ID.test(bot)) return failResult('bad-request', 'bot 必填');
      const raw = parseObjectBody(body);
      if (raw === null) return invalidJson();
      const code = typeof raw.code === 'string' ? raw.code.trim() : '';
      if (code === '') return failResult('bad-request', 'code 必填');
      const attempt = im.submitWechatVerifyCode(bot, code);
      return okResult(attempt === null ? { ok: false, reason: 'no-login' } : { ok: true, login: attempt });
    }

    if (rest === 'im/wechat/logout') {
      if (method !== 'POST') return methodNotAllowed();
      if (!BOT_ID.test(bot)) return failResult('bad-request', 'bot 必填');
      await im.logoutWechat(bot);
      return okResult({ ok: true });
    }

    if (rest === 'im/qq/bind') {
      if (method !== 'POST') return methodNotAllowed();
      if (!BOT_ID.test(bot)) return failResult('bad-request', 'bot 必填');
      const raw = parseObjectBody(body);
      if (raw === null) return invalidJson();
      const appId = typeof raw.appId === 'string' ? raw.appId : '';
      const appSecret = typeof raw.appSecret === 'string' ? raw.appSecret : '';
      try {
        await im.bindQq(bot, appId, appSecret);
      } catch (error) {
        return failResult('bad-request', error instanceof Error ? error.message : String(error));
      }
      return okResult({ ok: true });
    }

    if (rest === 'im/qq/logout') {
      if (method !== 'POST') return methodNotAllowed();
      if (!BOT_ID.test(bot)) return failResult('bad-request', 'bot 必填');
      await im.logoutQq(bot);
      return okResult({ ok: true });
    }

    return undefined;
  } catch (error) {
    deps.log.warn(`[dsh-pet] 消息接入失败：${error instanceof Error ? error.message : String(error)}`);
    return failResult('internal-error', 'dsh-pet: 消息接入失败');
  }
}
