import type { SettingsRuntime } from './runtime.ts';
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
export declare function makeSoulCard(rt: SettingsRuntime): (props: SoulCardProps) => import("react").ReactElement<any, string | import("react").JSXElementConstructor<any>>;
