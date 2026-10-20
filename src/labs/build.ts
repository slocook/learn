import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activity } from "../agents/activity.ts";
import { runAgent } from "../agents/runner.ts";
import { LabResultSchema } from "../agents/schemas.ts";
import type { LearnRuntime } from "../learn/runtime.ts";
import type { KNode } from "../types.ts";
import { labDirs, runPython, runTests } from "./run.ts";

const NOTEBOOK_RUNNER = `import os, sys, runpy
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
out = os.environ["LEARN_FIG_DIR"]
os.makedirs(out, exist_ok=True)
count = [0]
def _show(*args, **kwargs):
    for num in plt.get_fignums():
        count[0] += 1
        plt.figure(num).savefig(os.path.join(out, f"fig{count[0]}.png"), dpi=80, bbox_inches="tight")
    plt.close("all")
plt.show = _show
notebook = os.path.abspath(sys.argv[1])
sys.path.insert(0, os.path.dirname(notebook))
if os.environ.get("LEARN_SOLUTION_DIR"):
    sys.path.insert(0, os.environ["LEARN_SOLUTION_DIR"])
runpy.run_path(notebook, run_name="__main__")
_show()
`;

/** Resolve "lab/…" or "hidden/…" to a real path inside this node's lab directories, or throw. */
function resolveLabPath(dirs: { lab: string; hidden: string }, p: string): string {
	const m = /^(lab|hidden)\/(.+)$/.exec(p.replace(/\\/g, "/").replace(/^\.\//, ""));
	if (!m) throw new Error('paths must start with "lab/" (learner-visible) or "hidden/" (tests, reference)');
	const base = m[1] === "lab" ? dirs.lab : dirs.hidden;
	const full = path.resolve(base, m[2]!);
	if (!full.startsWith(base + path.sep)) throw new Error("path escapes the lab directory");
	return full;
}

function tail(text: string, max = 6000): string {
	return text.length > max ? `…${text.slice(-max)}` : text;
}

export function labTools(cwd: string, node: KNode, onPreview: (file: string) => void) {
	const dirs = labDirs(cwd, node.id);
	const isSkill = node.lab?.type === "skill";
	const tools = [
		defineTool({
			name: "write_file",
			label: "write",
			description: 'Write a lab file. Paths start with "lab/" (learner-visible: notebook.py, solution.py, README.md) or "hidden/" (test_solution.py, reference.py, requirements.txt).',
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			async execute(_id, params) {
				const file = resolveLabPath(dirs, params.path);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, params.content, "utf8");
				return { content: [{ type: "text", text: `Wrote ${params.path} (${params.content.split("\n").length} lines).` }], details: undefined };
			},
		}),
		defineTool({
			name: "read_file",
			label: "read",
			description: 'Read a lab file ("lab/…" or "hidden/…").',
			parameters: Type.Object({ path: Type.String() }),
			async execute(_id, params) {
				return { content: [{ type: "text", text: fs.readFileSync(resolveLabPath(dirs, params.path), "utf8") }], details: undefined };
			},
		}),
		defineTool({
			name: "run_notebook",
			label: "run notebook",
			description:
				"Run lab/notebook.py headless as a script. Figures shown with plt.show() come back as images: LOOK at them. With solution=reference, `import solution` resolves to hidden/reference.py.",
			parameters: Type.Object({ solution: Type.Optional(Type.Union([Type.Literal("stub"), Type.Literal("reference")])) }),
			async execute(_id, params, signal) {
				const notebook = path.join(dirs.lab, "notebook.py");
				if (!fs.existsSync(notebook)) throw new Error("lab/notebook.py does not exist yet");
				const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-learn-lab-"));
				const runner = path.join(work, "run_notebook.py");
				fs.writeFileSync(runner, NOTEBOOK_RUNNER, "utf8");
				const env: Record<string, string> = { LEARN_FIG_DIR: path.join(work, "figs") };
				if (params.solution === "reference") {
					const sol = path.join(work, "solution");
					fs.mkdirSync(sol);
					fs.copyFileSync(path.join(dirs.hidden, "reference.py"), path.join(sol, "solution.py"));
					env.LEARN_SOLUTION_DIR = sol;
				}
				const res = await runPython(cwd, [runner, notebook], { requirements: path.join(dirs.hidden, "requirements.txt"), env, signal });
				const figDir = env.LEARN_FIG_DIR!;
				const figs = fs.existsSync(figDir) ? fs.readdirSync(figDir).sort().map((f) => path.join(figDir, f)) : [];
				const images: ImageContent[] = figs.slice(0, 6).map((f) => ({ type: "image", data: fs.readFileSync(f).toString("base64"), mimeType: "image/png" }));
				for (const f of figs) onPreview(f);
				const status = res.timedOut ? "TIMED OUT" : res.code === 0 ? "OK" : `FAILED (exit ${res.code})`;
				return {
					content: [{ type: "text", text: `${status}. ${figs.length} figure(s).\n${tail(`${res.stdout}\n${res.stderr}`.trim())}` }, ...images],
					details: undefined,
				};
			},
		}),
	];
	if (isSkill) {
		tools.push(
			defineTool({
				name: "run_tests",
				label: "run tests",
				description: "Run hidden/test_solution.py against lab/solution.py (the stub; must FAIL) or hidden/reference.py (must PASS).",
				parameters: Type.Object({ against: Type.Union([Type.Literal("stub"), Type.Literal("reference")]) }),
				async execute(_id, params, signal) {
					const solution = params.against === "stub" ? path.join(dirs.lab, "solution.py") : path.join(dirs.hidden, "reference.py");
					const r = await runTests(cwd, path.join(dirs.hidden, "test_solution.py"), solution, signal);
					return { content: [{ type: "text", text: `${r.passed ? "PASSED" : "FAILED"}\n${tail(r.output)}` }], details: undefined };
				},
			}) as (typeof tools)[number],
		);
	}
	return tools;
}

/** Build and verify a node's lab with the lab-builder subagent. */
export async function buildLab(rt: LearnRuntime, ctx: ExtensionContext, node: KNode): Promise<void> {
	if (!node.lab) return;
	const dirs = labDirs(rt.cwd, node.id);
	const gate = rt.store.getGate(node.id);
	const codeChecks = gate?.checks.filter((c) => c.type === "code") ?? [];
	let runRef: ReturnType<typeof activity.start> | undefined;
	const tools = labTools(rt.cwd, node, (file) => {
		if (runRef) activity.update(runRef, { previews: [...runRef.previews, file] });
	});
	const task = [
		`## Node\n${node.title} (\`${node.id}\`, ${node.kind})`,
		`## Outline\n${node.outline.map((b, i) => `${i + 1}. ${b.point}`).join("\n")}`,
		`## Lab\nType: ${node.lab.type}\nWhy: ${node.lab.justification}\nSpec: ${node.lab.spec}`,
		codeChecks.length > 0 ? `## Code checks the learner must pass (write tests for exactly these)\n${codeChecks.map((c) => `- ${c.prompt}`).join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const { output } = await runAgent(rt.agentEnv(ctx), {
		role: "lab",
		prompt: "lab-builder",
		label: `building lab: ${node.title}`,
		task,
		tools,
		output: LabResultSchema,
		onUpdate: (run) => {
			runRef = run;
		},
	});
	if (output?.status !== "ok") throw new Error(output?.reason ?? "the lab builder could not build it");

	if (node.lab.type === "skill") {
		const test = path.join(dirs.hidden, "test_solution.py");
		const stub = await runTests(rt.cwd, test, path.join(dirs.lab, "solution.py"));
		const ref = await runTests(rt.cwd, test, path.join(dirs.hidden, "reference.py"));
		if (stub.passed) throw new Error("the tests pass on the unimplemented stub, so they check nothing");
		if (!ref.passed) throw new Error(`the reference solution fails its own tests: ${ref.summary}`);
	}
	if (!fs.existsSync(path.join(dirs.lab, "README.md"))) {
		fs.writeFileSync(path.join(dirs.lab, "README.md"), `# Lab: ${node.title}\n\n${output.notes}\n`, "utf8");
	}
	const fresh = rt.store.getNode(node.id) ?? node;
	fresh.lab = { ...node.lab, built: true, path: path.relative(rt.cwd, dirs.lab) };
	rt.store.saveNode(fresh, rt.titles());
	rt.note(`Lab ready: \`${path.relative(rt.cwd, dirs.lab)}/\`. ${output.notes}`, "success");
}
