import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { PipelineService } from '../pipelines/pipeline.service';
import { ShellService } from './shell.service';

/**
 * Status strip (design.md §2): live-agent count with a dot per running
 * session, active model, keybind hints. Read-only — there is no global
 * composer input. The count is the number of actually running agent
 * sessions (the automation toggles live on the board's lane headers);
 * the block hides while nothing runs.
 */
@Component({
  selector: 'app-status-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-strip.component.html',
  styleUrl: './status-strip.component.scss',
})
export class StatusStripComponent {
  private readonly shell = inject(ShellService);
  private readonly pipelines = inject(PipelineService);

  protected readonly runningSessions = computed(() =>
    this.pipelines.agentSessions().filter((session) => session.status === 'running'),
  );
  protected readonly agentCount = computed(() => this.runningSessions().length);
  protected readonly agentDots = computed(() => this.runningSessions());
  protected readonly agentLabel = computed(() =>
    this.agentCount() === 1 ? 'agent running' : 'agents running',
  );
  protected readonly model = this.shell.model;
}
