import { describe, expect, it } from 'vitest';

import { EditorDraft } from './editor-draft';

describe('EditorDraft', () => {
  it('rejects a pipeline containing only the terminal Done marker', () => {
    const initial = EditorDraft.newDraft('P-1');
    const draft = initial.with({
      name: 'Nothing to execute',
      steps: initial.steps.filter((step) => step.terminal),
    });

    expect(draft.validate()).toBe('A pipeline needs at least one non-terminal executable step');
  });
});
