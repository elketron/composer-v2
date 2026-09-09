// The card domain's fold steps: creation, stage moves, pipeline
// assignment, type change (resets step states), assignment (absent = 
// unassigned), archive, step-state updates, and the automation toggles.
// Immutable instances: every change swaps the card via `with()`.

import { Card } from '../domain/card.js';
import { projectStateOf, readBody, type FoldHandler } from './state.js';

export const cardHandlers: Record<string, FoldHandler> = {
  cardCreated: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardCreated');
    const cards = projectStateOf(state, projectId).cards;
    cards.set(body.card.id, Card.fromWire(body.card));
  },
  cardStepMoved: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardStepMoved');
    const cards = projectStateOf(state, projectId).cards;
    const card = cards.get(body.cardId);
    if (!card) return;
    cards.set(
      body.cardId,
      card.with({
        stepId: body.toStepId,
        ...(body.comment !== undefined ? { rejectionComment: body.comment } : {}),
        updatedAt: envelope.occurredAt,
      }),
    );
  },
  cardPipelineAssigned: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardPipelineAssigned');
    const cards = projectStateOf(state, projectId).cards;
    const card = cards.get(body.cardId);
    if (!card) return;
    cards.set(
      body.cardId,
      card.with({
        pipelineId: body.pipelineId,
        stepId: body.stepId,
        updatedAt: envelope.occurredAt,
      }),
    );
  },
  cardTypeChanged: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardTypeChanged');
    const cards = projectStateOf(state, projectId).cards;
    const card = cards.get(body.cardId);
    if (!card) return;
    cards.set(
      body.cardId,
      card.with({ type: body.to, stepStates: {}, updatedAt: envelope.occurredAt }),
    );
  },
  cardAssigned: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardAssigned');
    const cards = projectStateOf(state, projectId).cards;
    const card = cards.get(body.cardId);
    if (!card) return;
    // An absent assignee unassigns (the change set drops the field).
    cards.set(
      body.cardId,
      card.with({ assignee: body.assignee, updatedAt: envelope.occurredAt }),
    );
  },
  cardArchived: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardArchived');
    projectStateOf(state, projectId).cards.delete(body.cardId);
  },
  cardStepStateUpdated: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardStepStateUpdated');
    const cards = projectStateOf(state, projectId).cards;
    const card = cards.get(body.cardId);
    if (!card) return;
    cards.set(
      body.cardId,
      card.with({
        stepStates: { ...card.stepStates, [body.stepId]: body.status },
        updatedAt: envelope.occurredAt,
      }),
    );
  },
  dependencyStateChanged: () => undefined,
  // Derived state; clients fold blocked-ness from card data themselves.
  automationToggled: (state, envelope, projectId) => {
    const body = readBody(envelope, 'automationToggled');
    const project = projectStateOf(state, projectId);
    let steps = project.automation.get(body.pipelineId);
    if (!steps) {
      steps = new Map();
      project.automation.set(body.pipelineId, steps);
    }
    steps.set(body.stepId, body.on);
  },
};
