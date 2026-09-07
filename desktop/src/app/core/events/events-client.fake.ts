import { signal } from '@angular/core';
import { Subject } from 'rxjs';

import { EventsClient } from './events-client';
import {
  CardJson,
  DomainEventJson,
  EventKind,
  PublishRequestJson,
  PublishResponseJson,
  WireCardType,
} from './wire';

/**
 * In-memory stand-in for EventsClient in unit tests. Specs drive the fold by
 * emitting wire events (snapshot sequences included) and assert on the
 * commands services published. Publish responses default to `{ ok: true }`;
 * queue scripted responses with `respondWith`.
 */
export class FakeEventsClient {
  private readonly eventsSubject = new Subject<DomainEventJson>();
  readonly events$ = this.eventsSubject.asObservable();
  readonly connected = signal(true);
  readonly serverBase = '';

  readonly published: PublishRequestJson[] = [];
  readonly attached: import('./events-client').RegistryEntry[] = [];
  private responders: Array<
    PublishResponseJson | ((request: PublishRequestJson) => PublishResponseJson)
  > = [];

  /** The multi-server attach point (the per-project server registry). */
  attach(entry: import('./events-client').RegistryEntry): void {
    this.attached.push(entry);
  }

  emit(event: DomainEventJson): void {
    this.eventsSubject.next(event);
  }

  publish(request: PublishRequestJson): Promise<PublishResponseJson> {
    this.published.push(request);
    const responder = this.responders.shift();
    if (typeof responder === 'function') return Promise.resolve(responder(request));
    return Promise.resolve(responder ?? { ok: true });
  }

  respondWith(
    ...responses: Array<
      PublishResponseJson | ((request: PublishRequestJson) => PublishResponseJson)
    >
  ): void {
    this.responders.push(...responses);
  }

  /** The command field name set on a published request (the oneof case). */
  static commandKind(request: PublishRequestJson): EventKind | string | undefined {
    return Object.keys(request).find((key) => key !== 'projectId');
  }

  lastCommand(kind?: string): PublishRequestJson | undefined {
    const commands = kind
      ? this.published.filter((c) => FakeEventsClient.commandKind(c) === kind)
      : this.published;
    return commands.at(-1);
  }
}

/** Provide the fake wherever an EventsClient is injected. */
export function provideFakeEventsClient(fake: FakeEventsClient) {
  return { provide: EventsClient, useValue: fake };
}

let nextEventId = 1;

/** Build a wire event envelope; snapshot events just get fresh ids. */
export function wireEvent(
  kind: EventKind,
  payload: Readonly<Record<string, unknown>>,
  projectId = 'P-1',
): DomainEventJson {
  return {
    id: `e-${nextEventId++}`,
    projectId,
    occurredAt: new Date().toISOString(),
    [kind]: payload,
  } as DomainEventJson;
}

/** Build a global (project-less) wire event (the assistant's family). */
export function wireGlobalEvent(
  kind: EventKind,
  payload: Readonly<Record<string, unknown>>,
): DomainEventJson {
  return {
    id: `e-${nextEventId++}`,
    occurredAt: new Date().toISOString(),
    [kind]: payload,
  } as DomainEventJson;
}

/** Minimal card fixture in wire shape; override any field per test. */
export function wireCard(overrides: Partial<CardJson> & { id: string }): CardJson {
  const now = new Date().toISOString();
  return {
    projectId: 'P-1',
    type: WireCardType.CARD_TYPE_CODING,
    title: overrides.id,
    description: '',
    tags: [],
    pipelineId: 'PL-1',
    stageId: 'sg-1',
    blockedBy: [],
    stepStates: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---- Snapshot seeding helpers for component/service specs ----

/** Fold a project (auto-activates the first one, like the live stream). */
export function seedProject(events: FakeEventsClient, id: string, name = id): void {
  events.emit(
    wireEvent(
      'projectCreated',
      { project: { id, name, createdAt: new Date().toISOString() } },
      id,
    ),
  );
}

export function seedSession(events: FakeEventsClient, projectId: string, sessionId = 'S-1'): void {
  events.emit(
    wireEvent(
      'planningSessionCreated',
      { session: { id: sessionId, projectId, createdAt: new Date().toISOString() } },
      projectId,
    ),
  );
}

export function seedCard(
  events: FakeEventsClient,
  overrides: Partial<CardJson> & { id: string },
): void {
  const card = wireCard(overrides);
  events.emit(wireEvent('cardCreated', { card }, card.projectId ?? 'P-1'));
}
