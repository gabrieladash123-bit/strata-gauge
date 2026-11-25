# StrataGauge

**Audit rate comparisons on GenLayer.** StrataGauge independently verifies which counts apply to each cohort, then publishes an exact comparison showing whether pooling reverses the result.

An aggregate comparison can favor one system while every cohort favors the other. Different mixes of easy and hard workloads are enough. StrataGauge makes that reversal queryable by builders consuming benchmark, audit, or operational reports.

| Synthetic workload | Quartz | Basalt | Higher rate |
| --- | ---: | ---: | --- |
| Standard | 81 / 87 | 234 / 270 | Quartz |
| Burst | 192 / 263 | 55 / 80 | Quartz |
| **Pooled** | **273 / 350** | **289 / 350** | **Basalt** |

The pooled Quartz-minus-Basalt difference is **−8/175**, about **−4.57 percentage points**. Equal cohort weights reverse the sign. The reports also contain a superseded tally and a different metric. Consenting to the wrong Standard row changes the finding to `NO_REVERSAL` in the direct test.

## Contract

| Method | Effect |
| --- | --- |
| `create(plan_json: bytes)` | Freeze a UTF-8 JSON plan with the ordered arms, outcome, cohorts, pinned reports, and positive standard weights. The canonical plan digest is the study ID. |
| `record(study, index)` | Independently resolve a cohort report. Successful writes fill that slot once, in any order. The final slot automatically publishes the comparison. |
| `get_study(study)` | Read the plan, remaining cohort count, and complete result once available. |
| `get_observation(study, index)` | Read the selected literal count row, normalized counts, and source commitment. |

Anyone can create a study or record any missing cohort. The contract has no administrator. Study definitions, filled slots, and completed results are immutable.

## What validators verify

The leader and each validator independently fetch the full report bytes inside GenVM. Each checks the SHA-256, parses bounded literal count rows, and asks a model to identify the sole final observed row that matches the cohort, outcome, and ordered arms. Selection requires matching windows and denominator definitions within the row. The validator reruns the acquisition and interpretation and requires exact agreement on the row index, literal line, and four integers. The model selects among source rows. Python parses the numbers and computes every comparison.

An agreed abstention returns `UNRESOLVED` and leaves the slot empty. Fetch failures, changed bytes, malformed inputs, and failed consensus leave the slot unchanged. A study with genuinely ambiguous sources may remain incomplete. A new plan can reference clearer reports.

## Reading a result

- `SIMPSON_REVERSAL` means the pooled difference and every individual cohort difference have strict opposite signs.
- `STANDARDIZED_REVERSAL` means the common-weight difference and the pooled difference have strict opposite signs, without a unanimous strict cohort reversal.
- `POOLED_TIE` means the pooled difference is exactly zero.
- `NO_REVERSAL` covers the remaining outcomes.

The standardized difference is the weighted average of the within-cohort rate differences using the same positive cohort weights for both arms. The result returns reduced numerator and denominator strings and preserves every cohort’s counts. The [evidence format](docs/evidence.md) defines how to prepare a reusable study.

## Reproduce

Python 3.13, GenVM runner v0.2.16, Node.js 24.

```sh
pip install -r requirements-dev.txt
genvm-lint download --version v0.2.16
genvm-lint check contracts/strata_gauge.py
python -m pytest tests/direct -q
npm ci
```

The StudioNet workflow deploys one instance, records the two cohorts out of order, verifies a rejected duplicate, and reads back the result and the deployed source. The verifier (when given a proof ledger) replays those public checks with read-only RPC.

## Scope

The contract derives results conditional on the pinned reports and the study author’s cohort and weight choices. It cannot establish that samples actually occurred, prove cross-report sample disjointness, select a representative population, or infer causality. The included benchmark is synthetic.
