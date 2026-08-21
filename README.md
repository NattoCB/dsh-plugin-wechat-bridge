# dsh-plugin-wechat-bridge

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">把 DSH agent 装进你的微信:私聊消息驱动 agent 会话,回复以纯文本流式发回。</b><br /><br />
  <a href="https://github.com/NattoCB/dsh-plugin-wechat-bridge"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/NattoCB/dsh-plugin-wechat-bridge"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-NattoCB%2Fdsh--plugin--wechat--bridge-181717" /></a><br /><br />
  <img alt="微信 ilink bot 桥接" src="https://img.shields.io/badge/-微信%20ilink%20bot%20桥接-4d6bfe" />
  <img alt="热插拔" src="https://img.shields.io/badge/-热插拔-4d6bfe" />
  <img alt="每人每天一个会话" src="https://img.shields.io/badge/-每人每天一个会话-4d6bfe" />
  <img alt="崩溃安全" src="https://img.shields.io/badge/-崩溃安全-4d6bfe" />
  <img alt="出站媒体" src="https://img.shields.io/badge/-出站媒体-4d6bfe" /><br /><br />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH 插件" /></a><br /><br />
  <b>集成面:</b>设置命名空间 <code>wechat-bridge</code> · 斜杠命令 <code>/wechat</code> · 工具 <code>wechat_send_file</code> · Settings「微信桥接」页签
</div>

> **语言 / Language**:**中文** ｜ [English](./README.en.md)

> 把 DSH agent 装进你的微信。一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle 插件:
> 把微信(ilink bot)私聊消息桥接进 DSH agent 会话,回复以纯文本分片流式发回。
> 装进 `web` profile → 扫码绑定一个 `bot_type=3` 微信账号 → 微信里直接对话。
> 每人每天一个会话、JSON 文件持久化、崩溃安全的轮询;Settings UI / `/wechat` 命令 / `settings.yaml` 三种方式实时启停,无需重启 `dsh web`。

## ✨ 功能一览

- **📱 微信私聊 → DSH agent**:按配置账号轮询微信 `ilink bot` API(`getupdates`,支持多账号);私聊消息驱动 agent 会话,回复以纯文本分片发回(4096 字符 × 至多 5 段,超出截断)。
- **🔌 运行时热插拔**:Settings UI 页签、`/wechat` 斜杠命令、`settings.yaml` 三种独立控制,启停立即生效,无需重启进程。
- **🗓️ 每人每天一个会话**:本机时区本地零点轮换,当天首条入站消息惰性创建,标题 `<YYYY-MM-DD>`;当天无对话不产生会话文件,坏日志不会阻塞第二天。
- **🛡️ 结构上崩溃安全**:跨进程轮询锁(`~/.dsh/wechat-bridge/poll.lock`)、按聊天串行、入站去重(`message_id` 至多一次)、损坏日志隔离为 `.corrupt-<ts>` 并自愈重建。
- **🚪 入站白名单(fail-closed)**:`allowedPeers` 留空 = 拒绝所有人;匹配微信 ID(`from_user_id`)非昵称,逗号分隔,Settings UI 可编辑。
- **📤 出站媒体**:agent 调用 `wechat_send_file` 工具,把本地生成的图片/视频/文件上传微信 CDN 发给当前对话人(按扩展名路由,可选说明文字)。
- **📥 入站媒体**:微信发来的图片/文件/视频/语音自动从 CDN 下载并 AES 解密,存入 `WeChatSpace/inbox/<日期>/` 并注明路径;所选模型声明图像输入时,图片以原生 image 内容附带。
- **🧠 上下文与 GUI 等价**:每天会话注入用户全局 `~/.dsh/AGENTS.md` 全文与可用 skill 目录(`<available_skills>`),并挂载与 GUI 相同的 agent preset。
- **🚫 交互选项 UI 禁用(防挂起)**:`ask_user_question` 等交互式选项工具在微信会话中被 deny——其应答通道是 DSH 网页 GUI,手机端看不到也点不了;改为把问题与选项写成纯文本,用户以普通微信消息回复。
- **💾 自包含持久化**:账号、`context_token`、轮询偏移持久化在单个原子 JSON(`~/.dsh/wechat-bridge/state.json`),无需数据库;会话存 `~/.dsh/wechat-bridge/WeChatSpace`。
- **🔁 自动迁移**:旧 `weixin-bridge` 数据目录与设置段一次性更名为 `wechat-*`;账号遇 `errcode -14`(会话过期)暂停 60 分钟。

