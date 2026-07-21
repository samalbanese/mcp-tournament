# Results JSON Contract (v1)

This is the shared contract between the pipeline (writer) and the results-viewer GUI
(reader). Both MUST conform to it exactly. Naming is domain-generic: `candidate` (the
model under test) and `participant` (the simulated counterpart: player, customer,
test system), never `dm`/`player`.

## Directory layout

```
results/<runId>/                      # runId = run-YYYY-MM-DD-HHMMSS
  run.json                            # run manifest (see below)
  leaderboard.json                    # LeaderboardEntry[] sorted by overallAverage desc
  candidates/<modelSlug>/<scenarioSlug>/turns.json     # Turn[]
  candidates/<modelSlug>/<scenarioSlug>/metrics.json   # RunMetrics
  judges/<modelSlug>/<scenarioSlug>/<judgeRole>.json   # JudgeScore (one per judge)
  judges/<modelSlug>/<scenarioSlug>/synthesis.json     # Synthesis
```

`modelSlug` / `scenarioSlug`: lowercase, non-alphanumerics → `_` (see `src/plugins/base.ts`).

## run.json (manifest)

```json
{
  "runId": "run-2026-07-17-120000",
  "plugin": "dnd",
  "createdAt": "2026-07-17T12:00:00.000Z",
  "candidates": [{ "id": "moonshotai/kimi-k2.5", "name": "Kimi K2.5", "tier": "mid" }],
  "judges": [{ "role": "rules", "name": "Rules Judge", "model": "openai/gpt-5.4-mini" }],
  "synthesizer": { "model": "moonshotai/kimi-k2.5" },
  "scenarios": [{ "id": "scenario-01", "name": "The Moonlit Ambush" }]
}
```

## leaderboard.json · `LeaderboardEntry[]`

```json
[{
  "modelId": "moonshotai/kimi-k2.5",
  "modelName": "Kimi K2.5",
  "tier": "mid",
  "overallAverage": 5.33,
  "scenarioScores": [{
    "scenarioId": "scenario-01",
    "scenarioName": "The Moonlit Ambush",
    "average": 5.33,
    "scores": {
      "<criterion>": { "score": 7, "confidence": "high", "outliers": ["<judge disagreement note>"] }
    },
    "ruleErrors": ["..."],
    "flags": ["..."]
  }]
}]
```

`confidence` ∈ `"high" | "medium" | "contested"`. `scenarioId` is a **string**.

## turns.json · `Turn[]` (generic shape from `src/plugins/base.ts`)

```json
[{
  "turn": 0,
  "role": "participant",            // "candidate" | "participant"
  "content": "…message text…",
  "toolCalls": [{ "name": "roll_dice", "arguments": {}, "result": "…", "valid": true }],
  "metrics": { "ttfbMs": null, "totalTimeMs": 1234, "inputTokens": 100, "outputTokens": 250 }
}]
```

`toolCalls` and `metrics` are optional (participant turns typically have neither).

## metrics.json · `RunMetrics`

```json
{
  "candidateInputTokens": 0, "candidateOutputTokens": 0,
  "participantInputTokens": 0, "participantOutputTokens": 0,
  "totalTimeMs": 0, "toolCallCount": 0
}
```

## <judgeRole>.json · `JudgeScore` (see `src/schemas/judge-score.ts`)

```json
{
  "scores": { "<criterion>": { "score": 7, "justification": "…", "quotes": ["…"], "improvement": "…" } },
  "rule_errors": [], "tool_errors": [], "flags": [],
  "overall_impression": "…"
}
```

## synthesis.json · `Synthesis` (see `src/schemas/synthesis.ts`)

```json
{
  "final_scores": { "<criterion>": { "score": 7, "confidence": "high", "outliers": [] } },
  "average_score": 5.33,
  "rule_errors_confirmed": [],
  "assessment": "…",
  "judge_agreement": "…"
}
```

## GUI data directory

The GUI is static; it reads `gui/public/data/index.json`:

```json
{ "runs": ["run-2026-07-17-120000"] }
```

…and each listed run mirrored under `gui/public/data/<runId>/` with the same layout as
`results/<runId>/`. A helper script copies a run from `results/` into the GUI data dir
and updates `index.json`.

## Versioning

Breaking changes to this contract bump the version in this heading and must update
pipeline + GUI + this doc in the same commit.
