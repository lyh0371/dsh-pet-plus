# dsh-pet-plus 🐳

> DeepSeek Harness 桌宠增强版：在 **[dsh-pet](https://github.com/PC2005-cloud/dsh-pet)** 的基础上，
> 融合 **[dsh-pet-to-family](https://github.com/zi-O1/dsh-pet-to-family)** 的「人格灵魂色彩 / 长期记忆」与「原生微信、QQ 消息接入」。

![dsh](https://img.shields.io/badge/DSH-0.2.x-8A2BE2)
![license](https://img.shields.io/badge/license-MIT-blue)
![assets](https://img.shields.io/badge/assets-114%20webm%20animations-ff69b4)

---

## ⚠️ 来源声明（请先看这里）

**本项目不是原创作品，而是两个开源项目的二次封装（fork + 合并改造）：**

| 上游 | 作者 | 本项目的来源 |
|---|---|---|
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | PC2005-cloud（及社区） | **代码基座**：本仓库从它的 0.4.5 源码分出，动画素材、物理、语音、余额、待办、桌面模式等全部来自它 |
| [zi-O1/dsh-pet-to-family](https://github.com/zi-O1/dsh-pet-to-family) | zi-O1 | **功能移植**：`soul`（人格灵魂色彩 / 长期记忆 / 关系事件 / 反思）、`im`（原生微信 iLink / QQ 官方机器人）及其设置页 UI 来自它 |

两上游均为 MIT 许可。本仓库保留它们的版权声明（见 [LICENSE](LICENSE) 与文末「署名」），
新增的合并、接线与配置改造以 MIT 一并发布。

宠物形象「大肥鱼 / 鲸鱼娘」为社区二创，遵循 **CC BY-NC-SA 4.0**：**禁止商用**。

---

## 它是什么

一只住在 DSH 里的桌宠：待机呼吸、随机动作、屏幕漫游、点击 Q 弹、拖拽甩抛、
跟随会话状态切换动画、余额展示、碎碎念与对话、语音播报、待办、桌面透明置顶窗。

在保留以上全部能力的前提下，本版新增两块：

### 1. 人格灵魂色彩 + 长期记忆

- **灵魂卡**：身份 / 在意的东西 / 性格倾向 / 说话方式 / 欲望 / 恐惧 / 边界 / 关系起点 / 灵魂色；
- **动态灵魂状态**：情绪（愉悦/唤醒/精力，按离线时长衰减）、关系（信任/亲密/尊重/张力/阶段）、最近一次对话；
- **长期记忆**：反思层从对话里抽取偏好/事件/约定/人物/日期，最多 20 条，跨会话注入提示词；
- **关系事件与纪念日**：第一次、里程碑、约定、别扭、和好、礼物、日期，纪念日当天主动提；
- **反思节流**：至少 3 次互动后开始，之后每 6 次互动或间隔 12 小时整理一次（LLM 调用在记忆锁外）。

有卡时宿主在 system 提示词里追加两段：

```
【灵魂卡 · 稳定内在设定】
【此刻的灵魂状态】
```

没有卡（或关掉 `chatSoulEnabled`）时，提示词与上游逐字一致 —— 不读卡、不写状态、不追加任何段落。

### 2. 原生微信 / QQ 消息接入

- 每个平台可挂**多个机器人**，各自独立登录与回复方式：
  - **桌宠回复**：消息进宠物人格 / 灵魂 / 记忆，记忆按 `im:<平台>:<bot>:<发送者>` 分桶隔离；
  - **DSH 会话回复**：投递到固定会话，由该会话回复；
- 微信走 iLink 扫码登录；QQ 走官方开放平台机器人（AppID + AppSecret）；
- 凭据只存本机 `im-auth.json`（0600），不进配置、不回传浏览器；
- 白名单 / 自动放行本人 / 允许群聊（仅 @）/ 回复同时显示在桌面气泡。

> ⚠️ **微信风险与已知问题**：微信通道走 iLink，**不是个人微信的官方开放 API**，存在平台条款与账号风险；
> 另有部分账号的 **iLink 下行会被腾讯侧静默丢弃**（`sendmessage` 返回成功但手机收不到，上行正常）。
> 遇到该问题请换号重扫，或改用 QQ / 企业微信通道。QQ 为官方开放平台，推荐优先使用。

---

## 安装

### 方式 A：从 GitHub 直装（推荐）

```bash
dsh plugin --profile desktop add github:lyh0371/dsh-pet-plus
```

`dsh web` 用户把 `desktop` 换成 `web`。装完**完整退出并重开 DSH**。

> 仓库已提交构建产物 `lib/`，所以直装不需要先构建。

### 方式 B：解压发布包

下载 Release 里的 `dsh-pet-plus-0.5.0.zip`，解压到固定目录后：

```powershell
dsh plugin --profile desktop add "file:D:\dsh-plugins\dsh-pet-plus"
```

或手动：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
& $node $pnpm add "file:D:\dsh-plugins\dsh-pet-plus"
```

然后确认 `package.json` 的 `dsh.profile.bundles` 里有 `dsh-pet-plus`，重启 DSH。

### 与其它桌宠插件互斥

`dsh-pet`、`dsh-pet-to-family`、`dsh-pet-plus` **共用同一条 `/dsh-pet-7340` 前缀路由**，
同一 profile 里只能启用一个：装 plus 前请把前两者从 `bundles` 里去掉（包可以留着，便于回滚）。

数据目录共用 `%USERPROFILE%\.dsh\dsh-pet\`：换到 plus 后，原有配置、聊天记忆、
语音设置、灵魂状态都会沿用。

---

## 设置页

装好后桌宠设置里会多出两张卡：

**人格灵魂色彩**

| 控件 | 作用 |
|---|---|
| 启用灵魂卡 | `chatSoulEnabled`，随「保存」写入 |
| 灵魂卡（JSON） | 直接编辑卡；留空 = 显式没有卡；写坏 JSON 不会提交（保留磁盘旧值） |
| 预览注入 | 显示此刻真正发给模型的 system |
| 立即整理记忆 | 手动触发一次反思，返回新增长期记忆 / 关系事件条数 |
| 重置关系 / 清空记忆 | 分别对应 `/soul/reset` 的 `state` / `memories` |

**消息接入（微信 / QQ）**

机器人列表（启用、回复方式、宠物/会话、白名单、群聊）、微信扫码二维码、QQ 绑定、
连接状态（每 3 秒轮询 `/im/status`）、断开与删除。

---

## 配置字段

主配置 `<用户数据根>/main-config.jsonc` 里与本版相关的字段：

```jsonc
{
  "chatSoulEnabled": true,          // 灵魂注入总开关
  "soul": { /* 灵魂卡，见 assets/config.jsonc 的默认示例 */ },
  "im": {
    "wechat": { "bots": [ /* { id, enabled, mode, petId, sessionId, whitelist, allowOwner, allowGroups, writeSay } */ ] },
    "qq": { "bots": [] }
  }
}
```

- 灵魂状态：`<用户数据根>/soul-state.json`（情绪 / 关系 / 长期记忆 / 关系事件，可按宠物 id 备份或删除）；
- 消息接入凭据：`<用户数据根>/im-auth.json`（0600，含微信 token 与 QQ AppSecret，**不要提交、不要外发**）；
- 消息接入状态：`<用户数据根>/im-state.json`（同步游标与已处理消息 id）。

---

## 开发

```bash
pnpm install
pnpm build        # tsdown + 桌面 shared-core + 类型声明
pnpm test         # node --test（源码直跑，不依赖构建）
pnpm typecheck
```

冒烟脚本（不启动 DSH，用伪 ctx 直接打路由）：

```bash
node --experimental-strip-types --import ./scripts/test-register.mjs scripts/soul-smoke.mjs
node --experimental-strip-types --import ./scripts/test-register.mjs scripts/im-smoke.mjs
```

> 构建注意：宿主入口必须是 **es2022**。目标是 es2020 时 class field 会被降级成
> `@oxc-project/runtime` 辅助函数，产物里留下裸 import，装到用户机器上会
> `ERR_MODULE_NOT_FOUND` 导致整只插件起不来（`tsdown.config.mjs` 已显式固定）。

目录（新增部分）：

```
src/host/soul.ts            灵魂卡归一化 / 渲染 / 状态机
src/host/soul-memory.ts     长期记忆
src/host/soul-events.ts     关系事件与纪念日
src/host/soul-reflection.ts 反思 prompt / 解析 / 应用
src/host/soul-state.ts      soul-state.json 读写
src/host/im/*               微信 iLink / QQ 机器人 / 凭据与游标
src/host/routes/soul.ts     /soul*
src/host/routes/im.ts       /im/*
src/client/settings/soul-card.ts  灵魂卡 UI
src/client/settings/im-card.ts    消息接入 UI
```

---

## 已知限制

- 微信 iLink 非官方通道，**存在账号风险，且部分账号下行会被静默丢弃**（详见上文）；
- 消息接入目前只处理文本；微信只处理私聊；
- 灵魂反思依赖当前对话模型，模型不可用时只记日志、不阻塞回复；
- 桌宠形象素材禁止商用；Safari 不支持透明 webm（上游限制）。

---

## 署名与许可

- 代码基座：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）
- 灵魂 / 消息接入移植：[zi-O1/dsh-pet-to-family](https://github.com/zi-O1/dsh-pet-to-family)（MIT）
- 本项目：[lyh0371/dsh-pet-plus](https://github.com/lyh0371/dsh-pet-plus)（MIT）
- 宠物形象：社区二创「大肥鱼 / 鲸鱼娘」，
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) —— **禁止商用**；
  形象出处见上游 README（原型「溟月」@上善无形，DeepSeek 版设计 @ZipZipPipe）。

二次分发/改版请保留以上仓库地址与许可说明。
