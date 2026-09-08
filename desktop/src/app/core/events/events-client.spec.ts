import { TestBed } from '@angular/core/testing';

import { DomainEventJson, EventFrameJson, PublishResponseJson } from './wire';
import {
  EVENTS_TRANSPORT,
  EVENTS_TRANSPORT_FACTORY,
  EventsClient,
  EventsTransport,
  PROJECTS_GATEWAY,
} from './events-client';
import type { ProjectsBridge, RegistryEntry } from './events-client';

class FakeTransport implements EventsTransport {
  private onOpen: (() => void) | null = null;
  private onFrame: ((frame: EventFrameJson) => void) | null = null;
  private onClosed: (() => void) | null = null;
  openCalls = 0;

  open(
    onOpen: () => void,
    onFrame: (frame: EventFrameJson) => void,
    onClosed: () => void,
  ): () => void {
    this.openCalls += 1;
    this.onOpen = onOpen;
    this.onFrame = onFrame;
    this.onClosed = onClosed;
    return () => {
      this.onOpen = null;
      this.onFrame = null;
      this.onClosed = null;
    };
  }

  post(_path: string, _body: unknown): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  openStream(): void {
    this.onOpen?.();
  }

  emit(frame: EventFrameJson): void {
    this.onFrame?.(frame);
  }

  close(): void {
    this.onClosed?.();
  }
}

describe('EventsClient', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function provideClient(): EventsClient {
    TestBed.configureTestingModule({
      providers: [EventsClient, { provide: EVENTS_TRANSPORT, useValue: transport }],
    });
    return TestBed.inject(EventsClient);
  }

  it('reopens the stream after a drop and resets backoff on activity', () => {
    const client = provideClient();

    transport.openStream();
    expect(client.connected()).toBe(true);

    transport.close();
    expect(client.connected()).toBe(false);
    expect(transport.openCalls).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(transport.openCalls).toBe(2); // reconnect after the first delay

    transport.openStream();
    expect(client.connected()).toBe(true);

    transport.close(); // the successful open reset the backoff to 1s
    vi.advanceTimersByTime(1_000);
    expect(transport.openCalls).toBe(3);
  });

  it('folds SSE frames into oneof-shaped events', () => {
    const client = provideClient();
    const seen: DomainEventJson[] = [];
    client.events$.subscribe((event) => seen.push(event));

    transport.emit({
      id: 'e-1',
      projectId: 'P-1',
      occurredAt: '2026-08-19T12:00:00.000000Z',
      eventType: 'cardStageMoved',
      body: { cardId: 'T-1', pipelineId: 'PL-1', toStageId: 'sg-3' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].cardStageMoved).toEqual({ cardId: 'T-1', pipelineId: 'PL-1', toStageId: 'sg-3' });
  });

  it('maps command DTOs onto the action envelope before posting', async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    const recording: EventsTransport = {
      open: () => () => {},
      post: (path, body) => {
        posted.push({ path, body });
        return Promise.resolve({ ok: true });
      },
    };
    TestBed.configureTestingModule({
      providers: [EventsClient, { provide: EVENTS_TRANSPORT, useValue: recording }],
    });
    const client = TestBed.inject(EventsClient);

    await client.publish({
      projectId: 'P-1',
      requestCardStageMove: {
        cardId: 'T-1',
        toStageId: 'sg-3',
        override: false,
        comment: '',
      },
    });
    await client.publish({
      projectId: 'P-1',
      requestUserMessage: { sessionId: 'S-1', text: 'plan the board' },
    });
    await client.publish({
      projectId: 'P-1',
      requestPipelineRun: { cardId: 'T-1' },
    });
    await client.publish({ projectId: 'P-1', requestPipelineStop: { cardId: 'T-1' } });
    await client.publish({
      projectId: 'P-1',
      requestPipelineGateRespond: { cardId: 'T-1', approved: true, comment: 'ship it' },
    });
    await client.publish({
      projectId: 'P-1',
      requestProjectArchive: { projectId: 'P-1' },
    });
    await client.publish({
      projectId: 'P-1',
      requestProjectRestore: { projectId: 'P-1' },
    });

    expect(posted).toEqual([
      {
        path: 'action',
        body: { type: 'update', on: 'card', projectId: 'P-1', body: { id: 'T-1', stageId: 'sg-3' } },
      },
      {
        path: 'action',
        body: {
          type: 'create',
          on: 'chatMessage',
          projectId: 'P-1',
          body: { sessionId: 'S-1', text: 'plan the board' },
        },
      },
      {
        path: 'action',
        body: {
          type: 'start',
          on: 'pipeline',
          projectId: 'P-1',
          body: { cardId: 'T-1' },
        },
      },
      {
        path: 'action',
        body: { type: 'stop', on: 'pipeline', projectId: 'P-1', body: { cardId: 'T-1' } },
      },
      {
        path: 'action',
        body: {
          type: 'update',
          on: 'pipelineGate',
          projectId: 'P-1',
          body: { cardId: 'T-1', approved: true, comment: 'ship it' },
        },
      },
      {
        path: 'action',
        body: { type: 'delete', on: 'project', projectId: 'P-1', body: { id: 'P-1' } },
      },
      {
        path: 'action',
        body: {
          type: 'update',
          on: 'project',
          projectId: 'P-1',
          body: { id: 'P-1', archived: false },
        },
      },
    ]);
  });

  it('resolves transport failures as backend unavailable', async () => {
    const failing: EventsTransport = {
      open: () => () => {},
      post: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    TestBed.configureTestingModule({
      providers: [EventsClient, { provide: EVENTS_TRANSPORT, useValue: failing }],
    });
    const client = TestBed.inject(EventsClient);

    const response = await client.publish({
      projectId: 'P-1',
      requestUserMessage: { sessionId: 'S-1', text: 'plan the board' },
    });
    expect(response).toEqual({ ok: false, rejectionMessage: 'backend unavailable' });
  });
});

