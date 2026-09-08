import { Injectable, effect, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { RestClient } from '../core/rest';

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
  private readonly rest = inject(RestClient);
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
    if (!this.rest.serverBase) return;
    const request = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    const response = await this.rest.get<{ projects?: unknown }>('/dashboard');
    if (request !== this.request) return;
    if (response === null || !response.ok) {
      this.error.set('project health is temporarily unavailable');
    } else {
      this.projects.set(Array.isArray(response.body.projects) ? (response.body.projects as DashboardHealth[]) : []);
    }
    this.loading.set(false);
  }

  forProject(projectId: string): DashboardHealth | undefined {
    return this.projects().find((project) => project.id === projectId);
  }
}
