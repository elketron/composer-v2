import { Injectable, effect, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';

export interface DashboardHealth {
  id: string;
  name: string;
  directory?: string;
  runningRuns: number;
  waitingApprovals: Array<{ cardId: string; cardTitle: string; pipelineId: string }>;
  failedRuns: Array<{
    cardId: string;
    cardTitle: string;
    pipelineId: string;
    error?: string;
    endedAt?: string;
  }>;
  git: {
    status: 'clean' | 'dirty' | 'missing-directory' | 'not-repository' | 'error';
    branch?: string;
    latestCommit?: { hash: string; subject: string; at: string };
  };
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly events = inject(EventsClient);
  private request = 0;

  readonly projects = signal<readonly DashboardHealth[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (this.events.connected()) void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    const base = this.events.serverBase;
    if (!base) return;
    const request = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await fetch(`${base}/dashboard`);
      if (!response.ok) throw new Error(`dashboard request failed (${response.status})`);
      const body = (await response.json()) as { projects?: unknown };
      if (request !== this.request) return;
      this.projects.set(Array.isArray(body.projects) ? (body.projects as DashboardHealth[]) : []);
    } catch {
      if (request === this.request) this.error.set('project health is temporarily unavailable');
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  forProject(projectId: string): DashboardHealth | undefined {
    return this.projects().find((project) => project.id === projectId);
  }
}
