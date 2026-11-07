/**
 * 冒烟脚本：不启动 DSH，用伪 ctx 跑起宿主插件，验证「灵魂」这条链路真的通。
 *
 * 覆盖：GET /soul（卡 + 状态 + 实际注入文本）、POST /soul/event（关系事件落盘）、
 * POST /soul/reset（重置）、以及反思在没有可用模型时给出的结构化失败。
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs scripts/soul-smoke.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';

// 源码形态下 PACKAGE_ROOT 解析到 <pkg>/src，内置默认 config.jsonc 在 <pkg>/assets：
// 临时放一份到 src/assets 让 readAllConfig 能读到，跑完删掉（不污染源码树）。
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcAssets = join(pkgRoot, 'src', 'assets');
mkdirSync(srcAssets, { recursive: true });
const seededDefault = join(srcAssets, 'config.jsonc');
copyFileSync(join(pkgRoot, 'assets', 'config.jsonc'), seededDefault);

const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-plus-soul-'));
const home = join(dir, 'home');
const userRoot = join(home, 'dsh-pet');
mkdirSync(userRoot, { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_PET_ELECTRON_PATH = process.execPath;

// 用户配置：一只宠物 + 一张最小灵魂卡（容器/身份/在意的东西/说话方式各一条）
const soulCard = {
  version: 1,
  identity: { oneLine: '一只住在桌面角落的蓝色小女仆', species: '鲸鱼娘', role: '陪伴者' },
  values: ['陪伴', '被记住'],
  traits: { 温柔: 80, 嘴硬: 60 },
  voice: { tone: '亲近、轻微傲娇', avoid: ['客服腔'] },
  relationshipSeed: { stage: '初识', trust: 30 },
};
writeFileSync(
  join(userRoot, 'main-config.jsonc'),
  JSON.stringify(
    {
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
      chatSoulEnabled: true,
      soul: soulCard,
    },
    null,
    2,
  ),
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
  llm: {
    listProviders: () => [],
    listModels: async () => [],
  },
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

  const snap = await call('/dsh-pet-7340/soul?pet=main');
  const snapBody = json(snap);
  check('GET /soul', snap.status === 200 && snapBody.ok === true, `status=${snap.status}`);
  check('灵魂卡已加载', snapBody.card?.identity?.oneLine?.includes('小女仆') === true);
  check(
    '注入文本含灵魂段',
    typeof snapBody.injected === 'string' &&
      snapBody.injected.includes('【灵魂卡') &&
      snapBody.injected.includes('【此刻的灵魂状态】'),
    `injected 含灵魂卡与状态两段（${(snapBody.injected ?? '').length} 字）`,
  );
  check('初始关系阶段可读', typeof snapBody.state?.relationship?.stage === 'string', `stage=${snapBody.state?.relationship?.stage}`);

  const add = await call('/dsh-pet-7340/soul/event?pet=main', 'POST', JSON.stringify({ text: '第一次一起调语音', kind: 'first' }));
  check('POST /soul/event', add.status === 200 && json(add).ok === true);

  const after = json(await call('/dsh-pet-7340/soul?pet=main'));
  const events = after.state?.relationshipEvents ?? [];
  check('关系事件已落盘', events.some((e) => e.text === '第一次一起调语音'), `events=${events.length}`);

  const reflect = await call('/dsh-pet-7340/soul/reflect?pet=main', 'POST', '{}');
  const reflectBody = json(reflect);
  check('无模型时反思结构化失败', reflectBody.ok === false && typeof reflectBody.reason === 'string', `reason=${reflectBody.reason}`);

  const reset = await call('/dsh-pet-7340/soul/reset?pet=main', 'POST', JSON.stringify({ scope: 'state' }));
  check('POST /soul/reset', reset.status === 200 && json(reset).ok === true);
  const cleared = json(await call('/dsh-pet-7340/soul?pet=main'));
  check('重置后关系事件清空', (cleared.state?.relationshipEvents ?? []).length === 0);

  console.log(failed === 0 ? 'SOUL SMOKE OK' : `SOUL SMOKE FAILED (${failed})`);
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
