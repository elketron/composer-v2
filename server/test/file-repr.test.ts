// The file-backed domains' text repr round-trips: a note or a workflow
// serialized by the domain object parses back to the same metadata and
// body (the workflows library's format rule, applied to both domains).

import { describe, expect, it } from 'vitest';

import { KnowledgeNote } from '../src/domain/knowledge.js';
import { Workflow } from '../src/domain/workflow.js';
import { scanFrontmatter, slugify } from '../src/domain/markdown.js';

describe('knowledge note repr', () => {
  it('a created note parses back to its title, tags, and body', () => {
    const content = KnowledgeNote.toMarkdown({
      title: '  WSL   setup ',
      tags: ['dev', ' windows'],
      content: '  1. Enable the VM.\n2. Install a distro.  ',
    });
    const note = KnowledgeNote.fromFile('wsl-setup.md', content);
    expect(note.title).toBe('WSL setup');
    expect(note.tags).toEqual(['dev', 'windows']);
    expect(note.body).toBe('\n1. Enable the VM.\n2. Install a distro.\n');
    expect(note.info()).toEqual({
      path: 'wsl-setup.md',
      title: 'WSL setup',
      tags: ['dev', 'windows'],
      size: 0,
      updatedAt: '',
    });
  });

  it('the frontmatter wins over the filename fallback, and its absence falls back', () => {
    const titled = KnowledgeNote.fromFile('note.md', '---\ntitle: Real title\n---\n\nbody');
    expect(titled.title).toBe('Real title');
    const bare = KnowledgeNote.fromFile('fallback.md', 'just body text');
    expect(bare.title).toBe('fallback');
    expect(bare.tags).toEqual([]);
    expect(bare.body).toBe('just body text');
  });

  it('a title match outweighs a tag match, and every token must hit', () => {
    const note = KnowledgeNote.fromFile('n.md', '---\ntitle: Deploy pipeline\ntags: ops\n---\n\nthe body text');
    expect(note.score(['deploy'])).toBe(4);
    expect(note.score(['ops'])).toBe(3);
    expect(note.score(['body'])).toBe(1);
    expect(note.score(['deploy', 'ops'])).toBe(7);
    expect(note.score(['deploy', 'missing'])).toBeNull();
  });
});

describe('workflow repr', () => {
  it('a recorded workflow round-trips through toMarkdown and fromFile', () => {
    const content = Workflow.toMarkdown({
      title: 'Ship the release',
      description: 'Cut a release tag',
      tags: ['release'],
      source: 'T-7',
      agent: 'coder',
      recordedAt: '2026-09-08T00:00:00Z',
      links: ['docs/release.md'],
      steps: [
        { title: 'Tag the build', detail: 'Annotated, signed.', command: 'git tag -s v1' },
        { title: 'Push', command: 'git push --tags' },
        { title: 'Announce' },
      ],
    });
    const workflow = Workflow.fromFile('ship-the-release.md', content);
    expect(workflow.title).toBe('Ship the release');
    expect(workflow.description).toBe('Cut a release tag');
    expect(workflow.tags).toEqual(['release']);
    expect(workflow.source).toBe('T-7');
    expect(workflow.agent).toBe('coder');
    expect(workflow.recordedAt).toBe('2026-09-08T00:00:00Z');
    expect(workflow.links).toEqual(['docs/release.md']);
    expect(workflow.steps).toEqual([
      { title: 'Tag the build', detail: 'Annotated, signed.', command: 'git tag -s v1' },
      { title: 'Push', command: 'git push --tags' },
      { title: 'Announce' },
    ]);
    expect(workflow.steps.length).toBe(3);
    expect(workflow.info().steps).toBe(3);
    // Reparsing the serialized text yields the same file text.
    expect(Workflow.toMarkdown({
      title: 'Ship the release',
      description: 'Cut a release tag',
      tags: ['release'],
      source: 'T-7',
      agent: 'coder',
      recordedAt: '2026-09-08T00:00:00Z',
      links: ['docs/release.md'],
      steps: [
        { title: 'Tag the build', detail: 'Annotated, signed.', command: 'git tag -s v1' },
        { title: 'Push', command: 'git push --tags' },
        { title: 'Announce' },
      ],
    })).toBe(content);
  });

  it('tolerates hand edits: stray prose is ignored, the first command per step wins', () => {
    const raw = [
      '---',
      'title: Edited',
      '---',
      '',
      'free prose before the list',
      '## Steps',
      '',
      '1. First step',
      '   detail line',
      '   !first --command',
      '   !second --command',
      '',
      'stray prose between steps',
      '2. Second step',
    ].join('\n');
    const workflow = Workflow.fromFile('edited.md', raw);
    expect(workflow.title).toBe('Edited');
    expect(workflow.steps).toEqual([
      { title: 'First step', detail: 'detail line', command: 'first --command' },
      { title: 'Second step' },
    ]);
  });
});

describe('shared markdown helpers', () => {
  it('slugs fall back when nothing survives, and cap at 48 chars', () => {
    expect(slugify('!!!', 'note')).toBe('note');
    expect(slugify('Hello, WSL World!', 'note')).toBe('hello-wsl-world');
    const long = slugify('x'.repeat(80), 'note');
    expect(long.length).toBe(48);
    expect(long.endsWith('-')).toBe(false);
  });

  it('the frontmatter scanner returns the fields and the body after the block', () => {
    const scanned = scanFrontmatter('---\ntitle: T\ntags: a, b\n---\n\nbody line\n');
    expect(scanned?.fields.get('title')).toBe('T');
    expect(scanned?.fields.get('tags')).toBe('a, b');
    expect(scanned?.body).toBe('\nbody line\n');
    expect(scanFrontmatter('no frontmatter')).toBeNull();
    expect(scanFrontmatter('---\nnever closed')).toBeNull();
  });
});
