---
title: "composer - Integrated Project Finder"
source: "https://chatgpt.com/g/g-p-6943f0dc8fb08191b62b8832a628038a/c/6a9e725c-386c-83eb-abcd-625de8504b44"
author:
published:
created: 2026-09-07
description: "Use ChatGPT to answer questions, write, create images, complete work, and code—all in one place. Get started for free or download the app."
tags:
  - "clippings"
---
Ah yeah, that makes more sense. **Pipeline visualization/debugging**, not a general architecture designer.

Then it maps almost perfectly onto the pipeline section already present in the ticket/run UI:

```markdown
retrieve context ──→ implement ──→ write tests ──→ validation
                                                   │
                                              ┌────┴────┐
                                              ▼         ▼
                                           review    remediate
                                              │         │
                                              └────←────┘
                                              │
                                              ▼
                                         human review
```

The canvas becomes useful once pipelines stop being purely linear. Conditions, retries, parallel agents, sub-agents, fallback models, approval gates, etc. become awful to understand as a checklist but trivial as a graph.

And during a live run, the same graph can visualize execution state: completed nodes, currently running nodes, failed nodes, skipped branches, and clicking a node opens that stage's run/output.

That also means you can reuse essentially the same component for **pipeline definition** and **pipeline execution**, with definition mode being editable and run mode being a read-only graph decorated with runtime state.

That feels much more valuable than building another generic node editor.

