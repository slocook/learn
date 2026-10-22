import assert from "node:assert/strict";
import { test } from "node:test";
import { beatExchange } from "../src/learn/engagement.ts";
import { LESSON_START } from "../src/learn/lesson.ts";
import { nodeTranscript } from "../src/learn/vocabulary.ts";

const msg = (message: object) => ({ type: "message", message });
const teacher = (text: string) => msg({ role: "assistant", content: [{ type: "text", text }] });
const learner = (text: string) => msg({ role: "user", content: text });
const beatDone = (isError = false) => msg({ role: "toolResult", toolName: "beat_done", isError, content: [{ type: "text", text: "Beat 1 done." }] });

test("the beat exchange starts after the last accepted beat_done", () => {
	const branch = [
		{ type: "custom_message", customType: LESSON_START },
		teacher("beat one"),
		learner("an answer"),
		beatDone(),
		teacher("beat two: what happens at r = 0?"),
		learner("sure"),
		beatDone(true),
		teacher("Then predict: what happens at r = 0?"),
	];
	assert.deepEqual(
		beatExchange(branch).map((t) => `${t.who}: ${t.text}`),
		["teacher: beat two: what happens at r = 0?", "learner: sure", "teacher: Then predict: what happens at r = 0?"],
	);
});

test("without a beat_done the exchange starts at the lesson start", () => {
	const branch = [learner("old lesson"), msg({ role: "custom", customType: LESSON_START, content: "brief" }), teacher("hi"), learner("hello")];
	assert.deepEqual(beatExchange(branch).map((t) => t.who), ["teacher", "learner"]);
});

test("a node's transcript joins every lesson session for it, including before a resume", () => {
	const start = (node: string) => ({ type: "custom_message", customType: LESSON_START, details: { node } });
	const branch = [start("a"), teacher("yaw turns the leg"), learner("ok"), start("b"), teacher("other node"), start("a"), teacher("resumed")];
	assert.equal(nodeTranscript(branch, "a"), "TEACHER: yaw turns the leg\n\nLEARNER: ok\n\nTEACHER: resumed");
});