// ---- Gateway mode (the Electron spawn-on-refusal, README §startup) ----

/** A transport keyed by its base URL, driven by the spec. */
class RoutedTransport implements EventsTransport {
  openCalls = 0;
  readonly posted: Array<{ path: string; body: unknown }> = [];
  private onFrame: ((frame: EventFrameJson) => void) | null = null;
  private onOpen: (() => void) | null = null;
  private onClosed: (() => void) | null = null;

  open(
    onOpen: () => void,
    onFrame: (frame: EventFrameJson) => void,
    onClosed: () => void,
  ): () => void {
    this.openCalls += 1;
    this.onOpen = onOpen;
    this.onFrame = onFrame;
    this.onClosed = onClosed;
    return () => {
      this.onOpen = null;
      this.onFrame = null;
      this.onClosed = null;
    };
  }

  post(path: string, body: unknown): Promise<PublishResponseJson> {
    this.posted.push({ path, body });
    return Promise.resolve({ ok: true });
  }

  start(): void {
    this.onOpen?.();
  }

  emit(frame: EventFrameJson): void {
    this.onFrame?.(frame);
  }

  drop(): void {
    this.onClosed?.();
  }
}

function serverEntry(uri: string): RegistryEntry {
  return { id: 'default', name: 'default', folder: '', uri };
}

describe('EventsClient (gateway)', () => {
  interface RigState {
    server: RoutedTransport;
    entry: RegistryEntry;
  }

  function rig(state: RigState): EventsClient {
    const gateway: ProjectsBridge = {
      discover: async () => state.entry,
    };
    const factory = (base: string) => {
      if (base !== state.entry.uri) throw new Error(`no transport for ${base}`);
      return state.server;
    };
    TestBed.configureTestingModule({
      providers: [
        EventsClient,
        { provide: EVENTS_TRANSPORT_FACTORY, useValue: factory },
        { provide: PROJECTS_GATEWAY, useValue: gateway },
      ],
    });
    const client = TestBed.inject(EventsClient);
    client.connect();
    return client;
  }

  function moveFrame(id: string, projectId: string): EventFrameJson {
    return {
      id,
      projectId,
      occurredAt: '2026-08-19T12:00:00.000000Z',
      eventType: 'cardStageMoved',
      body: { cardId: 'T-1', pipelineId: 'PL-1', toStageId: 'sg-3' },
    };
  }

  async function settle(times = 3): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  it('attaches the discovered server; frames from every project flow in', async () => {
    const server = new RoutedTransport();
    const client = rig({ server, entry: serverEntry('http://composer') });
    await settle();

    const seen: DomainEventJson[] = [];
    client.events$.subscribe((event) => seen.push(event));
    server.emit(moveFrame('e-1', 'alpha'));
    server.emit(moveFrame('e-2', 'beta'));

    expect(server.openCalls).toBe(1);
    expect(seen.map((event) => event.id)).toEqual(['e-1', 'e-2']);
  });

  it('publishes every command to the one server', async () => {
    const server = new RoutedTransport();
    const client = rig({ server, entry: serverEntry('http://composer') });
    await settle();

    await client.publish({
      projectId: 'alpha',
      requestCardStageMove: { cardId: 'T-1', toStageId: 'sg-3' },
    });

    expect(server.posted).toHaveLength(1);
    expect((server.posted[0].body as { projectId?: string }).projectId).toBe('alpha');
  });

  it('a dropped stream re-discovers and re-attaches the respawned server', async () => {
    const server = new RoutedTransport();
    const state: RigState = { server, entry: serverEntry('http://composer') };
    const client = rig(state);
    await settle();
    server.start();
    expect(client.connected()).toBe(true);

    // The server dies; the respawn lands on a new port.
    const respawned = new RoutedTransport();
    state.server = respawned;
    state.entry = serverEntry('http://composer2');
    server.drop();
    await settle();

    expect(respawned.openCalls).toBe(1);
    // Live frames now flow from the respawned server.
    const seen: DomainEventJson[] = [];
    client.events$.subscribe((event) => seen.push(event));
    respawned.emit(moveFrame('e-9', 'alpha'));
    expect(seen.map((event) => event.id)).toEqual(['e-9']);
  });
});
