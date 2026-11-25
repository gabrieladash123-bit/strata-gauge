# Prepare a study

Freeze 2–6 mutually exclusive cohorts and label the two arms and observed outcome. Use comparable observations across arms and a consistent study protocol across reports. The contract verifies documentary support within each report. Study maintainers remain responsible for sample provenance and cross-report consistency.

Publish one UTF-8 text file per cohort at a permanent GitHub commit. A report can contain up to 16 candidate rows. Put context in prose that explicitly maps A and B to the two study arms and states the cohort, outcome, measurement window, denominator definition, and which tally is final. Use this syntax for each numeric candidate.

```text
ROW 2 | A 81/87 | B 234/270
```

The numerators are observed successes. The positive denominators are eligible observations. Counts are integers capped at 1,000,000. IDs range from 1 to 99 and must be unique within the report. An identifier of zero is reserved for abstention. Malformed numeric rows invalidate the report.

Use `owner/repo/commit/path.txt` as the source coordinate and calculate each lowercase SHA-256 from the original report bytes. Paths are limited to plain ASCII letters, digits, underscores, hyphens, and slash-separated directories, with a final `.txt` extension. Each report must fit within 3,072 bytes. A plan is a JSON object with `outcome`, `arm_a`, `arm_b`, and `cohorts`. Each cohort has `name`, `source`, `sha256`, and `weight`. Each weight is a positive integer at most 1,000.

The included scripts make a complete plan from the pinned [Standard](../fixtures/standard.txt) and [Burst](../fixtures/burst.txt) fixture files.
