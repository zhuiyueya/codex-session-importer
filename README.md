# Codex Session Importer

[English](README.md) | [简体中文](README.zh-CN.md)

Turn external chat history into a real, resumable Codex session.

`import-codex-session` is a Codex Skill plus a deterministic local importer. It converts ChatGPT share transcripts or local Markdown, JSON, and JSONL conversations into native Codex threads through the official Codex App Server migration API.

## Why

Copying an old conversation into a new prompt loses the original turn structure and makes long sessions difficult to continue. This project preserves the visible user/assistant sequence and imports it as a native thread that Codex can reopen and continue.

The importer:

- Uses `externalAgentConfig/detect` and `externalAgentConfig/import` instead of editing Codex state directly.
- Defaults to a read-only dry-run; `--commit` is required to create a thread.
- Validates message count, role order, boundary content, title, working directory, model, provider, and direct-input support.
- Verifies every imported user and assistant message after migration.
- Uses deterministic source paths and import history to avoid accidental duplicates.
- Never prints full conversation bodies or authentication configuration.

## Install

Requirements:

- Node.js 18 or newer.
- Codex CLI or Codex Desktop with App Server support.
- API-key authentication by default. Other configured authentication modes require `--auth-mode any`.

### Install with an AI coding agent

If your AI coding agent has local filesystem and terminal access, send it this:

```text
Install the Codex Skill from https://github.com/zhuiyueya/codex-session-importer
into ~/.codex/skills/import-codex-session. Inspect the repository before installing,
do not overwrite an existing installation without asking, validate the installed Skill,
run `node ~/.codex/skills/import-codex-session/scripts/import_session.mjs --help`,
and then tell me how to use $import-codex-session.
```

中文安装提示：

```text
请将 https://github.com/zhuiyueya/codex-session-importer 安装为 Codex Skill，
目标目录是 ~/.codex/skills/import-codex-session。安装前先检查仓库内容；如果目标目录
已经存在，不要直接覆盖，先询问我。安装后请验证 Skill，运行导入脚本的 --help，
最后告诉我如何使用 $import-codex-session。
```

This works with Codex and other local coding agents that can access your terminal. A web-only chat assistant cannot install files on your machine.

### Install manually

Clone the repository into the Codex skills directory:

```bash
git clone https://github.com/zhuiyueya/codex-session-importer.git \
  ~/.codex/skills/import-codex-session
```

Codex can then discover the Skill as `$import-codex-session`.

## Use From Codex

Ask Codex:

```text
Use $import-codex-session to import this shared conversation as a resumable local Codex API session.
```

For ChatGPT share pages, the Skill first extracts and validates the complete visible conversation. The page extraction layer is intentionally separate from the stable local importer because long share pages can virtualize messages and their page structure can change.

## Use The Importer Directly

First run a dry-run:

```bash
node ~/.codex/skills/import-codex-session/scripts/import_session.mjs \
  --input /absolute/path/conversation.md \
  --title "Conversation title" \
  --cwd /absolute/project/path \
  --expected-messages 50 \
  --expected-first "Exact first user message" \
  --expected-last-contains "Distinctive text near the end"
```

If the checks pass, repeat with `--commit`:

```bash
node ~/.codex/skills/import-codex-session/scripts/import_session.mjs \
  --input /absolute/path/conversation.md \
  --title "Conversation title" \
  --cwd /absolute/project/path \
  --expected-messages 50 \
  --expected-first "Exact first user message" \
  --expected-last-contains "Distinctive text near the end" \
  --commit
```

Run `node scripts/import_session.mjs --help` for all options.

## Input Formats

Markdown:

```markdown
## 01 User

How should I learn RAG for an Agent engineering role?

## 02 Assistant

Start by treating RAG as one part of the broader Agent engineering stack.
```

JSON:

```json
[
  { "role": "user", "content": "Hello" },
  { "role": "assistant", "content": "Hi" }
]
```

JSONL uses the same message objects, one per line. A JSON object with a top-level `messages` array is also supported.

Transcripts must start with `user`, alternate strictly between `user` and `assistant`, and contain complete pairs.

## How It Works

```text
Share page or local transcript
              |
              v
  Normalized user/assistant messages
              |
              v
 Deterministic migration source file
              |
              v
 Official Codex App Server migration API
              |
              v
 Native thread -> resume -> exact verification
```

The project never writes Codex SQLite databases, session indexes, or rollout files directly.

## Limitations

- The CLI importer consumes local transcript files; it does not fetch ChatGPT share URLs itself.
- Share-page extraction may need adaptation when ChatGPT changes its page payload or rendering behavior.
- Codex App Server migration methods may evolve. This version was integration-tested with `codex-cli 0.153.0-alpha.5`.
- Only visible text messages with `user` and `assistant` roles are imported. Hidden system messages, reasoning, and tool artifacts are intentionally excluded.

## Security And Privacy

Conversation processing and migration are local. The importer emits hashes and counts rather than message bodies, does not read API keys directly, and does not invoke a model during migration. Review transcripts before importing sensitive material into your local Codex history.

## License

[MIT](LICENSE)
