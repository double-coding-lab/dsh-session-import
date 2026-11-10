# dsh-session-import

把第三方 AI 编程工具的会话历史，导入成 DeepSeek Harness 的原生会话——**能浏览、能搜索、能直接接着聊**。

> 当前状态：Qoder / Claude Code 已打通端到端（扫描 → 导入 → 续聊 → 增量 → 撤回）。见 [技术方案](docs/技术方案.md)。

## 它解决什么

换工具最痛的不是模型，是**历史留在旧工具里**。这个插件把旧会话搬进 DSH，导入后是一条正常的会话：左侧列表可见、可以继续对话、可以被搜索和导出。

支持现状：

| Provider | 状态 | 说明 |
|---|---|---|
| Qoder | ✅ | `~/.qoder/projects/*/*.jsonl` |
| Claude Code | ✅ | `~/.claude/projects/*/*.jsonl` |
| Codex / WorkBuddy | ⏳ | 待补 provider 描述（纯数据，无需改代码） |

## 安装

```bash
dsh plugin --profile web add link:<本仓库路径>
```

装完**必须重启 `dsh web`**（见下方「开发时的坑」）。

## 用法

设置 → **会话导入**：

1. 顶部搜索工作区或会话，展开应用 → 工作区，勾选要搬的会话（应用和工作区都支持全选）
2. 点「导入」→ 确认弹窗 → 完成后左侧列表出现该会话
3. 底部实时显示「已选 X 个会话 · Y 个工作区」；「清除选择」重置勾选，「导出日志」下载上一次导入报告

状态徽标：`未导入` / `已导入` / `有新增` / `失败`。已导入的行有「撤回」。

工作区行右侧也有撤回入口，一次撤回该工作区所有已导入 / 有新增的会话。最后一个会话撤回后，空工作区会从侧栏移除；只移除工作区注册，磁盘目录、源工具会话和会话日志都不会删除。

导入结束后，底部出现「导出日志」：下载 JSON 报告，包含本次每个会话的来源、状态、错误消息、轮次/事件数与耗时，便于把失败结果转交排查。报告不包含会话正文。

## 文件链接

源会话里指向本地文件的链接会按 provider 规则保留为 DSH 原生文件 chip：点击后在右侧栏预览，不依赖浏览器协议。

- 规则是 `provider.json` 里的 `fileLinks` 纯数据；Qoder 识别 `[文件名](file:///D:/…)`，其他工具可声明绝对路径或工作区相对路径。
- 导入时链接会改成 inline code（同名文件用完整路径区分），同时写入该轮的 `deliverables/presented`，由 DSH 自带的文件提及解析器接管点击。
- DSH 只在每轮**收尾的** assistant 消息上提供文件提及解析，因此轮中过程消息里的链接保持普通文本。
- 本次升级前已导入的会话需要「撤回」后重新导入；源文件没变时重复导入会直接跳过，不会自动改写旧日志。


## 三条核心设计

**1. 只导入"能续聊的窗口"。**
源工具历史可能有几千轮、几十万 token。默认从源会话最后一次压缩点开始切，保证导入的是**还活着的那段上下文**，而不是把整个历史塞进新会话把预算烧光。要全量可切「完整历史」。

**2. 幂等 + 增量。**
按「源文件指纹 + 事件前缀哈希」判定。重复导入同一份源不会产生副本；源变长了只追加新增事件。**前缀不一致就拒绝追加**——源窗口前移时硬接会把两段不同历史缝在一起，日志直接报废，宁可报错。

**3. 结构必须能被 DSH 读回。**
导入后立刻用 `persistence.open()` 回读校验事件条数；DSH 的 v4 校验比我们的自检更严，读不回就当失败，绝不留下半截会话。

**4. 中断的源会话也能导入。**
Qoder 正常退出才写 `active-leaf`；崩溃或中断的会话没有这个标记，解析器会取最新的一条叶子消息恢复主线，并排除被放弃的分支，不再报「解析后没有可导入的事件」。

## 开发

```bash
npm run check     # 构建宿主 + 客户端，跑结构/幂等/增量三个自检
```

`npm run check` 需要 esbuild：本仓 `npm i` 可能因未发布的 peer 包失败，可指定

```powershell
$env:ESBUILD_MODULE="<path>/node_modules/esbuild/lib/main.js"
npm run check
```

### ⚠️ 开发时的两个坑（都踩过）

**1. 改完客户端必须重启 `dsh web`，刷新页面不够。**
DSH 在启动时把客户端产物打成带 `rev` 的快照，之后一直发那份。磁盘上 `dist/client.js` 是新的，用户看到的还是旧的——会误判成"样式没生效"。

**2. 对齐官方样式要看 TSX，不能只看 CSS。**
`packages/client/ui-*` 里 `.module.css` 只描述布局；图标（chevron 等）的 `width`/`viewBox`/`stroke-width`/`path` 是内联在 `.tsx` 里的。只读 CSS 会漏掉整个图标。

## 架构

```
src/
  index.ts              宿主入口：/api/health|sessions|import|retract
  client/index.tsx      设置页「会话导入」（settings.section）
  host/
    service.ts          扫描、目录展开、撤回、状态标注
    importer.ts         创建/追加/回读校验、指纹、前缀哈希
    state.ts            幂等台账（<DSH_HOME>/session-import/state.json）
    mapper.ts           源事件 → DSH v4 事件（turn/step/tool 状态机）
    file-links.ts       按 provider 规则识别本地文件链接，改成 DSH 原生文件 chip
    parsers/            按 family 分的解析器（claude-jsonl）
providers/<id>/provider.json   纯数据：会话在哪、怎么解析、文件链接怎么写
fixtures/                       自检样本（含孤儿调用与压缩点）
```

## DSH v4 契约要点

写日志时有几处是 0.1 时代不需要、0.2.1 会直接判「日志损坏」的：

- header 必填 `isSeeded`
- 消息必须有 `id` 与 `source`；工具结果用 `role:'tool'` + 顶层 `toolCallId`
- `user/message` 的事件数据**就是消息本身**（不再包一层 `message`）
- `tool/call` 之前必须有 assistant 消息用 `tool-call` block **广播**过该调用
- `step` 编号**每轮从 1 重新开始**

## 已知限制

- 增量追加要求源窗口前缀未变；前移后会提示先撤回再导
- 推理内容（reasoning）默认丢弃：跨工具签名/加密不可重放
- 用户消息里的图片会转存为 DSH 原生附件（优先源工具本地副本，签名 URL 仅作兜底；源副本被清理且链接过期的图片会丢弃）
- DSH 没有删除会话的 API，撤回是删会话目录（只允许删本插件创建的 `import-` 前缀）

## License

MIT
