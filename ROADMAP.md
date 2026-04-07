# pi-ghostty-theme-sync — Roadmap

Fork of `@ogulcancelik/pi-ghostty-theme-sync`.

## Current state (fork, post-Phase 1)

On `session_start`, reads current theme name from `cmux themes list`, reads the theme file directly from `/Applications/cmux.app/Contents/Resources/ghostty/themes/{name}`, generates a pi theme JSON with semantic color validation, writes it to `~/.pi/agent/themes/ghostty-sync-{slug}.json`, and calls `ctx.ui.setTheme(name)`. One-directional: cmux → pi. No runtime interaction after startup.

Phase 1 changes already implemented:
- Readable theme names (`ghostty-sync-twilight` instead of `ghostty-sync-18052515`)
- Semantic color mapping with hue validation and contrast checks
- Border derived from bg/fg mix instead of ANSI slot 4

## Architecture notes

### Config file ownership

Two config files exist:

| file | owner | role |
|---|---|---|
| `~/Library/Application Support/com.cmuxterm.app/config.ghostty` | cmux | Theme authority. `cmux themes set` writes here. |
| `~/Library/Application Support/com.mitchellh.ghostty/config` | user | Base settings (fonts, padding, opacity, etc.). **Must NEVER contain color overrides** — they block theme switching. |

### Theme change flow (cmux → pi, current)

```
cmux themes list → get current theme name
→ read /Applications/cmux.app/.../themes/{name} (475 bytes)
→ generatePiTheme() → write ~/.pi/agent/themes/ghostty-sync-{slug}.json
→ ctx.ui.setTheme("ghostty-sync-{slug}")
```

### Theme change flow (pi → cmux, Phase 2)

```
user picks theme in /ghostty picker
→ write pi theme JSON to ~/.pi/agent/themes/ghostty-sync-preview.json (<1ms)
→ ctx.ui.setTheme("ghostty-sync-preview") (16ms, sync repaint)
→ exec("cmux themes set {name}") (40ms, fire-and-forget)
```

### Key APIs

| API | What it does |
|---|---|
| `cmux themes set "Name"` | Changes cmux/Ghostty theme live (~40ms, auto-reloads). No `reload-config` needed. |
| `cmux themes list` | Lists all available themes, marks current light/dark |
| `ctx.ui.setTheme("name")` | Sets pi theme by name (16ms). **Only accepts string** — Theme objects fail. Must write JSON to disk first. |
| `ctx.ui.custom(factory, { overlay })` | Full custom overlay component with keyboard focus |
| `pi.registerCommand(name, opts)` | Registers a `/slash` command |
| `ThemeSelectorComponent` | Exported from `@mariozechner/pi-coding-agent`. Built-in picker with `onPreview` via `onSelectionChange`. |
| `SelectList.onSelectionChange` | Fires on cursor move (not just select/cancel). Available on the component from `@mariozechner/pi-tui`. |

**Critical:** The mitchellh ghostty config must NEVER contain hardcoded `background`, `foreground`, `cursor-color`, `cursor-text`, `selection-background`, or `selection-foreground` values. These override the theme and break `cmux themes set`.

### Validated benchmarks

`cmux themes set` — 300 iterations across 30 themes, 10 rounds each:

| metric | value |
|---|---|
| min | 37ms |
| avg | 41.9ms |
| p50 | 40ms |
| p95 | 57ms |
| p99 | 73ms |
| max | 77ms |

100% success rate.

### Validated via probe (runtime API)

| finding | detail |
|---|---|
| `ctx.ui.setTheme(Theme)` | ✘ Fails — only accepts string name |
| `ctx.ui.setTheme("name")` | ✔ 16ms — looks up theme JSON from disk, repaints |
| `writeFileSync` theme JSON | ✔ <1ms |
| **pi side total (write + setTheme)** | **~17ms** |
| **full preview (pi 17ms + cmux 40ms)** | **~57ms** |
| `ThemeSelectorComponent` | ✔ Exported. Constructor: `(currentTheme, onSelect, onCancel, onPreview)`. Uses `SelectList` with `onSelectionChange` internally. |
| External deps needed | None — all components available from pi-coding-agent / pi-tui |

---

## Phase 2 — live theme picker (`/ghostty` command)

### Goal

A `/ghostty` slash command that opens an interactive theme picker with real-time preview of both cmux (terminal) and pi (TUI) simultaneously.

### Theme data source

cmux ships ~463 theme files at:
```
/Applications/cmux.app/Contents/Resources/ghostty/themes/
```

Each file is exactly 475 bytes — 16 palette entries + bg/fg/cursor/selection. Simple `key = value` format, trivially parseable.

### Preview file strategy

Since `ctx.ui.setTheme()` only accepts a string name and loads from disk, previews must write to disk first.

