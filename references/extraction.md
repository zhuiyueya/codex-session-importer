# ChatGPT Share Extraction

Use this reference only when the source is a ChatGPT share URL or another virtualized chat page.

## Required Output

Produce a linear list with this schema:

```json
[
  { "role": "user", "content": "First prompt" },
  { "role": "assistant", "content": "First answer" }
]
```

The importer also accepts equivalent JSONL or Markdown sections such as:

```markdown
## 01 用户

First prompt

## 02 ChatGPT

First answer
```

## Extraction Rules

1. Prefer the page's embedded linear conversation payload or a complete export over visible DOM text.
2. Do not assume all messages are mounted in the accessibility tree. Long share pages commonly virtualize earlier messages.
3. Follow the active conversation branch in chronological order.
4. Keep only messages visible to the human reader with role `user` or `assistant`.
5. Exclude system prompts, developer instructions, internal reasoning, tool calls, tool results, hidden metadata, navigation labels, copy buttons, and composer text.
6. Preserve message bodies verbatim, including Markdown and code fences. Normalize line endings only.
7. Do not summarize, merge, rewrite, or translate messages.

## Completeness Checks

Before running the importer, record and verify:

- Total visible message count.
- Strict user/assistant alternation.
- Exact first user message.
- A distinctive substring from the last assistant message.
- The number of user prompts shown by page navigation, when available.

Pass these facts as `--expected-messages`, `--expected-first`, and `--expected-last-contains`. A mismatch means extraction is incomplete and must not be committed.

If the embedded payload cannot be read reliably after a page change, stop scraping the rendered viewport. Obtain a local Markdown or JSON export, then use the same importer against that file.
