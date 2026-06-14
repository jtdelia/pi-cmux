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
import { hasCmuxContext, execCmux } from "./cmux-core.ts";

const DEFAULT_COMPLETE_THRESHOLD_MS = 15000;
const FINAL_CLEAR_DELAY_MS = 2500;
const CMUX_TIMEOUT_MS = 1500;
const DEFAULT_STATUS_PRIORITY = 80;

type StatusKind = "running" | "tool" | "waiting" | "complete" | "cancelled" | "error";
type LogLevel = "info" | "progress" | "success" | "warning" | "error";
type FlashLevel = "all" | "error" | "disabled";

interface RunState {
	startedAt: number;
	prompt?: string;
	readFiles: Set<string>;
	changedFiles: Set<string>;
	searchCount: number;
	bashCount: number;
	toolCount: number;
	turnCount: number;
	firstToolError?: string;
}

interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface AssistantMessageLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	content?: string | Array<{ type?: string; text?: string }>;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: number | { total?: number } };
}

const STATUS_STYLE: Record<StatusKind, { icon: string; color: string }> = {
	running: { icon: "sparkle", color: "#0A84FF" },
	tool: { icon: "hammer", color: "#FF9F0A" },
	waiting: { icon: "clock", color: "#8E8E93" },
	complete: { icon: "check", color: "#30D158" },
	cancelled: { icon: "x", color: "#8E8E93" },
	error: { icon: "x", color: "#FF453A" },
};

function envBool(name: string, fallback: boolean): boolean {
	const v = process.env[name]?.trim().toLowerCase();
	if (!v) return fallback;
	if (v === "1" || v === "true") return true;
	if (v === "0" || v === "false") return false;
	return fallback;
}