## Quick Start

### 前置条件

- 已安装 DeepSeek Harness(`dsh web` 可运行)。
- 一个具备 `ilink bot` 权限(`bot_type=3`)的微信账号。
- 注意:harness 从扁平的 `~/.dsh/profiles/node_modules` 回退解析 bundle 依赖——**不要**把 profile 树外的包符号链接进来(ESM 限制),请复制到 profile 下(`file:` 依赖 + `dsh.profile.bundles` 条目是正式注册方式;复制的副本才是实际启动的产物)。

### 安装(装入 `web` profile)

一条命令安装:

```bash
dsh plugin --profile web add github:NattoCB/dsh-plugin-wechat-bridge
```

手动安装见下。

```bash
# 1. 把插件复制到 web profile 的 node_modules 下
#    (保留 vendored 依赖:qrcode/pngjs/dijkstrajs 在插件自带的 node_modules 里)
SRC=/path/to/dsh-plugin-wechat-bridge
DST=~/.dsh/profiles/web/node_modules/dsh-plugin-wechat-bridge
rm -rf "$DST" && cp -R "$SRC" "$DST"

# 2. 在 profile manifest(~/.dsh/profiles/web/package.json)注册
#    dependencies 添加  "dsh-plugin-wechat-bridge": "file:<SRC>"
#    dsh.profile.bundles 添加 "dsh-plugin-wechat-bridge"

# 3. (重)启 dsh web —— bundle patch 挂载 wechat-bridge 服务,
#    客户端设置页签从 /plugins/<id>/client.js 提供
dsh web
```

### 扫码绑定

打开 DSH 网页左下角 **Settings →「微信桥接」** 页签 → 点击「扫码绑定账号」→ 页面内直接渲染二维码(PNG data URL)→ 每 2 秒自动轮询扫码状态 → 微信确认后自动保存账号并启用桥接。

也可在任意 DSH 会话走命令行:`/wechat qrlogin` 发起登录(返回 `sessionId`)→ `/wechat qrstatus <sessionId>` 轮询状态,`confirmed` 时保存账号并启用。

### 运行

给机器人发一条私聊消息(如「今天有什么安排」)——agent 会像在 GUI 里一样回答,回复以纯文本发回。服务开机时挂载:若 `settings.wechat-bridge.enabled` 为 true 立即开始轮询,否则保持待命直到启用。

## Configuration

### 配置项

| 键 | 默认值 | 含义 |
|:----|:--------|:------|
| `enabled` | `false` | 设置项缺失时的开机自启开关;每次变更实时重新应用 |
| `mediaEnabled` | `true` | 接收入站媒体(下载 / 解密 / 落盘) |
| `defaultProvider` | `''` | 桥接会话的 provider 覆盖(空 = 跟随全局默认;Settings UI 可编辑) |
| `defaultModel` | `''` | 桥接会话的 model 覆盖(空 = 跟随全局默认;Settings UI 可编辑) |
| `allowedPeers` | `''` | 入站白名单:允许驱动 agent 的微信 ID(`from_user_id`),逗号分隔;留空 = 拒绝所有人(fail-closed) |
| `dataDir` | `~/.dsh/wechat-bridge` | `state.json`(账号 / 令牌 / 偏移)所在目录 |
| `defaultCwd` | `''` | 新会话的工作目录(否则 `~/.dsh/wechat-bridge/WeChatSpace`) |

`enabled`、`mediaEnabled`、`defaultProvider`、`defaultModel`、`allowedPeers` 同时以 `wechat-bridge:` 段存在于 `~/.dsh/settings.yaml`,编辑保存即热生效:

```yaml
wechat-bridge:
  enabled: true        # 实时开关;每次变更服务都会重新应用
  mediaEnabled: true
  defaultProvider: ''  # 桥接会话 provider(空 = 跟随全局默认)
  defaultModel: ''     # 桥接会话 model(空 = 跟随全局默认)
  allowedPeers: 'wxid_abc123, wxid_def456'  # 入站白名单,逗号分隔
```

### 入站白名单(fail-closed)

`allowedPeers` 是**默认拒绝**的入站闸门:只有列表内的微信 ID 能驱动 agent 会话。

