# Codex 会话导入器

[English](README.md) | [简体中文](README.zh-CN.md)

把外部聊天记录转换成真正可恢复、可继续对话的 Codex 会话。

`import-codex-session` 由一个 Codex Skill 和一个确定性的本地导入器组成。它可以通过官方 Codex App Server 迁移 API，将 ChatGPT 分享对话或本地 Markdown、JSON、JSONL 对话记录转换成原生 Codex 线程。

## 为什么需要它

把旧对话直接复制到新提示词里，会丢失原始轮次结构，长对话也很难自然延续。本项目会保留用户与助手之间可见的消息顺序，并将其导入为 Codex 可以重新打开和继续对话的原生线程。

导入器具备以下特性：

- 使用 `externalAgentConfig/detect` 和 `externalAgentConfig/import`，不会直接修改 Codex 状态数据。
- 默认执行只读的 dry-run；只有显式传入 `--commit` 才会创建线程。
- 校验消息数量、角色顺序、首尾内容、标题、工作目录、模型、Provider 和直接输入能力。
- 迁移完成后逐条验证所有导入的用户和助手消息。
- 使用确定性的源文件路径和导入历史，避免意外重复导入。
- 不会在输出中打印完整对话内容或认证配置。

## 安装

环境要求：

- Node.js 18 或更高版本。
- 支持 App Server 的 Codex CLI 或 Codex Desktop。
- 默认要求 API Key 认证。使用其他已配置的认证方式时，需要传入 `--auth-mode any`。

### 让 AI 编程助手安装

如果你的 AI 编程助手拥有本地文件系统和终端权限，可以直接把下面这段话发给它：

```text
请将 https://github.com/zhuiyueya/codex-session-importer 安装为 Codex Skill，
目标目录是 ~/.codex/skills/import-codex-session。安装前先检查仓库内容；如果目标目录
已经存在，不要直接覆盖，先询问我。安装后请验证 Skill，运行导入脚本的 --help，
最后告诉我如何使用 $import-codex-session。
```

这种安装方式适用于 Codex 和其他能够访问本地终端的 AI 编程助手。仅运行在网页中的聊天助手无法直接在你的电脑上安装文件。

### 手动安装

将仓库克隆到 Codex Skills 目录：

```bash
git clone https://github.com/zhuiyueya/codex-session-importer.git \
  ~/.codex/skills/import-codex-session
```

安装后，Codex 会将它识别为 `$import-codex-session`。

## 在 Codex 中使用

可以直接对 Codex 说：

```text
使用 $import-codex-session，把这个共享对话导入为可继续对话的本地 Codex API 会话。
```

处理 ChatGPT 分享页面时，Skill 会先提取并验证完整的可见对话。页面提取层与稳定的本地导入器相互独立，因为长对话页面可能采用虚拟化渲染，页面结构也可能随时变化。

## 直接使用导入脚本

首先执行 dry-run：

```bash
node ~/.codex/skills/import-codex-session/scripts/import_session.mjs \
  --input /absolute/path/conversation.md \
  --title "对话标题" \
  --cwd /absolute/project/path \
  --expected-messages 50 \
  --expected-first "第一条用户消息的完整内容" \
  --expected-last-contains "最后一条助手消息中的特征文本"
```

所有检查通过后，使用相同参数并增加 `--commit`：

```bash
node ~/.codex/skills/import-codex-session/scripts/import_session.mjs \
  --input /absolute/path/conversation.md \
  --title "对话标题" \
  --cwd /absolute/project/path \
  --expected-messages 50 \
  --expected-first "第一条用户消息的完整内容" \
  --expected-last-contains "最后一条助手消息中的特征文本" \
  --commit
```

运行 `node scripts/import_session.mjs --help` 可以查看全部参数。

## 输入格式

Markdown：

```markdown
## 01 用户

为了找 Agent 开发工作，我应该怎样学习 RAG？

## 02 ChatGPT

先把 RAG 当作 Agent 工程能力栈的一部分来学习。
```

JSON：

```json
[
  { "role": "user", "content": "你好" },
  { "role": "assistant", "content": "你好！" }
]
```

JSONL 使用相同的消息对象，每行一条。也支持包含顶层 `messages` 数组的 JSON 对象。

对话记录必须以 `user` 开始，严格按照 `user` 和 `assistant` 交替排列，并包含完整的问答对。

## 工作原理

```text
ChatGPT 分享页面或本地对话文件
                |
                v
      标准化用户/助手消息
                |
                v
       确定性的迁移源文件
                |
                v
    官方 Codex App Server 迁移 API
                |
                v
   原生线程 -> 恢复 -> 逐条精确验证
```

本项目不会直接写入 Codex SQLite 数据库、会话索引或 rollout 文件。

## 限制

- CLI 导入器读取本地对话文件，不会自行抓取 ChatGPT 分享链接。
- ChatGPT 更改页面数据或渲染方式后，分享页面提取逻辑可能需要适配。
- Codex App Server 的迁移接口可能继续演进。当前版本已使用 `codex-cli 0.153.0-alpha.5` 完成集成测试。
- 仅导入角色为 `user` 和 `assistant` 的可见文本消息。隐藏的系统消息、推理内容和工具调用会被主动排除。

## 安全与隐私

对话处理和迁移均在本地完成。导入器只输出哈希值和数量，不输出消息正文；它不会直接读取 API Key，也不会在迁移过程中调用模型。将敏感对话导入本地 Codex 历史记录前，请先自行检查内容。

## 许可证

[MIT](LICENSE)
