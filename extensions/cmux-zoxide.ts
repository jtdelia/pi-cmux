import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

const ZOXIDE_TIMEOUT_MS = 5000;
const MAX_COMPLETIONS = 10;

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function resolveDirectoryCandidate(value: string, baseDir: string): string | undefined {
	const expanded = expandHome(value.trim());
	if (!expanded) return undefined;
	const resolved = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return undefined;
	return resolved;
}

function getZoxideMatches(prefix: string): string[] {
	const query = prefix.trim();
	if (!query) return [];
	try {
		const out = execFileSync("zoxide", ["query", "-l", ...query.split(/\s+/)], { encoding: "utf8", timeout: ZOXIDE_TIMEOUT_MS });
		return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(0, MAX_COMPLETIONS);
	} catch { return []; }
}

async function resolveTarget(
	pi: ExtensionAPI,
	query: string,
	baseDir: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const direct = resolveDirectoryCandidate(query, baseDir);
	if (direct) return { ok: true, path: direct };

	const keywords = query.trim().split(/\s+/).filter((k) => k.length > 0);
	if (keywords.length === 0) return { ok: false, error: "Provide a query" };

	const result = await pi.exec("zoxide", ["query", ...keywords], { timeout: ZOXIDE_TIMEOUT_MS });
	if (result.killed) return { ok: false, error: "zoxide timed out" };
	if (result.code !== 0) return { ok: false, error: result.stderr.trim() || "No match" };

	const target = result.stdout.trim();
	return target ? { ok: true, path: target } : { ok: false, error: "No match" };
}

async function openZoxideSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	query: string,
	direction: SplitDirection,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const target = await resolveTarget(pi, query, ctx.cwd);
	if (!target.ok) return target;

	return openCommandInNewSplit(
		pi,
		direction,
		buildPiCommand(target.path),
		{ tabTitle: await buildContextualTabTitle(pi, target.path, "Pi", "Pi") },
	);
}

export default function cmuxZoxideExtension(pi: ExtensionAPI) {
	pi.registerCommand("cmz", {
		description: "Open a right split for a zoxide directory match",
		getArgumentCompletions: (prefix) => {
			const matches = getZoxideMatches(prefix);
			return matches.length > 0 ? matches.map((m) => ({ value: m, label: m })) : null;
		},
		handler: async (args, ctx) => {
			const q = args.trim();
			if (!q) { ctx.ui.notify("Usage: /cmz <query>", "warning"); return; }
			const r = await openZoxideSplit(pi, ctx, q, "right");
			r.ok ? ctx.ui.notify("Opened zoxide split", "info") : ctx.ui.notify(`zoxide: ${r.error}`, "error");
		},
	});

	pi.registerCommand("cmzh", {
		description: "Open a lower split for a zoxide directory match",
		getArgumentCompletions: (prefix) => {
			const matches = getZoxideMatches(prefix);
			return matches.length > 0 ? matches.map((m) => ({ value: m, label: m })) : null;
		},
		handler: async (args, ctx) => {
			const q = args.trim();
			if (!q) { ctx.ui.notify("Usage: /cmzh <query>", "warning"); return; }
			const r = await openZoxideSplit(pi, ctx, q, "down");
			r.ok ? ctx.ui.notify("Opened zoxide split", "info") : ctx.ui.notify(`zoxide: ${r.error}`, "error");
		},
	});
}
