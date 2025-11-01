# OmniSwitch for Obsidian

OmniSwitch is a fast vault‑wide switcher that keeps your keyboard at the center of everything. From a single command (`Cmd/Ctrl + K`) you can:

- Jump to notes, attachments, commands, and folders with fuzzy search.
- Limit results on the fly with lightweight prefixes (`/`, `>`, `.`, `#`).
- Open existing tabs instead of duplicating them, or spawn new panes with `Cmd/Ctrl + Enter`.
- Browse folders inline with `/ `: drill into directories, open their files, and step back with `Backspace`.
- Search headings inside notes using the `# ` prefix (desktop builds stream them into Meilisearch for instant retrieval).
- Follow the active mode from the pill label beside the input (Notes, Commands, Attachments, Folders).
- Log the currently open editor leaves to the console for debugging complex layouts.

The plugin automatically ignores Obsidian accessory panes (outline, backlinks, etc.) so focusing an already open note always returns to the correct editor.

## Search Modes & Prefixes

Open the switcher with **Cmd/Ctrl + K** *(command id: `omniswitch-open`)* and use the following prefixes. All prefixes require a trailing space before they activate.

| Prefix | Mode | Result |
| --- | --- | --- |
| *(none)* | Notes | Markdown notes and recents. |
 
| `> ` | Commands | Vault commands (same list as Command Palette). |
| `/ ` | Folders | Vault folders; press Enter to drill into the selected directory. |
| `# ` | Headings | Headings inside markdown notes (desktop only). |
| `. ` | Attachments | All non‑note attachments. |
| `.image ` | Attachments | Image files (`avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp`). |
| `.audio ` | Attachments | Audio files (`flac`, `m4a`, `mp3`, `ogg`, `wav`, `webm`, `3gp`). |
| `.video ` | Attachments | Video files (`mkv`, `mov`, `mp4`, `ogv`, `webm`). |
| `.obsidian ` | Attachments | Obsidian native formats (`base`, `canvas`). |
| `.<ext> ` | Attachments | A specific extension (e.g. `.pdf `, `.csv `). |

### Navigation
- **Enter** – Open the selected entry (reuses existing tabs when available).
- **Cmd/Ctrl + Enter** – Open in a new pane.
- **Ctrl + J / Ctrl + K** – Move selection down/up.
- **Backspace** – Leave the current mode when the search box is empty. In folder mode it moves up one directory level before returning to Notes.

## Registered Commands

| Command | Description |
| --- | --- |
| `Search vault and commands` | Opens OmniSwitch (Cmd/Ctrl + K). |
| `Search vault notes` | Directly opens note mode. |
 
| `Search vault commands` | Opens command mode. |
| `Search vault attachments` | Opens attachment mode. |
| `Omni Switch: Log open tabs` | Logs all open editor leaves to the developer console with their view type and location. |

## How Search Works (Engine)

OmniSwitch uses Fuse.js for text relevance and then applies a small, transparent refinement to break ties using frequency (times opened) and recency (last modified), without ever letting personalization overpower clearly better text matches.

Pipeline (for Notes and Attachments)
- Text ranking: Fuse computes `textScore = 1 − fuseScore` and sorts results in descending order.
- Bands: We group candidates by a two‑decimal floor of `textScore` (e.g., 0.9966 → band 0.99). Bands are sorted by band key; no cross‑band reordering.
- In‑band refinement (unitless): Inside each band, for the items that already share the same text band:
  - `freqPct` = percentile of open counts within the band (0..1, least→most opened).
  - `recPct` = percentile of modification time within the band (0..1, oldest→newest).
  - `p = wFreq * freqPct + (1 − wFreq) * recPct` where `wFreq` is your “Tie break” slider.
  - `t = (textScore − bandFloor)/0.01` gives position within the band (0..1).
  - In‑band score: `Sband = 0.8 * t + 0.2 * p`. We sort the band by `Sband` desc and then concatenate bands.
- Threshold + cap: After band sorting, we keep only items whose `textScore ≥ topScore * (1 − TopResults%/100)` and then take the first 20.

Notes
- Empty query (Notes) shows “Recents” and does not apply this engine pipeline.
- Folders and Commands have their own flows and don’t use the engine refinement.

Indexing
- Single pass vault scan: files (`TFile`) and folders (`TFolder` tree). Headings are collected on desktop builds using a local SQLite cache; the index is refreshed in the background and only reprocesses notes whose `mtime` has changed.
- Excluded paths are honored everywhere (engine and recents).
- Frequency is persisted as a simple open counter (path → count) using `workspace.on('file-open')` with debounced saves.

Headings (desktop)
- The first launch builds a SQLite index (`cache/headings.db`) beside the plugin.
- Subsequent launches diff the vault against the database and only reindex changed/renamed notes.
- Non-markdown files (attachments, media, canvas, etc.) are ignored by the heading indexer.
- Debug mode logs refresh summaries (`reindex`, `removed`, timings) so you can monitor long-running updates.

## Architecture Overview

