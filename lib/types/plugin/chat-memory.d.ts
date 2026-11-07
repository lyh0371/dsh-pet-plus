import { type ChatMemoryMessage } from '../chat.ts';
import type { PetImageRef } from '../image-attachment.ts';
import { type VoiceTarget } from '../surface.ts';
import type { SoulCard, SoulState } from '../../shared/soul.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';
/** 对话与记忆的输入：装配期对象与更早的工厂。 */
export type ChatMemoryInput = {
    /** 宿主上下文（apply 收到的那一个）。 */
    ctx: HostContext;
} & Pick<HostSetup, 'configPaths'> & Pick<HostSetup, 'log'> & Pick<HostSetup, 'memeDirsFor'> & Pick<HostSetup, 'playback'> & Pick<HostSetup, 'state'> & Pick<HostSetup, 'userRoot'>;
/**
 * 创建对话与记忆。
 */
export declare function createChatMemory(deps: ChatMemoryInput): {
    lastWhisperAt: Map<string, number>;
    memoryPath: string;
    readMemory: () => Promise<Record<string, Record<string, {
        messages: ChatMemoryMessage[];
    }>>>;
    memoryRounds: (conf: Record<string, unknown>) => number;
    publishWhisper: (petId: string, image?: string, voiceTo?: VoiceTarget, kind?: "whisper" | "manual") => Promise<{
        ok: true;
        text: string;
        image?: string;
    } | {
        ok: false;
        reason: "provider-missing" | "generate-error" | "unknown-pet" | "unknown-image";
        message?: string;
    }>;
    publishSleepTalk: (petId: string) => Promise<boolean>;
    chatWithPet: (petId: string, text: string, image?: PetImageRef, opts?: {
        memoryKey?: string;
        writeSay?: boolean;
        speaker?: string;
    }) => Promise<{
        ok: true;
        text: string;
        image?: string;
    } | {
        ok: false;
        reason: "provider-missing" | "generate-error" | "unknown-pet";
        message?: string;
    }>;
    deleteHistory: (petId: string, ts?: readonly number[]) => Promise<{
        ok: true;
        removed: number;
    } | {
        ok: false;
        reason: "unknown-pet";
        message: string;
    }>;
    orphanHistory: () => Promise<import("./memory-orphans.ts").OrphanBucket[]>;
    deleteOrphans: () => Promise<{
        ok: true;
        pets: number;
        messages: number;
    }>;
    getActivePetId: () => string;
    setActivePetId: (id: string) => void;
    soulSnapshot: (petId: string) => Promise<{
        ok: false;
        reason: "unknown-pet";
        card?: undefined;
        state?: undefined;
        injected?: undefined;
    } | {
        ok: true;
        card: SoulCard | null;
        state: SoulState | null;
        injected: string;
        reason?: undefined;
    }>;
    reflectSoulNow: (petId: string) => Promise<{
        ok: true;
        memories: number;
        relationshipEvents: number;
        activeGoals: number;
        selfNarrative: boolean;
    } | {
        ok: false;
        reason: "busy" | "no-soul" | "no-memory" | "generate-error" | "parse-error" | "error";
        message?: string;
    }>;
    resetSoul: (petId: string, scope: "state" | "memories") => Promise<void>;
    addSoulEvent: (petId: string, text: string, kind?: string, at?: string) => Promise<{
        ok: true;
    } | {
        ok: false;
        reason: "unknown-pet" | "bad-request";
    }>;
    removeSoulEvent: (petId: string, text: string) => Promise<{
        ok: true;
        removed: number;
    }>;
};
/** 对话与记忆的产出（供下游工厂按需 Pick）。 */
export type ChatMemory = ReturnType<typeof createChatMemory>;
