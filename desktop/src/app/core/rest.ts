import { Injectable, inject } from '@angular/core';

import { EventsClient } from './events/events-client';

/** A parsed REST response against the attached server. */
export interface RestResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T;
}

/**
 * The shared REST client (F5): the one `fetch` wrapper the read services
 * (docs, knowledge, settings, dashboard) use — the server base, the JSON
 * parse, and the offline fallback (null) live here instead of being
 * hand-rolled per service.
 */
@Injectable({ providedIn: 'root' })
export class RestClient {
  private readonly events = inject(EventsClient);

  get serverBase(): string | null {
    return this.events.serverBase;
  }

  /** GET `{base}{path}`; null when detached or the network failed. */
  async get<T = unknown>(path: string): Promise<RestResponse<T> | null> {
    const base = this.events.serverBase;
    if (base === null) return null;
    try {
      const response = await fetch(`${base}${path}`);
      const body = (await response.json().catch(() => ({}))) as T;
      return { ok: response.ok, status: response.status, body };
    } catch {
      return null;
    }
  }

  /** PUT `{base}{path}` with a JSON body; null when detached or offline. */
  async put<T = unknown>(path: string, value: unknown): Promise<RestResponse<T> | null> {
    const base = this.events.serverBase;
    if (base === null) return null;
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      const body = (await response.json().catch(() => ({}))) as T;
      return { ok: response.ok, status: response.status, body };
    } catch {
      return null;
    }
  }
}