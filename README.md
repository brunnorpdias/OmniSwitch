# OmniSwitch for Obsidian

OmniSwitch replaces the sample-plugin boilerplate with a fast vault-wide switcher that keeps your keyboard at the centre of everything. From a single command (`Cmd/Ctrl + K`) you can:

- Jump to notes, headings, attachments, commands, and folders with fuzzy search.
- Limit results on the fly with lightweight prefixes (`/`, `>`, `#`, `.`).
- Open existing tabs instead of duplicating them, or spawn new panes with `Cmd/Ctrl + Enter`.
- Browse folders inline with `/ `: drill into directories, open their files, and step back with `Backspace`.
- Follow the active mode from the pill label beside the input (Notes, Commands, Attachments, Folders, Headings).
- Search 2M+ headings in <30ms with optimized dual-engine architecture.

The plugin automatically ignores Obsidian accessory panes (outline, backlinks, etc.) so focusing an already open note always returns to the correct editor.

## Search Modes & Prefixes

Open the switcher with **Cmd/Ctrl + K** *(command id: `omniswitch-open`)* and use the following prefixes. All prefixes require a trailing space before they activate.

| Prefix | Mode | Result |
| --- | --- | --- |
| *(none)* | Notes | Markdown notes and recents. |
| `# ` | Headings | Headings from Markdown notes. |
| `> ` | Commands | Vault commands (same list as Command Palette). |
| `/ ` | Folders | Vault folders; press Enter to drill into the selected directory. |
| `.` | Attachments | All non-note attachments. |
| `.image ` | Attachments | Image files (`avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp`). |
| `.audio ` | Attachments | Audio files (`flac`, `m4a`, `mp3`, `ogg`, `wav`, `webm`, `3gp`). |
| `.video ` | Attachments | Video files (`mkv`, `mov`, `mp4`, `ogv`, `webm`). |
| `.obsidian ` | Attachments | Obsidian native formats (`canvas`). |
| `.<ext> ` | Attachments | A specific extension (e.g., `.pdf `, `.docx `, `.c `). |

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
| `Search vault headings` | Opens heading mode. |
| `Search vault commands` | Opens command mode. |
| `Search vault attachments` | Opens attachment mode. |
| `Omni Switch: Log open tabs` | Logs all open editor leaves to the developer console with their view type and location. |

## Architecture

### Overview

OmniSwitch uses a sophisticated dual-engine architecture optimized for different search types, with aggressive memory optimization through numeric ID mapping.

```
┌─────────────────────────────────────────────────────────────┐
│                      OmniSwitch Modal                        │
│                    (User Interface)                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Search Coordinator                         │
│  • Mode detection & routing                                  │
│  • Engine selection (Hybrid/Fuse/Mini)                       │
│  • Result mapping & caching                                  │
│  • Numeric ID ↔ Path resolution                             │
└─────┬──────────────────────┬─────────────────────┬──────────┘
      │                      │                     │
      ▼                      ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Fuse Engine  │    │ Mini Engine  │    │ IndexManager │
│ (Files)      │    │ (Headings)   │    │ (Vault Sync) │
└──────────────┘    └──────────────┘    └──────────────┘
      │                      │                     │
      └──────────────────────┴─────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      IndexStore                              │
│  • Persists indexes to disk (5 files, v6)                   │
│  • Numeric ID maps (2.28M headings → 83MB)                  │
│  • Direct JSON loading for Mini headings                    │
└─────────────────────────────────────────────────────────────┘
```

### Dual-Engine System

**Hybrid Mode (Default & Recommended)**:
- **Fuse.js** for files/folders/commands: Excellent fuzzy matching, handles typos well
- **MiniSearch** for headings: 15-25x faster for text-heavy searches (inverted index + BM25)

**Why Hybrid?**
- File searches benefit from Fuse's typo tolerance and fuzzy matching
- Heading searches require speed at scale (2M+ headings)
- MiniSearch uses inverted indexes optimized for text (heading titles average 20-50 chars)
- Fuse uses Bitap algorithm better suited for short exact matches (file names)

### Numeric ID Optimization

**Problem**: 2.28M headings with full path IDs = 284MB+ index files

**Solution**: Numeric ID mapping
```typescript
// Instead of storing full paths in engine indexes:
// "folder/subfolder/note.md::0" (30+ chars)

// Store numeric IDs:
// "12345" (5 chars)

// Mapping stored separately:
headingIdMap: Map<"12345", "folder/subfolder/note.md::0">
```

**Results**:
- **85% file size reduction**: 582MB → 75-100MB total
- **Faster loading**: No doc array parsing needed
- **Memory efficient**: Engines only store numeric references
- **Fast resolution**: O(1) Map lookups for path resolution

### Index Persistence (5 Files, v6)

```
.obsidian/plugins/obsidian-omniswitch-plugin/indexes/
├── id-maps.json             (~83MB)  - Numeric ID mappings (separate file)
├── fuse-files.json          (~449KB) - Fuse file index (with version wrapper)
├── fuse-headings.json       (~139MB) - Fuse heading index (with version wrapper)
├── mini-files.json          (~592KB) - Mini file index (with version wrapper)
└── mini-headings-v6.json    (~153MB) - Mini heading index (RAW JSON, no wrapper)
```

