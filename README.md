# Shakeview

[![codecov](https://codecov.io/gh/manuroe/shakeview/graph/badge.svg)](https://codecov.io/gh/manuroe/shakeview)

A web viewer for **rageshake logs** produced by the [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk) and Element X apps ([Android](https://github.com/element-hq/element-x-android), [iOS](https://github.com/element-hq/element-x-ios)). **All processing runs locally in your browser** — no data is sent anywhere.

Live at **https://manuroe.github.io/shakeview/**

![Summary view](public/demo/screenshot-summary-light.png#gh-light-mode-only)
![Summary view](public/demo/screenshot-summary-dark.png#gh-dark-mode-only)

![Logs view](public/demo/screenshot-logs-light.png#gh-light-mode-only)
![Logs view](public/demo/screenshot-logs-dark.png#gh-dark-mode-only)

![Logs by span](public/demo/screenshot-spans-light.png#gh-light-mode-only)
![Logs by span](public/demo/screenshot-spans-dark.png#gh-dark-mode-only)

![Sync waterfall](public/demo/screenshot-sync-light.png#gh-light-mode-only)
![Sync waterfall](public/demo/screenshot-sync-dark.png#gh-dark-mode-only)

## Demo mode

Click **"Try with demo logs: Mobile · Web"** on the landing page to explore the app with an Element X or Element Web log, without a real log file.

Element X and Element Web logs are both supported, with some differences: see [LOG_FORMATS.md](LOG_FORMATS.md).

## Run locally

```bash
npm install
npm start
```

Open http://localhost:5173

## Rageshake CLI

`cli/rageshake.ts` provides compact, LLM-friendly views over rageshake archives
(summary, module overview, span tree, lifecycle timeline, filtered slices) — every
command emits bounded output sized for an agent's context window.

```bash
npm run rageshake -- <command> <path> [options]   # dev, runs via tsx
```

For consumers (agents, scripts), build the standalone bundle once and run it with
plain node — it is the package's `bin`:

```bash
npm run build:cli
node dist-cli/rageshake.mjs <command> <path> [options]
```

Run with no arguments for the full command reference.

### Opening a log line by URL

`rageshake serve [dir]` serves the built viewer and a directory of rageshakes on one origin
(`http://127.0.0.1:7357` by default), so an archive can be opened by link instead of by
dropping it in — and a specific line pointed at:

```bash
rageshake serve ~/Downloads
# http://127.0.0.1:7357/#/logs?archive=/rageshake.tar.gz&file=console.2026-07-21-14.log.gz&line=1234
```

`line=` is the number the CLI prints in each line's `[<line>|f<tag>]` prefix, and `file=` is
the log that `f<tag>` stands for in the `# files:` legend above the output — so a line you
found in the terminal is one click from its context in the viewer. Naming the file keeps it
quick: one log parses in ~0.3s, where merging all 56 logs of a real archive takes ~2.4s. Drop
`file=` to open the whole archive merged instead; `line=A-B` highlights a range. The server is
read-only, bound to localhost, and safe to start twice (the second run reuses the first).

## Browser extension

The extension enhances listing pages of any [rageshake](https://github.com/matrix-org/rageshake) server deployment by redirecting `/api/listing/*` pages into the bundled viewer and rendering them with the same archive-style screen used by the web app. It auto-detects rageshake archive pages using the standard `/api/listing/*` path — no configuration needed.

<table>
	<tr>
		<td align="center"><strong>Without extension</strong></td>
		<td align="center"><strong>With extension</strong></td>
	</tr>
	<tr>
		<td>
			<img src="public/demo/screenshot-extension-before-light.png#gh-light-mode-only" alt="Rageshake listing page without extension" />
			<img src="public/demo/screenshot-extension-before-dark.png#gh-dark-mode-only" alt="Rageshake listing page without extension" />
		</td>
		<td>
			<img src="public/demo/screenshot-extension-light.png#gh-light-mode-only" alt="Rageshake listing page enhanced by extension" />
			<img src="public/demo/screenshot-extension-dark.png#gh-dark-mode-only" alt="Rageshake listing page enhanced by extension" />
		</td>
	</tr>
</table>

> **Note:** The extension is not yet published on the Chrome Web Store or Firefox Add-ons. It must be installed manually as an unpacked/temporary extension.

### Install

**Chrome / Edge**

```bash
npm run build:extension
```

Output is written to `extension-dist/`.

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the `extension-dist/` folder.

To pick up changes: run `npm run build:extension`, then click the ↺ refresh icon on the extension card.

**Firefox — temporary (session only)**

`extension-dist/` uses a Chrome-format manifest that Firefox does not support. Build the Firefox-specific bundle first:

```bash
npm run build:extension:firefox
```

Then:

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension-dist-firefox/manifest.json`.

To pick up changes: re-run `npm run build:extension:firefox`, click **Reload** next to the extension, then reload the rageshakes tab (Cmd+R).

The extension is removed when Firefox closes.

**Firefox — persistent (via web-ext)**

```bash
npm run webext:run
```

This builds the Firefox bundle and launches a dedicated Firefox profile with the extension pre-loaded. Preferred for active development.

### Usage

Navigate to any rageshake listing URL (e.g. `https://<your-rageshake-server>/api/listing/<id>/`). The content script runs automatically and opens the bundled archive-style viewer for that listing, including per-file summaries, `details.json` metadata, and screenshot thumbnails when present.

## Contributing

See [AGENTS.MD](AGENTS.MD) for architecture notes and agent/contributor guidance.
