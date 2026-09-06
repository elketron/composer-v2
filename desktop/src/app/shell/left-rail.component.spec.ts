import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { LeftRailComponent } from './left-rail.component';

describe('LeftRailComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LeftRailComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders all rail entries in MVP order', async () => {
    const fixture = TestBed.createComponent(LeftRailComponent);
    fixture.componentRef.setInput('projectId', 'P-1');
    await fixture.whenStable();
    const entries = (fixture.nativeElement as HTMLElement).querySelectorAll('.entry');

    expect(entries.length).toBe(8);
  });

  it('wires board, plan, pipelines, coding and settings as links', async () => {
    const fixture = TestBed.createComponent(LeftRailComponent);
    fixture.componentRef.setInput('projectId', 'P-1');
    await fixture.whenStable();
    const links = [...(fixture.nativeElement as HTMLElement).querySelectorAll('a.entry')];
    const labels = links.map((a) => a.getAttribute('aria-label'));

    expect(labels).toEqual(['board', 'plan', 'pipelines', 'coding', 'projects', 'settings']);
  });

  it('renders canvas and account as disabled stubs', async () => {
    const fixture = TestBed.createComponent(LeftRailComponent);
    fixture.componentRef.setInput('projectId', 'P-1');
    await fixture.whenStable();
    const disabled = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('.entry.disabled'),
    ];
    const labels = disabled.map((el) => el.getAttribute('title'));

    expect(labels).toEqual(['canvas · not available yet', 'account · not available yet']);
    for (const el of disabled) {
      expect(el.getAttribute('aria-disabled')).toBe('true');
    }
  });
});