function envNumber(name: string, fallback: number): number {
	const v = process.env[name];
	if (!v) return fallback;
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getFlashLevel(): FlashLevel {
	const v = process.env.PI_CMUX_SIDEBAR_FLASH?.trim().toLowerCase();
	if (v === "all" || v === "error" || v === "disabled") return v;
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

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function getPathFromInput(event: ToolResultEvent): string | undefined {
	const p = event.input.path;
	return typeof p === "string" && p.length > 0 ? p : undefined;
}

function createEmptyState(prompt?: string): RunState {
	return { startedAt: Date.now(), prompt, readFiles: new Set(), changedFiles: new Set(), searchCount: 0, bashCount: 0, toolCount: 0, turnCount: 0 };
}

function createEmptyTokens(): TokenTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function estimateProgress(state: RunState): number {
	return Math.min(0.9, 0.08 + state.turnCount * 0.14 + state.toolCount * 0.04);
}

function isAssistant(m: unknown): m is AssistantMessageLike {
	return typeof m === "object" && m !== null && (m as any).role === "assistant";
}

function summarizeSuccess(state: RunState, durationMs: number, thresholdMs: number): string {
	const changed = state.changedFiles.size;
	if (changed === 1) {
		const [file] = [...state.changedFiles];
		const s = `Updated ${basename(file)}`;
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
	return durationMs >= thresholdMs ? `Finished in ${formatDuration(durationMs)}` : "Waiting for input";
}

function summarizeFailure(messages: readonly unknown[], fallback?: string): { kind: "error" | "cancelled"; summary: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isAssistant(m)) continue;
		if (m.stopReason === "aborted") return { kind: "cancelled", summary: m.errorMessage || fallback || "Aborted" };
		if (m.stopReason === "error") return { kind: "error", summary: m.errorMessage || fallback || "Error" };
	}
	return undefined;
}

export default function cmuxSidebarExtension(pi: ExtensionAPI) {
	if (!envBool("PI_CMUX_SIDEBAR", true) || !hasCmuxContext()) return;

	const statusKey = `pi-cmux-${process.env.CMUX_SURFACE_ID || process.pid}`;
	const source = "pi";
	const priority = envNumber("PI_CMUX_SIDEBAR_STATUS_PRIORITY", DEFAULT_STATUS_PRIORITY);
	const thresholdMs = envNumber("PI_CMUX_NOTIFY_THRESHOLD_MS", DEFAULT_COMPLETE_THRESHOLD_MS);
	const progressEnabled = envBool("PI_CMUX_SIDEBAR_PROGRESS", true);
	const tokenTracking = envBool("PI_CMUX_SIDEBAR_TOKENS", true);
	const includeCost = envBool("PI_CMUX_SIDEBAR_COST", false);
	const toolLogs = envBool("PI_CMUX_SIDEBAR_LOG_TOOLS", false);
	const flashLevel = getFlashLevel();

	let runState = createEmptyState();
	let tokenTotals = createEmptyTokens();
	let runSequence = 0;
	let agentActive = false;
	let activeToolCount = 0;
	let cmuxUnavailable = false;
	let commandQueue = Promise.resolve();
	let finalClearTimeout: ReturnType<typeof setTimeout> | undefined;

	const enqueue = (args: string[]): void => {
		if (cmuxUnavailable) return;
		commandQueue = commandQueue.then(
			() => runCmd(args),
			() => runCmd(args),
		);
	};

	const runCmd = async (args: string[]): Promise<void> => {
		if (cmuxUnavailable) return;
		const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS });
		if (result.code !== 0 && (result.stderr.includes("ENOENT") || result.stderr.includes("not found"))) {
			cmuxUnavailable = true;
		}
	};

	const setStatus = (kind: StatusKind, text: string) => {
		const s = STATUS_STYLE[kind];
		enqueue(["set-status", statusKey, text, "--icon", s.icon, "--color", s.color, "--priority", String(priority)]);
	};

	const clearStatus = () => enqueue(["clear-status", statusKey]);
	const appendLog = (level: LogLevel, msg: string) => enqueue(["log", "--level", level, "--source", source, "--", msg.slice(0, 240)]);
	const setProgress = (value: number, label: string) => {
		if (!progressEnabled) return;
		const tokenStr = tokenTracking ? buildTokenLabel() : "";
		const full = tokenStr ? `${label} · ${tokenStr}` : label;
		enqueue(["set-progress", Math.min(1, Math.max(0, value)).toFixed(2), "--label", full]);
	};
	const clearProgress = () => { if (progressEnabled) enqueue(["clear-progress"]); };
	const triggerFlash = (isError: boolean) => {
		if (flashLevel === "disabled") return;
		if (flashLevel === "error" && !isError) return;
		enqueue(["trigger-flash"]);
	};

	const buildTokenLabel = (): string => {
		const t = tokenTotals;
		if (t.input === 0 && t.output === 0) return "";
		const parts = [`↑${formatTokenCount(t.input)}`];
		const cache = t.cacheRead + t.cacheWrite;
		if (cache > 0) parts.push(`+${formatTokenCount(cache)} cache`);
		parts.push(`↓${formatTokenCount(t.output)}`);
		if (includeCost && t.cost > 0) parts.push(`$${t.cost < 0.01 ? t.cost.toFixed(4) : t.cost.toFixed(2)}`);
		return `tok ${parts.join(" ")}`;
	};

	const cancelFinalClear = () => { if (finalClearTimeout) { clearTimeout(finalClearTimeout); finalClearTimeout = undefined; } };
	const scheduleFinalClear = (seq: number) => {
		cancelFinalClear();
		finalClearTimeout = setTimeout(() => { finalClearTimeout = undefined; if (seq === runSequence) { clearProgress(); clearStatus(); } }, FINAL_CLEAR_DELAY_MS);
		(finalClearTimeout as any).unref?.();
	};

	pi.on("session_start", async () => {
		cancelFinalClear();
		runState = createEmptyState();
		tokenTotals = createEmptyTokens();
		agentActive = false;
		activeToolCount = 0;
		clearProgress();
		clearStatus();
	});

	pi.on("before_agent_start", async (event) => {
		runState.prompt = event.prompt?.slice(0, 120);
	});

	pi.on("agent_start", async () => {
		runSequence++;
		agentActive = true;
		cancelFinalClear();
		runState = createEmptyState(runState.prompt);
		tokenTotals = createEmptyTokens();
		activeToolCount = 0;
		setStatus("running", "Pi running");
		setProgress(0.08, "Starting");
		appendLog("progress", runState.prompt ? `Started: ${runState.prompt}` : "Run started");
	});

	pi.on("turn_start", async (event) => {
		runState.turnCount = Math.max(runState.turnCount, event.turnIndex + 1);
		setStatus("running", event.turnIndex > 0 ? `Pi turn ${event.turnIndex + 1}` : "Pi thinking");
		setProgress(estimateProgress(runState), "Thinking");
	});

	pi.on("message_end", async (event) => {
		if (!tokenTracking || !isAssistant(event.message)) return;
		const u = (event.message as AssistantMessageLike).usage;
		if (!u) return;
		tokenTotals.input += u.input ?? 0;
		tokenTotals.output += u.output ?? 0;
		tokenTotals.cacheRead += u.cacheRead ?? 0;
		tokenTotals.cacheWrite += u.cacheWrite ?? 0;
		const cost = typeof u.cost === "number" ? u.cost : (u.cost as any)?.total ?? 0;
		tokenTotals.cost += cost;
	});

	pi.on("tool_execution_start", async (event) => {
		activeToolCount++;
		setStatus("tool", `Pi ${event.toolName}`);
		setProgress(estimateProgress(runState), event.toolName);
		if (toolLogs) appendLog("progress", `Using ${event.toolName}`);
	});

	pi.on("tool_result", async (event) => {
		runState.toolCount++;
		if (event.isError) {
			const path = getPathFromInput(event);
			const err = path ? `${event.toolName} failed for ${basename(path)}` : `${event.toolName} failed`;
			if (!runState.firstToolError) runState.firstToolError = err;
			appendLog("warning", err);
			return;
		}
		if (isReadToolResult(event)) { const p = getPathFromInput(event); if (p) runState.readFiles.add(p); }
		else if (isEditToolResult(event) || isWriteToolResult(event)) {
			const p = getPathFromInput(event);
			if (p) { runState.changedFiles.add(p); appendLog("success", `Updated ${basename(p)}`); }
		}
		else if (isGrepToolResult(event) || isFindToolResult(event)) { runState.searchCount++; }
		else if (isBashToolResult(event)) { runState.bashCount++; }
	});

	pi.on("tool_execution_end", async () => {
		activeToolCount = Math.max(0, activeToolCount - 1);
		if (agentActive && activeToolCount === 0) {
			setStatus("running", "Pi thinking");
			setProgress(estimateProgress(runState), "Thinking");
		}
	});

	pi.on("agent_end", async (event) => {
		agentActive = false;
		activeToolCount = 0;
		const durationMs = Date.now() - runState.startedAt;
		const failure = summarizeFailure(event.messages, runState.firstToolError);
		const summary = failure?.summary || summarizeSuccess(runState, durationMs, thresholdMs);
		const tokenStr = tokenTracking ? buildTokenLabel() : "";
		const fullSummary = tokenStr ? `${summary} · ${tokenStr}` : summary;

		if (failure?.kind === "error") {
			setStatus("error", "Pi error"); setProgress(1, "Error"); appendLog("error", fullSummary); triggerFlash(true);
		} else if (failure?.kind === "cancelled") {
			setStatus("cancelled", "Pi cancelled"); setProgress(1, "Cancelled"); appendLog("warning", fullSummary); triggerFlash(false);
		} else if (runState.changedFiles.size > 0 || durationMs >= thresholdMs) {
			setStatus("complete", "Pi done"); setProgress(1, "Done"); appendLog("success", fullSummary); triggerFlash(false);
		} else {
			setStatus("waiting", "Pi waiting"); setProgress(1, "Waiting"); appendLog("info", fullSummary); triggerFlash(false);
		}
		scheduleFinalClear(runSequence);
	});

	pi.on("session_shutdown", async () => {
		runSequence++;
		agentActive = false;
		activeToolCount = 0;
		cancelFinalClear();
		clearProgress();
		clearStatus();
		await commandQueue.catch(() => {});
	});
}
