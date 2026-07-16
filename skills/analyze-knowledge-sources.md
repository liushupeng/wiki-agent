---
name: analyze_knowledge_sources
description: Use before onboarding a real notes directory; audit directory structure and propose source policy, ignore rules, and initial knowledge source config.
---

# analyze_knowledge_sources

Use this skill before indexing a real, messy knowledge directory.

## Goal

Do not index everything blindly. First understand the directory structure and produce a practical source policy:

```text
directory tree
-> domain taxonomy
-> source types
-> ignore rules
-> recommended config/knowledge.sources.jsonc changes
-> first small validation scope
```

## Input

The user may provide:

- A directory tree file, such as `dir_list.txt`.
- A path under `notes/`.
- A short description of the knowledge base.

## Audit Checklist

1. Identify top-level domains, such as wealth, career, computer science, projects, code, or data.
2. Separate raw knowledge from code projects, generated data, caches, images, and attachments.
3. Mark directories that should be ignored, such as `__pycache__`, `node_modules`, `dist`, `build`, `.git`, `finalData`, generated CSV folders, or large static assets.
4. Recommend which directories should be indexed first.
5. Recommend which directories should be wiki-maintainable and which should only be searchable.
6. Identify file types that current loaders do not support well.
7. Propose a minimal `config/knowledge.sources.jsonc` update.
8. Propose 3-5 real validation questions to run after indexing.

## Output Shape

```markdown
## Source Audit Summary

## Domain Taxonomy

## Recommended Source Config

## Ignore Policy

## First Validation Scope

## Validation Questions

## Risks And Follow-ups
```

## Rules

- Prefer a small first validation scope over full indexing.
- Do not suggest adding code until a real issue is observed from trace, eval, or bad cases.
- Make source policy explicit and testable.
