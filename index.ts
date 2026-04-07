/**
 * cmux Theme Sync Extension
 *
 * Syncs pi theme with the currently active cmux terminal theme on session start.
 * Source of truth is cmux (`cmux themes list`) + cmux bundled theme files.
 */

import { execFile, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Key, SelectList, Text, type SelectItem, matchesKey } from "@mariozechner/pi-tui";

const CMUX_THEME_DIR = "/Applications/cmux.app/Contents/Resources/ghostty/themes";
const PI_THEMES_DIR = join(homedir(), ".pi", "agent", "themes");
const PREVIEW_THEME_NAME = "ghostty-sync-preview";
const PREVIEW_THEME_FILE = `${PREVIEW_THEME_NAME}.json`;
const THROTTLE_INTERVAL_MS = 100;

type FilterMode = "all" | "dark" | "light";

interface CmuxColors {
	background: string;
	foreground: string;
	palette: Record<number, string>;
}

interface CmuxThemeEntry {
	name: string;
	colors: CmuxColors;
	isDark: boolean;
}

type SessionContext = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];
type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

function ensureThemesDir(): void {
	if (!existsSync(PI_THEMES_DIR)) {
		mkdirSync(PI_THEMES_DIR, { recursive: true });
	}
}

function removePreviewThemeFile(): void {
	try {
		unlinkSync(join(PI_THEMES_DIR, PREVIEW_THEME_FILE));
	} catch {
		// Best-effort cleanup
	}
}

