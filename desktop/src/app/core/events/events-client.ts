import { Inject, InjectionToken, Injectable, Optional, signal } from '@angular/core';
import { Subject } from 'rxjs';

import {
  DomainEventJson,
  EventFrameJson,
  PublishRequestJson,
  PublishResponseJson,
  actionForCommand,
  frameToDomainEvent,
} from './wire';

/**
 * Transport boundary to a server's REST + SSE surface. Production talks
 * HTTP directly from the renderer (EventSource + fetch); tests provide a
 * fake via the transport tokens.
 */
export interface EventsTransport {
  /** Opens the `GET /events` stream. Returns a dispose function. */
  open(
    onOpen: () => void,
    onFrame: (frame: EventFrameJson) => void,
    onClosed: () => void,
  ): () => void;
  /** POSTs a body to `{base}/{path}`; resolves the parsed 200 response. */
  post(path: string, body: unknown): Promise<PublishResponseJson>;
}

export const EVENTS_TRANSPORT = new InjectionToken<EventsTransport>(
  'composer.events.transport',
);

/** Builds the transport for one server base URL (multi-server mode). */
export type TransportFactory = (baseUrl: string) => EventsTransport;

export const EVENTS_TRANSPORT_FACTORY = new InjectionToken<TransportFactory>(
  'composer.events.transport-factory',
);

/** The server gateway (the Electron bridge). */
export const PROJECTS_GATEWAY = new InjectionToken<ProjectsBridge>(
  'composer.projects.gateway',
);

/** The renderer's door to the Electron main process. */
export interface ProjectDirectorySelection {
  readonly name: string;
  readonly directory: string;
}

/** One server entry (v2: there is exactly one server). */
export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly uri: string;
}

export interface ProjectsBridge {
  pickDirectory(): Promise<ProjectDirectorySelection | null>;
  /** Probes the server URI, spawns it on refusal, waits for health. */
  discover(): Promise<RegistryEntry | null>;
}

declare global {
  interface Window {
    composer?: { serverUrl?: string; projects?: ProjectsBridge };
  }
}

const UNAVAILABLE: PublishResponseJson = {
  ok: false,
  rejectionMessage: 'backend unavailable',
};

/**
 * The single event stream of the app (docs/architecture.md). Composer v2
 * is one server process for all projects: this client attaches one SSE
 * transport (found or spawned by the Electron main process) and frames
 * carry their projectId — the domain folds are per-project keyed. Commands
 * publish to the server; transport failures resolve as a typed
 * `backend unavailable` rejection.
 *
 * When the stream drops, the client re-discovers (respawning a refused
 * server) and re-attaches — folds are idempotent, so a resubscribe that
 * replays a fresh snapshot reconciles.
 */
@Injectable({ providedIn: 'root' })
export class EventsClient {
  private readonly transportFactory: TransportFactory;
  private readonly gateway: ProjectsBridge | null;
  private readonly eventsSubject = new Subject<DomainEventJson>();

  /** The one server link; the test/dev injected transport keeps `fallback`. */
  private link: ServerLink | null = null;
  private fallback: ServerLink | null = null;

  readonly events$ = this.eventsSubject.asObservable();
  readonly connected = signal(false);

  /** The attached server's base URL; null when only a test transport exists. */
  get serverBase(): string | null {
    if (this.fallback) return null;
    return this.link?.uri ?? null;
  }

  constructor(
    @Optional() @Inject(EVENTS_TRANSPORT) providedTransport: EventsTransport | null,
    @Optional() @Inject(EVENTS_TRANSPORT_FACTORY) transportFactory: TransportFactory | null,
    @Optional() @Inject(PROJECTS_GATEWAY) gatewayOverride: ProjectsBridge | null,
  ) {
    this.transportFactory = transportFactory ?? ((base) => new HttpEventsTransport(base));
    this.gateway = gatewayOverride ?? windowComposer()?.projects ?? null;
    if (providedTransport) {
      // Test/dev injection: one transport, no discovery.
      this.fallback = new ServerLink(
        '',
        providedTransport,
        this.eventsSubject,
        () => {},
        () => this.recomputeConnected(),
      );
      return;
    }
    void this.startup();
  }

