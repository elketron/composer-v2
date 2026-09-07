# Assistant, knowledge, and skills model

Status: approved product direction; target implementation planned.

This document defines the product boundaries between assistant conversations,
project scope, plan writes, global knowledge, skills, and future project
indexing. Existing assistant and knowledge features remain the baseline; the
rules below govern their continued development.

## Assistant role

The assistant is Composer's interface for unstructured understanding and
intent. It can investigate, compare, research, remember, plan, and propose
structured work. Tasks, pipelines, and runs remain the execution system.

The assistant may:

- answer general questions and research external sources;
- inspect one or more selected projects;
- compare implementation and plans across selected projects;
- search and save global knowledge;
- update plan documents in selected projects after an explicit instruction;
- propose tasks and dependencies for user confirmation; and
- explain task, pipeline, and run outcomes.

The assistant may not start or stop pipelines or answer approval gates without
a separate, explicit execution authority designed for that action. Plan writes
do not grant general project-file editing authority.

## Threads and OpenCode sessions

- Assistant threads are global and persistent.
- Each assistant thread owns one OpenCode session.
- A thread may have zero, one, or several selected projects.
- A thread permits at most one active turn.
- Separate threads may run concurrently.
- Navigating away from a running thread does not stop its turn.
- Conversation history and branch lineage remain attached to the thread.

An unscoped thread with zero selected projects can converse, research the web,
and use global knowledge. It cannot inspect project files, Composer project
state, or plans until the required projects are added to its explicit scope.

## Scope and write authority

Conversation context, selected projects, and global knowledge are distinct
scopes:

```text
conversation context -> selected project(s) -> global Composer knowledge
```

Project-reading and plan-writing tools validate the thread's current project
scope on every call. Scope is live rather than copied into the session once:
removing a project removes subsequent access to it.

A direct instruction to update a plan is sufficient authorization for the
assistant to write that plan. The target project must be selected in the
thread. The assistant must not infer broad or ongoing write permission from one
instruction.

Task proposals remain editable and require confirmation before task creation.
Pipeline runs and human approval responses remain explicit user actions.

## Global knowledge

Global knowledge is durable, project-agnostic information that can support
future conversations across Composer. It is not an automatic copy of chat or
project documentation.

- Knowledge is saved only after an explicit instruction such as "remember
  this."
- That instruction is sufficient; no second confirmation is required.
- Saved knowledge records its source thread, selected project scope, and
  creation time as provenance.
- Project documents remain project-local and are not silently promoted into
  global knowledge.
- Knowledge remains searchable from threads with or without selected projects.

Provenance describes where an item came from. It does not restrict an item to
those projects after it has deliberately been saved as global knowledge.

## Tool activity

Polished tool-specific rendering remains deferred while tool schemas and
execution events are changing. The current presentation should remain compact,
collapsible, and lossless:

- show tool name, status, and a concise summary;
- keep raw input, output, and errors available on expansion;
- preserve execution order; and
- provide a generic fallback for unknown tools.

Future specialized renderers should consume a generic execution-event model,
not hard-code each tool's transport payload. The model should be able to
represent identity, status, timing, input, output, errors, artifacts, and child
calls. Common tools may later receive purpose-built command, file, search,
diff, and nested-agent views.

Rich rendering is an observability refinement, not a prerequisite for assistant
or pipeline autonomy.

## Skill distribution and resolution

Composer's default capabilities must work on a clean machine. Built-in skills
must ship with Composer or be installed as a pinned Composer-managed bundle.
Machine-global configuration must not be an undeclared runtime dependency.

Skill resolution precedence is:

```text
Composer built-in -> project-local -> user-global
```

Rules:

- Composer built-in skill names are reserved and always win conflicts.
- Project-local and user-global skills supplement built-ins under unique names.
- A project-local skill wins a conflict with a user-global skill.
- Name conflicts are reported rather than silently hiding their source.
- Runtime diagnostics expose each resolved skill's source, path, and version.
- Resolution is deterministic across development and packaged installations.

## Optional project indexing

A richer project indexer is useful leverage but is not required for normal
operation. Ordinary file listing, lexical search, and Git tools remain the
default discovery path.

- Indexing is opt-in per project.
- A project without an index remains fully usable.
- Composer must not enable indexing silently based on repository size.
- Skill discovery does not depend on the project indexer.
- Index storage, refresh policy, embedding provider, and retrieval ranking are
  deferred.

A future index may combine lexical matches, embeddings, symbols, references,
dependencies, documentation, Git history, and Composer knowledge. Those signals
require a separate implementation design and measured need.

## Invariants

- One assistant thread owns one OpenCode session and at most one active turn.
- Separate threads may execute concurrently.
- Project access always requires live thread scope.
- Explicit plan-write permission applies only to the requested plan operation.
- Remembering knowledge is explicit and records provenance.
- Built-in Composer skills cannot be overridden by project or global skills.
- Normal operation never requires optional global skills or project indexes.

## Deferred details

Open assistant-authority, tool-rendering, skill-discovery, and project-indexing
questions are tracked in
[Deferred product decisions](deferred-product-decisions.md). They are not part
of this approved product contract.
