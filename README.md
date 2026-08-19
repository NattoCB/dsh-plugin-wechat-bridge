<img src="banner.png" width="100%" alt="dsh-plugin-wechat-bridge — DeepSeek Harness 微信(ilink bot)桥接插件">

# dsh-plugin-wechat-bridge

> **语言 / Language**：**中文** ｜ [English](./README.en.md)

> **把 DSH agent 装进你的微信。** DSH(DeepSeek Harness)捆绑插件:把**微信(ilink bot)**私聊消息桥接进 DSH agent 会话,并把回复以纯文本流式发回——支持**运行时启停热插拔**,无需重启 `dsh web`。

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件:
> 装进 `web` profile,扫码绑定一个微信机器人账号,就能在微信里和你的 DSH agent
> 对话。每个联系人每天一个会话、JSON 文件持久化状态、崩溃安全的轮询。

移植自 CodePilot 的微信桥接子系统(`src/lib/bridge/adapters/weixin/*`),
对 DSH 自包含(JSON 文件持久化替代 SQLite,无 OpenClaw 运行时依赖)。

## 为什么需要它

在电脑前才能和 agent 对话,意味着你被锁在工作台边。装上这个插件,微信就是你的
随身终端:扫码绑定一次,之后任何私聊消息都会驱动 DSH agent,回复以纯文本流式发回
手机——人在外面,agent 照常干活。

## 亮点

- **热插拔**——从 Settings UI 页签、`/wechat` 斜杠命令或 `settings.yaml` 实时启停,无需重启进程。
- **每人每天一个会话**——本地零点轮换,首条消息时才惰性创建,标题为 `<YYYY-MM-DD>`。
- **结构上崩溃安全**——跨进程轮询锁、按聊天串行、入站消息去重、损坏日志隔离与自愈。
- **自包含**——账号、令牌、轮询偏移都持久化在单个原子 JSON 文件中,无需数据库。
- **Settings UI 页签**——在浏览器里扫码绑定账号并管理,无需改配置文件。

## 功能

- 按配置账号轮询微信 `ilink bot` API(`getupdates`),支持多账号。
- **每人每天一个会话(本机时区)。** 本地零点后的第一条入站消息会惰性创建当天会话,
  标题为 `<YYYY-MM-DD>`;当天没有对话就不会产生会话文件。因此某天日志损坏
  永远不会阻塞第二天的对话。
- 会话默认存放在 `~/.dsh/wechat-bridge/WeChatSpace`(而非进程 cwd)。
- 按聊天串行:同一联系人的消息严格逐条驱动,并发入站消息不会交错写进同一个会话日志。
- **跨进程轮询锁**(`~/.dsh/wechat-bridge/poll.lock`):同一时刻只有一个 DSH 进程轮询
  微信账号;第二个进程看到存活锁会等待,避免 launchd keep-alive 实例与手动重启
  竞争时双写同一个会话日志。
- **入站去重**:每条微信 `message_id`(缺省时用服务端 `seq`)在驱动 agent 前记录为
  已处理,重投批次(偏移持久化前崩溃,或第二个进程)会被直接跳过。
- **损坏日志自愈**:会话存储日志同时 resume 失败且 create 失败("already exists")时,
  把产物隔离为 `session.jsonl.zstd.corrupt-<ts>` 并重建当天会话,一个坏日志
  不会让整天消息全部失败。
- 把 agent 回复以纯文本分片发回微信(4096 字符 × 最多 5 段)。
- **上下文注入**:每天会话创建时自动注入用户全局 `~/.dsh/AGENTS.md` 全文和
  可用 skill 目录(`<available_skills>`),与 GUI 会话等价——微信里的 agent 同样
  遵守全局纪律并可按名加载 skill。
- **禁用交互式选项 UI(防卡死)**:微信会话里的交互式选项工具(特别是
  `ask_user_question`)其应答通道是 **DSH 网页 GUI** 而非微信——选项只弹在浏览器
  里,手机端看不到也点不了,除非有人操作电脑界面,否则 agent 永远阻塞、回复永远
  到不了。每天会话创建时注入一条前置 `system-reminder`,强制模型**不要**使用
  交互式选项工具,改为把问题和各个选项直接写成纯文本回复,让用户以普通微信消息
  回复即可;下一条消息会自动继续当天会话。
- **入站媒体**:微信发来的图片/文件/视频/语音自动从 CDN 下载并 AES 解密,
  存入 `WeChatSpace/inbox/<日期>/` 并在消息中注明路径;所选模型声明图像输入时,
  图片还会作为原生 image 内容附带给模型。
- **出站媒体**:agent 可调用 `wechat_send_file` 工具,把本地生成的图片/视频/
  文件上传微信 CDN 并发给当前对话人(按扩展名路由,可选文字说明)。
- 按联系人保存 `context_token`,重启后仍可回复(微信要求)。
- 账号遇 `errcode -14`(会话过期)暂停 60 分钟。
- 自动迁移更名前的状态:`~/.dsh/weixin-bridge` 数据目录与 `weixin-bridge:`
  设置段会一次性改名为 `wechat-*`。

## 安装(装入 `web` profile)

