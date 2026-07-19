# MCP Tournament Desktop

From the repo root, run `npm run build` and `npm --prefix gui run build`.
Then run `cd electron`, `npm install`, and `npm start` for desktop development.
Run `npm run dist` in `electron/` to create unsigned Windows NSIS and portable builds.
Artifacts are written to `electron/dist-app/`.
Unsigned builds can trigger Windows SmartScreen warnings; code signing is intentionally deferred.
