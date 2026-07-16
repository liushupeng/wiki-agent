---
title: wiki maintenance schema
type: schema
status: active
---

# Wiki Maintenance Schema

This directory is the agent-maintained wiki layer. Raw sources remain the source of truth; wiki pages are compiled, structured, and kept current by the agent.

## Layers

- `notes/raw/`: immutable or mostly read-only raw sources.
- `wiki/`: maintained Markdown pages that summarize, connect, and reconcile source knowledge.
- `var/knowledge/`: generated indexes and runtime artifacts.

## Page Types

- `source`: summary page for one raw source.
- `concept`: durable explanation of a concept or recurring idea.
- `project`: project-specific context, status, and decisions.
- `decision`: architectural or product decision with rationale.
- `person`: person or organization page, when relevant.
- `contradiction`: unresolved conflict, stale claim, or evidence gap.

## Frontmatter

Use YAML frontmatter for maintained wiki pages:

```yaml
---
title: short human-readable title
type: source | concept | project | decision | person | contradiction
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - notes/raw/example.md
tags:
  - agent
status: draft | active | needs-review | stale
---
```

## Citation Rules

- Every important factual claim should point to a source page or raw source path.
- Do not delete conflicting claims silently. Record the conflict in `contradictions.md`.
- Distinguish source-backed claims from agent synthesis.

## Ingest Rules

When ingesting a raw source:

1. Read the raw source.
2. Create or update a `wiki/sources/*.md` summary page.
3. Update related concept, project, decision, or person pages.
4. Update `wiki/index.md`.
5. Append an entry to `wiki/log.md`.
6. Record unresolved conflicts in `wiki/contradictions.md`.

## Query Rules

When answering questions:

1. Search the wiki first.
2. If wiki evidence is missing or weak, search raw sources.
3. Cite wiki pages and raw sources separately.
4. If the answer creates durable synthesis, suggest writing it back to the wiki.

## Lint Rules

Periodically check for:

- Orphan pages with no inbound links.
- Pages with missing or stale sources.
- Duplicate concepts.
- Claims that conflict with newer sources.
- Important terms that appear often but do not have concept pages.
