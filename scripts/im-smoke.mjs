/**
 * 冒烟脚本：验证消息接入（/im/*）的装配与校验，不真的去连微信/QQ 平台。
 *
 * 覆盖：GET /im/status（空配置）、POST /im/reload、参数校验（缺 bot、空 AppID）、
 * 以及未登录时的 /im/wechat/login 查询。跑法：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/im-smoke.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcAssets = join(pkgRoot, 'src', 'assets');
mkdirSync(srcAssets, { recursive: true });
const seededDefault = join(srcAssets, 'config.jsonc');
copyFileSync(join(pkgRoot, 'assets', 'config.jsonc'), seededDefault);

const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-plus-im-'));
const home = join(dir, 'home');
const userRoot = join(home, 'dsh-pet');
mkdirSync(userRoot, { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_PET_ELECTRON_PATH = process.execPath;

writeFileSync(
  join(userRoot, 'main-config.jsonc'),
  JSON.stringify({
    pets: [
      {
        id: 'main',
        name: '蓝毛小女仆',
        size: 462,
        balanceEnabled: false,
        whisperEnabled: false,
        workStatusEnabled: false,
        fixedEnabled: false,
        display: 'web',
        position: { corner: 'top-right', marginX: 24, marginY: 100 },
      },
    ],
    im: { wechat: { bots: [] }, qq: { bots: [] } },
  }),
  'utf8',
);

const { apply } = await import('../src/host/index.ts');

class FakeRes extends Writable {
  constructor() {
    super();
    this.status = 0;
    this.chunks = [];
  }
  writeHead(status) {
    this.status = status;
    return this;
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

let handler;
const noop = () => {};
const disposers = [];
apply({
  effect: (fn) => {
    try {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    } catch {
      return undefined;
    }
  },
  provide: () => noop,
  on: () => noop,
  webServer: { register: (spec) => ((handler = spec.handler), noop) },
  commands: { register: () => noop },
  logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'no-such-provider', model: 'x' }) },
  credentials: { resolve: async () => undefined },
  connection: {},
  llm: { listProviders: () => [], listModels: async () => [] },
});

const call = (url, method = 'GET', body) =>
  new Promise((done) => {
    const res = new FakeRes();
    res.on('finish', () => done({ status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }));
    void handler(
      {
        method,
        url,
        on: (event, cb) => {
          if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(body, 'utf8')));
          if (event === 'end') queueMicrotask(() => cb());
          return undefined;
        },
      },
      res,
    );
  });

const json = (r) => JSON.parse(r.body);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failed += 1;
};

try {
  assert.ok(handler, 'apply() 应注册路由处理器');

  const status = await call('/dsh-pet-7340/im/status');
  const s = json(status);
  check('GET /im/status', status.status === 200 && Array.isArray(s.wechat?.bots) && s.wechat.bots.length === 0);
  check('QQ 侧为空', Array.isArray(s.qq?.bots) && s.qq.bots.length === 0);

  const noBot = await call('/dsh-pet-7340/im/wechat/login', 'POST');
  check('微信登录缺 bot → bad-request', json(noBot).reason === 'bad-request');

  const emptyBind = await call('/dsh-pet-7340/im/qq/bind?bot=qq-1', 'POST', JSON.stringify({ appId: '', appSecret: '' }));
  const bindBody = json(emptyBind);
  check('QQ 绑定空凭据 → bad-request', bindBody.reason === 'bad-request', `message=${bindBody.message ?? ''}`);

  const reload = await call('/dsh-pet-7340/im/reload', 'POST', '{}');
  check('POST /im/reload', reload.status === 200 && json(reload).ok === true);

  const sessions = await call('/dsh-pet-7340/im/sessions');
  check('GET /im/sessions 有应答', sessions.status === 200, `body=${sessions.body.slice(0, 80)}`);

  console.log(failed === 0 ? 'IM SMOKE OK' : `IM SMOKE FAILED (${failed})`);
  if (failed !== 0) process.exitCode = 1;
} finally {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* 忽略 */
    }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(seededDefault, { force: true });
}
