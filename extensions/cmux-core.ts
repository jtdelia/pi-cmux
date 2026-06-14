import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename } from "node:path";

const CMUX_TIMEOUT_MS = 5000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;
const TAB_TITLE_CONTEXT_TIMEOUT_MS = 1000;
const MAX_TAB_TITLE_LENGTH = 48;

export type SplitDirection = "right" | "down";

interface CmuxExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

interface CmuxCallerContext {
	workspace_ref: string;
	surface_ref: string;
	pane_ref?: string;
}

interface CmuxPaneInfo {
	ref?: string;
	selected_surface_ref?: string;
	surface_refs?: string[];
}

export interface SplitOptions {
	tabTitle?: string;
	focus?: boolean;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function hasCmuxContext(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID?.trim());
}

function getCmuxBin(): string {
	const bundled = process.env.CMUX_BUNDLED_CLI_PATH;
	if (bundled && existsSync(bundled)) return bundled;
	return "cmux";
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildPiCommand(cwd: string, opts?: { sessionFile?: string; prompt?: string }): string {
	const parts = ["cd", shellEscape(cwd), "&&", "exec", "pi"];
	if (opts?.sessionFile) parts.push("--session", shellEscape(opts.sessionFile));
	const prompt = opts?.prompt?.trim();
	if (prompt) parts.push(shellEscape(prompt));
	return parts.join(" ");
}

export function buildShellCommand(cwd: string, command: string): string {
	return ["cd", shellEscape(cwd), "&&", "exec", "sh", "-lc", shellEscape(command)].join(" ");
}

export async function execCmux(pi: ExtensionAPI, args: string[]): Promise<CmuxExecResult> {
	const bin = getCmuxBin();
	const result = await pi.exec(bin, args, { timeout: CMUX_TIMEOUT_MS });
	if (result.killed) {
		return { ok: false, stdout: result.stdout, stderr: result.stderr, error: "cmux timed out" };
	}
	if (result.code !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.stderr.trim() || result.stdout.trim() || `cmux exited ${result.code}`,
		};
	}
	return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

async function getCallerInfo(pi: ExtensionAPI): Promise<{ ok: true; caller: CmuxCallerContext } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "identify"]);
	if (!result.ok) return { ok: false, error: result.error || "Failed to identify cmux caller" };

	const parsed = parseJson<{ caller?: { workspace_ref?: string; surface_ref?: string; pane_ref?: string } }>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (!workspaceRef || !surfaceRef) return { ok: false, error: "Not inside a cmux surface" };

	return { ok: true, caller: { workspace_ref: workspaceRef, surface_ref: surfaceRef, pane_ref: parsed?.caller?.pane_ref } };
}

async function listPanes(pi: ExtensionAPI, workspaceRef: string): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) return { ok: false, error: result.error || "Failed to list panes" };
	const parsed = parseJson<{ panes?: CmuxPaneInfo[] }>(result.stdout);
	return { ok: true, panes: parsed?.panes ?? [] };
}

function collectSurfaceRefs(panes: CmuxPaneInfo[]): Set<string> {
	const refs = new Set<string>();
	for (const pane of panes) {
		if (pane.selected_surface_ref) refs.add(pane.selected_surface_ref);
		for (const r of pane.surface_refs ?? []) refs.add(r);
	}
	return refs;
}

async function waitForNewSurface(pi: ExtensionAPI, workspaceRef: string, previousPanes: CmuxPaneInfo[]): Promise<string | undefined> {
	const prevRefs = new Set(previousPanes.map((p) => p.ref).filter(Boolean));
	const prevSurfaces = collectSurfaceRefs(previousPanes);

	for (let i = 0; i < SPLIT_READY_ATTEMPTS; i++) {
		const result = await listPanes(pi, workspaceRef);
		if (!result.ok) return undefined;

		for (const pane of result.panes) {
			if (pane.ref && !prevRefs.has(pane.ref)) {
				if (pane.selected_surface_ref) return pane.selected_surface_ref;
				const fresh = pane.surface_refs?.find((r) => !prevSurfaces.has(r));
				if (fresh) return fresh;
			}
		}
		for (const pane of result.panes) {
			for (const r of pane.surface_refs ?? []) {
				if (!prevSurfaces.has(r)) return r;
			}
		}
		await delay(SPLIT_READY_DELAY_MS);
	}
	return undefined;
}

