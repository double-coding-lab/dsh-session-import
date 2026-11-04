# dsh-session-import

把第三方 AI 编程工具的会话历史，导入成 DeepSeek Harness 的原生会话——**能浏览、能搜索、能直接接着聊**。

> 当前状态：设计完成，开发中。见 [技术方案](docs/技术方案.md)。

## 解决什么问题

换个 AI 编程工具，就要把之前几小时讲清楚的架构、决策和改动重新解释一遍。每个工具都把会话写在自己的私有目录里，格式互不相通。

这个插件把这些历史搬进 DSH：导入后会话出现在对应的项目下，打开就是完整上下文，可以直接继续对话。

## 设计取向

**新增一个工具的支持，只需要加一段 JSON。**

同族格式（Claude 系 jsonl）零代码接入；只有遇到全新格式才写解析器。provider 描述文件是纯数据，不含可执行代码。

```json
{
  "id": "qoder",
  "name": "Qoder",
  "family": "claude-jsonl",
  "roots": { "win32": ["~/.qoder/projects"] },
  "layout": { "sessionGlob": "*/*.jsonl" }
}
```

## 计划支持

| Provider | 状态 |
|---|---|
| Qoder | 第一批 |
| Claude Code | 第一批 |
| Codex | 计划中 |
| WorkBuddy | 计划中 |

## 导入策略

宁可少导，不要导一半。几条硬规则：

- **默认只导入可续聊窗口**，全量导入需显式选择——否则导入完根本发不出下一句话。
- **单条文本有硬上限**。DSH 的上下文压缩只能替换整段节点，压不掉单条巨型工具输出，所以必须在导入期截断。
- **推理块默认丢弃**。第三方工具的 thinking 带签名或服务端加密，换宿主后不可重放。
- **工具调用双向修复**。无主的工具结果补占位、无结果的调用补错误结果，保证事件链闭合。
- **源目录只读**，不修改、不删除任何原始会话。

## 开发

```bash
npm install
npm run check      # 契约校验 + fixtures 回归（用 DSH 自己的加载器做裁判）
npm run build
dsh plugin --profile web add link:.
```

## 参与贡献

新增一个内置 provider 通常只需要：

1. `providers/<id>/provider.json`
2. `fixtures/<id>/` 下一份**脱敏**的会话样例
3. 跑 `npm run check`

契约见 `schema/provider.schema.json`，细则见 [技术方案](docs/技术方案.md)。

## License

[MIT](LICENSE)
