import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildContextualTabTitle,
	buildShellCommand,
	openCommandInNewSplit,
	openCommandInNewTab,
	type SplitDirection,
} from "./cmux-core.ts";

type TerminalPlacement = SplitDirection | "tab";

async function openTool(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	command: string,
	placement: TerminalPlacement,
	title?: string,
	focus?: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const tabTitle = await buildContextualTabTitle(pi, ctx.cwd, title ?? command, "Tool");
	if (placement === "tab") {
		return openCommandInNewTab(pi, buildShellCommand(ctx.cwd, command), { tabTitle, focus });
	}
	return openCommandInNewSplit(pi, placement, buildShellCommand(ctx.cwd, command), { tabTitle, focus });
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch { return undefined; }
}

interface ConfiguredCommand {
	run: string;
	acceptArgs: boolean;
	direction: SplitDirection;
	description: string;
}

function loadConfiguredCommands(cwd: string): Map<string, ConfiguredCommand> {
	const commands = new Map<string, ConfiguredCommand>();
	const paths = [join(homedir(), ".pi", "agent", "settings.json"), join(cwd, ".pi", "settings.json")];

	for (const path of paths) {
		const settings = readJsonFile(path);
		const section = settings?.["pi-cmux"] as Record<string, unknown> | undefined;
		if (!section || typeof section !== "object") continue;
		const cmds = section.commands as Record<string, unknown> | undefined;
		if (!cmds || typeof cmds !== "object") continue;

		for (const [name, value] of Object.entries(cmds)) {
			if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue;

			if (typeof value === "string") {
				if (value.trim()) commands.set(name, { run: value.trim(), acceptArgs: false, direction: "right", description: `Open ${value.trim()} in a split` });
				continue;
			}
			if (typeof value === "object" && value && !Array.isArray(value)) {
				const v = value as Record<string, unknown>;
				if (v.disabled === true) { commands.delete(name); continue; }
				const run = typeof v.run === "string" ? v.run.trim() : "";
				if (!run) continue;
				const dir = v.direction === "down" ? "down" as const : "right" as const;
				commands.set(name, {
					run,
					acceptArgs: v.acceptArgs === true,
					direction: dir,
					description: typeof v.description === "string" ? v.description : `Open ${run} in a split`,
				});
			}
		}
	}
	return commands;
}

const RESERVED = new Set(["login", "logout", "model", "settings", "resume", "new", "tree", "fork", "compact", "reload", "quit", "exit", "help", "cmv", "cmh", "cmo", "cmoh", "cmt", "cmz", "cmzh", "cmcv", "cmch", "cmrv", "cmrh"]);

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	// Slash commands
	pi.registerCommand("cmo", {
		description: "Open a command in a right split",
		handler: async (args, ctx) => {
			const cmd = args.trim();
			if (!cmd) { ctx.ui.notify("Usage: /cmo <command>", "warning"); return; }
			const r = await openTool(pi, ctx, cmd, "right");
			r.ok ? ctx.ui.notify("Opened tool split", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});

	pi.registerCommand("cmoh", {
		description: "Open a command in a lower split",
		handler: async (args, ctx) => {
			const cmd = args.trim();
			if (!cmd) { ctx.ui.notify("Usage: /cmoh <command>", "warning"); return; }
			const r = await openTool(pi, ctx, cmd, "down");
			r.ok ? ctx.ui.notify("Opened tool split", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});

	pi.registerCommand("cmt", {
		description: "Open a command in a new cmux tab",
		handler: async (args, ctx) => {
			const cmd = args.trim();
			if (!cmd) { ctx.ui.notify("Usage: /cmt <command>", "warning"); return; }
			const r = await openTool(pi, ctx, cmd, "tab");
			r.ok ? ctx.ui.notify("Opened tool tab", "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
		},
	});

	// Configured shortcuts
	for (const [name, config] of loadConfiguredCommands(process.cwd())) {
		if (RESERVED.has(name.toLowerCase())) continue;
		pi.registerCommand(name, {
			description: config.description,
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (trimmed && !config.acceptArgs) { ctx.ui.notify(`Usage: /${name}`, "warning"); return; }
				const cmd = trimmed ? `${config.run} ${trimmed}` : config.run;
				const r = await openTool(pi, ctx, cmd, config.direction);
				r.ok ? ctx.ui.notify(`Opened /${name}`, "info") : ctx.ui.notify(`Failed: ${r.error}`, "error");
			},
		});
	}

	// LLM-callable tool
	pi.registerTool({
		name: "cmux_open_terminal",
		label: "Open cmux terminal",
		description: "Open an interactive terminal command in cmux as a right split, lower split, or new tab.",
		promptSnippet: "Open an interactive terminal command in cmux when the user asks for a tool or view in another pane, split, tab, or background terminal.",
		promptGuidelines: [
			"Use cmux_open_terminal only when the user explicitly asks to open a command in cmux, another pane, split, tab, or background terminal.",
			"Use cmux_open_terminal with placement='tab' for tabs, placement='right' for side panes, placement='down' for lower panes.",
			"Use cmux_open_terminal for interactive TUIs like k9s, lazygit, htop, log tails, dev servers; do not use bash for these unless the user wants captured output.",
			"Do not open terminals proactively with cmux_open_terminal without a user request.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Terminal command to run (e.g. k9s, npm run dev, lazygit)" }),
			placement: StringEnum(["right", "down", "tab"] as const, { description: "Where to open. Defaults to tab.", default: "tab" }),
			title: Type.Optional(Type.String({ description: "Optional tab title" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const placement: TerminalPlacement = params.placement || "tab";
			const result = await openTool(pi, ctx, params.command, placement, params.title);
			if (!result.ok) throw new Error(result.error);
			const label = placement === "tab" ? "tab" : placement === "right" ? "right split" : "lower split";
			return {
				content: [{ type: "text", text: `Opened ${params.command} in a cmux ${label}.` }],
				details: { command: params.command, placement, cwd: ctx.cwd },
			};
		},
	});
}
