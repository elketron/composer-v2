// The agent workflow (S34): one recorded procedure — frontmatter (title,
// description, tags, source, agent, recorded, links) plus a `## Steps`
// ordered list (`N. title` headers, indented detail lines, an indented
// `!command` line). The class owns the workflow's text representation —
// parsing a file (tolerant by design: prose outside the step list is
// ignored, the first `!command` per step wins) and serializing a recording
// into the file format — plus its scored match. The library's file I/O
// stays in src/workflows.ts; this is the repr.

import type { WorkflowInfo, WorkflowStep } from '../wire/models.js';
import { listValue, oneLine, scanFrontmatter, scoreText, snippetFor } from './markdown.js';

export interface RecordParts {
  title: string;
  description?: string;
  tags?: string[];
  source?: string;
  agent?: string;
  steps: RecordedStep[];
  links?: string[];
  recordedAt: string;
}

/**
 * One recorded step: what to do, why (detail), and the command that does
 * it (any one of the three may carry the step alone).
 */
export interface RecordedStep {
  title: string;
  detail?: string;
  command?: string;
}

export class Workflow {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly source?: string;
  readonly agent?: string;
  readonly recordedAt?: string;
  readonly links: readonly string[];
  /** The parsed step list (the wire metadata carries only the count). */
  readonly steps: readonly WorkflowStep[];
  /** The file text under the frontmatter (the `## Steps` list lives here). */
  readonly body: string;

  private constructor(
    path: string,
    title: string,
    description: string,
    tags: readonly string[],
    source: string | undefined,
    agent: string | undefined,
    recordedAt: string | undefined,
    links: readonly string[],
    steps: readonly WorkflowStep[],
    body: string,
  ) {
    this.path = path;
    this.title = title;
    this.description = description;
    this.tags = tags;
    this.source = source;
    this.agent = agent;
    this.recordedAt = recordedAt;
    this.links = links;
    this.steps = steps;
    this.body = body;
  }

  /**
   * Parses one workflow's file text. The title falls back to the path
   * (minus the extension); the frontmatter wins when present.
   */
  static fromFile(path: string, raw: string): Workflow {
    const scanned = scanFrontmatter(raw);
    let title = path.replace(/\.md$/i, '');
    let description = '';
    let tags: readonly string[] = [];
    let source: string | undefined;
    let agent: string | undefined;
    let recordedAt: string | undefined;
    let links: readonly string[] = [];
    let body = raw;
    if (scanned !== null) {
      body = scanned.body;
      const fields = scanned.fields;
      const frontTitle = fields.get('title');
      if (frontTitle !== undefined && frontTitle !== '') title = frontTitle;
      description = fields.get('description') ?? '';
      tags = listValue(fields.get('tags'));
      const sourceValue = fields.get('source');
      if (sourceValue !== undefined && sourceValue !== '') source = sourceValue;
      const agentValue = fields.get('agent');
      if (agentValue !== undefined && agentValue !== '') agent = agentValue;
      const recordedValue = fields.get('recorded');
      if (recordedValue !== undefined && recordedValue !== '') recordedAt = recordedValue;
      links = listValue(fields.get('links'));
    }

    const steps: WorkflowStep[] = [];
    let inSteps = false;
    let current: (WorkflowStep & { detailLines: string[]; commandLine?: string }) | null = null;
    const flush = (): void => {
      if (current === null) return;
      steps.push({
        title: current.title,
        ...(current.detailLines.length > 0 ? { detail: current.detailLines.join('\n') } : {}),
        ...(current.commandLine !== undefined ? { command: current.commandLine } : {}),
      });
      current = null;
    };
    for (const line of body.split('\n')) {
      if (/^##\s+Steps\s*$/.test(line)) {
        flush();
        inSteps = true;
        continue;
      }
      if (!inSteps) continue;
      const header = /^\s*(\d+)\.\s+(.*)$/.exec(line);
      if (header !== null && !line.startsWith('   ') && !line.startsWith('\t')) {
        flush();
        current = { title: header[2]!.trim(), detailLines: [] };
        continue;
      }
      if (current === null) continue;
      if (/^\s+!\s*(.+)$/.test(line)) {
        if (current.commandLine === undefined) {
          current.commandLine = /^\s+!\s*(.+)$/.exec(line)![1]!.trim();
        }
        continue;
      }
      if (line.trim() === '') continue;
      if (/^\s/.test(line)) current.detailLines.push(line.trim());
      // An unindented non-header line inside the step list is stray prose —
      // ignored, never an error: hand edits keep reading.
    }
    flush();

    return new Workflow(path, title, description, tags, source, agent, recordedAt, links, steps, body);
  }

  /** The wire metadata (size/updatedAt ride the store's stat). */
  info(): Omit<WorkflowInfo, 'size' | 'updatedAt'> {
    return {
      path: this.path,
      title: this.title,
      description: this.description,
      tags: [...this.tags],
      ...(this.source !== undefined ? { source: this.source } : {}),
      ...(this.agent !== undefined ? { agent: this.agent } : {}),
      steps: this.steps.length,
      links: [...this.links],
      ...(this.recordedAt !== undefined ? { recordedAt: this.recordedAt } : {}),
    };
  }

  /** The search body: the description plus everything under the frontmatter. */
  haystack(): string {
    return [this.description, this.body].join('\n').toLowerCase();
  }

  /**
   * The workflow's AND-scored match for the query tokens — a title hit
   * weighs 4, a tag hit 3, a body hit 1, and every token must match
   * somewhere. Null when the workflow does not match.
   */
  score(tokens: readonly string[]): number | null {
    return scoreText(
      tokens,
      this.title.toLowerCase(),
      this.tags.map((tag) => tag.toLowerCase()),
      this.haystack(),
    );
  }

  /** A search-body excerpt around the first token hit. */
  snippet(token: string): string {
    return snippetFor(this.haystack(), token);
  }

  /** Serializes a recording into the file format (the inverse of fromFile). */
  static toMarkdown(parts: RecordParts): string {
    const tags = (parts.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '');
    const links = (parts.links ?? []).map((link) => link.trim()).filter((link) => link !== '');
    const frontmatter =
      `---\n` +
      `title: ${oneLine(parts.title)}\n` +
      (parts.description?.trim() ? `description: ${oneLine(parts.description)}\n` : '') +
      (tags.length > 0 ? `tags: ${tags.join(', ')}\n` : '') +
      (parts.source?.trim() ? `source: ${oneLine(parts.source)}\n` : '') +
      (parts.agent?.trim() ? `agent: ${oneLine(parts.agent)}\n` : '') +
      `recorded: ${parts.recordedAt}\n` +
      (links.length > 0 ? `links: ${links.join(', ')}\n` : '') +
      `---\n`;
    const steps = parts.steps
      .map((step, index) => {
        const lines = [`${index + 1}. ${oneLine(step.title)}`];
        if (step.detail?.trim()) lines.push(...step.detail.trim().split('\n').map((line) => `   ${line}`));
        if (step.command?.trim()) lines.push(`   !${step.command.trim()}`);
        return lines.join('\n');
      })
      .join('\n');
    return `${frontmatter}\n## Steps\n\n${steps}\n`;
  }
}
