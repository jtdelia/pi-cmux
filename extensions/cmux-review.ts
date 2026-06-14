import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

type ReviewMode = "general" | "bugs" | "refactor" | "tests" | "diff";

interface ReviewRequest {
	mode: ReviewMode;
	target?: string;
}

function parseReviewArgs(args: string): { ok: true; request: ReviewRequest } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, request: { mode: "diff" } };

	const tokens = trimmed.split(/\s+/);
	let mode: ReviewMode = "general";
	let modeSet = false;
	let idx = 0;

	while (idx < tokens.length && tokens[idx].startsWith("--")) {
		const t = tokens[idx];
		const m = t === "--bugs" ? "bugs" : t === "--refactor" ? "refactor" : t === "--tests" ? "tests" : t === "--diff" ? "diff" : undefined;
		if (!m) return { ok: false, error: `Unknown flag: ${t}` };
		if (modeSet) return { ok: false, error: "Use only one mode flag" };
		mode = m;
		modeSet = true;
		idx++;
	}

	const target = tokens.slice(idx).join(" ").trim() || undefined;
	if (mode !== "diff" && !target) return { ok: false, error: "Specify a file or directory to review" };

	return { ok: true, request: { mode, target } };
}

function isGitHubPrUrl(value?: string): boolean {
	return Boolean(value && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(value));
}

function buildReviewPrompt(request: ReviewRequest): string {
	const common = "Start with a concise summary ordered by severity. List concrete findings with suggested fixes. Do not edit files unless asked.";
	const modeMap: Record<ReviewMode, string> = {
		general: "Focus on correctness, readability, maintainability, and missing tests.",
		bugs: "Focus on correctness issues, runtime failures, and edge cases.",
		refactor: "Focus on simplifications, structure, naming, and duplication.",
		tests: "Focus on missing coverage, brittle assertions, and untested edge cases.",
		diff: "Focus on regressions, correctness issues, and missing tests.",
	};

	if (isGitHubPrUrl(request.target)) {
		return `Review GitHub PR ${request.target}. Use gh CLI: gh pr view ${request.target} and gh pr diff ${request.target}. ${modeMap[request.mode]} ${common}`;
	}

	if (request.mode === "diff") {
		const focus = request.target ? ` Extra focus: ${request.target}.` : "";
		return `Review the current git diff.${focus} ${modeMap.diff} ${common}`;
	}

	return `Review ${request.target} from the current project. ${modeMap[request.mode]} ${common}`;
}

async function openReviewSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	request: ReviewRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return openCommandInNewSplit(
		pi,
		direction,
		buildPiCommand(ctx.cwd, { prompt: buildReviewPrompt(request) }),
		{ tabTitle: await buildContextualTabTitle(pi, ctx.cwd, "Review", "Review") },
	);
}

export default function cmuxReviewExtension(pi: ExtensionAPI) {
	pi.registerCommand("cmrv", {
		description: "Open a code review session in a right split",
		handler: async (args, ctx) => {
			const parsed = parseReviewArgs(args);
			if (!parsed.ok) { ctx.ui.notify(`${parsed.error}. Usage: /cmrv [--bugs|--refactor|--tests|--diff] [target]`, "warning"); return; }
			const r = await openReviewSplit(pi, ctx, "right", parsed.request);
			r.ok ? ctx.ui.notify("Opened review split", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});

	pi.registerCommand("cmrh", {
		description: "Open a code review session in a lower split",
		handler: async (args, ctx) => {
			const parsed = parseReviewArgs(args);
			if (!parsed.ok) { ctx.ui.notify(`${parsed.error}. Usage: /cmrh [--bugs|--refactor|--tests|--diff] [target]`, "warning"); return; }
			const r = await openReviewSplit(pi, ctx, "down", parsed.request);
			r.ok ? ctx.ui.notify("Opened review split", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});
}
