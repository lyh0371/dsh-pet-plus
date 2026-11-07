/**
 * 灵魂卡：人格灵魂色彩（soul 卡）的编辑与维护。
 *
 * 卡本身以 JSON 文本编辑（字段太多，逐项做表单不现实，且用户会从别处粘贴整卡）；
 * 开关与卡文本都只改本地状态、随「保存」整包写入——
 * 「预览注入 / 立即整理 / 重置关系 / 清空记忆」是动作，直接打 /soul 路由，不改配置。
 * @module dsh-pet-plus/src/client/settings/soul-card
 */
import { useState } from 'react';
import { ROUTE_PATH } from '../../shared/constants.ts';
import type { SettingsRuntime } from './runtime.ts';
import { makeUiKit } from './ui.ts';

/** 灵魂卡的输入。 */
export interface SoulCardProps {
  /** 保存中或配置未就绪时禁用全部控件。 */
  readonly busy: boolean;
  /** 灵魂注入总开关（chatSoulEnabled）。 */
  readonly enabled: boolean;
  /** 卡的 JSON 文本（用户原文；空串 = 没有卡）。 */
  readonly cardText: string;
  /** 当前编辑的宠物 id（动作端点都按它定位）。 */
  readonly petId: string;
  /** 切换注入开关。 */
  readonly onToggle: (value: boolean) => void;
  /** 改写卡文本。 */
  readonly onCardTextChange: (value: string) => void;
}

/** 造灵魂卡。 */
export function makeSoulCard(rt: SettingsRuntime) {
  const { h, t } = rt;
  const { cardHead, field, toggleCell } = makeUiKit({ h, t });

  return function SoulCard(props: SoulCardProps) {
    const [result, setResult] = useState<{ kind: '' | 'ok' | 'err'; text: string }>({ kind: '', text: '' });
    const [preview, setPreview] = useState('');
    const [running, setRunning] = useState(false);

    const act = async (label: string, run: () => Promise<{ ok: boolean; text: string }>): Promise<void> => {
      if (running) return;
      setRunning(true);
      setResult({ kind: '', text: t('soulWorking') });
      try {
        const outcome = await run();
        setResult({ kind: outcome.ok ? 'ok' : 'err', text: label + '：' + outcome.text });
      } catch (error) {
        setResult({ kind: 'err', text: label + '：' + (error instanceof Error ? error.message : String(error)) });
      } finally {
        setRunning(false);
      }
    };

    const petQuery = () => '?pet=' + encodeURIComponent(props.petId);

    const onPreview = (): void =>
      void act(t('soulPreviewAction'), async () => {
        const response = await fetch(ROUTE_PATH + '/soul' + petQuery(), { cache: 'no-store' });
        const body = (await response.json()) as { ok?: boolean; injected?: string; reason?: string };
        if (body.ok !== true) return { ok: false, text: body.reason ?? 'error' };
        setPreview(body.injected ?? '');
        return { ok: true, text: t('soulPreviewDone') };
      });

    const onReflect = (): void =>
      void act(t('soulReflect'), async () => {
        const response = await fetch(ROUTE_PATH + '/soul/reflect' + petQuery(), { method: 'POST', body: '{}' });
        const body = (await response.json()) as {
          ok?: boolean;
          reason?: string;
          memories?: number;
          relationshipEvents?: number;
        };
        if (body.ok === true) {
          return {
            ok: true,
            text: t('soulReflectDone')
              .replace('{m}', String(body.memories ?? 0))
              .replace('{e}', String(body.relationshipEvents ?? 0)),
          };
        }
        return { ok: false, text: body.reason ?? 'error' };
      });

    const onReset = (scope: 'state' | 'memories'): void =>
      void act(scope === 'state' ? t('soulResetState') : t('soulResetMemories'), async () => {
        const response = await fetch(ROUTE_PATH + '/soul/reset' + petQuery(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope }),
        });
        const body = (await response.json()) as { ok?: boolean };
        return { ok: body.ok === true, text: body.ok === true ? t('soulResetDone') : 'error' };
      });

    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(t('soulTitle'), t('soulHint')),
        h('div', {
          className: 'dsh-pet-cfg__grid2',
          children: [toggleCell('chatSoulEnabled', props.enabled, props.busy, props.onToggle)],
        }),
        field(
          t('soulCardLabel'),
          h('textarea', {
            className: 'dsh-pet-cfg__input',
            rows: 10,
            value: props.cardText,
            disabled: props.busy || !props.enabled,
            onChange: (e: { target: { value: string } }) => props.onCardTextChange(e.target.value),
          }),
          t('soulCardHint'),
        ),
        h('div', {
          className: 'dsh-pet-cfg__grid4',
          children: [
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn is-sm',
              disabled: props.busy || running,
              onClick: onPreview,
              children: t('soulPreview'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn is-sm',
              disabled: props.busy || running || !props.enabled,
              onClick: onReflect,
              children: t('soulReflect'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn is-sm is-danger',
              disabled: props.busy || running,
              onClick: () => onReset('state'),
              children: t('soulResetState'),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-pet-cfg__btn is-sm is-danger',
              disabled: props.busy || running,
              onClick: () => onReset('memories'),
              children: t('soulResetMemories'),
            }),
          ],
        }),
        result.text !== ''
          ? h('p', {
              className: 'dsh-pet-cfg__note',
              style: result.kind === 'err' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
              children: result.text,
            })
          : null,
        preview !== ''
          ? h('pre', {
              className: 'dsh-pet-cfg__note',
              style: { whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto' },
              children: preview,
            })
          : null,
      ],
    });
  };
}
