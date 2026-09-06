import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  seedSession,
  wireEvent,
} from '../core/events/events-client.fake';
import { PlanDocumentComponent } from './plan-document.component';
import { PlanService } from './plan.service';

describe('PlanDocumentComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [PlanDocumentComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    // Instantiate the folding service before seeding: folds only see
    // events after subscription. The document pane reads the active
    // project's session, so the project must be selected explicitly.
    const plan = TestBed.inject(PlanService);
    plan.setProject('P-1');
    seedProject(events, 'P-1', 'alpha');
    seedSession(events, 'P-1');
  });

  function render(): Promise<{ nativeElement: HTMLElement; whenStable: () => Promise<void> }> {
    const fixture = TestBed.createComponent(PlanDocumentComponent);
    return fixture.whenStable().then(() => ({
      nativeElement: fixture.nativeElement as HTMLElement,
      whenStable: () => fixture.whenStable(),
    }));
  }

  it('renders an empty state before the planner writes the plan', async () => {
    const { nativeElement } = await render();
    expect(nativeElement.querySelector('.document-text')).toBeNull();
    expect(nativeElement.textContent).toContain('the planner writes the plan here');
  });

  it('renders markdown and escapes raw HTML to literal text', async () => {
    events.emit(
      wireEvent('planDocumentUpdated', { sessionId: 'S-1', document: '# Goal\n\n<system-echo>' }, 'P-1'),
    );
    const { nativeElement, whenStable } = await render();
    await whenStable();

    const text = nativeElement.querySelector('.document-text')!;
    expect(text.querySelector('h1')?.textContent).toBe('Goal');
    // The injected tag displays literally; nothing executes or mounts.
    expect(text.querySelector('system-echo')).toBeNull();
    expect(text.textContent).toContain('<system-echo>');
  });

  it('keeps javascript: links inert under Angular sanitization', async () => {
    events.emit(
      wireEvent(
        'planDocumentUpdated',
        { sessionId: 'S-1', document: '[click me](javascript:alert(1))\n\n[docs](https://example.com)' },
        'P-1',
      ),
    );
    const { nativeElement, whenStable } = await render();
    await whenStable();

    const links = [...nativeElement.querySelectorAll('.document-text a')];
    expect(links).toHaveLength(2);
    // The sanitizer rewrites unsafe URLs (unsafe:javascript:…) rather than
    // dropping the attribute; either way it cannot execute.
    expect(links[0]!.getAttribute('href')!.startsWith('javascript:')).toBe(false);
    expect(links[1]!.getAttribute('href')).toBe('https://example.com');
  });
});
