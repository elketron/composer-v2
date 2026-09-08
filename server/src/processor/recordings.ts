// The open workflow recordings (S34): the processor's only in-memory state
// between a worker agent's start and stop tool calls. Encapsulated in its
// own registry (injected, like the file repositories) so the recordings
// never live on the processor itself. A restart (or a crashed run) drops
// it — only a stopped recording is durable.

import type { WorkflowStep } from '../wire/models.js';

export interface WorkflowRecording {
  title: string;
  description: string;
  tags: string[];
  source?: string;
  agent?: string;
  steps: WorkflowStep[];
  startedAt: string;
}

/** One open recording per `<projectId>/<sessionId>`. */
export class WorkflowRecordings {
  private readonly byKey = new Map<string, WorkflowRecording>();

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  get(key: string): WorkflowRecording | undefined {
    return this.byKey.get(key);
  }

  set(key: string, recording: WorkflowRecording): void {
    this.byKey.set(key, recording);
  }

  delete(key: string): void {
    this.byKey.delete(key);
  }
}