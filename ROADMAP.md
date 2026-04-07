# pi-ghostty-theme-sync — Roadmap

Fork of `@ogulcancelik/pi-ghostty-theme-sync`.

## Current state (v0.1.0, upstream)

On `session_start`, reads cmux's active config via `ghostty +show-config`, parses bg/fg + 16-color ANSI palette, generates a pi theme JSON, writes it to `~/.pi/agent/themes/ghostty-sync-{hash}.json`, and calls `ctx.ui.setTheme()`. One-directional: cmux → pi. No runtime interaction after startup.

## Architecture notes

### Theme change flow (cmux → pi)

```
ghostty +show-config  →  parse colors  →  generate pi theme JSON
                                          →  write ~/.pi/agent/themes/ghostty-sync-{name}.json
                                          →  ctx.ui.setTheme(name)
```

### Theme change flow (pi → cmux, planned — Phase 2)

```
user picks theme in /ghostty TUI  →  cmux themes set "{name}"
                                  →  read theme file from disk (475 bytes)
                                  →  generate pi theme in-memory
                                  →  ctx.ui.setTheme(themeObj) (instant pi repaint)
```

### Key APIs

| API | What it does |
|---|---|
| `cmux themes set "Name"` | Changes theme live (~20ms, auto-reloads) |
| `cmux themes list` | Lists all available themes, marks current light/dark |
| `cmux reload-config` | Reloads config from disk (not needed for theme switch) |
| `ctx.ui.setTheme(name \| Theme)` | Sets pi theme instantly (full TUI repaint) |
| `ctx.ui.getAllThemes()` | Lists available pi themes with paths |
| `ctx.ui.select(title, options)` | Simple picker dialog |
| `ctx.ui.custom(factory, { overlay })` | Full custom overlay component with keyboard focus |
| `pi.registerCommand(name, opts)` | Registers a `/slash` command |

**Critical:** The mitchellh ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config`) must NEVER contain hardcoded `background`, `foreground`, `cursor-color`, `cursor-text`, `selection-background`, or `selection-foreground` values. These override the theme's colors and break `cmux themes set`.

---

## Phase 1 — quality fixes (no new features)

### 1.1 Readable theme names

**Problem:** Generated theme files use opaque hashes — `ghostty-sync-18052515` — making it impossible to tell what theme is active.

**Fix:** Parse `cmux themes list` output to get the current theme name. Use it slugified: `ghostty-sync-twilight`. Fall back to hash only when the theme name can't be determined.

**Changes:**
- Add `themeName: string | null` to `GhosttyColors` interface
- Get current theme name from `cmux themes list` (parse "Current dark: ..." line)
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

### Theme data source

cmux ships ~463 theme files at:
```
/Applications/cmux.app/Contents/Resources/ghostty/themes/
```

Each file is exactly 475 bytes — 16 palette entries + bg/fg/cursor/selection. Simple `key = value` format, trivially parseable. No subprocess needed to read them.

This extension targets cmux only. No standalone Ghostty fallback.

### Loading strategy: lazy with in-memory cache

**Decision:** Do NOT pre-bundle converted themes or generate all at startup.

- **At startup:** scan the themes directory for file names only → build `string[]` of theme names. Cost: one `readdirSync`, sub-millisecond.
- **On picker open:** theme list is already available, render immediately.
- **On cursor highlight:** read the 475-byte theme file, parse 22 lines of `key = value`, run `generatePiTheme()` (pure hex math). Cache the result in a `Map<string, Theme>`. Total cost per uncached theme: <1ms.
- **Subsequent visits to same theme:** cache hit, zero computation.

Why not pre-bundle:
- 463 files get stale when Ghostty/cmux updates its theme library
- Adds a build step and package bloat for zero perceptible benefit
- The theme files are already on disk and trivially fast to parse

### Preview pipeline (latest-wins, non-blocking)

The preview must update both cmux (terminal) and pi (TUI) simultaneously as the user navigates. The UI must never block or stutter, even during fast scrolling.

**Pattern: latest-wins single slot with generation counter.** No queue (FIFO or LIFO). Each cursor move overwrites the pending preview. Only the most recent theme ever gets processed.

```
cursor move → increment generation, reset debounce timer
             └─ after 80ms idle:
                  1. generate pi theme (sync, <1ms, cached)
                  2. ctx.ui.setTheme(piTheme)           — sync, instant repaint
                  3. execAsync("cmux themes set ...")    — fire-and-forget, no await
