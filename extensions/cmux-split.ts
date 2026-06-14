import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextualTabTitle, buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

async function openPiSplit(pi: ExtensionAPI, ctx: ExtensionCommandContext, direction: SplitDirection, args: string): Promise<void> {
	const prompt = args.trim() || undefined;
	const result = await openCommandInNewSplit(
		pi,
		direction,
		buildPiCommand(ctx.cwd, { prompt }),
		{ tabTitle: await buildContextualTabTitle(pi, ctx.cwd, prompt, "Pi") },
	);
	if (result.ok) {
		ctx.ui.notify(`Opened ${direction === "right" ? "vertical" : "horizontal"} split`, "info");
	} else {
		ctx.ui.notify(`cmux split failed: ${result.error}`, "error");
	}
}

export default function cmuxSplitExtension(pi: ExtensionAPI) {
	pi.registerCommand("cmv", {
		description: "Open a new right split with a fresh pi session",
		handler: async (args, ctx) => openPiSplit(pi, ctx, "right", args),
	});

	pi.registerCommand("cmh", {
		description: "Open a new lower split with a fresh pi session",
		handler: async (args, ctx) => openPiSplit(pi, ctx, "down", args),
	});
}