- Use a single stable file: `~/.pi/agent/themes/ghostty-sync-preview.json`
- Overwrite it on each preview (writeFileSync, <1ms)
- On confirm: rename/copy to `ghostty-sync-{slug}.json` (the permanent file)
- On cancel: delete the preview file, revert to original theme

### Preview pipeline

```
onSelectionChange(name)
  → debounce 100ms (setTimeout + clearTimeout, latest wins)
  → generate pi theme JSON from cached cmux theme file
  → writeFileSync("~/.pi/agent/themes/ghostty-sync-preview.json", json)  — <1ms
  → ctx.ui.setTheme("ghostty-sync-preview")                              — 16ms, sync
  → exec("cmux themes set {name}")                                       — 40ms, fire-and-forget
```

Total: ~57ms. Debounce at 100ms gives comfortable headroom above p99 (73ms).

**Debounce implementation:** Simple `setTimeout` + `clearTimeout`. No external lib needed.

```typescript
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function previewTheme(name: string, ctx: ExtensionContext) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const colors = getCmuxThemeColors(name);     // readFileSync, 475 bytes
    if (!colors) return;
    const json = generatePiTheme(colors, "ghostty-sync-preview");
    writeFileSync(previewPath, JSON.stringify(json, null, 2));
    ctx.ui.setTheme("ghostty-sync-preview");     // sync, 16ms
    exec(`cmux themes set "${name}"`, noop);      // async, fire-and-forget
  }, 100);
}
```

**`exec` detail:** Use `child_process.exec(cmd, callback)` (not `execSync`). The callback is a no-op — we don't care about the result. This is non-blocking.

### Flow

1. User types `/ghostty`
2. Capture current state: `originalPiTheme = ctx.ui.theme.name`, `originalCmuxTheme` from `cmux themes list`
3. Build theme list from `readdirSync(CMUX_THEME_DIR)`
4. Open picker via `ctx.ui.custom(factory, { overlay: true })`
5. As user navigates: `onSelectionChange` → debounced `previewTheme(name)`
6. On confirm (enter):
   - Copy preview JSON to `ghostty-sync-{slug}.json`
   - Delete preview file
   - `ctx.ui.setTheme("ghostty-sync-{slug}")`
   - Clean up old `ghostty-sync-*.json` files
7. On cancel (escape):
   - Delete preview file
   - `ctx.ui.setTheme(originalPiTheme)`
   - `exec("cmux themes set {originalCmuxTheme}")`

### Component approach

Two options. Decide during implementation:

**Option A: Use `ThemeSelectorComponent` directly.**
Constructor: `new ThemeSelectorComponent(currentTheme, onSelect, onCancel, onPreview)`.
Pro: zero custom UI code. Con: it only lists pi themes (calls `getAvailableThemes()`), not cmux themes. Would need to either subclass or pre-populate the pi themes dir.

**Option B: Build picker with `SelectList` + `Container` + `DynamicBorder`.**
Same pattern as `pi-themes` extension. Pro: full control over theme list source (cmux dir). Con: ~40 lines of UI boilerplate.

**Recommendation: Option B.** We need to list cmux themes, not pi themes. The boilerplate is minimal — `pi-themes` already provides the exact pattern to copy.

### Registration

```typescript
pi.registerCommand("ghostty", {
  description: "Switch cmux + pi theme with live preview",
  handler: async (args, ctx) => {
    if (args?.trim()) {
      // Direct switch: /ghostty "Catppuccin Mocha"
      applyTheme(args.trim(), ctx);
      return;
    }
    await showThemePicker(ctx);
  },
});
```

---

## Phase 3 — tracked config management (future)

### 3.1 Base config tracking

The mitchellh config (`com.mitchellh.ghostty/config`) holds structural settings (fonts, padding, opacity). A git-tracked `config-base` file already exists at `~/.pi/agent/ghostty/config-base`.

Future: wire the mitchellh config to include `config-base` via `config-file` directive, so the extension can own the thin main config while the user owns the stable settings.

**Note:** cmux owns theme selection via its own config at `com.cmuxterm.app/config.ghostty`. The `config-file` wiring only applies to the mitchellh config for structural settings — it does NOT affect theme switching.

### 3.2 `/ghostty config` subcommand

Open `config-base` in `$EDITOR` for editing, then trigger `cmux reload-config` on save.

---

## Phase 4 — extended TUI (future)

- `/ghostty fonts` — font picker with live preview
- `/ghostty opacity` — slider for background-opacity with live preview
- `/ghostty padding` — adjust window padding with live preview
- Settings persistence: changes written to `config-base` and committed

---

## Implementation order

1. ~~**Phase 1.1** — readable names~~ ✔ Done
2. ~~**Phase 1.2** — semantic color fix~~ ✔ Done
3. **Phase 1.3** — AGENTS.md
4. **Phase 2** — live theme picker (main feature)
5. **Phase 3** — config tracking (future)
6. **Phase 4** — extended TUI (future)
