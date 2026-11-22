# Field report: <project>

> Copy this file to `references/field-reports/<project>/summary.md` and keep a `field-log.md` next to it.
> Rules: aggregated numbers only, no private data (no URLs, tokens, customer names or payloads from the
> real backend). Every number is measured; **"not measured"** plus the reason is a valid answer, an
> estimate is not. Archive the `verify --json` outputs under `<project>/artifacts/verify/`.

## Project

| | |
|---|---|
| Project | name, public repo or "internal" |
| Stack | framework, data layer, how the API origin is configured |
| Contract | OpenAPI / types / none |
| atrezzo version | commit or tag |
| Period | start and end date of the field work |
| Who | role of the person adopting it (knew atrezzo before or not) |

## How to collect the times

Write one line per milestone in `field-log.md` with `date +%s` and the command that produced it:

```
<epoch> init       atrezzo init                      (exit, duration, what it printed that mattered)
<epoch> world      atrezzo world <scenario>          (first exit 0)
<epoch> serve      atrezzo serve --scenario <name>
<epoch> verify     atrezzo verify <flow> --driver …  (first run, whatever the result)
<epoch> green      atrezzo verify <flow>             (first exit 0 on a real screen)
```

Times are measured from `init` (T0). Anything before T0 that the adopter had to do (install, build, read
docs) goes in the log with its own duration, so the metric stays comparable and the cost stays visible.

## The seven metrics

| # | Metric | How it is collected | Decision taken with the value |
|---|---|---|---|
| 1 | **Time to the first working mock**: from `atrezzo init` to the first `verify` exit 0 on one real screen | `field-log.md` timestamps (+ commits) | > 2 h → invest in `init` / `import` / `scene`, not in features |
| 2 | **Time to a complex scenario**: ≥ 3 entities, declared `writes`, a 3-step flow green | same | > 1 day → the DSL is too verbose; review its defaults |
| 3 | **Real bugs reproduced**: reproduced / attempted, and time per bug | every bug of the project in the period (tracker issues, incidents); each attempt is a flow that is red while the bug exists | < 50 % → the missing capability is the only legitimate source of new features |
| 4 | **Maintenance when the front end changes**: scenario/flow lines changed per front-end PR; breakages `verify` caught | `git diff --stat` of `atrezzo/` against the front-end diff, per PR | more lines changed in the scenario than in the code → DSL design problem |
| 5 | **Gaps per week** | `atrezzo misses --json` at the end of each week (count, resolved/unresolved) | if they do not go down after the first week, `gap` / `harvest` do not close the loop |
| 6 | **Diagnosis accuracy in the field** | every KO run with `--diagnose`: mark by hand whether the first `confirmed`/`likely` hypothesis was right; each one goes to `tests/diagnosis.test.mjs` with its cause | `likely` < 60 % in the field → remove heuristics |
| 7 | **Silent divergences between runtimes** | incidents noted while working; plus one replay of the app's request sequence through `serve` and the generated handlers | > 0 after F2 → the matrix lies; stop everything and fix it |

The saving against hand-written mocks (fixtures or handlers removed vs scenario lines) may be noted, but with
two projects it is an anecdote: it does not drive any decision.

## Results

For each metric: the value, the evidence (log line, artifact, test) and the decision. Use this shape:

### 1. Time to the first working mock
- **Value:**
- **Evidence:**
- **Decision:**

(… one section per metric …)

## Field findings

Every place where atrezzo failed, was missing something, or made the adopter work around it. Do **not**
patch atrezzo during the field period: write it here. One row each:

| # | Finding | Where it showed up | Workaround used | Severity (blocks / costs time / cosmetic) |
|---|---|---|---|---|

## Diagnosis cases added to the corpus

| case name in `tests/diagnosis.test.mjs` | injected cause | first strong hypothesis | right? |
|---|---|---|---|

And the corpus result after adding them (`node --test tests/diagnosis.test.mjs`): `confirmed` precision
(must be 1.0), `likely` precision (≥ 0.8), top-1.

## What was not measured, and why
