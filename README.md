# OmniSwitch for Obsidian

OmniSwitch replaces the sample-plugin boilerplate with a fast vault-wide switcher that keeps your keyboard at the centre of everything. From a single command (`Cmd/Ctrl + K`) you can:

- Jump to notes, headings, attachments, and commands with fuzzy search.
- Limit results on the fly with lightweight prefixes (`>`, `#`, `!`).
- Open existing tabs instead of duplicating them, or spawn new panes with `Cmd/Ctrl + Enter`.
- Log the currently open editor leaves to the console for debugging complex layouts.

The plugin automatically ignores Obsidian accessory panes (outline, backlinks, etc.) so focusing an already open note always returns to the correct editor.

## Search Modes & Prefixes

Open the switcher with **Cmd/Ctrl + K** *(command id: `omniswitch-open`)* and use the following prefixes. All prefixes require a trailing space before they activate.

| Prefix | Mode | Result |
| --- | --- | --- |
| *(none)* | Notes | Markdown notes and recents. |
| `# ` | Headings | Headings from Markdown notes. |
| `> ` | Commands | Vault commands (same list as Command Palette). |
| `! ` | Attachments | All non-note attachments. |
| `!image ` | Attachments | Image files (`avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp`). |
| `!audio ` | Attachments | Audio files (`flac`, `m4a`, `mp3`, `ogg`, `wav`, `webm`, `3gp`). |
| `!video ` | Attachments | Video files (`mkv`, `mov`, `mp4`, `ogv`, `webm`). |
| `!obsidian ` | Attachments | Obsidian native formats (`base`, `canvas`). |
| `!<ext> ` | Attachments | A specific extension (e.g. `!pdf `, `!md `, `!c `). |

### Navigation
- **Enter** – Open the selected entry (reuses existing tabs when available).
- **Cmd/Ctrl + Enter** – Open in a new pane.
- **Ctrl + J / Ctrl + K** – Move selection down/up.
- **Backspace** – Leave the current mode when the search box is empty.

## Registered Commands

| Command | Description |
| --- | --- |
| `Search vault and commands` | Opens OmniSwitch (Cmd/Ctrl + K). |
| `Search vault notes` | Directly opens note mode. |
| `Search vault headings` | Opens heading mode. |
| `Search vault commands` | Opens command mode. |
| `Search vault attachments` | Opens attachment mode. |
| `Omni Switch: Log open tabs` | Logs all open editor leaves to the developer console with their view type and location. |

## Project Structure

```
├─ docs/                 # Additional documentation (moved from root)
├─ scripts/              # Repository scripts (version bump)
├─ src/
│  ├─ omni-switch-modal.ts   # Core modal & UI logic
│  ├─ search-index.ts        # Vault indexing and cache refresh
│  ├─ search-utils.ts        # Shared prefix/category helpers
│  ├─ settings*.ts           # Settings types and tab
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

### Available scripts
| Command | Description |
| --- | --- |
| `npm run dev` | Run esbuild in watch mode. |
| `npm run build` | Type-check + production bundle (outputs `main.js`). |
| `npm run test` | Execute unit tests with Vitest. |
| `npm run version` | Bump plugin + manifest versions (uses `scripts/version-bump.mjs`). |

Place the repository inside your vault under `.obsidian/plugins/omniswitch` for live testing. After `npm run build`, enable the plugin in **Settings → Community Plugins**.

## Release Checklist
1. Update `manifest.json` and `versions.json` with the new version.
2. Run `npm run build` to generate `main.js`.
3. Create a GitHub release containing `manifest.json`, `main.js`, and `styles.css`.
4. (Optional) Submit updates to the community plugin registry.

## License

MIT © OmniSwitch contributors.
