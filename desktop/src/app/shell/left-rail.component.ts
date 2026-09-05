import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  Bot,
  CircleUser,
  Kanban,
  Library,
  LucideAngularModule,
  LucideIconData,
  MessageSquare,
  PenTool,
  Settings,
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
  protected readonly viewEntries: readonly RailEntry[] = [
    { id: 'board', label: 'board', icon: Kanban, route: '/board' },
    { id: 'plan', label: 'plan', icon: MessageSquare, route: '/plan' },
    { id: 'agent', label: 'agent', icon: Bot },
    { id: 'canvas', label: 'canvas', icon: PenTool },
    { id: 'library', label: 'library', icon: Library },
  ];

  protected readonly bottomEntries: readonly RailEntry[] = [
    { id: 'account', label: 'account', icon: CircleUser },
    { id: 'settings', label: 'settings', icon: Settings, route: '/settings' },
  ];
}
