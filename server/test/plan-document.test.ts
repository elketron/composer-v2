import { describe, expect, it } from 'vitest';
import { parseTickets } from '../src/domain/plan-document.js';

describe('parseTickets', () => {
  it('reads each bracketed, fenced ticket block, ignoring prose', () => {
    const document = [
      'A plan for the board.',
      '',
      '# A normal prose heading',
      '',
      '#[Add dark mode]',
      '',
      '---',
      'cardType: design',
      'key: dark-mode',
      'blockedBy: [T-12, t2]',
      '---',
      '',
      'Toggle the theme from the OS preference.',
      '',
      '#[Wire the debugger]',
      '',
      '---',
      'cardType: coding',
      '---',
      '',
      'Attach the debugger to the runtime.',
    ].join('\n');

    expect(parseTickets(document)).toEqual([
      {
        title: 'Add dark mode',
        cardType: 'design',
        key: 'dark-mode',
        blockedBy: ['T-12', 't2'],
        description: 'Toggle the theme from the OS preference.',
      },
      {
        title: 'Wire the debugger',
        cardType: 'coding',
        description: 'Attach the debugger to the runtime.',
        blockedBy: [],
      },
    ]);
  });

  it('defaults the card type and empty optionals', () => {
    const document = ['#[Ticket]', '', '---', '---', '', 'Body text.'].join('\n');
    expect(parseTickets(document)).toEqual([
      { title: 'Ticket', cardType: 'coding', description: 'Body text.', blockedBy: [] },
    ]);
  });

  it('rejects a present but invalid card type', () => {
    const document = ['#[Ticket]', '', '---', 'cardType: Design', '---', '', 'Body text.'].join('\n');

    expect(() => parseTickets(document)).toThrow("Ticket 'Ticket' has invalid cardType 'Design'");
  });

  it('reads a blockedBy list form', () => {
    const document = ['#[Ticket]', '', '---', 'blockedBy:', '  - T-1', '  - k2', '---', '', 'x'].join('\n');
    expect(parseTickets(document)).toEqual([
      { title: 'Ticket', cardType: 'coding', description: 'x', blockedBy: ['T-1', 'k2'] },
    ]);
  });

  it('treats an unbracketed heading as prose, not a ticket', () => {
    // A normal markdown title, even one followed by a frontmatter fence, is
    // not a ticket — the square brackets are the discriminator.
    const document = ['# Not a ticket', '', '---', 'cardType: design', '---', '', 'body'].join('\n');
    expect(parseTickets(document)).toEqual([]);
  });

  it('ignores bracketed headings without a frontmatter fence', () => {
    const document = ['#[Not fenced]', '', 'Just text, no fence.'].join('\n');
    expect(parseTickets(document)).toEqual([]);
  });

  it('ignores a ticket with unterminated frontmatter', () => {
    const document = [
      '#[Malformed ticket]',
      '',
      '---',
      'cardType: design',
      '',
      'This description must not be discarded into frontmatter.',
    ].join('\n');

    expect(parseTickets(document)).toEqual([]);
  });

  it('stops a ticket description at the next plan-level markdown section', () => {
    const document = [
      '#[Ticket]',
      '',
      '---',
      'cardType: docs',
      '---',
      '',
      'First description paragraph.',
      '',
      '- Description detail',
      '',
      '## Notes',
      '',
      'This is plan prose, not part of the ticket.',
    ].join('\n');

    expect(parseTickets(document)).toEqual([
      {
        title: 'Ticket',
        cardType: 'docs',
        description: 'First description paragraph.\n\n- Description detail',
        blockedBy: [],
      },
    ]);
  });
});
