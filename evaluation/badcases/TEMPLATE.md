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
- ops_incomplete

自动收割的 `failureTypes` 是运行信号（例如 `partial_evidence`、`fallback`、
`tool_failure`），不是最终根因。人工复核后应从上面的根因标签中选择，并写入
rubric 或 provenance 的 `failureTags`。

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
  "id": "",
  "question": "",
  "expectedSources": [],
  "expectedTerms": [],
  "contract": {
    "schemaVersion": 1
  },
  "provenance": {
    "source": "online-trace",
    "traceId": "",
    "observedAt": "",
    "failureTags": []
  }
}
```