- **Lifecycle:** OmniSwitch waits for Obsidian's layout to finish before wiring up vault listeners or running the heading indexer. This prevents background work from blocking vault startup.
- **Search engines:** Notes and attachments use Fuse.js with tie-breaking on open frequency and modification time; full-text note bodies and headings are indexed into Meilisearch so lookups stay fast even on large vaults.
- **Incremental indexing:** The plugin walks the vault once, streams documents to Meilisearch in small batches, and yields to the UI every few dozen files to keep Obsidian responsive. Only files whose `mtime` changed are re-uploaded after the initial build.
- **Event filtering:** Vault events are filtered to markdown notes before touching the Meilisearch queue; attachments and other file types bypass the content index.
- **Modal separation:** `SearchIndex` supplies items for the modal, while the Meilisearch indexer runs in the background; the modal watches completion tokens so headings appear as soon as the backend is ready.
- **Debug visibility:** With the Debug setting enabled the console reports streaming progress and Meilisearch task IDs, making it easy to spot long-running refreshes on huge vaults.
- **Startup safety:** Refreshes begin only after `workspace.onLayoutReady` fires, so the plugin never blocks Obsidian's “Loading vault…” screen. If Meilisearch is offline the plugin falls back to metadata-only search and surfaces a single notice.

## Settings

### Engine
- Top results (%)
  - Controls the score threshold vs the top match. Only items with `Score ≥ topScore * (1 − %/100)` are kept, then a hard 20‑item cap is applied. Default: 20%.
- Tie break
  - Split between Frequency (times opened) and Recency (last modified). Affects in‑band ordering only; text stays primary.

### General
- Excluded paths
  - One per line. Exclusions apply to all modes and to recents.

### Advanced
- Rebuild index
  - Rescan the vault immediately.
- Debug mode
  - Print live engine logs to the console (top 20 rows only; shows name, Score, freq, mtime).

## Project Structure

```
├─ docs/                 # Additional documentation (moved from root)
├─ scripts/              # Repository scripts (version bump)
├─ src/
│  ├─ search/
│  │  ├─ index.ts        # Vault indexing and cache refresh
│  │  ├─ types.ts        # Shared search item definitions
│  │  └─ utils.ts        # Prefix detection & workspace helpers
│  ├─ settings/
│  │  ├─ index.ts        # Settings schema and migration helpers
│  │  └─ tab.ts          # Settings tab UI
│  ├─ omni-switch-modal.ts   # Core modal & UI logic
│  ├─ obsidian-helpers.ts    # Command palette utilities
│  └─ ...
├─ tests/               # Vitest suites for helpers
├─ main.ts              # Obsidian entrypoint
├─ styles.css           # Modal visuals
└─ manifest.json        # Obsidian metadata
```

## Development

### Requirements
- Node.js 18+
- npm (bundled with Node)

### Setup
```bash
npm install
```

### Meilisearch setup (required for headings & full-text)
1. **Install Meilisearch** (v1.4+ recommended). Choose any of the official binaries or package managers.<br>
   - macOS (Homebrew): `brew install meilisearch`<br>
   - Direct download: https://github.com/meilisearch/meilisearch/releases
2. **Launch the server** with a dedicated data directory:
   ```bash
   meilisearch --db-path ~/meili-data --http-addr 127.0.0.1:7700 --master-key "omniswitch"
   ```
   Leave this terminal running while you use OmniSwitch. You can pick any host, port, or key—just mirror it in the plugin settings.
3. **Point OmniSwitch at the server** under *Settings → OmniSwitch → Meilisearch* and press **Apply & Rebuild**. The rebuild runs in the background; headings and note content appear as soon as it completes.
4. **Mobile fallback:** When Meilisearch is unreachable (or disabled) the plugin stays usable with file/command/attachment search only.

> Tip: If Meilisearch refuses to start because of an older data directory, supply a fresh `--db-path` or follow the official migration guide linked in the error message.

### Available scripts
| Command | Description |
| --- | --- |
| `npm run dev` | Run esbuild in watch mode. |
| `npm run build` | Type-check + production bundle (outputs `main.js`). |
| `npm run test` | Execute unit tests with Vitest. |
| `npm run version` | Bump plugin + manifest versions (uses `scripts/version-bump.mjs`). |

> **Note:** OmniSwitch now relies on Meilisearch for full note and heading search. Point the plugin at a running Meilisearch instance (default `http://127.0.0.1:7700`) inside the settings tab; mobile builds fall back to metadata-only search if the service is unavailable.

Place the repository inside your vault under `.obsidian/plugins/omniswitch` for live testing. After `npm run build`, enable the plugin in **Settings → Community Plugins**.

## Release Checklist
1. Update `manifest.json` and `versions.json` with the new version.
2. Run `npm run build` to generate `main.js`.
3. Create a GitHub release containing `manifest.json`, `main.js`, and `styles.css`.
4. (Optional) Submit updates to the community plugin registry.

## License

MIT © OmniSwitch contributors.

## Disclosures

- OmniSwitch’s full experience isn’t plug-and-play—you must run a local (or remote) Meilisearch server. Without it, headings and deep note content are unavailable.
- When Meilisearch is running, indexing streams in the background, yielding real-time, fuzzy, typo-tolerant search over entire notes and their headings.
- The plugin never uploads vault content; the Meilisearch process you run is entirely under your control.
