import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";
import { getGitRepoInfo, ensureCreatedBranchWorktree } from "./git-core.ts";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");

type ContinueRequest =
	| { mode: "handoff"; note?: string }
	| { mode: "worktree-create"; branch: string; fromRef?: string; note?: string };

interface HandoffContext {
	sourceCwd: string;
	sourceSessionName?: string;
	currentTask?: string;
	branch?: string;
	modifiedFiles: string[];
	newFiles: string[];
	targetBranch?: string;
	targetWorktreePath?: string;
	note?: string;
	fromRef?: string;
}

function parseContinueArgs(args: string): { ok: true; request: ContinueRequest } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, request: { mode: "handoff" } };

	const tokens = trimmed.split(/\s+/);
	const [first, ...rest] = tokens;

	if (first === "-c" || first === "--create") {
		if (rest.length < 1) return { ok: false, error: "Requires a branch name" };
		const [branch, ...remaining] = rest;
		let fromRef: string | undefined;
		const noteParts: string[] = [];
		for (let i = 0; i < remaining.length; i++) {
			if (remaining[i] === "--from" || remaining[i] === "-f") {
				fromRef = remaining[++i];
				if (!fromRef) return { ok: false, error: "--from requires a ref" };
			} else noteParts.push(remaining[i]);
		}
		return { ok: true, request: { mode: "worktree-create", branch, fromRef, note: noteParts.join(" ") || undefined } };
	}

	if (trimmed.startsWith("-")) return { ok: false, error: `Unknown flag: ${first}` };
	return { ok: true, request: { mode: "handoff", note: trimmed } };
}

function findRecentTask(entries: readonly unknown[]): string | undefined {
	for (let i = (entries as any[]).length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (e?.type !== "message" || e?.message?.role !== "user") continue;
		const content = e.message.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
		}
		text = text.trim();
		if (!text || text.startsWith("/") || text.length <= 4) continue;
		return text.length > 280 ? `${text.slice(0, 277)}...` : text;
	}
	return undefined;
}

function summarizeGitStatus(lines: string[]): { modified: string[]; newFiles: string[] } {
	const modified: string[] = [];
	const newFiles: string[] = [];
	for (const line of lines) {
		const code = line.slice(0, 2);
		const file = line.slice(3).trim();
		if (!file || file.startsWith(".pi/") || file.startsWith("node_modules/")) continue;
		if (code === "??") newFiles.push(file);
		else modified.push(file);
	}
	return { modified, newFiles };
}

function buildHandoffSummary(ctx: HandoffContext, inheritedHistory: boolean): string {
	const lines = ["Handoff context from another Pi pane:"];
	lines.push(`- Source cwd: ${ctx.sourceCwd}`);
	if (ctx.sourceSessionName) lines.push(`- Session: ${ctx.sourceSessionName}`);
	if (ctx.branch) lines.push(`- Branch: ${ctx.branch}`);
	if (ctx.targetBranch) lines.push(`- Target branch: ${ctx.targetBranch}`);
	if (ctx.fromRef) lines.push(`- Base ref: ${ctx.fromRef}`);
	if (ctx.targetWorktreePath) lines.push(`- Worktree: ${ctx.targetWorktreePath}`);
	if (ctx.currentTask) lines.push(`- Task: ${ctx.currentTask}`);
	if (ctx.note) lines.push(`- Focus: ${ctx.note}`);
	if (ctx.modifiedFiles.length > 0) { lines.push("- Modified:"); ctx.modifiedFiles.forEach((f) => lines.push(`  ${f}`)); }
	if (ctx.newFiles.length > 0) { lines.push("- New files:"); ctx.newFiles.forEach((f) => lines.push(`  ${f}`)); }
	if (inheritedHistory) lines.push("- Session history inherited.");
	return lines.join("\n");
}

function readTemplate(name: string, replacements: Record<string, string>): string {
	let tmpl = readFileSync(join(TEMPLATE_DIR, name), "utf8");
	for (const [k, v] of Object.entries(replacements)) tmpl = tmpl.replaceAll(`{{${k}}}`, v);
	return tmpl.trim();
}

