import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  BookOpen,
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
 * Left icon rail: the coding workflow's views plus the global destinations
 * (projects, settings). Entries without a route render as disabled stubs
 * for destinations the product plan has not scheduled yet.
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
      { id: 'docs', label: 'docs', icon: BookOpen, route: `${base}/docs` },
      { id: 'canvas', label: 'canvas', icon: PenTool, route: `${base}/canvas` },
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