![c8b7bf79-fad8-4aa3-821d-9d349a3274fc.png](https://chatgpt.com/backend-api/estuary/content?id=file_00000000255481f4aae5c887ec6350d1&ts=496887&p=fs&cid=1&sig=76644685432c2be9a356a1dd99932f79acdc9d3802f8ebf798008f11cbf65875&v=0)

but the coolest one is actually already the assistant view. and its the most functional today

Yeah, I can see why. The assistant view is already basically the **general-purpose interface into Composer**.

What makes it interesting is that it isn't just chat. From the screenshot, the model is already grounding itself through Composer itself: checking the project overview, searching Composer knowledge, listing files, reading the actual codebase, etc. And the project scope in the top-right means the conversation has an explicit working context rather than “here's a chatbot, hopefully it knows what I'm talking about.”

The `THREADS / KNOWLEDGE` split is also a good foundation. Eventually I could see the assistant becoming the place where you do all the weird, unstructured stuff that doesn't deserve a dedicated workflow:

> “Why did these three runs fail?”

> “Look through these two projects and tell me where this abstraction should live.”

> “What was the reasoning behind this architecture?”

> “Create tickets for the problems you find.”

> “Compare this implementation against what we planned.”

Meanwhile the board/pipelines/runs handle the **structured execution**.

And multi-threading is actually pretty important here. You can have one thread doing architecture research for 15 minutes while another investigates a bug and another answers something quick. Since Composer is server-backed, those don't need to correspond to one foreground UI interaction either.

The rough tool-call rendering is probably the most obvious thing I'd improve in this view. The raw JSON is useful for debugging Composer itself right now, but eventually:

```markdown
✓ Project overview
✓ Searched knowledge: "agent framework pipeline AI integration"
✓ Listed project files
⟳ Reading implementation...
```

with the raw arguments/results expandable would preserve everything without having a giant JSON wall.

But functionally, yeah: **this already looks like the part I'd personally use constantly while developing.** The other views are building the autonomous workflow around what is already a pretty capable project-aware engineering assistant.

it can also be scoped over multiple project (going to improve the UX of it). do research, create tickets and create knowledge that is global

Yeah, that changes the assistant from “project chat” into something closer to the **cross-project intelligence layer of Composer**.

The multiple-project scope is particularly powerful because a lot of useful engineering questions aren't actually bounded by a repo:

> “We need agent functionality in `dotnet-automations-fa`. Look at how I implemented agents in these three other projects, research the current ecosystem, and recommend what fits here.”

Then from that same conversation it can turn the result into persistent state:

```markdown
Assistant
   │
   ├── inspect ──────► Project A
   │                  Project B
   │                  Project C
   │
   ├── research ─────► external sources
   │
   ├── remember ─────► global knowledge
   │
   └── act ──────────► tickets / plans
                           │
                           ▼
                     autonomous pipelines
```

And **global knowledge** is the part that makes this compound over time. Research doesn't have to disappear into an old chat. Something like “for simple extraction agents we prefer X; use Y when orchestration becomes dynamic; here are the tradeoffs we found” becomes available to future assistants and planning agents across every project.

That gives Composer three useful scopes almost naturally:

**conversation context → selected project(s) → global Composer knowledge.**

Then the assistant is also a bridge between the fuzzy and structured sides of Composer. You can start with an extremely vague conversation, let it inspect/research until the idea solidifies, have it write durable knowledge where appropriate, and finally say **“cool, make the tickets.”**

From there the board takes over.

That's a much more interesting interface than making every interaction start with a coding agent. The assistant handles **understanding and intent**, while the ticket/pipeline system handles **execution**.

and the rendering of toolcalls is one of the last items. since it is a massive undertaking to do that part correclty and if it is still undergoing development rapidly then its not worth it

Yeah, that’s the right tradeoff. Tool-call rendering is one of those features where doing it “properly” means you’re effectively building a mini observability/debugging UI for every tool type.

While the tool schema, execution model, streaming format, nested calls, retries, sub-agents, and result shapes are still moving, polishing the renderer just creates migration work. Raw JSON is ugly, but it’s lossless and cheap.

I’d postpone the polished renderer until the underlying event model stabilizes, then build it against a generic execution-event abstraction rather than against individual tools. Something like:

```markdown
ToolCall
├── name
├── status
├── startedAt
├── duration
├── input
├── output
├── error
├── artifacts[]
└── childCalls[]
```

Then rendering becomes mostly presentation logic:

```markdown
bash          → command + stdout/stderr
read          → path + preview
search        → query + result count
write/edit    → path + diff
agent         → nested run
generic tool  → structured key/value fallback
```

That way new tools still render acceptably without needing bespoke UI immediately.

And until then, the current approach is probably optimal: make tool calls collapsible, keep the raw payload available, and spend the engineering time on the parts that actually unlock Composer’s autonomy—worktrees/groups, scheduling, recovery, ticket flow, run inspection, etc.

Yeah, that’s the most likely explanation.

Classic sequence:

**dev machine has globally installed skills → Composer resolves them fine → repo looks complete → fresh machine immediately falls over.**

I’d check the resolver path first and make the runtime print exactly where each skill was loaded from. Something like:

```markdown
skill: coding
source: global
path: ~/.composer/skills/coding
version: 0.8.2
```

That will probably expose the hidden dependency immediately.

And once confirmed, I’d make bootstrap deterministic: either Composer ships the built-in skills with the server package, or first-run installs a pinned built-in skill bundle. Global user-installed skills should be an extension mechanism, not something required for the default install to function.

plus i can still build the indexer agent later. will be handy. but is not something needed on day 1

Exactly. The indexer is leverage, not a prerequisite.

Day 1 only really needs deterministic skill discovery/loading, a clear global/project resolution model, and enough metadata that Composer knows what skills exist. You can get very far with filesystem scanning plus manifests.

The indexer starts paying off later when you have lots of skills and want semantic discovery:

> “find me a skill that can review EF migrations”

or automatic planner selection based on capabilities rather than hardcoded names.

At that point it becomes useful for ranking, aliases, descriptions, compatibility, maybe even historical success rates. But none of that should block getting skills installed correctly on a clean machine first.

So I’d keep the sequence simple: **distribution → deterministic resolver → manifests → basic discovery → semantic indexer later.**

Yeah, that’s probably where the indexer becomes **much more important than skill discovery**.

For a normal repo, an agent can `glob` / `grep` /read its way to the relevant code cheaply enough. On a genuinely massive codebase, that starts wasting huge amounts of context and tool calls just figuring out where to look.

An indexer can give Composer a persistent semantic map:

```markdown
query: "where is authorization enforced for booking requests?"

→ BookingAuthorizationHandler.cs
→ BookingRequestController.cs
→ AuthorizationExtensions.cs
→ ADR-014-auth-model.md
→ related tests
```

And because Composer is a persistent server, indexing is particularly attractive. You pay the expensive scan once, then incrementally update it from Git/filesystem changes. Every assistant thread, planner, coding agent, and review agent can share the resulting index.

Eventually I could see **project knowledge** being more than embeddings too: symbols, references, dependency relationships, ownership/module boundaries, Git history, docs, existing Composer knowledge, etc. Then retrieval can combine lexical + semantic + structural signals.

But yeah, totally separable from day one. `grep` is an extraordinarily good indexer until the repo becomes big enough that it isn't.
