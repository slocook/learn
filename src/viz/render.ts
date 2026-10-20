import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { runProcess } from "../labs/run.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const BROWSER_CANDIDATES = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
	"microsoft-edge",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function onPath(cmd: string): string | undefined {
	if (cmd.includes("/")) return fs.existsSync(cmd) ? cmd : undefined;
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const full = path.join(dir, cmd);
		if (fs.existsSync(full)) return full;
	}
	return undefined;
}

/** A Chrome-family browser for mermaid-cli: config, then env, then common installs. Undefined lets puppeteer use its own. */
export function findBrowser(configured?: string): string | undefined {
	if (configured && fs.existsSync(configured)) return configured;
	const env = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (env && fs.existsSync(env)) return env;
	for (const c of BROWSER_CANDIDATES) {
		const found = onPath(c);
		if (found) return found;
	}
	return undefined;
}

function mmdcBin(): string {
	const local = path.join(PACKAGE_ROOT, "node_modules", ".bin", "mmdc");
	if (fs.existsSync(local)) return local;
	const found = onPath("mmdc");
	if (!found) throw new Error("mermaid-cli (mmdc) is not installed; run npm install in the pi-learn package");
	return found;
}

export async function renderMermaid(source: string, outFile: string, browser?: string): Promise<void> {
	const outPng = path.resolve(outFile);
	fs.mkdirSync(path.dirname(outPng), { recursive: true });
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-learn-mmd-"));
	const input = path.join(work, "diagram.mmd");
	fs.writeFileSync(input, source, "utf8");
	const puppeteer = path.join(work, "puppeteer.json");
	const exe = findBrowser(browser);
	fs.writeFileSync(puppeteer, JSON.stringify({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox", "--disable-gpu"] }), "utf8");
	const res = await runProcess(mmdcBin(), ["-i", input, "-o", outPng, "-b", "white", "-s", "2", "-p", puppeteer, "-q"], { cwd: work, timeoutMs: 120_000 });
	if (res.code !== 0 || !fs.existsSync(outPng)) {
		const err = `${res.stderr}\n${res.stdout}`.trim().split("\n").slice(-12).join("\n");
		throw new Error(res.timedOut ? "mermaid rendering timed out" : err || "mermaid rendering failed");
	}
}

let sansFamily: string | undefined;

/** The system's sans-serif family (resvg assumes Arial, which many Linux systems lack). */
function systemSans(): string {
	if (sansFamily === undefined) {
		try {
			sansFamily = execFileSync("fc-match", ["-f", "%{family}", "sans-serif"], { encoding: "utf8", timeout: 5000 }).split(",")[0]!.trim();
		} catch {
			sansFamily = "";
		}
		if (!sansFamily) sansFamily = process.platform === "darwin" ? "Helvetica" : "Arial";
	}
	return sansFamily;
}

export function renderSvg(source: string, outPng: string): void {
	const resvg = new Resvg(source, {
		background: "white",
		fitTo: { mode: "width", value: 1200 },
		font: { loadSystemFonts: true, sansSerifFamily: systemSans(), defaultFontFamily: systemSans() },
	});
	fs.mkdirSync(path.dirname(outPng), { recursive: true });
	fs.writeFileSync(outPng, resvg.render().asPng());
}

export function publishName(slug: string): string {
	const clean =
		slug
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "viz";
	return `viz-${clean}-${Date.now()}.png`;
}
