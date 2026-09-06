import { TestBed } from '@angular/core/testing';

import { ConfirmDialogComponent } from './confirm-dialog.component';
import { ConfirmService } from './confirm.service';

describe('ConfirmService + ConfirmDialogComponent', () => {
  let confirm: ConfirmService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
    }).compileComponents();
    confirm = TestBed.inject(ConfirmService);
  });

  function text(el: HTMLElement): string {
    return el.textContent ?? '';
  }

  it('renders nothing while idle', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('.dialog')).toBeNull();
  });

  it('renders title, detail, and labels while pending', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    void confirm.confirm({
      title: 'Delete this pipeline?',
      detail: 'Runs keep their history.',
      confirmLabel: 'delete',
      danger: true,
    });
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    expect(text(el.querySelector('.dialog h2')!)).toContain('Delete this pipeline?');
    expect(text(el.querySelector('.dialog p')!)).toContain('Runs keep their history.');
    expect(text(el.querySelector('.actions')!)).toContain('delete');
  });

  it('resolves true on confirm and closes', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    const decided = confirm.confirm({ title: 'Archive?' });
    await fixture.whenStable();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.accept')!.click();
    await fixture.whenStable();

    expect(await decided).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.dialog')).toBeNull();
  });

  it('resolves false on cancel and on the backdrop', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    const cancelled = confirm.confirm({ title: 'Archive?' });
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.actions button')!.click();
    expect(await cancelled).toBe(false);

    const backdropCancelled = confirm.confirm({ title: 'Archive?' });
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.backdrop')!.click();
    expect(await backdropCancelled).toBe(false);
  });

  it('resolves false on Escape', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    const decided = confirm.confirm({ title: 'Archive?' });
    await fixture.whenStable();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(await decided).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('.dialog')).toBeNull();
  });

  it('a superseding request cancels the abandoned promise', async () => {
    void confirm.confirm({ title: 'first' });
    const second = confirm.confirm({ title: 'second' });

    confirm.resolve(true);
    expect(await second).toBe(true);
  });

  it('restores focus to the trigger when the dialog settles', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    await fixture.whenStable();

    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const decided = confirm.confirm({ title: 'Archive?' });
    await fixture.whenStable();
    // Focus moved into the dialog.
    expect(document.activeElement).not.toBe(trigger);

    confirm.resolve(true);
    expect(await decided).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
