import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
} from '../events/events-client.fake';
import { PaletteComponent } from './palette.component';
import { PaletteService } from './palette.service';

describe('PaletteComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [PaletteComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
    TestBed.inject(PaletteService);
    seedProject(events, 'P-1', 'alpha');
  });

  function press(key: string, init: KeyboardEventInit = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  }

  // Input-level keys (arrows/Enter) must be dispatched at the focused
  // input; document-level ones (shortcuts, Escape) go to the document.
  function pressInInput(fixture: { nativeElement: HTMLElement }, key: string): void {
    fixture.nativeElement.querySelector<HTMLInputElement>('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  it('stays hidden until Ctrl/Cmd+K opens it and Escape closes it', async () => {
    const fixture = TestBed.createComponent(PaletteComponent);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.palette')).toBeNull();

    press('k', { ctrlKey: true });
    await fixture.whenStable();
    expect(el.querySelector('.palette')).not.toBeNull();
    expect(document.activeElement?.tagName).toBe('INPUT');

    press('Escape');
    await fixture.whenStable();
    expect(el.querySelector('.palette')).toBeNull();
  });

  it('filters as the user types and runs the active entry on Enter', async () => {
    const fixture = TestBed.createComponent(PaletteComponent);
    const palette = TestBed.inject(PaletteService);
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true);
    palette.openPalette();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'settings';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    const options = [...el.querySelectorAll('li')];
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('open settings');

    pressInInput({ nativeElement: el }, 'Enter');
    await fixture.whenStable();
    expect(palette.isOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  it('arrow keys move the active entry', async () => {
    const fixture = TestBed.createComponent(PaletteComponent);
    const palette = TestBed.inject(PaletteService);
    palette.openPalette();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    pressInInput({ nativeElement: el }, 'ArrowDown');
    await fixture.whenStable();
    expect(palette.activeIndex()).toBe(1);
    expect(el.querySelectorAll('li')[1]!.classList.contains('active')).toBe(true);

    pressInInput({ nativeElement: el }, 'ArrowUp');
    pressInInput({ nativeElement: el }, 'ArrowUp');
    await fixture.whenStable();
    expect(palette.activeIndex()).toBe(palette.results().length - 1);
  });

  it('a backdrop click closes without running anything', async () => {
    const fixture = TestBed.createComponent(PaletteComponent);
    const palette = TestBed.inject(PaletteService);
    palette.openPalette();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('.backdrop')!.click();
    await fixture.whenStable();
    expect(palette.isOpen()).toBe(false);
  });
});
