---
name: lint_wiki
description: Use to health-check the maintained wiki for orphan pages, missing citations, stale claims, duplicate concepts, and contradictions.
---

# lint_wiki

Use this skill when the user asks to check wiki quality, consistency, stale pages, missing links, or contradictions.

## Checks

1. Read `wiki/AGENTS.md`, `wiki/index.md`, `wiki/log.md`, and `wiki/contradictions.md`.
2. Check whether important pages are listed in `wiki/index.md`.
3. Find pages with missing frontmatter or missing `sources`.
4. Look for orphan pages that are not linked from index or related pages.
5. Look for duplicate concepts with overlapping meaning.
6. Check whether claims are stale compared with newer source summaries.
7. Identify important repeated terms that deserve concept pages.
8. Update `wiki/contradictions.md` for unresolved conflicts.
9. Append a lint entry to `wiki/log.md`.

## Output Requirements

- Report findings by severity: blocking, warning, suggestion.
- Each finding should include the page path and a concrete fix.
- Do not rewrite large parts of the wiki unless the user asks.
- Prefer small maintenance edits that make the wiki easier to navigate.