  publish(request: PublishRequestJson): Promise<PublishResponseJson> {
    const route = actionForCommand(request);
    if (!route) return Promise.resolve(UNAVAILABLE);
    if (this.fallback) return this.fallback.post(route.path, route.body).catch(() => UNAVAILABLE);
    const link = this.link;
    if (!link) return Promise.resolve(UNAVAILABLE);
    return link.post(route.path, route.body).catch(() => UNAVAILABLE);
  }

  /** Attaches (or re-attaches) the server; idempotent. */
  attach(entry: RegistryEntry): void {
    if (this.link?.uri === entry.uri) return;
    this.link?.abandon();
    this.link = new ServerLink(
      entry.uri,
      this.transportFactory(entry.uri),
      this.eventsSubject,
      () => void this.rediscover(),
      () => this.recomputeConnected(),
    );
    this.recomputeConnected();
  }

  private async startup(): Promise<void> {
    if (this.gateway) {
      // Find (or spawn) the one server, then attach.
      const entry = await this.gateway.discover().catch(() => null);
      if (entry) this.attach(entry);
      return;
    }
    // Browser dev (ng serve, no Electron): the default server.
    this.attach({ id: 'default', name: 'default', folder: '', uri: serverUrl() });
  }

  /** The documented fallback: re-probe, respawn, re-attach. */
  private async rediscover(): Promise<void> {
    if (!this.gateway) return;
    const entry = await this.gateway.discover().catch(() => null);
    if (entry) this.attach(entry);
    this.recomputeConnected();
  }

  private recomputeConnected(): void {
    if (this.fallback) {
      this.connected.set(this.fallback.connected());
      return;
    }
    this.connected.set(this.link !== null && this.link.connected());
  }
}

/** The per-server link: one SSE stream with its own backoff. */
class ServerLink {
  private dispose: (() => void) | null = null;
  private retryDelay = 1_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly connectedState = signal(false);
  /** Set when the parent rebinds the project to a new link: no more retries. */
  private abandoned = false;

  constructor(
    readonly uri: string,
    private readonly transport: EventsTransport,
    private readonly events: Subject<DomainEventJson>,
    private readonly onDrop: () => void,
    private readonly onStateChange: () => void,
  ) {
    this.connect();
  }

  readonly connected = () => this.connectedState();

  post(path: string, body: unknown): Promise<PublishResponseJson> {
    return this.transport.post(path, body);
  }

  /** Stops the link: no further reconnects (the parent rebinds instead). */
  abandon(): void {
    this.abandoned = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.dispose?.();
    this.dispose = null;
  }

  private connect(): void {
    this.dispose = this.transport.open(
      () => this.onStreamActivity(),
      (frame) => {
        this.onStreamActivity();
        this.events.next(frameToDomainEvent(frame));
      },
      () => {
        this.connectedState.set(false);
        this.dispose?.();
        this.dispose = null;
        this.onStateChange();
        if (this.abandoned) return;
        this.onDrop();
        this.scheduleRetry();
        this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
      },
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);
  }

  private onStreamActivity(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelay = 1_000;
    if (!this.connectedState()) {
      this.connectedState.set(true);
      this.onStateChange();
    }
  }
}

function windowComposer(): { serverUrl?: string; projects?: ProjectsBridge } | null {
  return typeof window !== 'undefined' ? (window.composer ?? null) : null;
}

function serverUrl(): string {
  return windowComposer()?.serverUrl ?? 'http://127.0.0.1:5214';
}

/** The production transport: EventSource for the stream, fetch for writes. */
export class HttpEventsTransport implements EventsTransport {
  constructor(private readonly baseUrl: string) {}

  open(
    onOpen: () => void,
    onFrame: (frame: EventFrameJson) => void,
    onClosed: () => void,
  ): () => void {
    const source = new EventSource(`${this.baseUrl}/events`);
    source.onopen = () => onOpen();
    source.onmessage = (message) => {
      try {
        onFrame(JSON.parse(message.data) as EventFrameJson);
      } catch {
        // Skip a malformed frame rather than dropping the stream.
      }
    };
    source.onerror = () => {
      source.close();
      onClosed();
    };
    return () => source.close();
  }

  post(path: string, body: unknown): Promise<PublishResponseJson> {
    return fetch(`${this.baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as PublishResponseJson;
    });
  }
}
