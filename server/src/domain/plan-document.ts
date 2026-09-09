// The planner's markdown plan document (D8): the document is the artifact —
// prose plus one ticket per frontmatter block. The block's shape (the
// prompt teaches it) is:

//   #[Ticket title]
//
//   ---
//   cardType: coding      # coding | design | docs (default: coding)
//   key: t1               # optional in-batch key other tickets block on
//   blockedBy: [T-12, t2] # existing card ids or in-batch keys
//   ---
//
//   The markdown description…

// The square brackets on the heading are literal and mark a ticket: a
// plain `# Title` is a normal prose heading, never a ticket. `parseTickets`
// reads the bracketed blocks back into the validated `TicketEmission`
// shape on approval; the rest of the document is prose and is ignored here.

import type { TicketEmission } from '../wire/commands.js';
import type { CardType } from '../wire/models.js';
import { CommandRejection } from './rejection.js';

/** Extracts the tickets embedded in a planner's markdown plan document. */
export function parseTickets(document: string): TicketEmission[] {
  const lines = document.split(/\r?\n/);
  const tickets: TicketEmission[] = [];
  let i = 0;
  while (i < lines.length) {
    const title = headingTitle(lines[i]);
    if (title === null || title === '') {
      i++;
      continue;
    }
    // A ticket block is a heading immediately followed by a fenced YAML
    // frontmatter; anything else is prose.
    let j = i + 1;
    while (j < lines.length && lines[j]?.trim() === '') j++;
    if (lines[j]?.trim() !== '---') {
      i++;
      continue;
    }
    const fields: string[] = [];
    j++;
    while (
      j < lines.length &&
      lines[j]?.trim() !== '---' &&
      headingTitle(lines[j]) === null &&
      !isMarkdownHeading(lines[j])
    ) {
      fields.push(lines[j] ?? '');
      j++;
    }
    if (lines[j]?.trim() !== '---') {
      i++;
      continue;
    }
    j++; // consume the closing fence
    const body: string[] = [];
    while (j < lines.length && headingTitle(lines[j]) === null && !isMarkdownHeading(lines[j])) {
      body.push(lines[j] ?? '');
      j++;
    }
    tickets.push(toTicket(title, fields, body.join('\n').trim()));
    i = j;
  }
  return tickets;
}

/** `#[Title]` — the bracketed ticket heading; anything else (incl. `# Title`) is prose. */
function headingTitle(line: string | undefined): string | null {
  if (line === undefined) return null;
  const trimmed = line.trim();
  const bracketed = /^#\[(.+)\]$/.exec(trimmed);
  if (bracketed !== null) return bracketed[1]!.trim();
  return null;
}

/** An ordinary ATX heading starts a new plan-level prose section. */
function isMarkdownHeading(line: string | undefined): boolean {
  return line !== undefined && /^ {0,3}#{1,6}(?:\s+|$)/.test(line);
}

/** Builds a ticket from its frontmatter fields and markdown body. */
function toTicket(title: string, fields: readonly string[], body: string): TicketEmission {
  let cardType: CardType = 'coding';
  let key: string | undefined;
  const blockedBy: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(fields[i] ?? '');
    if (match === null) {
      i++;
      continue;
    }
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === 'cardtype') {
      if (value !== 'design' && value !== 'docs' && value !== 'coding') {
        throw new CommandRejection('invalidCommand', `Ticket '${title}' has invalid cardType '${value}'`);
      }
      cardType = value;
      i++;
    } else if (field === 'key') {
      key = unquote(value) || undefined;
      i++;
    } else if (field === 'blockedby') {
      if (value !== '') {
        for (const dep of inlineList(value)) blockedBy.push(dep);
        i++;
      } else {
        i++;
        while (i < fields.length && /^\s*-\s+/.test(fields[i] ?? '')) {
          blockedBy.push(unquote((fields[i] ?? '').replace(/^\s*-\s+/, '').trim()));
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return {
    ...(key !== undefined ? { key } : {}),
    title,
    cardType,
    description: body,
    blockedBy,
  };
}

/** `[a, b, "c d"]` → ['a', 'b', 'c d']. */
function inlineList(value: string): string[] {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return [];
  return inner
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
