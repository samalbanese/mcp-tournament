# Contributing

Thanks for your interest! This project is small and moves fast; issues and PRs welcome.

## Getting set up

```bash
git clone https://github.com/samalbanese/mcp-tournament.git
cd mcp-tournament
npm run setup               # installs + builds server and GUI
npm test                    # unit tests, no API key needed
node dist/cli.js gui        # local app at http://localhost:4600
```

Or one click, zero local setup:
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/samalbanese/mcp-tournament)

Real runs need an OpenRouter key (`OPENROUTER_API_KEY` or paste it in the GUI
Settings). Unit tests and the results viewer work without one.

## What contributions look like

- **New benches**: the easiest contribution, a JSON file in `benches/`
  (or build it in the GUI at `#/build` and copy the file out). See
  [docs/PLUGINS.md](docs/PLUGINS.md).
- **Code plugins**: domains that need custom tools (see `src/plugins/dnd.ts`).
- **Bug fixes**: please include a failing test that your fix turns green.

## Ground rules

- TypeScript ESM with NodeNext resolution; imports need `.js` extensions.
- `npm run build` and `npm test` must pass; CI runs both plus the GUI build.
- Keep the core pipeline domain-agnostic; domain logic belongs in plugins.
- The MCP server logs to stderr only (stdout is reserved for JSON-RPC). Two
  regression tests enforce this and the no-paid-API default; don't break them.

## Conduct

Be kind, assume good faith.
