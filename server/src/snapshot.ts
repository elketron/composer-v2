// The SSE snapshot: current state replayed as synthetic events, in the
// fold's expected order (v1 rule — folds are idempotent, so a resubscribe
// with fresh ids is safe). This file is only the ordering coordinator: the
// per-domain reconstruction lives in the appenders (snapshot/*.ts), which
// push frames through one shared nonce-scoped emitter.

import { randomUUID } from 'node:crypto';
import type { EventFrame } from './wire/envelope.js';
import type { State } from './fold/index.js';
import { appendAssistantThreads } from './snapshot/assistant.js';
import { makeEmitter } from './snapshot/emit.js';
import { appendProposals } from './snapshot/proposals.js';
import { appendProject } from './snapshot/project.js';

export function snapshotEvents(state: State, projectId?: string): EventFrame[] {
  const events: EventFrame[] = [];
  const nonce = randomUUID().slice(0, 8);
  const emit = makeEmitter(events, nonce);

  // Global assistant threads first (Phase 6): creation + messages + terminal
  // status re-marking — only for the global (project-agnostic) stream.
  if (projectId === undefined) {
    appendAssistantThreads(emit, state.assistantThreads);
  }

  // Work proposals (Phase 8) replay before the projects.
  appendProposals(emit, state.proposals);

  const projects = [...state.projects.values()]
    .filter((project) => projectId === undefined || project.id === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const project of projects) {
    const projectState = state.byProject.get(project.id);
    if (!projectState) continue;
    appendProject(emit, project, projectState);
  }

  return events;
}