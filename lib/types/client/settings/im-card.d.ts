import { type ImConfig } from '../../shared/im.ts';
import type { SettingsRuntime } from './runtime.ts';
/** 消息接入卡的输入。 */
export interface ImCardProps {
    /** 保存中或配置未就绪时禁用编辑类控件。 */
    readonly busy: boolean;
    /** 当前机器人配置（main.im）。 */
    readonly im: ImConfig;
    /** 可选的宠物（「桌宠回复」用）。 */
    readonly pets: ReadonlyArray<{
        id: string;
        name?: string;
    }>;
    /** 改写机器人配置。 */
    readonly onChange: (next: ImConfig) => void;
}
/** 造消息接入卡。 */
export declare function makeImCard(rt: SettingsRuntime): (props: ImCardProps) => import("react").ReactElement<any, string | import("react").JSXElementConstructor<any>>;
