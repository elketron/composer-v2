/**
 * The chat composer's shared behavior (FNT-007): the auto-grow textarea
 * and the Enter-to-send contract. The assistant and the planning chat
 * mount identical composers; the mention handling stays local to the
 * assistant (only it has @-mentions).
 */

/** Grows the textarea with its content (up to the cap). */
export function resizeComposer(area: HTMLTextAreaElement, capPx = 180): void {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight, capPx)}px`;
}

/**
 * Enter sends, shift+enter (and alt/ctrl+enter) keep editing.
 * Returns true when the event was consumed as a send.
 */
export function composerEnter(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  event.preventDefault();
  return true;
}
