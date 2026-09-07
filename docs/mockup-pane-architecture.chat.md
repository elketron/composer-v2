---
title: "composer - Mockup pane architecture"
source: "https://chatgpt.com/g/g-p-6943f0dc8fb08191b62b8832a628038a/c/6a9e8da3-1a64-83ed-ac07-4ccba044e9c4"
author:
published:
created: 2026-09-07
description: "Use ChatGPT to answer questions, write, create images, complete work, and code—all in one place. Get started for free or download the app."
tags:
  - "clippings"
---
I think that's a strong change. It actually **removes UI complexity while strengthening the pipeline model**.

The abstraction I'd preserve when implementing it is:

> **Column = workflow stage. Stage = executor + transition rules.**

Not `column = agent`, because that would unnecessarily constrain you later.

That naturally accommodates:

```markdown
Planning        Implementation      Review          Approval       Done
   │                  │                │                │
 Planner            Coder           Tester           Human
 agent              agent            agent            gate
```

And later:

```markdown
Research → Plan → Generate → Evaluate → Human approval → Publish
```

works equally well for image/video workflows without inventing another board model.

It also gives the board and pipeline views a really nice relationship: **the board shows where work is; the pipeline view shows what happens to move it.**

That feels worth getting into v0.1 because it's not really another feature—it's simplifying an existing one around the model you're already converging on.

also the generalized case is not "one pipeline step is one kanban row". because "build the project" can be a step and that would be mostly noise

Right. That's the important distinction. **The Kanban is a projection of the pipeline, not a visualization of every pipeline step.**

Some pipeline steps represent meaningful work states:

```markdown
Plan → Implement → Review → Done
```

Others are execution mechanics:

```markdown
checkout
install deps
build
run tests
collect artifacts
cleanup
```

Putting all of those on the board would immediately destroy its usefulness.

So I'd give pipeline steps an explicit presentation/semantic role, rather than deriving Kanban columns mechanically:

```markdown
type PipelineStep = {
  id: string
  executor: Executor

  // Only meaningful workflow stages become board columns.
  stage?: {
    id: string
    label: string
  }
}
```

Then multiple execution steps can happen *inside* one Kanban stage:

```markdown
┌──────────── IMPLEMENTATION ────────────┐
│                                       │
│  coding agent                         │
│       ↓                               │
│  build                                │
│       ↓                               │
│  tests                                │
│       ↓                               │
│  artifact collection                  │
│                                       │
└───────────────────────────────────────┘
                    ↓
┌─────────────── REVIEW ────────────────┐
│ reviewer agent                        │
└───────────────────────────────────────┘
```

That gives you three levels that are actually quite clean:

**Board → stages of work**  
**Pipeline → execution graph that moves work between stages**  
**Run → concrete execution of those steps**

And it means a stage isn't necessarily synonymous with an agent either. `Implementation` might contain an agent step, build step, test step, and retry logic. The board only cares that the ticket is currently **in Implementation**.

I'd probably even make the pipeline DSL/config explicitly distinguish `stage` from `step`. That's a useful semantic distinction beyond just UI rendering.

Yeah, exactly. That’s probably the right place for it.

The board column should stay at the **meaningful workflow stage**, while the card can expose the current finer-grained execution state:

```markdown
IMPLEMENTATION

┌──────────────────────────────┐
│ Add Jira sync               │
│                              │
│ ● Building                   │
│                              │
│ Coder · 12m                  │
└──────────────────────────────┘
```

Then the same card might move through internal substates without changing columns:

```markdown
Implementation
  ├─ Starting agent
  ├─ Editing
  ├─ Building
  ├─ Testing
  ├─ Fixing tests
  └─ Ready for review
```

That gives you the useful detail without turning `Building`, `Testing`, `Installing dependencies`, etc. into top-level Kanban stages.

I’d probably model those as **run/substage status**, distinct from board stage:

```markdown
type CardExecutionState = {
  stageId: "implementation"
  substage?: "editing" | "building" | "testing" | "waiting"
}
```

And the card renderer can surface that very prominently when active.

So visually you get a nice hierarchy:

**column = where the work is in the overall process**  
**card status = what is happening to it right now**  
**pipeline/run view = full execution detail**

That feels much cleaner than trying to make one representation serve all three levels.
