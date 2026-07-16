---
name: answer_from_wiki
description: Use for evidence-aware answers that should search maintained wiki first and raw sources only when needed.
---

# answer_from_wiki

Use this skill when answering questions against the knowledge base.

## Retrieval Order

1. Search the maintained wiki first with `search_notes` or `grep_notes`.
2. Read relevant wiki pages with `read_note`.
3. If wiki evidence is missing, stale, or too thin, search raw sources.
4. Use `related_notes` when the user asks for adjacent concepts or extended reading.

## Answer Rules

- Cite maintained wiki pages and raw sources separately.
- Distinguish:
  - wiki-established conclusions
  - raw-source facts
  - agent synthesis or inference
- Do not over-search once evidence is sufficient.
- If the question produces durable synthesis, suggest writing it back into the wiki.

## Recommended Answer Shape

```text
结论：
<short answer>

依据：
- Wiki: wiki/concepts/example.md
- Raw: raw/example-source.md

推断/不确定性：
<what is inferred or still missing>

可沉淀内容：
<whether this answer should become or update a wiki page>
```
