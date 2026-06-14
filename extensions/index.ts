import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cmuxNotifyExtension from "./cmux-notify.ts";
import cmuxSidebarExtension from "./cmux-sidebar.ts";
import cmuxSplitExtension from "./cmux-split.ts";
import cmuxOpenExtension from "./cmux-open.ts";
import cmuxContinueExtension from "./cmux-continue.ts";
import cmuxReviewExtension from "./cmux-review.ts";
import cmuxZoxideExtension from "./cmux-zoxide.ts";

export default function piCmuxExtension(pi: ExtensionAPI) {
	cmuxNotifyExtension(pi);
	cmuxSidebarExtension(pi);
	cmuxSplitExtension(pi);
	cmuxOpenExtension(pi);
	cmuxContinueExtension(pi);
	cmuxReviewExtension(pi);
	cmuxZoxideExtension(pi);
}
