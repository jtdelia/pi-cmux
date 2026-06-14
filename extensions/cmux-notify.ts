import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { hasCmuxContext } from "./cmux-core.ts";

const DEFAULT_THRESHOLD_MS = 15000;
const DEFAULT_DEBOUNCE_MS = 3000;
const NOTIFY_TIMEOUT_MS = 5000;

type NotifyLevel = "all" | "medium" | "low" | "disabled";

interface RunState {
	startedAt: number;
	readFiles: Set<string>;
	changedFiles: Set<string>;
	searchCount: number;
	bashCount: number;
	firstToolError?: string;
}

interface AssistantMessageLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
}

function envNumber(name: string, fallback: number): number {
	const v = process.env[name];
	if (!v) return fallback;
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getNotifyLevel(): NotifyLevel {
	const v = process.env.PI_CMUX_NOTIFY_LEVEL?.trim().toLowerCase();
	if (v === "all" || v === "medium" || v === "low" || v === "disabled") return v;
	return "all";
}

function pluralize(n: number, s: string): string { return n === 1 ? s : `${s}s`; }

function formatDuration(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	const m = Math.floor(s / 60);
	const sec = s % 60;
	if (m === 0) return `${sec}s`;
	if (sec === 0) return `${m}m`;
	return `${m}m ${sec}s`;
}

function getPathFromInput(event: ToolResultEvent): string | undefined {
	const p = event.input.path;
	return typeof p === "string" && p.length > 0 ? p : undefined;
}

function createEmptyState(): RunState {
	return { startedAt: Date.now(), readFiles: new Set(), changedFiles: new Set(), searchCount: 0, bashCount: 0 };
}

function summarizeSuccess(state: RunState, durationMs: number, thresholdMs: number): string {
	const changed = state.changedFiles.size;
	if (changed === 1) {
		const s = `Updated ${basename([...state.changedFiles][0])}`;
		return durationMs >= thresholdMs ? `${s} in ${formatDuration(durationMs)}` : s;
	}
	if (changed > 1) {
		const s = `Updated ${changed} ${pluralize(changed, "file")}`;
		return durationMs >= thresholdMs ? `${s} in ${formatDuration(durationMs)}` : s;
	}
	const read = state.readFiles.size;
	if (read > 0) {
		const s = read === 1 ? `Reviewed ${basename([...state.readFiles][0])}` : `Reviewed ${read} ${pluralize(read, "file")}`;
		return durationMs >= thresholdMs ? `${s} in ${formatDuration(durationMs)}` : s;
	}
	if (state.bashCount > 0) {
		const s = `Ran ${state.bashCount} ${pluralize(state.bashCount, "command")}`;
		return durationMs >= thresholdMs ? `${s} in ${formatDuration(durationMs)}` : s;
	}
	return durationMs >= thresholdMs ? `Finished in ${formatDuration(durationMs)}` : "Finished and waiting for input";
}

function isAssistant(m: unknown): m is AssistantMessageLike {
	return typeof m === "object" && m !== null && (m as any).role === "assistant";
}

function getRunError(messages: readonly unknown[], fallback?: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isAssistant(m)) continue;
		if (m.stopReason === "error" || m.stopReason === "aborted") {
			return m.errorMessage || fallback || "Agent failed";
		}
	}
	return undefined;
}

function shouldNotify(level: NotifyLevel, subtitle: string): boolean {
	if (level === "disabled") return false;
	if (level === "all") return true;
	if (level === "medium") return subtitle === "Task Complete" || subtitle === "Error";
	return subtitle === "Error";
}

export default function cmuxNotifyExtension(pi: ExtensionAPI) {
	if (!hasCmuxContext()) return;

	const thresholdMs = envNumber("PI_CMUX_NOTIFY_THRESHOLD_MS", DEFAULT_THRESHOLD_MS);
	const debounceMs = envNumber("PI_CMUX_NOTIFY_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
	const notifyLevel = getNotifyLevel();
	const title = process.env.PI_CMUX_NOTIFY_TITLE || "Pi";

	let runState = createEmptyState();
	let lastNotifyAt = 0;
	let lastNotifyKey = "";
	let cmuxUnavailable = false;

	const sendNotification = async (subtitle: string, body: string): Promise<void> => {
		if (cmuxUnavailable) return;
		const key = `${subtitle}\n${body}`;
		const now = Date.now();
		if (key === lastNotifyKey && now - lastNotifyAt < debounceMs) return;

		const result = await pi.exec("cmux", ["notify", "--title", title, "--subtitle", subtitle, "--body", body], { timeout: NOTIFY_TIMEOUT_MS });
		if (result.code !== 0 && (result.stderr.includes("ENOENT") || result.stderr.includes("not found"))) {
			cmuxUnavailable = true;
			return;
		}
		lastNotifyAt = now;
		lastNotifyKey = key;
	};

	pi.on("agent_start", async () => {
		runState = createEmptyState();
	});

	pi.on("tool_result", async (event) => {
		if (event.isError && !runState.firstToolError) {
			const path = getPathFromInput(event);
			runState.firstToolError = path ? `${event.toolName} failed for ${basename(path)}` : `${event.toolName} failed`;
		}
		if (isReadToolResult(event)) { const p = getPathFromInput(event); if (p) runState.readFiles.add(p); }
		else if (isEditToolResult(event) || isWriteToolResult(event)) { const p = getPathFromInput(event); if (p && !event.isError) runState.changedFiles.add(p); }
		else if (isGrepToolResult(event) || isFindToolResult(event)) { if (!event.isError) runState.searchCount++; }
		else if (isBashToolResult(event) && !event.isError) { runState.bashCount++; }
	});

	pi.on("agent_end", async (event) => {
		const durationMs = Date.now() - runState.startedAt;
		const runError = getRunError(event.messages, runState.firstToolError);
		const hasError = Boolean(runError);
		const subtitle = hasError ? "Error" : (runState.changedFiles.size > 0 || durationMs >= thresholdMs) ? "Task Complete" : "Waiting";

		if (!shouldNotify(notifyLevel, subtitle)) return;
		const body = runError || summarizeSuccess(runState, durationMs, thresholdMs);
		await sendNotification(subtitle, body);
	});
}
