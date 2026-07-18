# Deploy the results viewer demo

The demo is a fully static, read-only results viewer.
It has no backend and needs no API key.
The committed demo runs are baked into the bundle during the build.

## Build the bundle

From the repository root, install dependencies if needed:

```powershell
npm ci
Set-Location gui
npm ci
Set-Location ..
```

Then create the deployable `demo-dist/` folder:

```powershell
npm run demo:bundle
```

## Option A: Cloudflare dashboard

1. Sign in to the Cloudflare dashboard.
2. Open **Workers & Pages** and choose **Create application**.
3. Choose **Pages**, then the direct upload or drag-and-drop option.
4. Name the project `mcp-tournament`.
5. Upload the generated `demo-dist/` folder.
6. Deploy it and open the URL Cloudflare provides.

No command-line tool is needed for this path.

## Option B: Wrangler CLI

From the repository root, run:

```powershell
npx wrangler pages deploy demo-dist --project-name mcp-tournament
```

Follow Wrangler's sign-in prompt if this is your first deployment.
Open the URL shown after the upload finishes.

## After deployment

Confirm the viewer loads and that its demo runs open correctly.
Then replace the live-demo link in `README.md` with the new Cloudflare Pages URL.
