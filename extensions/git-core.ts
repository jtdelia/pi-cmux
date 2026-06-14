import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const GIT_TIMEOUT_MS = 10000;

export interface GitExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface GitRepoInfo {
	repoRoot: string;
	branch?: string;
	statusLines: string[];
}

export async function execGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<GitExecResult> {
	const result = await pi.exec("git", args, { timeout: GIT_TIMEOUT_MS, cwd });
	if (result.killed) return { ok: false, stdout: result.stdout, stderr: result.stderr, error: "git timed out" };
	if (result.code !== 0) {
		return { ok: false, stdout: result.stdout, stderr: result.stderr, error: result.stderr.trim() || `git exited ${result.code}` };
	}
	return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

export async function getGitRepoInfo(pi: ExtensionAPI, cwd: string): Promise<GitRepoInfo | undefined> {
	const rootResult = await execGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootResult.ok) return undefined;
	const repoRoot = rootResult.stdout.trim();
	if (!repoRoot) return undefined;

	const branchResult = await execGit(pi, cwd, ["branch", "--show-current"]);
	const statusResult = await execGit(pi, cwd, ["status", "--short", "--untracked-files=all"]);

	return {
		repoRoot,
		branch: branchResult.ok ? branchResult.stdout.trim() || undefined : undefined,
		statusLines: statusResult.ok
			? statusResult.stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0).slice(0, 20)
			: [],
	};
}

export async function branchExists(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<boolean> {
	const result = await pi.exec("git", ["show-ref", "--verify", "--", `refs/heads/${branch}`], { timeout: GIT_TIMEOUT_MS, cwd: repoRoot });
	return !result.killed && result.code === 0;
}

function slugifyBranch(branch: string): string {
	return branch.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "worktree";
}

export async function ensureCreatedBranchWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	branch: string,
	fromRef?: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	if (await branchExists(pi, repoRoot, branch)) {
		return { ok: false, error: `Branch already exists: ${branch}` };
	}

	const worktreeRoot = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
	const targetPath = join(worktreeRoot, slugifyBranch(branch));
	if (existsSync(targetPath)) {
		return { ok: false, error: `Worktree path already exists: ${targetPath}` };
	}

	mkdirSync(worktreeRoot, { recursive: true });
	const args = ["worktree", "add", "-b", branch, targetPath];
	if (fromRef?.trim()) args.push(fromRef.trim());

	const result = await execGit(pi, repoRoot, args);
	if (!result.ok) return { ok: false, error: result.error || "Failed to create worktree" };
	return { ok: true, path: targetPath };
}
