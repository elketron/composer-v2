import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  Bot,
  CircleUser,
  LayoutDashboard,
  Kanban,
  LucideAngularModule,
  LucideIconData,
  MessageSquare,
  PenTool,
  Settings,
  Workflow,
} from 'lucide-angular';

interface RailEntry {
  id: string;
  label: string;
  icon: LucideIconData;
  /** Present when the entry navigates; absent entries are disabled stubs. */
  route?: string;
}

/**
 * Left icon rail (design.md §2). Per the MVP scope (docs/mvp.md), only Board,
 * Plan and Settings are wired; Agent, Canvas, Library and Account render as
 * disabled stubs.
 */
@Component({
  selector: 'app-left-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, LucideAngularModule],
  templateUrl: './left-rail.component.html',
  styleUrl: './left-rail.component.scss',
})
export class LeftRailComponent {
  readonly projectId = input<string | null>(null);

  protected readonly viewEntries = computed<readonly RailEntry[]>(() => {
    const base = `/projects/${encodeURIComponent(this.projectId() ?? '')}/coding`;
    return [
      { id: 'board', label: 'board', icon: Kanban, route: `${base}/board` },
      { id: 'plan', label: 'plan', icon: MessageSquare, route: `${base}/plan` },
      {
        id: 'pipelines',
        label: 'pipelines',
        icon: Workflow,
        route: `${base}/pipelines`,
      },
      { id: 'agent', label: 'coding', icon: Bot, route: `${base}/coding` },
      { id: 'canvas', label: 'canvas', icon: PenTool },
    ];
  });

  protected readonly bottomEntries: readonly RailEntry[] = [
    {
      id: 'dashboard',
      label: 'projects',
      icon: LayoutDashboard,
      route: '/dashboard',
    },
    { id: 'account', label: 'account', icon: CircleUser },
    { id: 'settings', label: 'settings', icon: Settings, route: '/settings' },
  ];
}
