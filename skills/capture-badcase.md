---
name: capture_badcase
description: Use when an agent failure, weak answer, bad retrieval, wrong tool choice, or user correction should be turned into eval and improvement data.
---

# capture_badcase

Use this skill when the user reports that the agent answer was wrong, weak, poorly cited, used the wrong tool, missed a source, or behaved inefficiently.

## Goal

Turn a failure into durable improvement data:

```text
failure
-> evaluation/badcases/*.md
-> eval case
-> schema / skill / prompt / tool update recommendation
```

## Failure Types

- retrieval_miss: relevant wiki/raw source was not retrieved.
- routing_error: wrong tool or tool group was selected.
- weak_evidence: answer was correct-looking but under-cited.
- hallucination: answer claimed something unsupported.
- stale_wiki: maintained wiki content was outdated.
- schema_gap: wiki rules did not say how to handle the case.
- permission_gap: policy or approval behavior blocked or allowed the wrong thing.

## Workflow

1. Identify the user question and expected behavior.
2. Summarize the actual behavior.
3. Inspect trace if available.
4. Classify the failure type.
5. Create a bad case Markdown file under `evaluation/badcases/`.
6. Add or suggest an eval case under `examples/*-eval/`.
7. Recommend the smallest durable fix: schema, skill, prompt, tool description, test, or eval.

## Bad Case Template

```markdown
# Short title

## User Question

## Expected Behavior

## Actual Behavior

## Failure Type

## Evidence

## Trace Notes

## Fix Plan

## Eval Candidate
```
