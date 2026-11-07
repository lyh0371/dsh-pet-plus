/**
 * 对话与记忆：读写记忆文件、串行化对话队列、维护活跃宠物并生成碎碎念与回复。
 *
 * 不拼人设（人设归配置），不发网络请求（归 ./chat、./whisper）。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/chat-memory
 */
import { join } from 'node:path';
import { generateChat, type ChatMemoryMessage } from '../chat.ts';
import { chatActionNames } from '../chat-action.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { composeSystemPrompt, petPersona } from '../persona.ts';
import { findPetInstance, readAllConfig, removeRoundsByTs, sliceMemoryRounds } from '../config.ts';
import type { PetImageRef } from '../image-attachment.ts';
import { limitPool, matchMeme, pickMeme, readMemePool } from '../memes.ts';
import { generateWhisper } from '../whisper.ts';
import { createMemoryOrphans } from './memory-orphans.ts';
import { configuredModel } from '../model-selection.ts';
import { SLEEP_TALK_INSTRUCTION } from '../whisper.ts';
import { pickVoiceSurface, type VoiceTarget } from '../surface.ts';
import { decaySoulState, normalizeSoulState, observeUserText, recordExchange, soulCardOf } from '../soul.ts';
import {
  applySoulReflection,
  buildSoulReflectionPrompt,
  parseSoulReflection,
  shouldReflectSoul,
} from '../soul-reflection.ts';
import { createSoulStateStore } from '../soul-state.ts';
import { appendSoulEvent, normalizeSoulEvent } from '../soul-events.ts';
import type { SoulCard, SoulState } from '../../shared/soul.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';
import {
  activeChatMemoryProvider,
  type ChatContent,
  type ChatContentPatch,
  type ChatTurn,
} from '../chat-memory-provider.ts';

/** 第三方召回的硬超时（ms）：到点按“不修改内容”继续生成，不拖住这一轮对话。 */
const RECALL_TIMEOUT_MS = 1500;

/** 校验召回补丁里的历史项：形状不对的整段丢弃，避免坏数据把生成打崩。 */
function isChatTurn(value: unknown): value is ChatTurn {
  const turn = value as { role?: unknown; content?: unknown; ts?: unknown } | null;
  return (
    (turn?.role === 'user' || turn?.role === 'assistant') &&
    typeof turn?.content === 'string' &&
    typeof turn?.ts === 'number'
  );
}

/** 这一句该由哪一端念：取宠物实例的 display 推导（桌面优先）；两端都不显示时为 `undefined`。 */
function voiceTargetFor(pet: Record<string, unknown>): VoiceTarget | undefined {
  return pickVoiceSurface(String(pet.display ?? '')) ?? undefined;
}

/** 对话与记忆的输入：装配期对象与更早的工厂。 */
export type ChatMemoryInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<HostSetup, 'configPaths'> &
  Pick<HostSetup, 'log'> &
  Pick<HostSetup, 'memeDirsFor'> &
  Pick<HostSetup, 'playback'> &
  Pick<HostSetup, 'state'> &
  Pick<HostSetup, 'userRoot'>;

/**
 * 创建对话与记忆。
 */
