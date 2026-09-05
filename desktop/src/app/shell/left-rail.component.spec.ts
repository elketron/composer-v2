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
    await fixture.whenStable();
    const entries = (fixture.nativeElement as HTMLElement).querySelectorAll('.entry');

    expect(entries.length).toBe(7); // board, plan, agent, canvas, library + account, settings
  });

  it('wires board, plan and settings as links', async () => {
    const fixture = TestBed.createComponent(LeftRailComponent);
    await fixture.whenStable();
    const links = [...(fixture.nativeElement as HTMLElement).querySelectorAll('a.entry')];
    const labels = links.map((a) => a.getAttribute('aria-label'));

    expect(labels).toEqual(['board', 'plan', 'settings']);
  });

  it('renders agent, canvas, library and account as disabled stubs', async () => {
    const fixture = TestBed.createComponent(LeftRailComponent);
    await fixture.whenStable();
    const disabled = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.entry.disabled')];
    const labels = disabled.map((el) => el.getAttribute('title'));

    expect(labels).toEqual([
      'agent · lands in M2',
      'canvas · lands in M2',
      'library · lands in M2',
      'account · lands in M2',
    ]);
    for (const el of disabled) {
      expect(el.getAttribute('aria-disabled')).toBe('true');
    }
  });
});
