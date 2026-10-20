# pi-learn

Learn any subject with [pi](https://pi.dev): a persistent knowledge graph of what you know, lessons with fixed exit criteria, and visible progress.

Inspired by [amosblomqvist/learn](https://github.com/amosblomqvist/learn) and its teaching philosophy (unconditional truths first; "how could I have discovered this?"). The difference is structure. What you know is stored as data, every lesson's exit criteria are written during planning and frozen, and code decides when a node is done. The teacher can't move the goalposts or ask you the same question in ten different ways.

## Install

```bash
pi install /path/to/pi-learn            # local checkout (or git:github.com/<you>/pi-learn once published)
pi -e /path/to/pi-learn                 # try it for one session without installing
```

Then, in any directory you want to use as a learning project:

```
/learn inverse kinematics for robot arms
```

## How it works

**Planning** (`/learn <goal>`):

1. **Goal interview.** A few multiple-choice questions turn "I want to learn IK" into a concrete goal.
2. **Research.** A researcher subagent searches the web and writes a sourced scope brief.
3. **Placement.** You rate yourself on each prerequisite strand (trig, linear algebra, …). Then a short adaptive quiz binary-searches where your knowledge runs out, at most ~15 questions, so lesson one is neither arithmetic nor over your head.
4. **Plan.** A planner draws the knowledge graph from your frontier up to the goal. Foundations you already know are marked *already known* and never taught. Nodes you've learned in earlier topics are reused.
5. **Gates.** A separate gate writer writes 1–3 checks per node: free-text, multiple-choice, numeric, or code.
6. **Review.** You see the map, the lessons and every gate question. Approve it, request changes, or edit a gate. On approval the gates are frozen (hashed).

**Lessons** (one per node):

- The teacher sees only the current node: its 2–5 *beats*, the gate questions (never the answers), and how you did on the prerequisites.
- Beats are tracked. Practice questions are capped per beat, and repeats of questions you already got right are rejected. Tangents are parked for later.
- When the beats are done the gate is ready. Free-text answers come from your next chat message and are graded on ideas, not wording ("the elbow spins" counts as "the elbow rotates"). An unclear answer gets one follow-up question rather than a fail.
- A failed check is retried as the same question after the teacher helps. After 3 tries you choose: pass with assistance, mark weak and move on, keep working, or split the node into the missing foundation underneath.
- When a node closes, a summarizer writes your notes into the node's file and the next lesson starts with a clean context.

**Labs** are the exception, used only when hands-on code is much better than conversation. *Skill labs*: you implement something (e.g. damped least-squares IK) in `labs/<node>/solution.py`, and hidden tests are the gate. *Exploration labs*: a notebook with sliders. Notebooks are jupytext `.py` files you can open in VS Code or Jupyter.

## Commands

| Command | |
|---|---|
| `/learn <goal>` | Plan a new topic |
| `/learn` | Continue the active topic (or pick one) |
| `/learn <slug>` | Switch to a topic |
| `/gate` | Take the current gate; before a lesson starts, test out of a node you already know |
| `/gate cancel` | Back out of a gate without using an attempt |
| `/pass` | Close the gate (or one check) yourself; recorded as an override |
| `/dispute` | A second grader re-reads your last failed answer with your argument |
| `/unplace` | Something marked *already known* isn't. Learn it first |
| `/map [slug]` | The topic's graph, colour-coded, with parked tangents |
| `/map graph [slug]` | Open the dependency graph in a browser; hover a node to see what it builds on and unlocks |
| `/topics` | All topics with progress |
| `/lesson` | Exactly what the teacher sees for this lesson |
| `/agents` | Recent subagent runs: model, time, tokens, cost, full transcript |
| `/learn-config` | Create `.learn/config.yaml` |
| `/md-log <file>` | Mirror the session into a markdown file (append-only) |

Above the editor: topic progress (`IK · 6/14 nodes · ≈5 lessons left`), the current lesson (`beat 3/4 · turns 12/24 · Gate ready`), and a live line for every running subagent (role, model, time, tokens, current step).

## Files

```
knowledge/<id>.md          your notes, one per node; [[links]] = the graph (open as an Obsidian vault)
maps/<topic>.md, .canvas   the map as mermaid and as an Obsidian canvas
maps/<topic>.html          the interactive dependency graph (/map graph)
viz/                       diagrams
labs/<node>/               lab notebooks and solution stubs
.learn/                    system data (Obsidian ignores dot-folders, so no spoilers):
  config.yaml              models per role, grader, limits
  topics/<slug>.yaml       goal, node order, placement, backlog, lesson progress
  gates/<id>.yaml          frozen checks and rubrics, with hash
  evidence.jsonl           every attempt, override, dispute (append-only)
  agents/<role>.md         optional overrides of the bundled agent prompts
```

## Configuration

`/learn-config` writes `.learn/config.yaml`. Global defaults go in `~/.pi/agent/learn.yaml`. Every role defaults to `inherit`, meaning whatever model your pi session uses:

```yaml
models:
  teacher:     { model: anthropic/claude-opus-5-5, thinking: high }
  researcher:  { model: anthropic/claude-opus-5-5, thinking: medium }
  planner:     { model: anthropic/claude-opus-5-5, thinking: high }
  gate_writer: { model: anthropic/claude-opus-5-5, thinking: high }
  grader:      { model: anthropic/claude-sonnet-5-5 }
  diagram:     { model: anthropic/claude-sonnet-5-5 }
  lab:         { model: anthropic/claude-sonnet-5-5 }
  summarizer:  { model: anthropic/claude-haiku-5-5 }
grader: { backend: jev }          # or llm
gate: { attempts: 3, practice_per_beat: 2 }
lesson: { turns_per_beat: 6 }
learner: { notes: "I like concrete examples before formalism." }
```

## Optional extras

- **Jev** (`TYPESAFE_API_KEY`): fast, calibrated grading of free-text answers (one yes/no per rubric idea; unsure ideas go to the LLM grader), plus repeat-question detection and node de-duplication. Without it, the LLM grader does everything.
- **Web search**: uses the researcher model's native search (OpenAI, Anthropic). Otherwise it falls back to `BRAVE_API_KEY`, `TAVILY_API_KEY`, then DuckDuckGo (rate-limited).
- **Mermaid diagrams** need a Chrome-family browser. One is auto-detected; otherwise set `render.chrome` or let puppeteer download one. SVG diagrams need nothing.
- **Labs** run Python through [uv](https://docs.astral.sh/uv/) when available, with isolated environments built on the fly. Otherwise they use `python3` with numpy, matplotlib, ipywidgets and pytest installed.

## Development

```bash
npm install
npm test            # unit tests (node --test)
npm run typecheck
pi -e ./extensions/learn/index.ts -e ./extensions/questions/index.ts -e ./extensions/md-log/index.ts
```

See [DESIGN.md](DESIGN.md) for the design and its reasoning.
