# pi-ghostty-theme-sync

Sync [pi](https://github.com/badlogic/pi-mono) theme with your active [Ghostty](https://ghostty.org/) terminal colors.

![demo](assets/demo.gif)

On startup, the extension reads the active cmux theme (`cmux themes list`), loads the matching theme file from cmux, generates a pi theme, and switches pi to it.

## install

```bash
pi install git:git@github.com:victor-software-house/pi-ghostty-theme-sync
```

(Optional, try without installing):

```bash
pi -e git:git@github.com:victor-software-house/pi-ghostty-theme-sync
```

## commands

- `/ghostty` — open interactive picker (overlay) with live preview
  - type to search
  - `tab` cycles filters: `all → dark → light`
  - `↑/↓` navigate, `enter` apply, `esc` cancel/revert
- `/ghostty <theme name>` — apply a specific cmux theme directly

## how it works

- Reads active theme from `cmux themes list`.
- Loads theme files from: `/Applications/cmux.app/Contents/Resources/ghostty/themes`.
- Maps `background`, `foreground`, `palette[0..15]` to a pi theme.
- Writes pi themes to: `~/.pi/agent/themes/ghostty-sync-<slug>.json`.
- Uses a preview file for live picker: `~/.pi/agent/themes/ghostty-sync-preview.json`.
- Keeps only the latest synced theme file (`ghostty-sync-*.json`) after apply.

## mapping notes

Uses ANSI slot semantics:

- `palette[1]` → `error`
- `palette[2]` → `success`
- `palette[3]` → `warning`
- `palette[4]` → `link` (links/borders)
- `palette[5]` → `accent` (primary highlight)
- `palette[6]` → `accentAlt` (secondary highlight)

Neutrals (`muted`, `dim`, subtle borders) are derived from `background` + `foreground` instead of trusting `palette[0]`/`palette[8]`.

## requirements

- cmux installed and `cmux` available in `PATH`
- cmux app theme directory available at:
  `/Applications/cmux.app/Contents/Resources/ghostty/themes`

## license

MIT