- **留空 = 拒绝所有人**(安全默认,而非放行所有人)——未入列的 ID 发来消息会被忽略,并收到一条含其微信 ID 的提示,便于你在 Settings 页签里把自己加进去。
- 匹配对象是**微信 ID**(`from_user_id`),不是昵称——昵称会变,ID 稳定。
- 多个 ID 用英文逗号分隔,如 `wxid_abc123, wxid_def456`。
- 配置热生效,无需重启;也可以在 Settings UI 页签直接编辑。

### 运行时启停(热插拔)

1. **Settings UI 页签**:状态卡(运行状态 + 启用/停用按钮,点击立即生效)、默认模型卡(两个下拉框选择 provider/model,选项来自 DSH 已注册模型)、账号卡(账号 id、token 状态、最近登录时间 + 移除)、扫码绑定。
2. **斜杠命令**(任意 DSH 会话):
   - `/wechat status` — 运行中?账号数?
   - `/wechat enable` — 立即启动轮询循环(同时写入 `settings.wechat-bridge.enabled=true`)
   - `/wechat disable` — 立即停止轮询循环(写入 `settings.wechat-bridge.enabled=false`)
   - `/wechat accounts` — 列出已配置账号
   - `/wechat qrlogin` — 发起二维码登录;返回 `sessionId`
   - `/wechat qrstatus <sessionId>` — 轮询扫码状态;`confirmed` 时保存账号并启用
   - `/wechat rm <accountId>` — 移除账号
3. **设置项**(热重载):编辑 `~/.dsh/settings.yaml` 的 `wechat-bridge.enabled`,保存即重新读取并启停轮询循环。

UI 页签调用插件自带的 HTTP API(`/wechat-bridge/*`),由宿主 webserver 提供——不依赖任何外部服务。

### 会话模型

- 会话 id:`wechat-<chatId>-<YYYY-MM-DD>`(本机时区,如 `2026-08-15`);当天首条入站消息时惰性创建,零点从不预创建。
- 标题:`<YYYY-MM-DD>`,以 `user` 标题源钉住,自动标题生成不会覆盖它。
- 默认 cwd:`~/.dsh/wechat-bridge/WeChatSpace`(启动时创建,可用 `defaultCwd` 覆盖)。
- 联系人身份保持 `weixin::<accountId>::<peerUserId>` 编码(协议层,与 CodePilot 同源);只有插件自身的命名使用 `wechat-*`。

### 文件结构

```
src/index.js        WechatBridgeService:轮询循环、agent 驱动、按天会话、热插拔、/wechat 命令、/wechat-bridge/* HTTP API(服务端渲染二维码)
client/client.js    客户端 bundle:注册 Settings「微信桥接」section 槽位(React)
src/weixin-api.js   ilink bot 协议客户端(getupdates/sendmessage/sendtyping/getconfig/qrlogin)
src/weixin-media.js 入站媒体 CDN 下载 + AES 解密、出站媒体 CDN 上传
src/weixin-ids.js   synthetic chatId 编解码(weixin::<accountId>::<peerUserId>)
src/weixin-types.js 协议枚举/常量
src/store.js        JSON 文件持久化(账号、context_tokens、偏移;旧目录迁移)
cordis.patch.yml    bundle patch(注册 wechat-bridge 服务)
package.json        声明 dsh.bundle + dsh.client(web)
node_modules/       vendored qrcode/pngjs/dijkstrajs(二维码 data-URL 渲染,无需 pnpm)
```

### 说明与范围

- 出站媒体通过 `wechat_send_file` 工具由 agent 主动触发;语音入站仅落盘,不做转写。
- 仅私聊,无群聊语义。
- 需要具备 `ilink bot` 权限(`bot_type=3`)的微信账号。
- 持久化是单个原子 JSON 文件(`state.json`)——对单个 DSH 进程足够。
- 按聊天队列在单进程内串行;跨进程轮询锁与消息去重覆盖多进程场景(仍建议保持端口单属主)。

---

<div align="center">

[MIT License](https://github.com/NattoCB/dsh-plugin-wechat-bridge) · [GitHub 仓库](https://github.com/NattoCB/dsh-plugin-wechat-bridge) · [提 issue](https://github.com/NattoCB/dsh-plugin-wechat-bridge/issues)

</div>