function getCurrentCmuxThemeName(): string | null {
	try {
		const output = execSync("cmux themes list", {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const line of output.split("\n")) {
			if (line.startsWith("Current dark:")) return line.replace("Current dark:", "").trim();
		}
		for (const line of output.split("\n")) {
			if (line.startsWith("Current light:")) return line.replace("Current light:", "").trim();
		}
		return null;
	} catch {
		return null;
	}
}

function runCmuxThemeSet(themeName: string): void {
	execFile("cmux", ["themes", "set", themeName], { timeout: 5000 }, () => {
		// Fire-and-forget by design
	});
}

function getCmuxThemeColors(themeName: string): CmuxColors | null {
	try {
		const themePath = join(CMUX_THEME_DIR, themeName);
		if (!existsSync(themePath)) return null;
		const output = readFileSync(themePath, "utf-8");
		return parseThemeConfig(output);
	} catch {
		return null;
	}
}

function getAvailableCmuxThemes(): CmuxThemeEntry[] {
	try {
		const names = readdirSync(CMUX_THEME_DIR).sort((a, b) => a.localeCompare(b));
		const entries: CmuxThemeEntry[] = [];
		for (const name of names) {
			const colors = getCmuxThemeColors(name);
			if (!colors) continue;
			entries.push({
				name,
				colors,
				isDark: getLuminance(colors.background) < 0.5,
			});
		}
		return entries;
	} catch {
		return [];
	}
}

function parseThemeConfig(output: string): CmuxColors {
	const colors: CmuxColors = {
		background: "#1e1e1e",
		foreground: "#d4d4d4",
		palette: {},
	};

	for (const line of output.split("\n")) {
		const match = line.match(/^(\S+)\s*=\s*(.+)$/);
		if (!match) continue;

		const [, key, value] = match;
		const trimmedValue = value.trim();

		if (key === "background") {
			colors.background = normalizeColor(trimmedValue);
		} else if (key === "foreground") {
			colors.foreground = normalizeColor(trimmedValue);
		} else if (key === "palette") {
			const paletteMatch = trimmedValue.match(/^(\d+)=(.+)$/);
			if (paletteMatch) {
				const index = parseInt(paletteMatch[1], 10);
				if (index >= 0 && index <= 15) {
					colors.palette[index] = normalizeColor(paletteMatch[2]);
				}
			}
		}
	}

	return colors;
}

function normalizeColor(color: string): string {
	const trimmed = color.trim();
	if (trimmed.startsWith("#")) {
		if (trimmed.length === 4) {
			return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
		}
		return trimmed;
	}
	if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed}`;
	return `#${trimmed}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const h = hex.replace("#", "");
	return {
		r: parseInt(h.substring(0, 2), 16),
		g: parseInt(h.substring(2, 4), 16),
		b: parseInt(h.substring(4, 6), 16),
	};
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
	return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function getLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function adjustBrightness(hex: string, amount: number): string {
	const { r, g, b } = hexToRgb(hex);
	return rgbToHex(r + amount, g + amount, b + amount);
}

function mixColors(color1: string, color2: string, weight: number): string {
	const c1 = hexToRgb(color1);
	const c2 = hexToRgb(color2);
	return rgbToHex(
		c1.r * weight + c2.r * (1 - weight),
		c1.g * weight + c2.g * (1 - weight),
		c1.b * weight + c2.b * (1 - weight)
	);
}

function rgbToHsl(hex: string): { h: number; s: number; l: number } {
	const { r, g, b } = hexToRgb(hex);
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
	else if (max === gn) h = (bn - rn) / d + 2;
	else h = (rn - gn) / d + 4;
	h *= 60;
	return { h, s, l };
}

function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

function ensureSemanticHue(color: string | undefined, targetHue: number, fallback: string): string {
	if (!color) return fallback;
	const { h, s } = rgbToHsl(color);
	if (s >= 0.2 && hueDistance(h, targetHue) <= 65) return color;
	return mixColors(color, fallback, 0.5);
}

function contrastRatio(a: string, b: string): number {
	const l1 = getLuminance(a);
	const l2 = getLuminance(b);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

function pickReadableLink(candidate: string, bg: string, fallback: string, fg: string): string {
	if (contrastRatio(candidate, bg) >= 3) return candidate;
	if (contrastRatio(fallback, bg) >= 3) return fallback;
	return fg;
}

function slugifyThemeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function generatePiTheme(colors: CmuxColors, themeName: string): object {
	const bg = colors.background;
	const fg = colors.foreground;
	const isDark = getLuminance(bg) < 0.5;

	const error = ensureSemanticHue(colors.palette[1], 0, "#cc6666");
	const success = ensureSemanticHue(colors.palette[2], 120, "#98c379");
	const warning = ensureSemanticHue(colors.palette[3], 50, "#e5c07b");
	const rawLink = ensureSemanticHue(colors.palette[4], 220, "#61afef");
	const link = pickReadableLink(rawLink, bg, "#61afef", fg);

	const accent = colors.palette[5] || "#c678dd";
	const accentAlt = colors.palette[6] || "#56b6c2";

	const muted = mixColors(fg, bg, 0.65);
	const dim = mixColors(fg, bg, 0.45);
	const borderMuted = mixColors(fg, bg, 0.25);

	const bgShift = isDark ? 12 : -12;
	const selectedBg = adjustBrightness(bg, bgShift);
	const userMsgBg = adjustBrightness(bg, Math.round(bgShift * 0.7));
	const toolPendingBg = adjustBrightness(bg, Math.round(bgShift * 0.4));
	const toolSuccessBg = mixColors(bg, success, 0.88);
	const toolErrorBg = mixColors(bg, error, 0.88);
	const customMsgBg = mixColors(bg, accent, 0.92);

	return {
		$schema: "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		name: themeName,
		vars: {
			bg,
			fg,
			accent,
			accentAlt,
			link,
			error,
			success,
			warning,
			muted,
			dim,
			borderMuted,
			selectedBg,
			userMsgBg,
			toolPendingBg,
			toolSuccessBg,
			toolErrorBg,
			customMsgBg,
		},
		colors: {
			accent: "accent",
			border: "borderMuted",
			borderAccent: "accent",
			borderMuted: "borderMuted",
			success: "success",
			error: "error",
			warning: "warning",
			muted: "muted",
			dim: "dim",
			text: "",
			thinkingText: "muted",
			selectedBg: "selectedBg",
			userMessageBg: "userMsgBg",
			userMessageText: "",
			customMessageBg: "customMsgBg",
			customMessageText: "",
			customMessageLabel: "accent",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "muted",
			mdHeading: "warning",
			mdLink: "link",
			mdLinkUrl: "dim",
			mdCode: "accent",
			mdCodeBlock: "success",
			mdCodeBlockBorder: "muted",
			mdQuote: "muted",
			mdQuoteBorder: "muted",
			mdHr: "muted",
			mdListBullet: "accent",
			toolDiffAdded: "success",
			toolDiffRemoved: "error",
			toolDiffContext: "muted",
			syntaxComment: "muted",
			syntaxKeyword: "accent",
			syntaxFunction: "link",
			syntaxVariable: "accentAlt",
			syntaxString: "success",
			syntaxNumber: "accent",
			syntaxType: "accentAlt",
			syntaxOperator: "fg",
			syntaxPunctuation: "muted",
			thinkingOff: "borderMuted",
			thinkingMinimal: "muted",
			thinkingLow: "link",
			thinkingMedium: "accentAlt",
			thinkingHigh: "accent",
			thinkingXhigh: "accent",
			bashMode: "success",
		},
		export: {
			pageBg: isDark ? adjustBrightness(bg, -8) : adjustBrightness(bg, 8),
			cardBg: bg,
			infoBg: mixColors(bg, warning, 0.88),
		},
	};
}

function computeThemeHash(colors: CmuxColors): string {
	const parts: string[] = [];
	parts.push(`bg=${colors.background}`);
	parts.push(`fg=${colors.foreground}`);
	for (let i = 0; i <= 15; i++) parts.push(`p${i}=${colors.palette[i] ?? ""}`);
	const signature = parts.join("\n");
	return createHash("sha1").update(signature).digest("hex").slice(0, 8);
}

function cleanupOldGhosttyThemes(themesDir: string, keepFiles: string[]): void {
	const keep = new Set(keepFiles);
	try {
		for (const file of readdirSync(themesDir)) {
			if (keep.has(file)) continue;
			if (file === "ghostty-sync.json") {
				unlinkSync(join(themesDir, file));
				continue;
			}
			if (file.startsWith("ghostty-sync-") && file.endsWith(".json")) {
				unlinkSync(join(themesDir, file));
			}
		}
	} catch {
		// Best-effort cleanup
	}
}

function writeAndSetPiTheme(ctx: SessionContext, colors: CmuxColors, sourceThemeName: string): string {
	ensureThemesDir();
	const hash = computeThemeHash(colors);
	const slug = slugifyThemeName(sourceThemeName);
	const themeName = slug ? `ghostty-sync-${slug}` : `ghostty-sync-${hash}`;
	const themeFile = `${themeName}.json`;
	const themePath = join(PI_THEMES_DIR, themeFile);

	const themeJson = generatePiTheme(colors, themeName);
	writeFileSync(themePath, JSON.stringify(themeJson, null, 2));
	cleanupOldGhosttyThemes(PI_THEMES_DIR, [themeFile]);

	const result = ctx.ui.setTheme(themeName);
	if (!result.success) {
		ctx.ui.notify(`cmux theme sync failed: ${result.error}`, "error");
	}
	return themeName;
}

function writeAndSetPreviewTheme(ctx: SessionContext, colors: CmuxColors): void {
	ensureThemesDir();
	const previewPath = join(PI_THEMES_DIR, PREVIEW_THEME_FILE);
	const previewJson = generatePiTheme(colors, PREVIEW_THEME_NAME);
	writeFileSync(previewPath, JSON.stringify(previewJson, null, 2));
	ctx.ui.setTheme(PREVIEW_THEME_NAME);
}

function isPrintableInput(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function nextFilterMode(mode: FilterMode): FilterMode {
	if (mode === "all") return "dark";
	if (mode === "dark") return "light";
	return "all";
}

function parseCommandThemeName(args: string): string {
	const trimmed = args.trim();
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function syncCurrentCmuxThemeToPi(ctx: SessionContext): void {
	const currentTheme = getCurrentCmuxThemeName();
	if (!currentTheme) return;
	const colors = getCmuxThemeColors(currentTheme);
	if (!colors) return;
	const themeName = slugifyThemeName(currentTheme)
		? `ghostty-sync-${slugifyThemeName(currentTheme)}`
		: `ghostty-sync-${computeThemeHash(colors)}`;
	if (ctx.ui.theme.name === themeName) return;
	writeAndSetPiTheme(ctx, colors, currentTheme);
}

async function showThemePicker(ctx: CommandContext): Promise<void> {
	const entries = getAvailableCmuxThemes();
	if (entries.length === 0) {
		ctx.ui.notify("No cmux themes found", "warning");
		return;
	}

	const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
	const originalPiTheme = ctx.ui.theme.name;
	const originalCmuxTheme = getCurrentCmuxThemeName();

	let filterMode: FilterMode = "all";
	let searchText = "";
	let selectedTheme = originalCmuxTheme && entryByName.has(originalCmuxTheme) ? originalCmuxTheme : entries[0]!.name;

	let previewTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPreviewFired = 0;
	let pendingThemeName: string | null = null;
	let lastPreviewName: string | null = null;
	let closed = false;

	const clearThrottle = (): void => {
		if (previewTimer) {
			clearTimeout(previewTimer);
			previewTimer = null;
		}
		pendingThemeName = null;
	};

	const applyPreview = (themeName: string): void => {
		if (closed || themeName === lastPreviewName) return;
		const entry = entryByName.get(themeName);
		if (!entry) return;
		lastPreviewName = themeName;
		// Both fire concurrently — setTheme is sync, cmux is fire-and-forget
		writeAndSetPreviewTheme(ctx, entry.colors);
		runCmuxThemeSet(themeName);
	};

	// Always deferred — never blocks the input handler's call stack.
	// delay=0 when cold (next tick, ~1ms), throttle interval when warm.
	const schedulePreview = (themeName: string): void => {
		if (closed) return;
		pendingThemeName = themeName;
		if (previewTimer) return; // timer pending, will pick up latest pendingThemeName

		const elapsed = Date.now() - lastPreviewFired;
		const delay = elapsed >= THROTTLE_INTERVAL_MS ? 0 : THROTTLE_INTERVAL_MS - elapsed;

		previewTimer = setTimeout(() => {
			previewTimer = null;
			lastPreviewFired = Date.now();
			const name = pendingThemeName;
			pendingThemeName = null;
			if (name) applyPreview(name);
		}, delay);
	};

	const closeWithConfirm = (themeName: string, done: (value: void) => void): void => {
		if (closed) return;
		closed = true;
		clearThrottle();
		removePreviewThemeFile();

		const entry = entryByName.get(themeName);
		if (!entry) {
			ctx.ui.notify(`Theme not found: ${themeName}`, "error");
			done(undefined);
			return;
		}

		writeAndSetPiTheme(ctx, entry.colors, themeName);
		runCmuxThemeSet(themeName);
		done(undefined);
	};

	const closeWithCancel = (done: (value: void) => void): void => {
		if (closed) return;
		closed = true;
		clearThrottle();
		removePreviewThemeFile();

		if (originalPiTheme) {
			ctx.ui.setTheme(originalPiTheme);
		}
		if (originalCmuxTheme) {
			runCmuxThemeSet(originalCmuxTheme);
		}
		done(undefined);
	};

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		let selectList: SelectList | null = null;

		const getVisibleEntries = (): CmuxThemeEntry[] => {
			const byMode = entries.filter((entry) => {
				if (filterMode === "all") return true;
				if (filterMode === "dark") return entry.isDark;
				return !entry.isDark;
			});
			if (!searchText) return byMode;
			const needle = searchText.toLowerCase();
			return byMode.filter((entry) => entry.name.toLowerCase().includes(needle));
		};

		const buildSelectItems = (visibleEntries: CmuxThemeEntry[]): SelectItem[] => {
			return visibleEntries.map((entry) => {
				const tags: string[] = [];
				if (entry.name === originalCmuxTheme) tags.push("current");
				tags.push(entry.isDark ? "dark" : "light");
				return {
					value: entry.name,
					label: entry.name,
					description: tags.join(" · "),
				};
			});
		};

		const rebuild = (): void => {
			const visibleEntries = getVisibleEntries();
			const items = buildSelectItems(visibleEntries);

			if (items.length > 0 && !items.some((item) => item.value === selectedTheme)) {
				selectedTheme = items[0]!.value;
			}

			container.clear();
			container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Ghostty Theme Picker")), 1, 0));
			container.addChild(new Text(theme.fg("dim", `Mode: ${filterMode} · Search: ${searchText || "—"}`), 1, 0));

			selectList = new SelectList(items, 14, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			const selectedIndex = items.findIndex((item) => item.value === selectedTheme);
			if (selectedIndex >= 0) {
				selectList.setSelectedIndex(selectedIndex);
			}

			selectList.onSelectionChange = (item) => {
				selectedTheme = item.value;
				schedulePreview(item.value);
			};
			selectList.onSelect = (item) => closeWithConfirm(item.value, done);
			selectList.onCancel = () => closeWithCancel(done);

			container.addChild(selectList);
			container.addChild(
				new Text(
					theme.fg("dim", "type to search · backspace delete · tab all/dark/light · ↑↓ navigate · enter apply · esc cancel"),
					1,
					0
				)
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
		};

		rebuild();
		if (selectedTheme) {
			schedulePreview(selectedTheme);
		}

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.tab)) {
					filterMode = nextFilterMode(filterMode);
					rebuild();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.backspace)) {
					if (searchText.length > 0) {
						searchText = searchText.slice(0, -1);
						rebuild();
						tui.requestRender();
					}
					return;
				}
				if (isPrintableInput(data)) {
					searchText += data;
					rebuild();
					tui.requestRender();
					return;
				}
				selectList?.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		syncCurrentCmuxThemeToPi(ctx);
	});

	pi.registerCommand("ghostty", {
		description: "Switch cmux + pi themes with live preview",
		handler: async (args, ctx) => {
			const themeArg = parseCommandThemeName(args);
			if (themeArg) {
				const colors = getCmuxThemeColors(themeArg);
				if (!colors) {
					ctx.ui.notify(`Unknown cmux theme: ${themeArg}`, "error");
					return;
				}
				removePreviewThemeFile();
				writeAndSetPiTheme(ctx, colors, themeArg);
				runCmuxThemeSet(themeArg);
				return;
			}

			await showThemePicker(ctx);
		},
	});
}
