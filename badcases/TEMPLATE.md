# Short Bad Case Title

## User Question

What did the user ask?

## Expected Behavior

What should the agent have done?

## Actual Behavior

What did the agent actually do?

## Failure Type

Choose one:

- retrieval_miss
- routing_error
- weak_evidence
- hallucination
- stale_wiki
- schema_gap
- permission_gap

## Evidence

Relevant wiki pages, raw sources, tool outputs, or user corrections.

## Trace Notes

Trace file path or important trace events.

## Fix Plan

Smallest durable fix:

- Add or update eval case
- Update wiki schema
- Update skill
- Update system prompt
- Update tool description
- Add test

## Eval Candidate

```json
{
  "question": "",
  "grepTerms": [],
  "expectedSource": "",
  "expectedTerms": []
}
```
