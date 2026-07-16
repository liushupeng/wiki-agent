---
name: ingest_source
description: Use when turning a raw source into maintained wiki pages, updating index/log, and recording contradictions.
---

# ingest_source

Use this skill when the user asks to add,整理, ingest, compile, or maintain a source in the wiki.

## Goal

Turn one raw source into durable wiki structure:

```text
raw source
-> source summary page
-> related concept/project/decision pages
-> index.md update
-> log.md entry
-> contradictions.md entry if needed
```

## Workflow

1. Read `wiki/AGENTS.md` first and follow its schema.
2. Read the raw source from `notes/raw/` or the path provided by the user.
3. Create or update one page in `wiki/sources/`.
4. Extract durable concepts, project context, decisions, people, and open questions.
5. Update related pages under `wiki/concepts/`, `wiki/projects/`, `wiki/decisions/`, or `wiki/people/`.
6. Update `wiki/index.md` with a one-line summary and link for each new or changed page.
7. Append a dated entry to `wiki/log.md`.
8. If new evidence conflicts with existing claims, add an item to `wiki/contradictions.md` instead of silently overwriting.

## Output Requirements

- Separate source-backed facts from synthesis.
- Keep citations as wiki paths or raw source paths.
- Prefer small focused page updates over one large catch-all page.
- If evidence is insufficient, record the gap explicitly.
