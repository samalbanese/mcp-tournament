# mcp-tournament

> AI model evaluation as an MCP server. Multi-judge panels, structured scoring, pluggable domains.

## What It Does

Submit any language model to a structured evaluation with a panel of AI judges. Get ranked results with confidence scores. All from your AI assistant.

```bash
npx mcp-tournament
```

## Quick Start

### As MCP Server (Claude Desktop, Cursor, Windsurf)

```json
{
  "mcpServers": {
    "tournament": {
      "command": "npx",
      "args": ["-y", "mcp-tournament"]
    }
  }
}
```

### As CLI

```bash
# Evaluate a single model
mcp-tournament evaluate --model "anthropic/claude-sonnet-4" --plugin dnd

# Compare two models head-to-head
mcp-tournament compare --models "claude-sonnet-4,gpt-4o" --plugin coding

# View leaderboard
mcp-tournament leaderboard --plugin dnd
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `tournament.evaluate` | Run a model through test cases with a multi-judge panel |
| `tournament.compare` | Head-to-head comparison of 2+ models |
| `tournament.quick_test` | Single test case, fast evaluation (~2 min) |
| `tournament.leaderboard` | View cached ranked results |
| `tournament.scenarios` | List available test scenarios |
| `tournament.judges` | List judge panel + specializations |
| `tournament.report` | Generate markdown report from past runs |
| `tournament.plugins` | List installed domain plugins |

## Plugins

Evaluation is domain-agnostic. Plugins define what "good" means for your use case:

| Plugin | Domain | Included |
|--------|--------|----------|
| `dnd` | D&D 5e Dungeon Master | ✅ |
| `coding` | Code generation & review | ✅ |
| `customer-support` | Help desk conversations | ✅ |
| `creative-writing` | Storytelling & prose | 🔜 |
| Custom | Your domain | 📦 |

## How It Works

4-phase pipeline:

```
1. EXECUTE  — Candidate model runs through test case(s)
2. JUDGE    — Panel of N specialist judges score independently
3. SYNTHESIZE — Opus arbitrates all judge scores (never evaluates independently)
4. AGGREGATE — Scores compiled into ranked leaderboard
```

## Why Multi-Judge?

Single evaluators miss things. A "Rules" judge catches logic errors. A "Creative" judge catches boring output. A "Holistic" judge catches "would I keep using this?" The synthesizer catches outlier scores and resolves disagreements.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude models (judges + synthesizer) |
| `OPENROUTER_API_KEY` | Yes | Non-Claude candidate models |

## License

MIT
