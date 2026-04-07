/**
 * cmux Theme Sync Extension
 *
 * Syncs pi theme with the currently active cmux terminal theme on session start.
 * Source of truth is cmux (`cmux themes list`) + cmux bundled theme files.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CMUX_THEME_DIR = "/Applications/cmux.app/Contents/Resources/ghostty/themes";

interface CmuxColors {
	background: string;
	foreground: string;
	palette: Record<number, string>;
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

function cleanupOldGhosttyThemes(themesDir: string, keepFile: string): void {
	try {
		for (const file of readdirSync(themesDir)) {
			if (file === keepFile) continue;
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const currentTheme = getCurrentCmuxThemeName();
		if (!currentTheme) return;

		const colors = getCmuxThemeColors(currentTheme);
		if (!colors) return;

		const themesDir = join(homedir(), ".pi", "agent", "themes");
		if (!existsSync(themesDir)) mkdirSync(themesDir, { recursive: true });

		const hash = computeThemeHash(colors);
		const slug = slugifyThemeName(currentTheme);
		const themeName = slug ? `ghostty-sync-${slug}` : `ghostty-sync-${hash}`;
		const themeFile = `${themeName}.json`;
		const themePath = join(themesDir, themeFile);

		if (ctx.ui.theme.name === themeName) return;

		const themeJson = generatePiTheme(colors, themeName);
		writeFileSync(themePath, JSON.stringify(themeJson, null, 2));
		cleanupOldGhosttyThemes(themesDir, themeFile);

		const result = ctx.ui.setTheme(themeName);
		if (!result.success) {
			ctx.ui.notify(`cmux theme sync failed: ${result.error}`, "error");
		}
	});
}
