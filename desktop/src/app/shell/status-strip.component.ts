import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { BoardService } from '../board/board.service';
import { ShellService } from './shell.service';

/**
 * Status strip (design.md §2): live-agent count with a dot per session, active
 * model, keybind hints. Read-only — there is no global composer input. Until
 * agents land, the count reflects enabled lane automation toggles
 * (mvp.md acceptance 13).
 */
@Component({
  selector: 'app-status-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-strip.component.html',
  styleUrl: './status-strip.component.scss',
})
export class StatusStripComponent {
  private readonly shell = inject(ShellService);
  private readonly board = inject(BoardService);

  protected readonly agentCount = computed(() => this.board.automation().onCount);
  protected readonly agentDots = computed(() => Array.from({ length: this.agentCount() }));
  protected readonly model = this.shell.model;
}