async function openContinueSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	request: ContinueRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const repo = await getGitRepoInfo(pi, ctx.cwd);
	const branchEntries = ctx.sessionManager.getBranch();
	const status = summarizeGitStatus(repo?.statusLines ?? []);

	const handoffCtx: HandoffContext = {
		sourceCwd: ctx.cwd,
		sourceSessionName: ctx.sessionManager.getSessionName(),
		currentTask: ctx.sessionManager.getSessionName() || findRecentTask(branchEntries),
		branch: repo?.branch,
		modifiedFiles: status.modified,
		newFiles: status.newFiles,
		note: request.note,
	};

	let targetCwd = ctx.cwd;
	let sessionFile: string | undefined;
	let prompt: string;

	if (request.mode === "worktree-create") {
		if (!repo) return { ok: false, error: "Not inside a git repository" };
		const wt = await ensureCreatedBranchWorktree(pi, repo.repoRoot, request.branch, request.fromRef);
		if (!wt.ok) return wt;

		handoffCtx.targetBranch = request.branch;
		handoffCtx.fromRef = request.fromRef;
		handoffCtx.targetWorktreePath = wt.path;
		targetCwd = wt.path;

		const summary = buildHandoffSummary(handoffCtx, false);
		const sm = SessionManager.create(targetCwd);
		sm.appendMessage({ role: "user", content: summary, timestamp: Date.now() });
		sessionFile = sm.getSessionFile();
		const focus = request.note ? ` Focus on: ${request.note}.` : "";
		prompt = readTemplate("handoff-worktree.md", { TARGET_BRANCH: request.branch, FOCUS_NOTE_SENTENCE: focus });
	} else {
		// Same-checkout handoff — fork session
		const currentFile = ctx.sessionManager.getSessionFile();
		const leafId = ctx.sessionManager.getLeafId();
		let forked = false;

		if (currentFile && leafId) {
			const current = SessionManager.open(currentFile, ctx.sessionManager.getSessionDir());
			const branchedFile = current.createBranchedSession(leafId);
			if (branchedFile) {
				const branched = SessionManager.open(branchedFile, ctx.sessionManager.getSessionDir());
				branched.appendMessage({ role: "user", content: buildHandoffSummary(handoffCtx, true), timestamp: Date.now() });
				sessionFile = branchedFile;
				forked = true;
			}
		}

		if (!forked) {
			const sm = SessionManager.create(ctx.cwd);
			sm.appendMessage({ role: "user", content: buildHandoffSummary(handoffCtx, false), timestamp: Date.now() });
			sessionFile = sm.getSessionFile();
		}

		const focus = request.note ? ` Focus on: ${request.note}.` : "";
		prompt = readTemplate("handoff-same-checkout.md", { FOCUS_NOTE_SENTENCE: focus });
	}

	return openCommandInNewSplit(
		pi,
		direction,
		buildPiCommand(targetCwd, { sessionFile, prompt }),
		{ tabTitle: await buildContextualTabTitle(pi, targetCwd, "Continue", "Continue") },
	);
}

export default function cmuxContinueExtension(pi: ExtensionAPI) {
	pi.registerCommand("cmcv", {
		description: "Continue the current task in a new right split, optionally in a git worktree",
		handler: async (args, ctx) => {
			const parsed = parseContinueArgs(args);
			if (!parsed.ok) { ctx.ui.notify(`${parsed.error}. Usage: /cmcv [note] | /cmcv -c <branch> [--from <ref>] [note]`, "warning"); return; }
			const r = await openContinueSplit(pi, ctx, "right", parsed.request);
			r.ok ? ctx.ui.notify("Opened continuation split", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});

	pi.registerCommand("cmch", {
		description: "Continue the current task in a new lower split, optionally in a git worktree",
		handler: async (args, ctx) => {
			const parsed = parseContinueArgs(args);
			if (!parsed.ok) { ctx.ui.notify(`${parsed.error}. Usage: /cmch [note] | /cmch -c <branch> [--from <ref>] [note]`, "warning"); return; }
			const r = await openContinueSplit(pi, ctx, "down", parsed.request);
			r.ok ? ctx.ui.notify("Opened continuation split", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});
}
