# learn — design

An installable pi package for learning any subject through a persistent knowledge graph.
Inspired by [amosblomqvist/learn](https://github.com/amosblomqvist/learn): it keeps that
teaching philosophy (unconditional truths first, "how could I have discovered this?") and
its graded/ungraded question split. What changes is the structure around the teacher: what
you know lives in data, exit criteria are fixed at planning time, and code, not the model,
decides when a node is done.

## Goals

1. **Structured knowledge that persists.** One global graph of what the learner knows,
   reused across topics and sessions.
2. **Deterministic progress.** Exit criteria are written during planning and frozen. The
   teacher cannot move the goalposts, rephrase the same question forever, or declare a
   node done.
3. **Focused lessons.** A lesson lasts as long as it takes to internalize one node, and no
   longer.
4. **Visible progress.** The learner always knows where they are and roughly how much is
   left.
5. **Any subject.** Math and physics, but also conceptual and applied topics (e.g. inverse
   kinematics: theory, solving for joint angles, and code).
6. **General.** Installs with `pi install`, works on Linux/macOS, every model configurable,
   Obsidian supported but not required, optional services (Jev) degrade gracefully.

Non-goals: spaced repetition or scheduled reviews (the learner can ask for a review any
time), a web UI, multi-learner support.

## Core model

### Nodes

A **node** is one idea or skill that can be internalized in a single focused lesson and
checked by its gate. Nodes are the only persistent unit of learning. Each node has:

- `id` — stable slug named after the idea, not the topic (`linalg/jacobian`, not
  `ik/lesson-4`), so other topics can reuse it.
- `kind` — `concept` (default), `derivation`, or `skill`.
- `requires` — prerequisite node ids. The graph must stay a DAG.
- `outline` — the lesson plan: 2–5 ordered **beats**, each a single point to establish,
  with a note on how to motivate it.
- `gate` — the exit criteria (below).
- `materials` — optional attachments: diagrams, an exploration lab.
- `state` — maintained by code only (below).

**Sizing rules** (enforced by validation at planning time):
- Outline has at most 5 beats, gate at most 3 checks. Larger → split the node.
- A node whose gate would be trivially implied by its prerequisite's gate → merge it.
- A node is named for one claim or skill. "IK" is a topic; "a 2-link planar arm has up to
  two IK solutions for a reachable target" is a node.

### Topics

A **topic** is a learning goal: a goal node plus everything it transitively requires.
Topics don't own nodes; they reference them. Planning a new topic first matches proposed
nodes against existing ones, so "Jacobian as a local linear map", learned for IK, is
already passed when it shows up again under optimization.

### Lessons

A **lesson** is a run of teaching aimed at one node. It is not stored as an object; it
leaves evidence. A node may take several lessons; its gate never changes.

### Gates

A gate is 1–3 **checks**, written during planning, reviewed by the learner as part of plan
approval, then frozen with a content hash. Check types:

| Type | Graded by | Notes |
|---|---|---|
| `choice` | code | Single/multi-select, shuffled, always offers "I don't know". |
| `free` | grader subagent | Free-text answer against a rubric. |
| `numeric` | code | Value with tolerance and units. |
| `code` | code | Hidden tests run against the learner's implementation (skill nodes only). |

**Rubrics are about ideas, not wording.** A rubric is a list of required ideas, each with
`accept` examples and a narrow `reject_if` (the specific misconception that should fail).
The grader is told to judge at human-language precision: informal phrasing, synonyms, and
loose-but-correct descriptions pass ("the elbow spins" = "the elbow rotates"). A point fails
only when the idea is missing or contradicted. Failure feedback names the missing *idea*,
never a wording difference.

**Free answers come from the chat.** While a `free` check is open, the learner's next chat
message is the answer. The widget shows `Answering check 2/3, your next message is
graded`, and `/gate cancel` returns to the lesson without using an attempt. The message is
taken by an input hook and goes to the grader, not to the teacher as a normal turn.

A borderline answer earns **one clarifying follow-up** ("Can you say more about what
happens to the second solution?") instead of a fail. The follow-up is limited to one per
check per attempt by code.

### Node state machine (code only)

```
locked ──prereqs passed──▶ ready ──lesson starts──▶ learning
learning ──gate passes─────────────────────────────▶ passed
learning ──attempts exhausted, learner chooses──┬──▶ passed-assisted
                                                ├──▶ weak
                                                └──▶ split (new prereq nodes; node → locked)
any ──/pass (learner override)─────────────────────▶ passed-override
(planning) ──below placement frontier──────────────▶ placed ──gap found, learner confirms──▶ ready
```

`placed` counts as satisfied for unlocking.

`weak` counts as satisfied for unlocking, but is flagged on the progress map.

## Keeping lessons on track

The teacher is not trusted with exit criteria or pacing. Code holds the structure; the
teacher fills it in.

1. **Lesson brief, not a topic.** The teacher's context gets only the current node: its
   outline, its gate questions, the learner's evidence on prerequisites, and short summaries
   of neighbouring nodes. It does not get the whole topic to wander through. The brief is
   injected into the system prompt on every turn, so it survives any compaction.
   **Rubrics are hidden** unless the teacher calls `view_rubric(check)`. The call is logged,
   and the teacher is told to use it for diagnosing after a failed attempt, not for
   scripting the lesson. Otherwise it would teach the rubric's exact phrasing and the gate
   would only test recall.
2. **Beats are tracked.** The teacher calls `beat_done(n)` after establishing each beat.
   The widget shows beat progress. When all beats are done, code marks the gate **ready**
   and the teacher must offer it.
3. **Budget.** Each node has a planned turn budget (derived from beat count). Past the
   budget, the widget shows it and the teacher is told to wrap up and offer the gate.
4. **Practice questions don't repeat.** The teacher can pose practice questions (graded or
   not) while teaching; they only add evidence. Before a practice question is shown, it is
   checked against those already answered correctly in this node. If it's essentially the
   same question, it's rejected. (Jev judgment; LLM fallback.) Max 2 practice questions
   per beat.
5. **Tangents get parked.** Learner questions are answered briefly. Anything that would
   take more than a short answer and isn't on the outline goes to `park(tangent)`, which
   adds it to the topic's backlog (candidates for future nodes) and returns the lesson to
   the current beat.
6. **New lesson = compact + re-prompt.** A single lesson should never need compaction: a
   properly sized node fits easily, and a lesson that would fill a quarter of a 1M context
   was too big and should have been split. The problem is accumulation across lessons:
   after several nodes, earlier lessons fill the context and pull the teacher back to old
   material. So when a node closes, a summarizer writes the lesson up into the node's notes
   and evidence, and code starts the next lesson with a lesson-start message that
   re-prompts the teacher. A `context` hook drops everything before the latest lesson
   start from what the model sees, so each lesson begins clean without a compaction round
   trip. It stays one continuous pi session, and the full transcript stays on disk.

### When to take the gate

- The widget shows **Gate ready** once all beats are done, and the teacher offers it.
- `/gate` works any time. Taking it early is how you test out of something you already know.
- Before a lesson starts, `/gate` on a `ready` node offers to test out directly.

### Failing a check

- You retry **the same question**. The teacher gets the missed ideas and can explain,
  hint, or reteach, but it cannot replace or reword the check.
- 3 attempts per check (configurable). After that, the learner picks: pass with
  assistance, mark weak and move on, or split the node.
- Split: a subagent proposes 1–2 missing prerequisite nodes with their own gates. The
  learner approves them; they're frozen like any other gate. The original gate is unchanged.

### Escape hatches

- `/pass [check]` — the learner closes a check or the whole gate. Recorded as an override
  in evidence; the node becomes `passed-override`.
- `/dispute` — the learner disagrees with a grade. A second grader (the teacher-tier model)
  re-reads the answer with the rubric and the learner's argument. Its verdict stands. The
  rubric is not edited.
- The teacher can call `propose_pass(reason)` when the rubric is clearly the problem. This
  is only a proposal: it opens a confirm popup for the learner and never closes anything
  on its own.

## Planning

`/learn <goal>` starts or resumes a topic.

1. **Goal interview** (`ask_user_question`): turn "I want to understand IK" into something
   concrete, e.g. "solve 2-link and 6-DOF arms, analytic and numerical, and implement DLS
   in Python".
2. **Scope research** (researcher subagent): core concepts, real first principles,
   standard framings, common misconceptions.
3. **Placement** (below): find the learner's frontier on each prerequisite strand.
4. **Graph draft** (planner subagent): proposes nodes, edges, outlines, kinds, and
   materials, rooted at the placement frontier. Matches each proposed node against the
   existing graph and reuses it on a match.
5. **Gate authoring** (gate-writer subagent, separate from the planner): writes checks and
   rubrics per node from the outline and research brief. Separating them keeps gates from
   just echoing the outline's wording.
6. **Validation** (code): DAG, sizing rules, every outline beat covered by some check,
   every `choice` answer key resolves, `code` checks have tests that fail on the stub and
   pass on the reference.
7. **Review**: the plan is shown as a map plus a node list, with placed nodes marked. The
   learner can edit, drop, merge, re-place a strand, or ask for changes. Labs are listed
   with the planner's justification.
8. **Freeze**: gates are hashed and written. The learner can still **test out** of any
   `ready` node by taking its gate directly.

### Placement

Starting behind the frontier makes learning a slog, and starting past it means building on
sand. Placement finds the frontier before the graph is drawn, so the plan is rooted at the
right depth. It has to be quick, and it has to be cheap when it gets something wrong.

1. **Strands.** From the research brief, the planner lists the prerequisite strands for the
   goal (for IK: trigonometry, vectors and matrices, Jacobians and derivatives, rigid-body
   transforms, Python/numpy). It skips any strand already covered by passed nodes in the
   global graph, so placement gets shorter with every topic learned.
2. **Self-report** (`ask_user_question`, one per strand): never seen it / heard of it /
   can use it / can derive or explain it. This brackets the search and costs seconds.
3. **Ladders.** For each strand, a subagent writes a fixed **ladder** of 4–6 short graded
   questions from easy to hard, all in one call before any are asked (e.g. trig: evaluate
   `sin(π/6)` → law of cosines → `atan2` vs `atan` quadrants → solving `a·cosθ + b·sinθ = c`).
4. **Probe.** Code runs a binary search on each ladder, starting at the self-reported level.
   It goes up on a correct answer and down on a miss or "I don't know", with at most 3
   questions per strand and a total cap of about 15. "Never seen it" skips the strand
   (frontier at the bottom). The model doesn't choose questions or decide when to stop.
5. **Result.** The frontier on each strand is the highest rung passed. When the graph is
   drafted, nodes below the frontier are created in a `placed` state: shown on the map,
   counted as satisfied for unlocking, never taught. Nodes at or above it are taught.

Being wrong is recoverable in both directions:
- **Placed too high.** If a gate failure's missed ideas trace back to a `placed` node, or
  the learner says "I don't actually know X", that node becomes `ready` and is inserted
  before the current one. The teacher can propose this; code applies it after the learner
  confirms.
- **Placed too low.** Test out of `ready` nodes with `/gate`, or re-place a strand from the
  plan review.

### Labs are the exception

The default is a normal conversational lesson. The planner must justify every lab:

- **Skill lab**: the node is the skill (`kind: skill`, e.g. "implement damped least-squares
  IK"). Its gate is a `code` check. Use only when the goal says the learner wants to build it.
- **Exploration lab**: material attached to a concept node, used when manipulating
  something live is much better than a picture (e.g. dragging a target and watching
  elbow-up/elbow-down solutions swap). The node's gate is still a question.

Validation warns when labs exceed ~20% of a topic's nodes.

Labs are Jupyter notebooks stored as jupytext `.py` (diffable), opened in whatever
front-end the learner uses. A lab-builder subagent writes the notebook, runs it headless
(nbclient), checks that the stub fails and the reference passes, and looks at the plots
before handing it over. Default stack: numpy + matplotlib (+ ipywidgets). Heavier sims
(MuJoCo, meshcat) are opt-in per topic.

## Progress

- **Widget** (always visible above the editor):
  `IK · 6/14 nodes · Jacobian (beat 3/4) · ≈5 lessons left` and `Gate ready` when it is.
- **`/map`** draws the topic's DAG in the terminal, layered by depth, colour-coded by state,
  with the current node and the goal marked. Remaining effort is estimated from the beat
  counts of unfinished nodes.
- **Files**: the same map is written as an Obsidian canvas (`maps/<topic>.canvas`) and a
  mermaid block in `maps/<topic>.md`, so it renders in Obsidian or any markdown viewer.
- **`/map graph`** renders the mermaid graph to SVG and wraps it in `maps/<topic>.html`, opened
  in the browser: pan and zoom, and hovering or clicking a node highlights everything it builds on
  and everything it unlocks. The full DAG is too wide for a terminal, so this is the edge view.
- **`/topics`** lists topics with completion and the backlog of parked tangents.

## Subagents

Wherever work doesn't need the conversation, it goes to a subagent. This keeps the teacher's
context small and lets each role use a suitable model.

| Role | Does | Default tier |
|---|---|---|
| teacher | The main session: runs lessons | top |
| researcher | Web research, fact checks, scope briefs | top |
| planner | Graph draft, node matching, splits | top |
| gate-writer | Checks and rubrics | top |
| grader | Grades `free` answers against rubrics | Jev, else mid |
| diagram-maker | Mermaid/SVG, render-and-inspect loop | mid |
| lab-builder | Builds and verifies notebooks | mid |
| summarizer | Compacts a finished lesson into evidence | small |

Subagents run **in-process** via pi's SDK (`createAgentSession` with an in-memory session
manager, per-role model, and only that role's tools). No tmux and no dependency on another
subagent extension. Agent prompts ship as markdown in the package and can be overridden per
project.

### Seeing subagents work

Subagents must never be a silent wait. Every run is visible while it happens:

- **Activity widget** (below the progress widget, shown only while something runs): one
  line per active subagent with role, model, elapsed time, tokens, and its current step,
  e.g. `⠋ researcher · opus-5-5 · 0:42 · 18k tok · web_fetch en.wikipedia.org/wiki/Inverse_kinematics`.
  Parallel subagents each get a line.
- **Inline tool rendering**: the call that spawned the subagent streams its progress in the
  transcript (tool calls as they happen, then the final result, collapsible), like pi's
  bundled subagent example.
- **`/agents`**: an overlay listing recent runs (running, done, failed) with duration,
  cost, and the full transcript of any one of them, to see what it actually did.
- **Diagram makers** show each rendered preview as it's produced, not just the final image.
- Failures and timeouts surface as a notification and in the widget, never as a hang.

## Jev (optional)

Used where a fast, calibrated typed judgment beats generated text, through pi's built-in
classifier support (`modelRegistry.classify` with `typesafe/jev-latest`). Each use has an
LLM fallback when `TYPESAFE_API_KEY` is unset.

- **Grading free answers.** One yes/no judgment per rubric idea, one choice over the
  rubric's known misconceptions (+ none). Low-confidence points go to the LLM grader rather
  than failing.
- **Repeat detection.** "Is this practice question essentially the same as one already
  answered correctly?" Rejects rephrased repeats.
- **Node matching.** During planning, choose which existing node (or none) a proposed node
  duplicates.

Picking the next node is graph code, not a judgment.

## Storage

Plain files in the learning project, readable without the package:

```
knowledge/                     # the learner's graph; open as an Obsidian vault if wanted
  linalg/jacobian.md           # prose notes + frontmatter (id, kind, requires, state)
  ik/two-link-solutions.md
maps/
  ik.canvas, ik.md
viz/                           # rendered diagrams
labs/
  ik/dls-solver.py             # learner-facing notebook (jupytext)
.learn/                        # system data; dot-folder so Obsidian ignores it (no spoilers)
  config.yaml                  # models per role, grader backend, attempt limits
  topics/ik.yaml               # goal, node list, backlog, plan approval
  gates/linalg/jacobian.yaml   # frozen checks, rubrics, hash
  labs/ik/dls-solver/          # hidden tests, reference solution
  evidence.jsonl               # every attempt, override, dispute; append-only
```

Node notes in `knowledge/` are where lesson summaries accumulate, written for the learner.
`requires` renders as `[[links]]`, so Obsidian's graph view shows the knowledge graph.

The optional session log (port of `md-log`) appends only and never overwrites the target file.

## Configuration

```yaml
# .learn/config.yaml (project) overrides ~/.pi/agent/learn.yaml (global)
models:
  teacher:    { model: anthropic/claude-opus-5-5, thinking: high }
  researcher: { model: anthropic/claude-opus-5-5, thinking: medium }
  planner:    { model: anthropic/claude-opus-5-5, thinking: high }
  gate_writer:{ model: anthropic/claude-opus-5-5, thinking: high }
  grader:     { backend: jev, fallback: anthropic/claude-sonnet-5-5 }
  diagram:    { model: anthropic/claude-sonnet-5-5 }
  lab:        { model: anthropic/claude-sonnet-5-5 }
  summarizer: { model: anthropic/claude-haiku-5-5 }
gate:
  attempts: 3
  practice_per_beat: 2
learner:
  notes: ""          # free-form "how I learn best", appended to the teacher prompt
render:
  chrome: auto       # path or auto-detect (Linux + macOS)
```

## Package layout

```
learn/
  package.json            # pi manifest; host packages as peerDependencies
  extensions/
    learn/                # core: store, state machine, planning + lesson tools, commands, widget
    questions/            # quiz + ask_user_question + free-answer input (one shared UI lock)
    viz/                  # diagram render tools
    labs/                 # notebook build/run/test tools
    md-log/               # optional session mirror
  agents/                 # role prompts (researcher, planner, gate-writer, grader, ...)
  skills/teach/           # teaching philosophy, rewritten learner-neutral
```

## Phases

Each phase ends usable and tested.

0. **Spike.** Package skeleton loads in pi 1.3. Prove an in-process SDK subagent with its
   own model and tools, with its progress streamed to an activity widget, and a Jev call
   from an extension.
1. **Knowledge store.** Schemas for nodes, gates, topics, and evidence; DAG and sizing
   validation; gate hashing; state machine. Pure library with unit tests, no UI.
2. **Questions.** Port quiz and ask_user_question (fix package names, shared lock inside the
   package); add free-text answer input.
3. **Planning.** `/learn`, goal interview, researcher, placement (strands, self-report,
   ladders, binary search), planner, gate-writer, validation, plan review, freeze, test-out.
4. **Lessons.** Node brief in the system prompt, beats, budget, `park`, practice-question
   limits, `/gate` with chat-message answers, `view_rubric`, LLM grader with one clarifying
   follow-up, failure outcomes, split, un-placing, `/pass`, `/dispute`, `propose_pass`,
   compact + re-prompt at node close.
5. **Progress.** Widget, `/map`, canvas and mermaid export, `/topics`, `/agents` overlay.
6. **Jev.** Grader backend, repeat detection, node matching, with fallbacks.
7. **Diagrams.** Port makers with cross-platform rendering.
8. **Labs.** Skill and exploration labs, lab-builder, test runner, `code` checks.
9. **Polish.** md-log port, README, install docs, IK as the worked example topic.
