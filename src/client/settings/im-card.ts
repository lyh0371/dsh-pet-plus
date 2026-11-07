/**
 * 消息接入卡：原生微信 / QQ 的机器人列表、扫码登录、QQ 绑定与连接状态。
 *
 * 机器人「长什么样」（启停 / 回复方式 / 宠物 / 白名单）只改本地状态、随「保存」整包写入；
 * 扫码、绑定、断开是动作，直接打 /im/* 路由，改的是凭据与运行时（im-auth.json），不经过保存。
 * 状态每 3 秒轮询一次：登录二维码、收发计数、错误都从 /im/status 来。
 * @module dsh-pet-plus/src/client/settings/im-card
 */
import { useEffect, useState } from 'react';
import { ROUTE_PATH } from '../../shared/constants.ts';
import {
  DEFAULT_IM,
  IM_MAX_BOTS,
  nextImBotId,
  type ImBotConfig,
  type ImConfig,
  type ImPlatform,
  type ImStatusView,
} from '../../shared/im.ts';
import { formatBridgeWhitelist, parseBridgeWhitelistText } from '../../shared/bridge.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 消息接入卡的输入。 */
export interface ImCardProps {
  /** 保存中或配置未就绪时禁用编辑类控件。 */
  readonly busy: boolean;
  /** 当前机器人配置（main.im）。 */
  readonly im: ImConfig;
  /** 可选的宠物（「桌宠回复」用）。 */
  readonly pets: ReadonlyArray<{ id: string; name?: string }>;
  /** 改写机器人配置。 */
  readonly onChange: (next: ImConfig) => void;
}

/** 把配置里的一只机器人补成完整形状（新增时用）。 */
function blankBot(id: string): ImBotConfig {
  return {
    id,
    enabled: false,
    mode: 'pet',
    petId: '',
    sessionId: '',
    whitelist: [],
    allowOwner: true,
    allowGroups: false,
    writeSay: false,
  };
}