export function createChatMemory(deps: ChatMemoryInput) {
  const { ctx, configPaths, log, memeDirsFor, playback, state, userRoot } = deps;
  /** 灵魂状态（情绪 / 关系 / 长期记忆）的落盘存储：与 memory.json 同目录。 */
  const soulStore = createSoulStateStore({ userRoot, log });
  // 命令「当前桌宠」（/pet 选择、/chat 使用）：全局单值不分会话；进程内内存，重启回默认第一只
  let activePetId = '';

  // 碎碎念周期调度的「上次生成时刻」（按宠物）：调度拍据此判断到没到点。
  // 生成结果直接写 S，多端共享同一句由 S 天然保证，不需要第二份缓存。
  const lastWhisperAt = new Map<string, number>();

  // 对话记忆文件（唯一读写方 = 本进程；浏览器/桌面两端都只是客户端 → 同一实例天然共享同一份记忆）。
  // 结构双层：{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }
  const memoryPath = join(userRoot, 'memory.json');

  // 对话写操作串行队列：read-modify-write 排队执行，防两端同时对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 读记忆文件：不存在 → 空；解析失败/根不是对象 → 记日志 + 空记忆（不备份、不改写源文件） */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    let raw: string;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch {
      return {}; // 文件不存在 = 尚无记忆
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;
    } catch (e) {
      log.error(
        `dsh-pet: 记忆文件无法解析（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      return {};
    }
  };

  const writeMemory = async (mem: Record<string, Record<string, { messages: ChatMemoryMessage[] }>>): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8');
  };

  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** 某宠物的最终人设 system：实例级 `pets[].whisperPrompt` 优先，没写回落到所属条目的那份。
   *  拼装在 ./persona（纯函数）：人设正文 + 名字声明 + 一行时间背景，时间每次现算；
   *  对话路径传 `{ historyTimes: true }` 追加【历史】说明，碎碎念没有历史，不传。
   *  收 `findPetInstance` 的命中结果而不是 (petId, cfg)：调用方都已解析过，再查只会多一处
   *  「查不到就兜底 main」的不可达分支。 */
  const petSystemPrompt = (
    found: { conf: Record<string, unknown>; pet: Record<string, unknown> },
    options: { historyTimes?: boolean; soulCard?: SoulCard | null; soulState?: SoulState | null } = {},
  ): string =>
    composeSystemPrompt({
      prompt: petPersona(found.conf, found.pet),
      name: String(found.pet.name ?? ''),
      id: String(found.pet.id ?? ''),
      now: new Date(),
      ...(options.historyTimes === true ? { historyTimes: true } : {}),
      soulCard: options.soulCard ?? null,
      soulState: options.soulState ?? null,
    });

  /** 当前生效的灵魂卡：全局开关 `chatSoulEnabled` 关闭时直接 null（不读卡、不写状态、不追加任何段落）。 */
  const effectiveSoulCard = (found: {
    conf: Record<string, unknown>;
    pet: Record<string, unknown>;
  }): SoulCard | null => (found.conf.chatSoulEnabled === false ? null : soulCardOf(found.conf, found.pet));

  /** 读一只宠物的灵魂状态（按离线时长衰减后返回）；没有卡时返回 null。 */
  const loadSoulState = async (petId: string, card: SoulCard): Promise<SoulState> => {
    const states = await soulStore.read();
    const now = new Date();
    const soulState = normalizeSoulState(states[petId], card, petId, now);
    decaySoulState(soulState, card, now);
    return soulState;
  };

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物所属条目的 chatMemoryRounds（合并器已填默认）。
   *  收已解析的条目配置：调用方都已拿到 `findPetInstance` 的结果。 */
  const memoryRounds = (conf: Record<string, unknown>): number => {
    const v = Number(conf.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

  /**
   * 对话前修改内容：召回钩子返回要覆盖的字段，核心合并后再交给模型。
   *
   * 超时、抛错、返回非法形状都当“不修改”，只记提供者 id 与原因。
   *
   * @param petId - 目标宠物；第三方按它区分记忆空间。
   * @param content - 本轮将要发给模型的 system/history/userText。
   * @returns 合法的覆盖字段；没有可应用的字段时 undefined。
   */
  const recallPatch = async (petId: string, content: ChatContent): Promise<ChatContentPatch | undefined> => {
    const provider = activeChatMemoryProvider();
    const recall = provider?.recall;
    if (!provider || !recall) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), RECALL_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([Promise.resolve(recall.call(provider, { petId, ...content })), timeout]);
      if (!result || typeof result !== 'object') return undefined;
      const patch: { system?: string; history?: readonly ChatTurn[]; userText?: string } = {};
      if (typeof result.system === 'string') patch.system = result.system;
      if (typeof result.userText === 'string') patch.userText = result.userText;
      if (Array.isArray(result.history) && result.history.every(isChatTurn)) patch.history = result.history;
      return Object.keys(patch).length === 0 ? undefined : patch;
    } catch (error) {
      log.warn(
        '[dsh-pet] 记忆召回失败 id=' + provider.id + '：' + (error instanceof Error ? error.message : String(error)),
      );
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * 落盘后接收这一轮问答：核心不等待，失败只记提供者 id 与原因。
   *
   * @param petId - 目标宠物。
   * @param turn - 本轮问答与元信息；action/image 只是名字，不含素材本体。
   */
  const captureTurn = (
    petId: string,
    turn: { userText: string; replyText: string; action?: string; image?: string; ts: number },
  ): void => {
    const provider = activeChatMemoryProvider();
    const capture = provider?.capture;
    if (!provider || !capture) return;
    void Promise.resolve()
      .then(() => capture.call(provider, { petId, ...turn }))
      .catch((error) => {
        log.warn(
          '[dsh-pet] 记忆接收失败 id=' + provider.id + '：' + (error instanceof Error ? error.message : String(error)),
        );
      });
  };

  /** 生成并返回某宠物的一句碎碎念（周期调度、菜单手动触发与命令行共用）：人设取它自己的 whisperPrompt，
   *  没写回落到所属条目；成功写进 S 的 pets.<id>.say——碎碎念 / 命令气泡 / 对话回复在前端是同一条
   *  展示链路，所以共用一个叶子。配图开关开启时从表情包池随机抽 1 张。
   *  失败带回真实 reason（含 unknown-pet / unknown-image），成功带回生成的文本——调用方不必再拉一拍 /state。
   *
   *  @param petId - 目标宠物实例 id。
   *  @param image - 指定配图的名称：给了就只用这张（不受 whisperImageEnabled 门控，手动点图是显式意图），
   *  不在池内返回 unknown-image；缺省 = 按开关随机抽或纯文本。
   *  @param voiceTo - 这一句该由哪一端念；缺省按它自己的 display 推导（桌面优先，见 {@link pickVoiceSurface}）。
   *  路由层带 `?surface=` 的会显式传请求面，其余调用点留空即可。
   *  @param kind - 这次生成的来源：`whisper` = 周期调度，受 `voiceWhisperEnabled` 管；`manual` = 菜单、
   *  斜杠命令、路由主动触发，不看那个开关（用户主动点的就是这一句）。缺省 `manual`。
   */
  const publishWhisper = async (
    petId: string,
    image?: string,
    voiceTo?: VoiceTarget,
    kind: 'whisper' | 'manual' = 'manual',
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet' | 'unknown-image'; message?: string }
  > => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    // 宠物可能在「校验那次读」与这里之间被删（配置随时会变，两次读之间就是窗口）：
    // 明确失败、不生成不写 S——写下去就是一只已不存在宠物的幽灵叶子（常驻到进程重启）。
    if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    // 调用方没指定就按这只宠物自己的 display 推（桌面优先）。规则只写在这一处，
    // 周期调度、斜杠命令这些调用点不必各算一遍。周期碎碎念另外受自己的开关管：
    // 关掉就不写 voiceTo（叶子不带这个键 = 谁都不念），气泡照旧弹。
    const whisperVoiceOn = cfg.main?.voiceWhisperEnabled === true;
    const target = kind === 'whisper' && !whisperVoiceOn ? undefined : (voiceTo ?? voiceTargetFor(found.pet));
    // 灵魂：碎碎念只读当前状态（不推进关系/情绪），让闲话也符合它此刻的心情与关系阶段。
    const soulCard = effectiveSoulCard(found);
    const soulState = soulCard ? await loadSoulState(petId, soulCard) : null;
    const system = petSystemPrompt(found, { soulCard, soulState });
    // 池只算一次：点名的图与随机抽图共用同一份（含文件存在性判定）。
    const pool = readMemePool(found.conf.memes, memeDirsFor(found.entry));
    // 点名了却没命中 = 配置写错或图已被删：明确失败，不静默换成另一张（点了 A 却看到 B 会以为坏了）。
    const forced = image === undefined ? undefined : matchMeme(pool, image);
    if (image !== undefined && forced === undefined) {
      return { ok: false, reason: 'unknown-image', message: '表情包不在池内：' + image };
    }
    const meme = forced ?? (found.conf.whisperImageEnabled === true ? pickMeme(pool) : undefined);
    // 模型：条目配置的 whisperModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
    const result = await generateWhisper(ctx, {
      system,
      meme,
      preferred: configuredModel(found.conf, 'whisperModel'),
    });
    if (!result.ok) {
      // 失败不写 S：静默跳过 + warn，不伪造文案、不弹错误气泡
      log.warn(
        '[dsh-pet] 碎碎念生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      // 真实 reason 原样带回：路由若把失败硬编码成 generate-error，独立模式下已算出的
      // provider-missing 就会在边界被吞掉（API.md 描述的降级 reason 正是它）。
      return result;
    }
    state.writePet(petId, 'say', {
      text: result.text,
      ...(result.image ? { image: result.image } : {}),
      ...(target ? { voiceTo: target } : {}),
    });
    // 成功也留一行：否则 logs.txt 里「没触发」与「触发了并且成功」无法区分。
    log.info(
      `[dsh-pet] 碎碎念生成成功 pet=${petId}，${result.text.length} 字` +
        (result.image ? `，配图=${result.image}` : ''),
    );
    // 文本随返回值带出，且与刚写进叶子的是同一个变量：两条出口给同一份文本，不是一个真相两个版本
    return { ok: true, text: result.text, ...(result.image ? { image: result.image } : {}) };
  };

  /** 生成并写一句梦话：system 只用人设，功能指令在 whisper（与碎碎念同属代码常量）；不配图、不念、不换动画。
   *  睡着时「换动画」本身就是打扰，所以写 `say` 显式 `anim: false`，也不写 `voiceTo`。
   *  @returns 是否真的生成并写进了 S；失败只留一行日志，调度下一拍再试。 */
  const publishSleepTalk = async (petId: string): Promise<boolean> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return false;
    // 梦话同样带上灵魂状态：睡着时说的话也该符合它此刻的心情（只读，不推进）。
    const sleepCard = effectiveSoulCard(found);
    const sleepState = sleepCard ? await loadSoulState(petId, sleepCard) : null;
    const system = petSystemPrompt(found, { soulCard: sleepCard, soulState: sleepState });
    const result = await generateWhisper(ctx, {
      system,
      preferred: configuredModel(found.conf, 'whisperModel'),
      instruction: SLEEP_TALK_INSTRUCTION,
    });
    if (!result.ok) {
      log.warn(
        '[dsh-pet] 梦话生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      return false;
    }
    state.writePet(petId, 'say', { text: result.text, anim: false });
    log.info(`[dsh-pet] 梦话生成成功 pet=${petId}，${result.text.length} 字`);
    return true;
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 写进 S 的 pets.<id>.say。
   *  供 POST /chat 与 /chat 命令共用（锁内读写，防两端交错写盘）；成功带回回复文本。 */
  /** 本轮对话成功后要排的反思任务：在锁外执行（LLM 调用不占记忆锁）。 */
  let reflectionJob: { petId: string; card: SoulCard; messages: ChatMemoryMessage[] } | null = null;

  /** 反思结果：成功时带回实际写入的条目数；失败用结构化 reason，设置页可直接显示。 */
  type SoulReflectOutcome =
    | { ok: true; memories: number; relationshipEvents: number; activeGoals: number; selfNarrative: boolean }
    | {
        ok: false;
        reason: 'busy' | 'no-soul' | 'no-memory' | 'generate-error' | 'parse-error' | 'error';
        message?: string;
      };

  /** 同一只宠物同一时间只跑一次反思：并发对话只让第一次触发，避免重复烧 token。 */
  const soulReflecting = new Set<string>();

  /**
   * 灵魂反思：把最近对话交给模型整理成长期记忆 / 关系事件 / 挂心 / 自我叙事。
   * LLM 调用在锁外，读改写走 withMemoryLock；失败返回结构化原因，不影响已经返回的回复。
   */
  const reflectSoul = async (job: {
    petId: string;
    card: SoulCard;
    messages: ChatMemoryMessage[];
  }): Promise<SoulReflectOutcome> => {
    if (soulReflecting.has(job.petId)) return { ok: false, reason: 'busy' };
    soulReflecting.add(job.petId);
    try {
      const states = await soulStore.read();
      const now = new Date();
      const promptState = normalizeSoulState(states[job.petId], job.card, job.petId, now);
      decaySoulState(promptState, job.card, now);
      const prompt = buildSoulReflectionPrompt(job.card, promptState, job.messages);
      const generated = await generateChat({
        ctx,
        system: prompt.system,
        history: [],
        userText: prompt.user,
        pool: [],
        actions: [],
        preferred: configuredModel({}, 'chatModel'),
      });
      if (!generated.ok) {
        log.warn(`[dsh-pet] 灵魂反思生成失败 pet=${job.petId} reason=${generated.reason}`);
        return {
          ok: false,
          reason: 'generate-error',
          message: generated.reason + (generated.message ? '：' + generated.message : ''),
        };
      }
      const reflection = parseSoulReflection(generated.text, new Date());
      if (!reflection) {
        log.warn(`[dsh-pet] 灵魂反思解析失败 pet=${job.petId}`);
        return { ok: false, reason: 'parse-error' };
      }
      await withMemoryLock(async () => {
        const current = await soulStore.read();
        const state = normalizeSoulState(current[job.petId], job.card, job.petId, new Date());
        applySoulReflection(state, reflection, new Date());
        current[job.petId] = state;
        await soulStore.write(current);
      });
      log.info(
        `[dsh-pet] 灵魂反思完成 pet=${job.petId}，记忆+${reflection.memories.length}，关系事件+${reflection.relationshipEvents.length}`,
      );
      return {
        ok: true,
        memories: reflection.memories.length,
        relationshipEvents: reflection.relationshipEvents.length,
        activeGoals: reflection.activeGoals.length,
        selfNarrative: reflection.selfNarrative.length > 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[dsh-pet] 灵魂反思异常 pet=${job.petId}：${message}`);
      return { ok: false, reason: 'error', message };
    } finally {
      soulReflecting.delete(job.petId);
    }
  };

  /** 灵魂快照：卡 + 状态（已按离线时长衰减）+ 实际会注入的 system，供设置页展示。 */
  const soulSnapshot = async (petId: string) => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return { ok: false as const, reason: 'unknown-pet' as const };
    const card = effectiveSoulCard(found);
    const states = await soulStore.read();
    const now = new Date();
    const state = normalizeSoulState(states[petId], card, petId, now);
    decaySoulState(state, card, now);
    return {
      ok: true as const,
      card,
      state: card === null ? null : state,
      injected: petSystemPrompt(found, { soulCard: card, soulState: card === null ? null : state }),
    };
  };

  /** 手动跑一次反思（设置页「立即整理记忆」）：与自动反思同一条实现。 */
  const reflectSoulNow = async (petId: string): Promise<SoulReflectOutcome> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return { ok: false, reason: 'no-soul' };
    const card = effectiveSoulCard(found);
    if (!card) return { ok: false, reason: 'no-soul' };
    const mem = await readMemory();
    const list = mem[found.entry]?.[petId]?.messages;
    if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'no-memory' };
    return reflectSoul({ petId, card, messages: list.slice(-12).map((m) => ({ ...m })) });
  };

  /**
   * 重置灵魂状态：`state` = 整只清空（情绪/关系/记忆全部回到初识）；
   * `memories` = 只清长期记忆与关系事件，保留情绪与关系数值。
   */
  const resetSoul = async (petId: string, scope: 'state' | 'memories'): Promise<void> => {
    const states = await soulStore.read();
    if (scope === 'memories') {
      const current = states[petId];
      if (current) {
        current.memories = [];
        current.relationshipEvents = [];
        current.activeGoals = [];
        current.selfNarrative = '';
        current.updatedAt = new Date().toISOString();
      }
    } else {
      delete states[petId];
    }
    await soulStore.write(states);
  };

  /** 手动加一条关系事件（设置页「关系事件」表单）。 */
  const addSoulEvent = async (
    petId: string,
    text: string,
    kind?: string,
    at?: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'unknown-pet' | 'bad-request' }> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    if (!found) return { ok: false, reason: 'unknown-pet' };
    const card = effectiveSoulCard(found);
    if (!card) return { ok: false, reason: 'bad-request' };
    const event = normalizeSoulEvent({ text, ...(kind ? { kind } : {}), ...(at ? { at } : {}) }, new Date());
    if (!event) return { ok: false, reason: 'bad-request' };
    const states = await soulStore.read();
    const state = normalizeSoulState(states[petId], card, petId, new Date());
    state.relationshipEvents = appendSoulEvent(state.relationshipEvents, event, new Date());
    states[petId] = state;
    await soulStore.write(states);
    return { ok: true };
  };

  /** 按正文删除一条关系事件（重复时删最早那条）。 */
  const removeSoulEvent = async (petId: string, text: string): Promise<{ ok: true; removed: number }> => {
    const states = await soulStore.read();
    const state = states[petId];
    const list = state?.relationshipEvents ?? [];
    const index = list.findIndex((event) => event.text === text);
    if (index >= 0 && state) {
      list.splice(index, 1);
      state.updatedAt = new Date().toISOString();
      await soulStore.write(states);
      return { ok: true, removed: 1 };
    }
    return { ok: true, removed: 0 };
  };

  /** 对话的可选参数：消息接入用独立记忆桶与说话人前缀，且默认不弹桌面气泡。 */
  type ChatOptions = { memoryKey?: string; writeSay?: boolean; speaker?: string };

  const chatWithPet = async (
    petId: string,
    text: string,
    image?: PetImageRef,
    opts?: ChatOptions,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string }
  > => {
    // 记忆桶：默认就是宠物 id（本机聊天）；消息接入传 `im:<平台>:<bot>:<发送者>` 隔离各人的上下文。
    const memoryKey = opts?.memoryKey?.trim() || petId;
    // 说话人前缀：只进模型与记忆，不进气泡（否则桌面上会显示成「wechat·张三：…」）。
    const speaker = opts?.speaker?.trim() ?? '';
    const userText = speaker ? `[${speaker}] ${text}` : text;
    reflectionJob = null;
    const result = await withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      // 宠物在「校验那次读」与这里之间被删了——本函数还要先排 withMemoryLock 的串行队列，
      // 窗口可能是秒级，所以这一支真会命中。明确失败：不生成、不写记忆也不写叶子，
      // 否则会在 memory.json 里永久留下一个已删宠物的分桶，外加一只幽灵叶子。
      if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
      const rounds = memoryRounds(found.conf);
      // 灵魂：对话前先按离线时长衰减、用这次用户发言推进（只改内存，生成成功后才落盘）。
      // 全局开关关闭 / 没有灵魂卡 → 不读不写，system 与旧版逐字一致。
      const soulCard = effectiveSoulCard(found);
      let soulState: SoulState | null = null;
      if (soulCard) {
        soulState = await loadSoulState(petId, soulCard);
        observeUserText(soulState, userText, new Date());
      }
      // 配图：开关关闭 → 空池（指令与解析都不介入）；目录链按所属条目取。
      // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
      const pool =
        found.conf.chatImageEnabled === true
          ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit))
          : [];
      // 动作名单：开关开启才取（关掉 = 不注入也不解析）；名单本身为空（没配 categories）同样等于关闭。
      const actions = found.conf.chatAnimationEnabled === true ? chatActionNames(found.conf.animations) : [];
      const mem = await readMemory();
      // 坏结构（数组/标量）按空桶重建；messages 不是数组的条目按新会话处理，避免 push 到坏对象上崩溃
      const bucket =
        mem[found.entry] && typeof mem[found.entry] === 'object' && !Array.isArray(mem[found.entry])
          ? mem[found.entry]
          : (mem[found.entry] = {});
      const existing = bucket[memoryKey];
      if (existing !== undefined && (!existing || !Array.isArray(existing.messages))) {
        log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId} key=${memoryKey}，按新会话处理：${memoryPath}`);
      }
      const entry = existing && Array.isArray(existing.messages) ? existing : (bucket[memoryKey] = { messages: [] });
      // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
      // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
      const list = sliceMemoryRounds(entry.messages, rounds);
      // 人设：实例级 whisperPrompt 优先，没写回落所属条目（与碎碎念同一拼装）。
      // 有历史才追加【历史】段：没有历史时那段话在描述不存在的前缀，只会误导模型。
      const system = petSystemPrompt(found, { historyTimes: list.length > 0, soulCard, soulState });
      // 图片只记尺寸与字节数（不记 base64）：模型不支持读图时 dsh-llm 会把它投影成占位文本，靠这行日志定位
      if (image !== undefined) {
        log.info(
          `[dsh-pet] 对话附带图片 pet=${petId}，${image.width}x${image.height}，${image.bytes} 字节` +
            '（模型不支持读图时内核会以占位文本代替）',
        );
      }
      // 第三方记忆：对话前修改内容；失败或超时降级为原内容（见 recallPatch）。
      const patch = await recallPatch(petId, {
        system,
        history: list.map(({ role, content, ts }) => ({ role, content, ts })),
        userText: text,
      });
      // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
      const generated = await generateChat({
        ctx,
        system: patch?.system ?? system,
        history: patch?.history ?? list,
        userText: patch?.userText ?? userText,
        pool,
        actions,
        preferred: configuredModel(found.conf, 'chatModel'),
        image,
      });
      if (!generated.ok) return generated;
      const now = Date.now();
      // 用户上传的图只存不送：记忆要能还原「这一轮带过图」（聊天记录存档），但不把图本体重发给模型；
      // AI 配的图只回填名称标记（见 chat.ts 的 historyMarkersOf），同样不带图本体。
      entry.messages.push({ role: 'user', content: userText, ts: now, ...(image ? { image } : {}) });
      entry.messages.push({
        role: 'assistant',
        content: generated.text,
        ts: now,
        ...(generated.image ? { meme: generated.image } : {}),
        // 动作名与配图名同类：落盘只存名字，回放历史时由 chat.ts 以 [动作:名] 回填——
        // 否则模型记不得自己演过什么，用户说「换一个」它无从判断
        ...(generated.action ? { action: generated.action } : {}),
      });
      await writeMemory(mem);
      // 灵魂状态落盘：只有生成成功才推进（失败不写，避免把没发生的对话记成关系事件）。
      if (soulCard !== null && soulState !== null) {
        recordExchange(soulState, userText, generated.text, new Date());
        const states = await soulStore.read();
        states[petId] = soulState;
        await soulStore.write(states);
        if (shouldReflectSoul(soulState, new Date())) {
          reflectionJob = { petId, card: soulCard, messages: entry.messages.slice(-12).map((m) => ({ ...m })) };
        }
      }
      // 第三方记忆：落盘后异步接收；不等待、失败只记日志，不能影响这一轮回复。
      captureTurn(petId, {
        userText: text,
        replyText: generated.text,
        ts: now,
        ...(generated.action !== undefined ? { action: generated.action } : {}),
        ...(generated.image !== undefined ? { image: generated.image } : {}),
      });
      // 动作先写：与 POST /anim 同一条写回链路（记录 + anim 叶子），渲染端据此播放并回报执。
      if (generated.action !== undefined) {
        const record = playback.create(petId, generated.action);
        state.writePet(petId, 'anim', { name: generated.action, playbackId: record.playbackId });
      }
      // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）。
      // 消息接入默认不写桌面气泡（opts.writeSay === false），避免多人聊天时桌面频繁弹话。
      // 该由哪一端念按这只宠物的 display 推：对话请求带的是 surface=any，本来就没有具体的一端可用。
      const replyVoiceTo = voiceTargetFor(found.pet);
      // 只有动作没有正文（模型只写了标记）→ 不写 say，避免弹一个空气泡。
      if (generated.text !== '' && opts?.writeSay !== false) {
        state.writePet(petId, 'say', {
          text: generated.text,
          ...(generated.image ? { image: generated.image } : {}),
          // 带动作时显式关掉碎碎念动画：气泡照弹，但不把刚点播的动作顶掉
          ...(generated.action !== undefined ? { anim: false } : {}),
          ...(replyVoiceTo ? { voiceTo: replyVoiceTo } : {}),
        });
      }
      // 同一份文本随返回值带出（叶子照写，不是二选一）
      return { ok: true as const, text: generated.text, ...(generated.image ? { image: generated.image } : {}) };
    });
    const job = reflectionJob;
    reflectionJob = null;
    // 反思只在对局成功时排，且不阻塞这一轮回包：它是旁路整理，失败只写日志。
    if (result.ok && job !== null) void reflectSoul(job);
    // 回调是从 generateChat 的宽类型直接透传的；对外契约仍是窄的三种失败原因。
    return result as {
      ok: true;
      text: string;
      image?: string;
    } | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string };
  };

  /** 删除某只宠物的对话记忆：`ts` 缺省 = 清空全部，给了 ts = 只删命中的轮（一轮两条共享 ts，成对删）。
   *  与对话共用同一条串行队列——删除不会插进一次回复的读-改-写中间，也不会被它覆盖写回。
   *  删空的宠物连叶子与空条目一起摘掉：否则 memory.json 里会永久堆着空对象，看不出这里曾有历史。 */
  const deleteHistory = async (
    petId: string,
    ts?: readonly number[],
  ): Promise<{ ok: true; removed: number } | { ok: false; reason: 'unknown-pet'; message: string }> =>
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      // 与对话同一支：宠物随时可能被删，明确失败，不在文件里留没人消费的分桶
      if (!found) return { ok: false as const, reason: 'unknown-pet' as const, message: '没有这只桌宠：' + petId };
      const mem = await readMemory();
      const byPet = mem[found.entry];
      const before = byPet?.[petId]?.messages;
      const list = Array.isArray(before) ? before : [];
      const kept = ts === undefined ? [] : removeRoundsByTs(list, ts).messages;
      const removed = list.length - kept.length;
      if (removed > 0) {
        const leaf = byPet?.[petId];
        if (kept.length > 0 && leaf !== undefined) {
          leaf.messages = kept;
        } else if (byPet !== undefined) {
          // 清空（或本来就只剩坏数据）：摘掉宠物叶子；条目空了连条目一起摘
          delete byPet[petId];
          if (Object.keys(byPet).length === 0) delete mem[found.entry];
        }
        await writeMemory(mem);
      }
      // 只记数量与动作，不打正文（记忆内容是用户隐私）
      log.info(`[dsh-pet] 删除对话记忆 pet=${petId}，removed=${removed}` + (ts === undefined ? '（清空）' : ''));
      return { ok: true as const, removed };
    });

  /** 已删宠物残留历史的查询与清理（判定与读写细节见 ./memory-orphans）。 */
  const { orphanHistory, deleteOrphans } = createMemoryOrphans({
    configPaths,
    readMemory,
    writeMemory,
    withLock: withMemoryLock,
    log,
  });

  /** 当前活跃宠物 id（会话事件写入，余额与碎念读取）。 */
  const getActivePetId = (): string => activePetId;

  /** 改写当前活跃宠物 id。 */
  const setActivePetId = (id: string): void => {
    activePetId = id;
  };
  return {
    lastWhisperAt,
    memoryPath,
    readMemory,
    memoryRounds,
    publishWhisper,
    publishSleepTalk,
    chatWithPet,
    deleteHistory,
    orphanHistory,
    deleteOrphans,
    getActivePetId,
    setActivePetId,
    // 灵魂：快照 / 手动反思 / 重置 / 关系事件（设置页与 /soul 路由共用）
    soulSnapshot,
    reflectSoulNow,
    resetSoul,
    addSoulEvent,
    removeSoulEvent,
  };
}
/** 对话与记忆的产出（供下游工厂按需 Pick）。 */
export type ChatMemory = ReturnType<typeof createChatMemory>;
