# Model studies

A study runs the same scenarios across a named set of candidates and judges, then
combines their saved scores into one report. Findings describe performance **in
this study**, with its specific prompts, rubric, models, and settings.

## Input file

Save a JSON file with these fields:

```json
{
  "id": "business-study",
  "title": "Business decisions in this study",
  "reasoningEffort": "low",
  "benches": [
    {
      "bench": "business-strategy",
      "label": "Business strategy",
      "scenarios": ["pricing-pivot", "hire-or-outsource"]
    }
  ],
  "candidates": [
    { "ref": "openai/gpt-6.1-sol", "family": "openai", "label": "GPT" },
    { "ref": "google/gemini-3.1-pro-preview", "family": "google", "label": "Gemini" }
  ],
  "judges": [
    { "ref": "openai/gpt-6.1-sol", "family": "openai" },
    { "ref": "google/gemini-3.1-pro-preview", "family": "google" }
  ],
  "judgeLens": "Assess practical usefulness, accuracy, and the stated constraints.",
  "participant": "meta-llama/llama-4-maverick",
  "synthesizer": "z-ai/glm-5.3"
}
```

- `id`: 3 to 40 lowercase letters, digits, or hyphens. Use a new ID when changing
  an existing study. `title` is at most 120 characters.
- `benches`: one or more registered bench names, display labels (at most 40
  characters), and explicit scenario IDs. Unknown benches, unknown scenarios,
  and repeated bench/scenario pairs are rejected before confirmation or calls.
- `candidates`: 2 to 8 unique model refs with family and display label.
- `judges`: 2 to 5 unique model refs, each with a different family. Seat order is
  fixed: entry 1 is `custom_1`, entry 2 is `custom_2`, and so on in every batch.
- `family`: a lab identifier of 2 to 30 lowercase letters, digits, or hyphens.
  Candidate and judge family names should match when they represent the same lab.
- `judgeLens`: shared evaluation instructions, 1 to 1,000 characters.
- `participant`: the model simulating follow-up messages in multi-round scenarios.
  `synthesizer`: the model combining judge reports for ordinary run evidence.
  Study statistics use the individual judges' scores, not synthesized scores.
- `reasoningEffort`: optional `minimal`, `low`, `medium`, or `high`. It temporarily
  sets `TOURNAMENT_REASONING_EFFORT`; the previous value, including an unset
  value, is restored on success or failure. If omitted, the environment is used.
  With reasoning on, candidates get a 32,768-token output limit because hidden
  reasoning counts against it. A reply that comes back empty or hits the limit
  is recorded as a failed answer, never scored.

Model refs use OpenRouter IDs or `anthropic:claude-...` for the registered Claude
subscription client. Configure that client through the local integration before
running subscription roles. All batches must have ready routes before the first
batch starts. The runner does not register or bypass a provider's billing guard.

## Commands and confirmation

```sh
mcp-tournament study studies/business-study.json --out ./results
mcp-tournament study studies/business-study.json --out ./results --yes
mcp-tournament study-analyze business-study --out ./results
```

The first command prints the number of batches, candidates, judges, answers, and
a rough dollar estimate. Answer `y` or `yes` to proceed; Enter defaults to No.
`--yes` accepts the printed estimate without prompting. Progress and confirmation
text go to stderr; a successful command prints only the output folder path to
stdout. The default results root is `TOURNAMENT_RESULTS_DIR`, or `./results`.

The estimate covers the full study, including batches already completed. It
excludes `anthropic:` refs because they run on the subscription. Other refs with
missing prices are listed separately. An offline catalog makes the estimate
unavailable. These are token-based estimates, not spending caps. When
`reasoningEffort` is set, reasoning tokens come on top of the estimate, and the
summary says so.

Actual cost is a best-effort sum of OpenRouter key usage differences. The runner
reads usage before the first pending batch and after every batch, including a
batch that fails, and keeps the running total in `progress.json` as `spentUsd`,
so a crash and resume keeps the spend from earlier invocations. The last raw
reading is saved as `lastUsage`; when a hard-killed run resumes, the gap since
that reading is added to the total. Usage is read with `OPENROUTER_API_KEY`,
falling back to `OPENROUTER_DICE_ORACLE_API_KEY`, with the same precedence as
the client. Any failed or non-numeric reading makes the total
`null` and does not stop the study. Keys and raw usage responses are never saved
or logged. Other activity on the same key during the study is counted too.

## Output and resume

```text
results/
  run-study-business-study-1-1/
    run.json
    candidates/<model-slug>/<scenario-name-slug>/...
    judges/<model-slug>/<scenario-name-slug>/custom_1.json
    judges/<model-slug>/<scenario-name-slug>/custom_2.json
    judges/<model-slug>/<scenario-name-slug>/synthesis.json
    leaderboard.json
    failures.json                  (when failures occurred)
  studies/business-study/
    progress.json
    study.json
    scores.csv
```

