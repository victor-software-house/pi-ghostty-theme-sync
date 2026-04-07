# pi-ghostty-theme-sync — Roadmap

Fork of `@ogulcancelik/pi-ghostty-theme-sync`.

## Current state (v0.1.0, upstream)

On `session_start`, reads Ghostty's active config via `ghostty +show-config`, parses bg/fg + 16-color ANSI palette, generates a pi theme JSON, writes it to `~/.pi/agent/themes/ghostty-sync-{hash}.json`, and calls `ctx.ui.setTheme()`. One-directional: Ghostty → pi. No runtime interaction after startup.

## Architecture notes

### Theme change flow (Ghostty → pi)

```
ghostty +show-config  →  parse colors  →  generate pi theme JSON
                                          →  write ~/.pi/agent/themes/ghostty-sync-{name}.json
                                          →  ctx.ui.setTheme(name)
```

### Theme change flow (pi → Ghostty, planned)

```
user picks theme in /ghostty TUI  →  cmux themes set "{name}"
                                  →  ghostty +show-config (read new palette)
                                  →  generate pi theme JSON
                                  →  ctx.ui.setTheme(name) (instant pi repaint)
```

### Key APIs

| API | What it does |
|---|---|
| `ghostty +show-config` | Dumps resolved Ghostty config (theme name, bg, fg, palette 0-15) |
| `cmux themes list` | Lists all available Ghostty themes, marks current light/dark |
| `cmux themes set "Name"` | Changes Ghostty theme live with instant preview |
| `cmux reload-config` | Reloads Ghostty config from disk programmatically |
| `ctx.ui.setTheme(name \| Theme)` | Sets pi theme instantly (full TUI repaint) |
| `ctx.ui.getAllThemes()` | Lists available pi themes with paths |
| `ctx.ui.select(title, options)` | Simple picker dialog |
| `ctx.ui.custom(factory, { overlay })` | Full custom overlay component with keyboard focus |
| `pi.registerCommand(name, opts)` | Registers a `/slash` command |

---

## Phase 1 — quality fixes (no new features)

### 1.1 Readable theme names

**Problem:** Generated theme files use opaque hashes — `ghostty-sync-18052515` — making it impossible to tell what theme is active.

**Fix:** Extract the `theme = ...` line from `ghostty +show-config` output. Use the actual theme name slugified: `ghostty-sync-twilight`. Fall back to hash only when no named theme is found (raw custom colors).

**Changes:**
- Add `themeName: string | null` to `GhosttyColors` interface
- Parse `theme = ...` in `parseGhosttyConfig()`
- Slugify: lowercase, replace spaces with dashes, strip non-alphanumeric
- File name: `ghostty-sync-{slug}.json` (or `ghostty-sync-{hash}.json` fallback)
- Keep hash internally for change detection (avoid regenerating when colors haven't changed)

### 1.2 Fix semantic color mapping

**Problem:** Current mapping blindly trusts ANSI slots. Twilight's slot 4 (blue) is `#44474a` (near-black), used as `link` and `border` — both become invisible. Errors should look red-ish, warnings yellow-ish, success green-ish regardless of how weird the palette is.

**Fix:** Validate ANSI slots against expected semantic hue. If a slot drifts too far from its canonical hue, blend it toward the expected color.

**Hue validation approach:**
- Convert slot color to HSL
- Check if hue is within ~60 degrees of expected range:
  - error (slot 1): red hue ~0/360 degrees
  - success (slot 2): green hue ~120 degrees
  - warning (slot 3): yellow/amber hue ~45 degrees
  - link (slot 4): blue hue ~220 degrees
- If out of range OR contrast against bg is too low (< 3:1), blend 50/50 with canonical fallback
- Canonical fallbacks: error `#cc6666`, success `#98c379`, warning `#e5c07b`, link `#61afef`

**Border fix:** Stop using `link` for `border`. Derive border from `mixColors(fg, bg, 0.3)` — always readable, always fits the theme.

### 1.3 AGENTS.md

Add `AGENTS.md` with extension-specific guidance for future development.

---

## Phase 2 — live theme picker (`/ghostty` command)

The main feature. A `/ghostty` slash command that opens an interactive theme picker with **real-time preview** of both Ghostty and pi simultaneously.

### Flow

1. User types `/ghostty` (or `/ghostty themes`)
2. Extension opens a picker overlay listing all Ghostty themes (via `cmux themes list`)
3. As user navigates the list (arrow keys), each highlighted theme:
   a. Calls `cmux themes set "{name}"` — Ghostty repaints instantly
   b. Reads new palette via `ghostty +show-config`
   c. Generates pi theme in-memory
   d. Calls `ctx.ui.setTheme(themeObj)` — pi repaints instantly
4. On confirm (enter): persist the choice, write theme JSON file, done
5. On cancel (escape): revert to previous theme (both Ghostty and pi)

### Implementation

- `pi.registerCommand("ghostty", { ... })` — entry point
- Use `ctx.ui.custom(factory, { overlay: true })` for the picker component
- The picker component:
  - Fetches theme list once via `cmux themes list`
  - Renders a scrollable list with search/filter
  - On cursor move: triggers the preview pipeline (cmux set → ghostty read → pi set)
  - Tracks original theme for revert on cancel
- Preview pipeline must be fast — debounce cursor moves (~100ms) to avoid thrashing

### Performance concern

The preview pipeline involves 2 subprocess calls per theme change:
1. `cmux themes set` (fast — IPC over unix socket)
2. `ghostty +show-config` (slower — spawns process, reads all config)

If `ghostty +show-config` is too slow for real-time preview, consider:
- Pre-reading all theme palettes at startup into a cache
- Or: `ghostty +list-themes` + reading theme files directly from Ghostty's resources dir at `/Applications/Ghostty.app/Contents/Resources/ghostty/themes/` (or cmux equivalent)
- Theme files are simple `key = value` format, trivially parseable

### Stretch: search and categories

- Fuzzy search filter in the picker
- Light/dark grouping (detect by bg luminance)
- Recently used themes at the top

---

## Phase 3 — tracked Ghostty config management

### 3.1 `config-file` include wiring

**Problem:** The main Ghostty config at `~/Library/Application Support/com.mitchellh.ghostty/config` gets clobbered by cmux/Ghostty whenever the theme changes. Stable settings (fonts, padding, opacity, clipboard, etc.) get mixed in with theme-volatile settings.

**Fix:** The extension manages the main config file. On startup (or on theme change), it writes:

```
theme = {current theme}
config-file = ~/.pi/agent/ghostty/config-base
```

The `config-base` file is git-tracked in `~/.pi/agent/ghostty/` and contains all stable settings. The extension owns the thin main config; the user owns `config-base`.

### 3.2 `/ghostty config` subcommand

Open `config-base` in `$EDITOR` for editing, then trigger `cmux reload-config` on save.

---

## Phase 4 — extended TUI (future)

Full Ghostty configuration management through a custom pi TUI:

- `/ghostty fonts` — font picker with live preview
- `/ghostty opacity` — slider for background-opacity with live preview
- `/ghostty padding` — adjust window padding with live preview
- Settings persistence: changes written to `config-base` and committed

This is the "custom TUI" idea — deferred until the theme picker proves the pattern works.

---

## Implementation order

1. **Phase 1.1** — readable names (small, high-value)
2. **Phase 1.2** — color fix (small, correctness)
3. **Phase 1.3** — AGENTS.md
4. **Phase 2** — live theme picker (main feature)
5. **Phase 3.1** — config-file wiring (depends on Phase 2 for theme write)
6. **Phase 3.2** — config editing
7. **Phase 4** — extended TUI (future scope)
