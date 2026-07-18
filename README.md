# mcp-tournament

> Build your own LLM benchmark in a form, run it from a local GUI or MCP — bring
> your own OpenRouter key. Multi-judge panels, arbiter synthesis, ranked results,
> all for pennies per run.

Describe a task in plain language, define (or AI-suggest) the judging criteria,
and submit any models to a structured tournament: each candidate plays through
your scenario, a panel of specialist AI judges scores it independently, an
arbiter resolves their disagreements, and the results land on a ranked
leaderboard. Run it from the bundled local web app, your AI assistant (MCP), or
the CLI — no code required to add a new benchmark.

![Leaderboard view](docs/images/leaderboard-1440.png)

## Why multi-judge?

Single evaluators miss things. A Rules judge catches mechanical errors; a Creative
judge catches boring output; a Holistic judge catches "would I keep using this?"
The synthesizer never scores independently — it arbitrates, flags outlier judges,
and records **why** they disagreed. Judge disagreements are first-class data,
rendered in the viewer:

![Model scorecard with judge disagreements](docs/images/scorecard-1440.png)

## How it works

```
1. EXECUTE     candidate model plays the scenario (tool calls included)
2. JUDGE       N specialist judges score independently against plugin criteria
3. SYNTHESIZE  arbiter merges scores, confidence-rates every criterion, keeps outlier notes
4. AGGREGATE   ranked leaderboard + full JSON audit trail (docs/RESULTS_FORMAT.md)
```

Domain logic is pluggable; the pipeline is not. Benches are declarative plugins —
a JSON file (or the Build Bench form) defines scenarios, rounds, an optional
simulated participant persona, and judging criteria. Code plugins can go further
with custom tools — see [docs/PLUGINS.md](docs/PLUGINS.md).

| Plugin | Domain | Kind |
|--------|--------|------|
| `business-strategy` | SMB pricing decision with real numbers to reason about | 📄 bench (JSON) |
| `creative-writing` | Opening chapter + 3 rounds with a developmental-editor persona | 📄 bench (JSON) |
| `customer-support` | Billing dispute with an escalating customer persona | 📄 bench (JSON) |
| `dnd` | Showcase: D&D 5e Dungeon Master with dice/damage tools and an LLM player | ⚙️ code plugin |
| `coding` | Code generation & review | ⚙️ code plugin |
| **Yours** | Build in the GUI (`#/build`), drop a JSON in `benches/`, or write TypeScript | 🛠 you |

## Quick start

```bash
npm install && npm run build
export OPENROUTER_API_KEY=sk-or-...   # one key, every role
```

### As a local app (BYOK GUI)

```bash
npm --prefix gui install && npm --prefix gui run build
node dist/cli.js gui              # http://localhost:4600
```

Paste your OpenRouter key in **Settings** (stored in your browser, sent only to
this local server, never written to disk), pick models from the live catalog
with prices, and start a run from **NEW RUN**. **BUILD BENCH** creates a new
benchmark from a form — question, rounds, persona, judging criteria (with an
AI-suggest button) — and saves it as a JSON plugin, live immediately.

### As an MCP server (Claude Desktop, Cursor, Windsurf)

```json
{
  "mcpServers": {
    "tournament": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

| Tool | Description |
|------|-------------|
| `tournament.evaluate` | 1–4 models × scenarios × judge panel → ranked results |
| `tournament.quick_test` | One scenario, one judge — fast smoke score |
| `tournament.leaderboard` | Best cached score per model across runs |

### As a CLI

```bash
# The demo: 3 cheap models, 1 scenario, 3 judges (~a few cents)
node dist/cli.js run --plugin dnd \
  --models "deepseek/deepseek-v3.2,google/gemini-2.5-flash-lite,meta-llama/llama-4-scout" \
  --scenario dnd-combat --judges 3

node dist/cli.js leaderboard
node dist/cli.js serve          # MCP stdio server
```

## Results viewer

`gui/` is a self-contained Vite + React static site — no backend, deploys to any
static host (Cloudflare Pages works as-is). It reads committed run JSON and
renders rankings, per-judge breakdowns, disagreement callouts, and full
transcripts with tool-call inspection.

```bash
cd gui && npm install
npm run import-run -- ../results/<runId>   # copy a run into the viewer
npm run build && npm run preview
```

![Transcript view](docs/images/transcript-1440.png)

## Model routing

Every role — the candidates, each judge, the synthesizer, the participant agent —
is independently model-selectable and routes through **OpenRouter by default**.
One key, any model, no paid first-party API in the demo path. Defaults are all
budget-tier (DeepSeek, Qwen Flash, Gemini Flash Lite — a full run costs cents);
override per role:

```bash
TOURNAMENT_MODEL_JUDGE_RULES=openai/gpt-5.4-mini
TOURNAMENT_MODEL_SYNTHESIZER=moonshotai/kimi-k2.5
TOURNAMENT_MODEL_PARTICIPANT=deepseek/deepseek-v3.2
```

The routing layer resolves a pluggable `ModelClient` per role
(`src/clients/types.ts`). That registry is the documented extension point for a
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) route, which
authenticates against a local `claude /login` session so Claude-judged runs draw
on a Max/Pro **subscription** instead of the metered API — the original
oracle-tournament design. Two regression tests guard the default: the demo path
never resolves to the paid Anthropic API, and the MCP server's logger stays on
stderr (stdout is reserved for JSON-RPC).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | All roles by default |
| `TOURNAMENT_MODEL_*` | No | Per-role model overrides (see above) |
| `TOURNAMENT_RESULTS_DIR` | No | Results output root (default `./results`) |

## Roadmap

Deferred deliberately: `tournament.compare` / `report` / `plugins` / `scenarios` /
`judges` tools, customer-support and creative-writing plugins, plugin
auto-discovery, npm publish, MCP registry submission, CI. Tracked in `TODO.md`.

## Provenance

Generalized from [oracle-tournament](https://github.com/samalbanese/oracle-tournament),
a D&D-specific model evaluator — its pipeline proved out the multi-judge +
arbiter design; this repo makes the domain pluggable.

## License

MIT