Batches split candidates into balanced groups of at most four for each bench:
five candidates become groups of three and two. A batch ID such as `1-2` means
the second candidate group on the first bench.

`progress.json` records completed batch IDs in `done`, the study snapshot, start
time, and the absolute `studyFile` path when called from the CLI. Completion is
saved after each successful batch. Rerunning the same input skips those batches.
An unfinished run folder is renamed to `<runId>-abandoned-<epochMs>` and the batch
starts again. Existing run data is never deleted. A changed saved study is
rejected rather than combining incompatible evidence.

`study.json` contains `{ study, meta, analysis }`. Metadata includes `runIds`,
`estimateUsd`, `actualUsd`, `startedAt`, `finishedAt`, and optional edited
`headlines: [{ title, body }]`. `scores.csv` contains one row per returned
criterion per judge, with these columns:

```text
runId,bench,benchLabel,scenarioId,scenarioName,candidateRef,candidateFamily,candidateLabel,judgeRole,judgeRef,judgeFamily,criterion,score
```

CSV records use CRLF line endings and RFC 4180 quoting: commas, quotes, and
newlines are enclosed in quotes, and embedded quotes are doubled. Scenario paths
come from the saved scenario **name**, not its ID. The collector checks saved
judge seats against the study before assigning judge refs and families. Missing
judge files are skipped; malformed files or mismatched seats raise errors.

`study-analyze` reads saved scores and rewrites both outputs without model calls,
catalog requests, or usage requests. It preserves existing metadata, including
edited headlines. If `study.json` does not yet exist, it uses progress and the
saved study snapshot or original study file, collecting only completed batches.

## Repairing gaps

```sh
mcp-tournament study-repair studies/business-study.json --out ./results
```

Repair fills gaps listed in `failures.json` for completed batches in place. It
reruns failed answers with judging, or fills only the missing judge seats on
saved answers. Successful work is never redone. Unfinished batches still belong
to the normal `study` resume command.

The command shows the answers and judge seats to repair before asking for y/N
confirmation. Use `--yes` to accept that summary without prompting. Declining
makes no model calls or file changes. Repair refreshes affected summaries,
leaderboards, `study.json`, and `scores.csv`, preserving edited metadata.

OpenRouter usage is read before and after repair and added to the saved spend.
An unavailable reading makes the total unknown (`null`). Progress and remaining
gaps go to stderr; the study folder goes to stdout. The exit code is 1 if any
gaps remain, so scripts can detect incomplete repairs.

## Reading the statistics

- An answer is one candidate on one scenario in one run. Each judge's answer
  score is the mean of the criteria that judge returned. Missing criteria are
  not zeros. Answers with at least two judges are analyzed; answers represented
  in the score rows with fewer judges are counted as dropped. Answers with no
  saved scores have no CSV rows and are not counted by this analysis; inspect
  run failure files alongside the planned answer count.
- Leaderboards average the judges for each answer, then average those answers
  per candidate. The 95% bootstrap interval repeatedly resamples whole scenarios
  to show uncertainty. Overlapping intervals appear in `tiedWith`; ranks still
  follow the mean score. Overlap is a descriptive tie rule, not proof of equality.
- A judge's offset is its answer score minus the other judges' mean on the same
  answer. Self-preference compares that offset for its own family versus other
  families. The matrix reports offsets by candidate family. Missing comparison
  groups produce `null`, not zero.
- Single-judge winners show which candidate each judge scored highest across
  analyzed answers. Exact ties break by model ref for consistent output.
- Agreement uses Krippendorff's alpha with interval distances: 1 means perfect
  agreement, 0 means no more agreement than expected by chance, and negative
  values mean less agreement. Insufficient data or no expected disagreement
  yields `null`.
- Contested answers are the five with the largest gap between judges. Their
  `byJudge` values are keyed by **family**, such as `anthropic`, not seat role.

These statistics reflect the scenarios sampled and available scores. They do
not establish a universal model ranking or measure variation across repeated
generations of the same answer.

## Library use

The package exports `runStudy`, `repairStudy`, `reanalyzeStudy`, `parseStudy`,
`planBatches`, and `analyzeStudy`, plus their main input and result types.
Register benches first with `loadDiscoveredBenches()` (the CLI does this), then
call `runStudy(parseStudy(input), { confirm: async summary => ... })`; optional
settings are `resultsRoot`, `onProgress`, `catalog`, `fetchUsage`, and `studyFile`.
`fetchUsage` returns a cumulative dollar reading or `null`. A declined confirmation
returns an outcome with `cancelled: true` and creates no output folders.