```

**Why this can't slow down or stutter:**

- **No queue, no backlog.** Debounce cancels all previous pending calls. Fast-scrolling through 50 themes produces exactly 1 preview — the last one.
- **Pi repaint is synchronous.** `ctx.ui.setTheme()` repaints the TUI in the same tick. The user sees the update before any async work starts.
- **cmux call is fire-and-forget.** We never `await` it. If the user moves again before cmux finishes, the old call completes harmlessly and the next one overwrites it.
- **Theme generation is cached.** First access: async read of 475-byte file + hex math = <1ms. Subsequent: `Map.get()` = instant.

```typescript
import { debounce } from "perfect-debounce";
import pMemoize from "p-memoize";

const getTheme = pMemoize((name: string) => loadThemeFromDisk(name));

const previewTheme = debounce(async (name: string) => {
  ctx.ui.setTheme(await getTheme(name));
  exec(`cmux themes set "${name}"`).catch(noop);  // ~20ms, auto-reloads
}, 80);

// in the picker component:
selectList.onHighlight = (name) => { previewTheme(name); };
```

### Flow

1. User types `/ghostty` (or `/ghostty themes`)
2. Extension opens a picker overlay (`ctx.ui.custom` with `SelectList`)
3. Theme list populated from cached directory scan
4. As user navigates (arrow keys):
   a. Debounce fires after 80ms pause
   b. Read theme file from disk (475 bytes, cached after first read)
   c. Generate pi theme object via `generatePiTheme()` (cached after first gen)
   d. `ctx.ui.setTheme(themeObj)` — pi repaints instantly (sync)
   e. `execAsync("cmux themes set ...")` — Ghostty repaints (async, non-blocking)
5. On confirm (enter):
   - Write final theme JSON to `~/.pi/agent/themes/ghostty-sync-{slug}.json`
   - Persist the choice in pi settings
6. On cancel (escape):
   - Revert pi theme to the one captured before picker opened
   - Revert Ghostty via `cmux themes set "{original}"`

### Component architecture

```
/ghostty command handler
  └─ ctx.ui.custom(factory, { overlay: true })
       └─ ThemePicker component
            ├─ SelectList — scrollable, filterable theme list
            ├─ DynamicBorder + header/footer chrome
            ├─ onHighlight(themeName) callback
            │    └─ debounced previewTheme(themeName)
            │         ├─ getOrGeneratePiTheme(themeName)  ← lazy cache
            │         ├─ ctx.ui.setTheme(theme)           ← sync
            │         └─ execAsync("cmux themes set")     ← async
            ├─ onSelect(themeName) → persist + done
            └─ onCancel() → revert + done
```

### SelectList highlight tracking

`pi-themes` uses `SelectList` from `@mariozechner/pi-tui`. Need to verify if it exposes an `onHighlight` callback or equivalent for cursor-move events (not just `onSelect`/`onCancel`). If not, options:
- Wrap `handleInput` to detect cursor position changes after each input
- Build a custom list component
- Contribute `onHighlight` upstream to `pi-tui`

### Stretch: search and categories

- Fuzzy search filter in the picker (SelectList may already support this)
- Light/dark grouping (detect by bg luminance from cached theme data)
- Recently used themes at the top
- Show a color swatch preview next to each theme name (bg/fg/accent dots)

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