**Format (v6)**:

*id-maps.json* (separate file for faster loading):
```json
{
  "version": 6,
  "fileIdMap": [["0", "path1.md"], ["1", "path2.md"]],
  "headingIdMap": [["0", "note.md::0"], ["1", "note.md::1"]],
  "nextFileId": 10017,
  "nextHeadingId": 2280080
}
```

*fuse-files.json, fuse-headings.json, mini-files.json* (wrapped format):
```json
{
  "version": 6,
  "index": { /* Fuse/Mini index with numeric IDs */ }
}
```

*mini-headings-v6.json* (RAW MiniSearch JSON, no wrapper):
```json
{ /* Direct MiniSearch index - passed to MiniSearch.loadJSON() */ }
```

**v6 Optimizations**:
- **Separate ID maps file**: Faster parallel loading, version checks independent
- **Direct JSON loading for Mini headings**: Eliminates parse → stringify → parse cycle (~3280ms savings)
- **Versioned filename**: `mini-headings-v6.json` allows multiple versions coexistence
- **No doc arrays saved**: Reduces file size by 80-85% (introduced in v4)

### Search Flow

1. **User types query** → Modal detects mode (prefix or current mode)
2. **Coordinator routes** → Selects engine (Fuse/Mini based on mode)
3. **Engine searches** → Returns `EngineResult[]` with numeric IDs
4. **Result mapping** → Resolves numeric IDs to full paths using ID maps
5. **Lazy resolution** → Converts paths to TFile/HeadingCache (only top 20 results)
6. **Display** → Modal shows filtered, sorted results

**Performance**:
- Engine search: 7-30ms (2M headings)
- ID resolution: 0.1ms (20 results × 0.005ms each)
- Total: <50ms for most queries

### Incremental Updates

The IndexManager monitors vault changes and updates engines incrementally:

```typescript
// File modified
→ Extract headings
→ Convert to numeric IDs (reuse existing or create new)
→ Remove old heading docs from engines
→ Add new heading docs to engines
→ Update currentHeadingDocs cache
```

**No full rebuild needed** for incremental changes, keeping the vault responsive.

## Project Structure

```
├─ docs/                 # Additional documentation
├─ scripts/              # Repository scripts (version bump)
├─ src/
│  ├─ search/
│  │  ├─ engines/
│  │  │  ├─ fuse-engine.ts      # Fuse.js wrapper
│  │  │  ├─ mini-engine.ts      # MiniSearch wrapper
│  │  │  └─ types.ts            # Engine result types
│  │  ├─ coordinator.ts         # Search routing & ID mapping
│  │  ├─ corpus.ts              # Document extraction from vault
│  │  ├─ index-manager.ts       # Vault change monitoring
│  │  ├─ index-store.ts         # Index persistence (4 files)
│  │  ├─ model.ts               # Core search types
│  │  ├─ status.ts              # Status announcements
│  │  ├─ types.ts               # Search item definitions
│  │  ├─ utils.ts               # Prefix detection & helpers
│  │  └─ text-normalize.ts      # Text processing utilities
│  ├─ settings/
│  │  ├─ index.ts               # Settings schema and migration
│  │  └─ tab.ts                 # Settings tab UI
│  ├─ omni-switch-modal.ts      # Core modal & UI logic
│  ├─ obsidian-helpers.ts       # Command palette utilities
│  └─ ...
├─ tests/                       # Vitest suites for helpers
├─ main.ts                      # Obsidian entrypoint
├─ styles.css                   # Modal visuals
├─ manifest.json                # Obsidian metadata
├─ README.md                    # This file
└─ AGENTS.md                    # Agent instructions for Claude Code
```

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Index build (10k files) | 30ms | Fuse + Mini |
| Index build (2.28M headings) | 12s | Mini async build |
| Search (2M headings) | 7-50ms | MiniSearch with adaptive fuzzy |
| Search (10k files) | 5-15ms | Fuse.js |
| Startup (cold, no cache) | 15-20s | Full vault scan + index build |
| Startup (warm, cached v6) | 7-7.5s | Direct JSON loading (2.28M headings) |
| Index files total (v6) | ~376MB | 5 files (v6 format) |
| Memory usage | ~150-200MB | Engines + ID maps + caches |

**v6 Performance Improvements**:
- **Direct JSON loading**: 3280ms faster than v5 (eliminated intermediate parse)
- **Hybrid mode optimizations**: Skips building unused heading structures at startup
- **Parallel loading**: ID maps + indexes loaded concurrently

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

Place the repository inside your vault under `.obsidian/plugins/obsidian-omniswitch-plugin` for live testing. After `npm run build`, enable the plugin in **Settings → Community Plugins**.

## Release Checklist
1. Update `manifest.json` and `versions.json` with the new version.
2. Run `npm run build` to generate `main.js`.
3. Create a GitHub release containing `manifest.json`, `main.js`, and `styles.css`.
4. (Optional) Submit updates to the community plugin registry.

## License

MIT © OmniSwitch contributors.
