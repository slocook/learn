import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeCheck } from "../types.ts";

export const BASE_PACKAGES = ["numpy", "matplotlib", "ipywidgets", "pytest"];

export interface ProcResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export function runProcess(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<ProcResult> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
		} catch (e) {
			resolve({ code: null, stdout: "", stderr: String(e), timedOut: false });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const kill = () => child.kill("SIGKILL");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutMs);
		opts.signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", kill);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

let uvAvailable: boolean | undefined;

async function hasUv(cwd: string): Promise<boolean> {
	if (uvAvailable === undefined) uvAvailable = (await runProcess("uv", ["--version"], { cwd, timeoutMs: 10_000 })).code === 0;
	return uvAvailable;
}

/**
 * Run Python with the lab packages available. With uv, an isolated cached environment is built
 * on the fly; without it, the system python3 is used as-is.
 */
export async function runPython(cwd: string, args: string[], opts: { requirements?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ProcResult> {
	const timeoutMs = opts.timeoutMs ?? 180_000;
	if (await hasUv(cwd)) {
		const uvArgs = ["run", "--quiet", "--no-project", ...BASE_PACKAGES.flatMap((p) => ["--with", p])];
		if (opts.requirements && fs.existsSync(opts.requirements)) uvArgs.push("--with-requirements", opts.requirements);
		return runProcess("uv", [...uvArgs, "python", ...args], { cwd, env: { MPLBACKEND: "Agg", PYTHONDONTWRITEBYTECODE: "1", ...opts.env }, timeoutMs, signal: opts.signal });
	}
	return runProcess("python3", args, { cwd, env: { MPLBACKEND: "Agg", PYTHONDONTWRITEBYTECODE: "1", ...opts.env }, timeoutMs, signal: opts.signal });
}

export function labDirs(cwd: string, nodeId: string): { lab: string; hidden: string } {
	return { lab: path.join(cwd, "labs", nodeId), hidden: path.join(cwd, ".learn", "labs", nodeId) };
}

/** Run the hidden tests against a solution file. */
export async function runTests(cwd: string, testFile: string, solutionFile: string, signal?: AbortSignal): Promise<{ passed: boolean; output: string; summary: string }> {
	const requirements = path.join(path.dirname(testFile), "requirements.txt");
	const res = await runPython(cwd, ["-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider", testFile], {
		requirements,
		env: { LEARN_SOLUTION: solutionFile },
		signal,
	});
	const output = `${res.stdout}\n${res.stderr}`.trim();
	if (res.timedOut) return { passed: false, output, summary: "the tests timed out (is there an infinite loop?)" };
	const last = output.split("\n").filter((l) => l.trim()).at(-1) ?? "";
	const failures = [...output.matchAll(/^FAILED (\S+)(?: - (.*))?$/gm)].map((m) => `${m[1]!.split("::").at(-1)}${m[2] ? `: ${m[2]}` : ""}`);
	const summary = res.code === 0 ? last : failures.length > 0 ? `${last}\n${failures.slice(0, 5).map((f) => `- ${f}`).join("\n")}` : last || "tests could not run";
	return { passed: res.code === 0, output, summary };
}

export async function runCodeCheck(cwd: string, check: CodeCheck, signal?: AbortSignal): Promise<{ passed: boolean; summary: string }> {
	const test = path.resolve(cwd, check.test_file);
	const solution = path.resolve(cwd, check.solution_file);
	if (!fs.existsSync(test) || !fs.existsSync(solution)) {
		return { passed: false, summary: `the lab files are missing (${check.solution_file}); the lab may not have been built` };
	}
	const r = await runTests(cwd, test, solution, signal);
	return { passed: r.passed, summary: r.summary };
}