> 前提:harness 从扁平的 `~/.dsh/profiles/node_modules` 回退解析 bundle 依赖,
> 因此**不要**把 profile 树外的包符号链接进来(ESM 限制)——请复制到 profile 下。
> (`file:` 依赖 + `dsh.profile.bundles` 条目是正式注册方式;复制的副本才是实际启动的产物。)

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
#    客户端设置页签从 /plugins/<id>/client.js 提供。
dsh web
```

服务开机挂载;若 `settings.wechat-bridge.enabled` 为 true 会立即开始轮询,
否则保持待命直到启用(见下文)。

## Settings UI 页签(推荐入口)

打开 DSH 网页左下角 **Settings →「微信桥接」** 页签:

- **状态卡**:桥接运行状态 + 启用/停用按钮(热插拔,点击立即生效,无需重启)
- **默认模型卡**:两个下拉框选择微信会话使用的 provider / model(选项来自 DSH
  已注册的模型,无需手动输入);留空则跟随全局默认,保存后持久化到 settings.yaml
- **账号卡**:已绑定账号列表(账号 id、token 状态、最近登录时间)+ 移除按钮
- **扫码绑定**:点击「扫码绑定账号」→ 页面内直接显示二维码(PNG data URL)→
  每 2 秒自动轮询扫码状态 → 微信确认后自动保存账号并启用桥接

## 运行时启停(热插拔)

三种独立控制方式,全部免重启:

1. **Settings UI 页签**(见上)。

2. **斜杠命令**(任意 DSH 会话中):
   - `/wechat status` — 运行中?账号数?
   - `/wechat enable` — 立即启动轮询循环(同时写入 `settings.wechat-bridge.enabled=true`)
   - `/wechat disable` — 立即停止轮询循环(写入 `settings.wechat-bridge.enabled=false`)
   - `/wechat accounts` — 列出已配置账号
   - `/wechat qrlogin` — 发起二维码登录;返回 `sessionId`
   - `/wechat qrstatus <sessionId>` — 轮询扫码状态;`confirmed` 时保存账号并启用
   - `/wechat rm <accountId>` — 移除账号

3. **设置项**(热重载):编辑 `~/.dsh/settings.yaml`:
   ```yaml
   wechat-bridge:
     enabled: true        # 实时开关;每次变更服务都会重新应用
     mediaEnabled: true
     defaultProvider: '' # 桥接会话 provider(空 = 跟随全局默认)
     defaultModel: ''     # 桥接会话 model(空 = 跟随全局默认)
   ```
   修改 `enabled` 保存后即重新读取并启停轮询循环。

UI 页签调用插件自带的 HTTP API(`/wechat-bridge/*`),由宿主 webserver 提供——
不依赖任何外部服务。

## 配置(cordis.patch.yml 中的插件 `config`)

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 设置项缺失时的开机自启开关 |
| `mediaEnabled` | `true` | (预留)接收入站媒体 |
| `dataDir` | `~/.dsh/wechat-bridge` | `state.json`(账号/令牌/偏移)所在目录 |
| `defaultModel` | `''` | 桥接会话的模型覆盖(否则用全局默认;可在设置页签选择) |
| `defaultProvider` | `''` | 桥接会话的提供商覆盖(否则用全局默认;可在设置页签选择) |
| `defaultCwd` | `''` | 新会话的工作目录(否则 `~/.dsh/wechat-bridge/WeChatSpace`) |

## 文件结构

```
src/index.js        WechatBridgeService:轮询循环、agent 驱动、按天会话、
                    热插拔、/wechat 命令、+ /wechat-bridge/* HTTP API(服务端渲染二维码)
client/client.js    客户端 bundle:注册 Settings「微信桥接」section 槽位(React)
src/weixin-api.js   ilink bot 协议客户端(getupdates/sendmessage/sendtyping/getconfig/qrlogin)
src/weixin-ids.js   synthetic chatId 编解码(weixin::<accountId>::<peerUserId>)
src/weixin-types.js 协议枚举/常量
src/store.js        JSON 文件持久化(账号、context_tokens、偏移;旧目录迁移)
cordis.patch.yml    bundle patch(注册 wechat-bridge 服务)
package.json        声明 dsh.bundle + dsh.client(web)
node_modules/       vendored qrcode/pngjs/dijkstrajs(二维码 data-URL 渲染,无需 pnpm)
```

## 会话模型

- 会话 id:`wechat-<chatId>-<YYYY-MM-DD>`(本机时区,如 `2026-08-15`)。
- 当天首条入站消息时惰性创建;零点从不预创建。
- 标题:`<YYYY-MM-DD>`,以 `user` 标题源钉住,自动标题生成不会覆盖它。
- 默认 cwd:`~/.dsh/wechat-bridge/WeChatSpace`(启动时创建;可用 `defaultCwd` 覆盖)。
- 联系人身份保持 `weixin::<accountId>::<peerUserId>` 编码(协议层,与 CodePilot
  同源);只有插件自身的命名使用 `wechat-*`。

## 说明与范围

- 出站媒体通过 `wechat_send_file` 工具由 agent 主动触发;语音入站仅落盘,
  不做转写。
- 仅私聊,无群聊语义。
- 需要具备 `ilink bot` 权限(`bot_type=3`)的微信账号。
- 持久化是单个原子 JSON 文件(`state.json`)——对单个 DSH 进程足够。
- 按聊天队列在单进程内串行;跨进程轮询锁与消息去重覆盖多进程场景
  (仍建议保持端口单属主)。

---

**试试看:** 装进 web profile、扫码绑定一个 `bot_type=3` 的微信账号,然后在微信里
给机器人发一句「今天有什么安排」——agent 会像在 GUI 里一样回答你。问题或想法?
[提 issue](https://github.com/NattoCB/dsh-plugin-wechat-bridge/issues)。