async function renameSurfaceTab(pi: ExtensionAPI, workspaceRef: string, surfaceRef: string, title: string | undefined): Promise<void> {
	if (!title) return;
	const trimmed = title.length > MAX_TAB_TITLE_LENGTH ? `${title.slice(0, MAX_TAB_TITLE_LENGTH - 3)}...` : title;
	await execCmux(pi, ["rename-tab", "--workspace", workspaceRef, "--surface", surfaceRef, "--title", trimmed]).catch(() => {});
}

async function respawnSurface(pi: ExtensionAPI, workspaceRef: string, surfaceRef: string, command: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["respawn-pane", "--workspace", workspaceRef, "--surface", surfaceRef, "--command", command]);
	if (!result.ok) return { ok: false, error: result.error || "Failed to respawn surface" };
	return { ok: true };
}

export async function buildContextualTabTitle(pi: ExtensionAPI, cwd: string, value: string | undefined, fallback: string): Promise<string> {
	const title = (value ?? "").trim() || fallback;
	let context = "";
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: TAB_TITLE_CONTEXT_TIMEOUT_MS });
		if (result.code === 0 && !result.killed) context = basename(result.stdout.trim()) || "";
	} catch { /* fallback */ }
	if (!context) context = basename(cwd) || "";

	const full = context ? `${title} · ${context}` : title;
	return full.length > MAX_TAB_TITLE_LENGTH ? `${full.slice(0, MAX_TAB_TITLE_LENGTH - 3)}...` : full;
}

export async function openCommandInNewSplit(
	pi: ExtensionAPI,
	direction: SplitDirection,
	command: string,
	opts: SplitOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) return callerResult;

	const { workspace_ref, surface_ref } = callerResult.caller;
	const beforePanes = await listPanes(pi, workspace_ref);
	if (!beforePanes.ok) return beforePanes;

	const splitArgs = ["new-split", direction, "--workspace", workspace_ref, "--surface", surface_ref];
	if (opts.focus !== undefined) splitArgs.push("--focus", String(opts.focus));

	const splitResult = await execCmux(pi, splitArgs);
	if (!splitResult.ok) return { ok: false, error: splitResult.error || "Failed to create split" };

	const newSurface = await waitForNewSurface(pi, workspace_ref, beforePanes.panes);
	if (!newSurface) return { ok: false, error: "Split created but new surface not found" };

	await delay(SURFACE_BOOT_DELAY_MS);
	const respawn = await respawnSurface(pi, workspace_ref, newSurface, command);
	if (!respawn.ok) return respawn;

	await renameSurfaceTab(pi, workspace_ref, newSurface, opts.tabTitle);
	return { ok: true };
}

export async function openCommandInNewTab(
	pi: ExtensionAPI,
	command: string,
	opts: SplitOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) return callerResult;

	const { workspace_ref, pane_ref } = callerResult.caller;
	if (!pane_ref) return { ok: false, error: "Not inside a cmux pane" };

	const beforePanes = await listPanes(pi, workspace_ref);
	if (!beforePanes.ok) return beforePanes;

	const tabResult = await execCmux(pi, ["new-surface", "--type", "terminal", "--workspace", workspace_ref, "--pane", pane_ref, "--focus", String(opts.focus ?? true)]);
	if (!tabResult.ok) return { ok: false, error: tabResult.error || "Failed to create tab" };

	const newSurface = await waitForNewSurface(pi, workspace_ref, beforePanes.panes);
	if (!newSurface) return { ok: false, error: "Tab created but surface not found" };

	await delay(SURFACE_BOOT_DELAY_MS);
	const respawn = await respawnSurface(pi, workspace_ref, newSurface, command);
	if (!respawn.ok) return respawn;

	await renameSurfaceTab(pi, workspace_ref, newSurface, opts.tabTitle);
	return { ok: true };
}
