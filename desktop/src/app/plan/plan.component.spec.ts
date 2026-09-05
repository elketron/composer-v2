import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  seedSession,
  wireEvent,
} from '../core/events/events-client.fake';
import { PlanService } from './plan.service';
import { ShellService } from '../shell/shell.service';
import { PlanComponent } from './plan.component';

describe('PlanComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [PlanComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    // Instantiate before seeding: folds only see events after subscription.
    TestBed.inject(ShellService);
    TestBed.inject(PlanService);
    // An active project before the component's effect wires the plan view.
    seedProject(events, 'P-1', 'alpha');
  });

  it('renders the planning header, chat and document panes', async () => {
    const fixture = TestBed.createComponent(PlanComponent);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('app-plan-chat')).toBeTruthy();
    expect(element.querySelector('app-plan-document')).toBeTruthy();
    expect(element.textContent).toContain('planning session');
    expect(element.textContent).toContain('plan document');
  });

  it('sends a chat message and renders the streamed answer', async () => {
    const fixture = TestBed.createComponent(PlanComponent);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('app-plan-chat input[name="message"]')!;
    input.value = 'Add a review step';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('app-plan-chat button.send')!.click();

    // The send awaits session creation, then the planner's turn streams back.
    seedSession(events, 'P-1');
    events.emit(
      wireEvent(
        'userMessageReceived',
        {
          sessionId: 'S-1',
          message: { index: 1, role: 'user', text: 'Add a review step', at: new Date().toISOString() },
        },
        'P-1',
      ),
    );
    await fixture.whenStable();
    expect(element.querySelector('.message.streaming .thinking')?.textContent).toContain('thinking');

    events.emit(
      wireEvent(
        'agentMessageDelta',
        { sessionId: 'S-1', messageIndex: 2, delta: 'Drafting ' },
        'P-1',
      ),
    );
    events.emit(
      wireEvent(
        'agentMessageDelta',
        { sessionId: 'S-1', messageIndex: 2, delta: 'the plan…' },
        'P-1',
      ),
    );
    await fixture.whenStable();
    expect(element.querySelector('.message.streaming .message-text')?.textContent).toContain(
      'Drafting the plan…',
    );

    events.emit(
      wireEvent(
        'agentMessageComplete',
        {
          sessionId: 'S-1',
          message: { index: 2, role: 'agent', text: 'Drafting the plan…', at: new Date().toISOString() },
        },
        'P-1',
      ),
    );
    await fixture.whenStable();

    expect(element.querySelector('.message.user')).toBeTruthy();
    expect(element.querySelector('.message.agent')).toBeTruthy();
  });

  it('renders the plan document and completion in the right pane', async () => {
    seedSession(events, 'P-1');
    const fixture = TestBed.createComponent(PlanComponent);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    const document = '<plan>\n<goal>a board</goal>\n</plan>';
    events.emit(wireEvent('planDocumentUpdated', { sessionId: 'S-1', document }, 'P-1'));
    await fixture.whenStable();

    expect(element.querySelector('app-plan-document .document-text')?.textContent).toContain(
      'a board',
    );

    events.emit(wireEvent('planningSessionCompleted', { sessionId: 'S-1' }, 'P-1'));
    await fixture.whenStable();
    expect(element.querySelector('app-plan-document .done')?.textContent).toContain('committed');
  });
});