/** 造消息接入卡。 */
export function makeImCard(rt: SettingsRuntime) {
  const { h, t } = rt;
  const { cardHead, field } = makeUiKit({ h, t });

  return function ImCard(props: ImCardProps) {
    const [status, setStatus] = useState<ImStatusView>(DEFAULT_IM as unknown as ImStatusView);
    const [qqDraft, setQqDraft] = useState<Record<string, { appId: string; appSecret: string }>>({});
    const [msg, setMsg] = useState<{ kind: '' | 'ok' | 'err'; text: string }>({ kind: '', text: '' });

    useEffect(() => {
      let alive = true;
      const tick = async (): Promise<void> => {
        try {
          const response = await fetch(ROUTE_PATH + '/im/status', { cache: 'no-store' });
          const body = (await response.json()) as ImStatusView;
          if (alive) setStatus(body);
        } catch {
          /* 轮询失败保持上一拍，不打扰用户 */
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), 3000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, []);

    const patchBot = (platform: ImPlatform, index: number, patch: Partial<ImBotConfig>): void => {
      const next: ImConfig = {
        wechat: { bots: [...props.im.wechat.bots] },
        qq: { bots: [...props.im.qq.bots] },
      };
      next[platform].bots[index] = { ...next[platform].bots[index], ...patch };
      props.onChange(next);
    };

    const removeBot = (platform: ImPlatform, index: number): void => {
      const next: ImConfig = {
        wechat: { bots: [...props.im.wechat.bots] },
        qq: { bots: [...props.im.qq.bots] },
      };
      next[platform].bots.splice(index, 1);
      props.onChange(next);
    };

    const addBot = (platform: ImPlatform): void => {
      const list = props.im[platform].bots;
      if (list.length >= IM_MAX_BOTS) {
        setMsg({ kind: 'err', text: t('imTooManyBots') });
        return;
      }
      const next: ImConfig = {
        wechat: { bots: [...props.im.wechat.bots] },
        qq: { bots: [...props.im.qq.bots] },
      };
      next[platform].bots.push(blankBot(nextImBotId(platform, list)));
      props.onChange(next);
    };

    const statusOf = (platform: ImPlatform, botId: string) =>
      status[platform]?.bots?.find((bot) => bot.id === botId) ?? null;

    const act = async (label: string, run: () => Promise<{ ok: boolean; text?: string }>): Promise<void> => {
      setMsg({ kind: '', text: t('imWorking') });
      try {
        const result = await run();
        setMsg({ kind: result.ok ? 'ok' : 'err', text: label + (result.text ? '：' + result.text : '') });
      } catch (error) {
        setMsg({ kind: 'err', text: label + '：' + (error instanceof Error ? error.message : String(error)) });
      }
    };

    const startWechat = (botId: string, platform: ImPlatform, index: number): void =>
      void act(t('imWechatLogin'), async () => {
        // 先确保配置里这只机器人是启用的，否则扫码成功也不会开始收消息。
        if (!props.im.wechat.bots[index].enabled) patchBot(platform, index, { enabled: true });
        const response = await fetch(ROUTE_PATH + '/im/wechat/login?bot=' + encodeURIComponent(botId), { method: 'POST' });
        const body = (await response.json()) as { ok?: boolean; reason?: string };
        return { ok: body.ok === true, text: body.ok === true ? '' : body.reason };
      });

    const cancelWechat = (botId: string): void =>
      void act(t('imCancel'), async () => {
        await fetch(ROUTE_PATH + '/im/wechat/login/cancel?bot=' + encodeURIComponent(botId), { method: 'POST' });
        return { ok: true };
      });

    const logoutWechat = (botId: string): void =>
      void act(t('imLogout'), async () => {
        await fetch(ROUTE_PATH + '/im/wechat/logout?bot=' + encodeURIComponent(botId), { method: 'POST' });
        return { ok: true };
      });

    const bindQq = (botId: string): void =>
      void act(t('imBindQq'), async () => {
        const draft = qqDraft[botId] ?? { appId: '', appSecret: '' };
        const response = await fetch(ROUTE_PATH + '/im/qq/bind?bot=' + encodeURIComponent(botId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: draft.appId, appSecret: draft.appSecret }),
        });
        const body = (await response.json()) as { ok?: boolean; message?: string; reason?: string };
        return { ok: body.ok === true, text: body.ok === true ? '' : (body.message ?? body.reason) };
      });

    const logoutQq = (botId: string): void =>
      void act(t('imLogout'), async () => {
        await fetch(ROUTE_PATH + '/im/qq/logout?bot=' + encodeURIComponent(botId), { method: 'POST' });
        return { ok: true };
      });

    const renderBot = (platform: ImPlatform, bot: ImBotConfig, index: number) => {
      const live = statusOf(platform, bot.id);
      const whitelistText = formatBridgeWhitelist(bot.whitelist);
      const qr = live?.login?.qrCodeDataUrl;
      return h('div', {
        key: platform + bot.id + index,
        className: 'dsh-pet-cfg__card',
        style: { marginTop: '8px' },
        children: [
          h('div', {
            className: 'dsh-pet-cfg__grid2',
            children: [
              field(
                t('imBotId'),
                h('input', {
                  className: 'dsh-pet-cfg__input',
                  value: bot.id,
                  disabled: props.busy,
                  onChange: (e: { target: { value: string } }) =>
                    patchBot(platform, index, { id: e.target.value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) }),
                }),
              ),
              h('div', {
                className: 'dsh-pet-cfg__grid2',
                children: [
                  h('label', {
                    children: [
                      h('input', {
                        type: 'checkbox',
                        checked: bot.enabled,
                        disabled: props.busy,
                        onChange: (e: { target: { checked: boolean } }) =>
                          patchBot(platform, index, { enabled: e.target.checked }),
                      }),
                      ' ' + t('imBotEnabled'),
                    ],
                  }),
                  h('label', {
                    children: [
                      h('input', {
                        type: 'checkbox',
                        checked: bot.writeSay,
                        disabled: props.busy || bot.mode !== 'pet',
                        onChange: (e: { target: { checked: boolean } }) =>
                          patchBot(platform, index, { writeSay: e.target.checked }),
                      }),
                      ' ' + t('imWriteSay'),
                    ],
                  }),
                ],
              }),
            ],
          }),
          h('div', {
            className: 'dsh-pet-cfg__grid2',
            children: [
              field(
                t('imMode'),
                h('select', {
                  className: 'dsh-pet-cfg__input',
                  value: bot.mode,
                  disabled: props.busy,
                  onChange: (e: { target: { value: string } }) =>
                    patchBot(platform, index, { mode: e.target.value === 'session' ? 'session' : 'pet' }),
                  children: [
                    h('option', { value: 'pet', children: t('imModePet') }),
                    h('option', { value: 'session', children: t('imModeSession') }),
                  ],
                }),
              ),
              bot.mode === 'pet'
                ? field(
                    t('imPet'),
                    h('select', {
                      className: 'dsh-pet-cfg__input',
                      value: bot.petId,
                      disabled: props.busy,
                      onChange: (e: { target: { value: string } }) => patchBot(platform, index, { petId: e.target.value }),
                      children: [
                        h('option', { value: '', children: t('imPetNone') }),
                        ...props.pets.map((pet) =>
                          h('option', { key: pet.id, value: pet.id, children: pet.name || pet.id }),
                        ),
                      ],
                    }),
                  )
                : field(
                    t('imSession'),
                    h('input', {
                      className: 'dsh-pet-cfg__input',
                      value: bot.sessionId,
                      disabled: props.busy,
                      onChange: (e: { target: { value: string } }) =>
                        patchBot(platform, index, { sessionId: e.target.value }),
                    }),
                  ),
            ],
          }),
          field(
            t('imWhitelist'),
            h('textarea', {
              className: 'dsh-pet-cfg__input',
              rows: 3,
              value: whitelistText,
              disabled: props.busy,
              onChange: (e: { target: { value: string } }) => {
                // 白名单按行文本编辑；解析失败先把文本原样留在本地、不覆盖已存的白名单。
                const parsed = parseBridgeWhitelistText(e.target.value);
                if (parsed.ok) patchBot(platform, index, { whitelist: parsed.list });
              },
            }),
            t('imWhitelistHint'),
          ),
          h('div', {
            className: 'dsh-pet-cfg__grid2',
            children: [
              h('label', {
                children: [
                  h('input', {
                    type: 'checkbox',
                    checked: bot.allowOwner,
                    disabled: props.busy,
                    onChange: (e: { target: { checked: boolean } }) =>
                      patchBot(platform, index, { allowOwner: e.target.checked }),
                  }),
                  ' ' + t('imAllowOwner'),
                ],
              }),
              platform === 'qq'
                ? h('label', {
                    children: [
                      h('input', {
                        type: 'checkbox',
                        checked: bot.allowGroups,
                        disabled: props.busy,
                        onChange: (e: { target: { checked: boolean } }) =>
                          patchBot(platform, index, { allowGroups: e.target.checked }),
                      }),
                      ' ' + t('imAllowGroup'),
                    ],
                  })
                : null,
            ],
          }),
          h('div', {
            className: 'dsh-pet-cfg__note',
            children:
              t('imState') +
              '：' +
              (live === null
                ? t('imStateUnknown')
                : `${live.state}${live.connected ? ' · ' + t('imConnected') : ''}` +
                  (live.account ? ` · ${live.account}` : '') +
                  ` · ${t('imCounts').replace('{r}', String(live.messagesReceived)).replace('{s}', String(live.messagesReplied))}` +
                  (live.lastError ? ` · ${live.lastError}` : '')),
          }),
          platform === 'wechat'
            ? h('div', {
                className: 'dsh-pet-cfg__grid4',
                children: [
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm',
                    disabled: props.busy || !bot.id,
                    onClick: () => startWechat(bot.id, platform, index),
                    children: t('imWechatLogin'),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm',
                    disabled: !bot.id,
                    onClick: () => cancelWechat(bot.id),
                    children: t('imCancel'),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm is-danger',
                    disabled: !bot.id,
                    onClick: () => logoutWechat(bot.id),
                    children: t('imLogout'),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm is-danger',
                    disabled: props.busy,
                    onClick: () => removeBot(platform, index),
                    children: t('imRemoveBot'),
                  }),
                ],
              })
            : h('div', {
                className: 'dsh-pet-cfg__grid2',
                children: [
                  field(
                    'AppID',
                    h('input', {
                      className: 'dsh-pet-cfg__input',
                      value: qqDraft[bot.id]?.appId ?? '',
                      disabled: props.busy,
                      onChange: (e: { target: { value: string } }) =>
                        setQqDraft((draft) => ({
                          ...draft,
                          [bot.id]: { appId: e.target.value, appSecret: draft[bot.id]?.appSecret ?? '' },
                        })),
                    }),
                  ),
                  field(
                    'AppSecret',
                    h('input', {
                      className: 'dsh-pet-cfg__input',
                      type: 'password',
                      value: qqDraft[bot.id]?.appSecret ?? '',
                      disabled: props.busy,
                      onChange: (e: { target: { value: string } }) =>
                        setQqDraft((draft) => ({
                          ...draft,
                          [bot.id]: { appId: draft[bot.id]?.appId ?? '', appSecret: e.target.value },
                        })),
                    }),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm',
                    disabled: props.busy || !bot.id,
                    onClick: () => bindQq(bot.id),
                    children: t('imBindQq'),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm is-danger',
                    disabled: !bot.id,
                    onClick: () => logoutQq(bot.id),
                    children: t('imLogout'),
                  }),
                  h('button', {
                    type: 'button',
                    className: 'dsh-pet-cfg__btn is-sm is-danger',
                    disabled: props.busy,
                    onClick: () => removeBot(platform, index),
                    children: t('imRemoveBot'),
                  }),
                ],
              }),
          qr
            ? h('img', {
                src: qr,
                style: { width: '180px', height: '180px', marginTop: '6px' },
                alt: 'wechat qr',
              })
            : null,
        ],
      });
    };

    const platformBlock = (platform: ImPlatform) =>
      h('div', {
        key: platform,
        style: { marginTop: '10px' },
        children: [
          h('div', {
            className: 'dsh-pet-cfg__cardTitle',
            children: platform === 'wechat' ? t('imWechat') : t('imQq'),
          }),
          ...props.im[platform].bots.map((bot, index) => renderBot(platform, bot, index)),
          h('button', {
            type: 'button',
            className: 'dsh-pet-cfg__btn is-sm',
            disabled: props.busy,
            onClick: () => addBot(platform),
            children: t('imAddBot'),
          }),
        ],
      });

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('imTitle'), t('imHint')),
        h('div', { className: 'dsh-pet-cfg__note', children: t('imRiskNote') }),
        platformBlock('wechat'),
        platformBlock('qq'),
        msg.text !== ''
          ? h('p', {
              className: 'dsh-pet-cfg__note',
              style: msg.kind === 'err' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
              children: msg.text,
            })
          : null,
      ],
    });
  };
}
