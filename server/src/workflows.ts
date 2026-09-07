// The agent workflow library (S34): recorded procedures ("stored
// procedures") under the project's `.composer/workflows/` directory — one
// markdown file per workflow, frontmatter plus a `## Steps` ordered list.
// A worker agent records one while it works (start_recording → add_step →
// stop_recording over MCP) and later retrieves and follows it via
// workflow_search / workflow_read. Files are the truth: the processor
// performs the writes inside the command path and publishes metadata
// events; content reaches clients over REST reads. The library is flat
// (no subdirectories); every access enforces containment like the
// knowledge store's.

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { WorkflowInfo, WorkflowStep } from './wire/models.js';

const WORKFLOWS_DIRNAME = 'workflows';
const WORKFLOWS_ROOT_DIRNAME = '.composer';
/** 256 KiB per workflow; procedures are procedures, not logs. */
export const MAX_WORKFLOW_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 10;
const MAX_SLUG_CHARS = 48;
/** A recording may not grow past a pipeline's own step ceiling. */
export const MAX_WORKFLOW_STEPS = 64;
export const MAX_LINKS = 20;
const MAX_LINK_CHARS = 200;

export type WorkflowResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The workflows root of a project directory (not required to exist yet). */
export function workflowsRoot(projectDirectory: string): string {
  return join(projectDirectory, WORKFLOWS_ROOT_DIRNAME, WORKFLOWS_DIRNAME);
}

export interface ParsedWorkflow {
  info: Omit<WorkflowInfo, 'size' | 'updatedAt'>;
  steps: WorkflowStep[];
  body: string;
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

// ---- Reads ----

/** Every workflow, sorted by path (a missing library lists empty). */
export function listWorkflows(projectDirectory: string): WorkflowInfo[] {
  const root = workflowsRoot(projectDirectory);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const infos: WorkflowInfo[] = [];
  for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const info = statWorkflow(root, name);
    if (info !== null) infos.push(info);
  }
  return infos.sort((a, b) => a.path.localeCompare(b.path));
}

/** One workflow's file text (frontmatter included) and parsed metadata. */
export function readWorkflow(
  projectDirectory: string,
  path: string,
): WorkflowResult<{ info: WorkflowInfo; content: string }> {
  const invalid = invalidWorkflowPath(path);
  if (invalid !== null) return { ok: false, error: invalid };
  let raw: string;
  try {
    raw = readFileSync(resolveContained(projectDirectory, path)).toString('utf8');
  } catch {
    return { ok: false, error: `not a readable workflow: ${path}` };
  }
  const parsed = parseWorkflow(path, raw);
  let size = 0;
  let updatedAt = '';
  try {
    const stat = statSync(resolveContained(projectDirectory, path));
    size = stat.size;
    updatedAt = stat.mtime.toISOString();
  } catch {
    // Read already succeeded; the stat is display metadata only.
  }
  return { ok: true, value: { info: { ...parsed.info, size, updatedAt }, content: raw } };
}

/**
 * Scored search (AND over whitespace-split tokens), the knowledge store's
 * weights: a title match weighs 4, a tag match 3, a body (steps, detail,
 * description) match 1. Results carry a snippet of the matched body.
 */
export function searchWorkflows(
  projectDirectory: string,
  query: string,
): Array<{ info: WorkflowInfo; snippet: string; score: number }> {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) return [];
  const results: Array<{ info: WorkflowInfo; snippet: string; score: number }> = [];
  for (const info of listWorkflows(projectDirectory)) {
    const read = readWorkflow(projectDirectory, info.path);
    if (!read.ok) continue;
    const parsed = parseWorkflow(info.path, read.value.content);
    const haystack = [parsed.info.description, parsed.body].join('\n').toLowerCase();
    const tags = info.tags.map((tag) => tag.toLowerCase());
    const title = info.title.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      if (title.includes(token)) tokenScore += 4;
      if (tags.some((tag) => tag.includes(token))) tokenScore += 3;
      if (haystack.includes(token)) tokenScore += 1;
      if (tokenScore === 0) {
        score = 0; // AND semantics: every token must match somewhere.
        break;
      }
      score += tokenScore;
    }
    if (score === 0) continue;
    results.push({ info, snippet: snippetFor(haystack, tokens[0]!), score });
  }
  return results
    .sort((a, b) => b.score - a.score || a.info.path.localeCompare(b.info.path))
    .slice(0, MAX_SEARCH_RESULTS);
}

// ---- Writes (the processor's command path) ----

/**
 * Saves a recorded workflow: the store builds the frontmatter, the step
 * list, and a unique slug filename, so an agent can never overwrite by
 * accident. Returns the saved metadata (including its path).
 */
export function saveWorkflow(
  projectDirectory: string,
  parts: RecordParts,
): WorkflowResult<WorkflowInfo & { path: string }> {
  const title = parts.title.trim();
  if (title === '') return { ok: false, error: 'a workflow needs a title' };
  if (parts.steps.length === 0) return { ok: false, error: 'a workflow needs at least one step' };
  const content = serializeWorkflow(parts);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WORKFLOW_BYTES) {
    return { ok: false, error: `workflow exceeds the ${Math.floor(MAX_WORKFLOW_BYTES / 1024)} KiB limit` };
  }
  const path = uniquePath(projectDirectory, slugify(title));
  const root = workflowsRoot(projectDirectory);
  try {
    mkdirSync(root, { recursive: true });
    const rootReal = realpathSync(root);
    const target = resolve(rootReal, path);
    if (!target.startsWith(rootReal + sep)) {
      return { ok: false, error: 'path escapes the workflows library' };
    }
    writeFileSync(target, content, 'utf8');
  } catch {
    return { ok: false, error: `workflow '${path}' could not be written` };
  }
  const parsed = parseWorkflow(path, content);
  return {
    ok: true,
    value: { ...parsed.info, size: bytes, updatedAt: new Date().toISOString() },
  };
}

/** Deletes one workflow; it must exist. */
export function deleteWorkflow(projectDirectory: string, path: string): WorkflowResult<null> {
  const invalid = invalidWorkflowPath(path);
  if (invalid !== null) return { ok: false, error: invalid };
  let target: string;
  try {
    target = resolveContained(projectDirectory, path);
    statSync(target);
  } catch {
    return { ok: false, error: `not a readable workflow: ${path}` };
  }
  try {
    rmSync(target);
  } catch {
    return { ok: false, error: `workflow '${path}' could not be deleted` };
  }
  return { ok: true, value: null };
}

// ---- Format ----

/**
 * A workflow path addresses one file of the flat library: a clean `.md`
 * name (no separators, no traversal) — the knowledge store's rule.
 */
export function invalidWorkflowPath(path: string): string | null {
  if (path.trim() === '') return 'workflow path is required';
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('/') || path.includes('\\')) {
    return 'workflow paths are plain file names of the flat library';
  }
  if (!path.toLowerCase().endsWith('.md')) return 'workflows are .md files';
  return null;
}

/** Serializes a recording into the file format (the inverse of parseWorkflow). */
export function serializeWorkflow(parts: RecordParts): string {
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

/**
 * Parses a workflow file: frontmatter (title, description, tags, source,
 * agent, recorded, links) plus the `## Steps` ordered list — `N. title`
 * headers, indented detail lines, an indented `!command` line. Tolerant by
 * design (files are the truth; human edits must keep reading): prose
 * outside the step list is ignored, detail lines attach to the current
 * step, and the first `!command` per step wins.
 */
export function parseWorkflow(path: string, raw: string): ParsedWorkflow {
  let title = path.replace(/\.md$/i, '');
  let description = '';
  let tags: string[] = [];
  let source: string | undefined;
  let agent: string | undefined;
  let recordedAt: string | undefined;
  let links: string[] = [];
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      const head = raw.slice(3, end);
      body = raw.slice(raw.indexOf('\n', end + 1) + 1);
      for (const line of head.split('\n')) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key === 'title' && value !== '') title = value;
        if (key === 'description') description = value;
        if (key === 'tags') tags = value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
        if (key === 'source' && value !== '') source = value;
        if (key === 'agent' && value !== '') agent = value;
        if (key === 'recorded' && value !== '') recordedAt = value;
        if (key === 'links') links = value.split(',').map((link) => link.trim()).filter((link) => link !== '');
      }
    }
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

  return {
    info: {
      path,
      title,
      description,
      tags,
      ...(source !== undefined ? { source } : {}),
      ...(agent !== undefined ? { agent } : {}),
      steps: steps.length,
      links,
      ...(recordedAt !== undefined ? { recordedAt } : {}),
    },
    steps,
    body,
  };
}

// ---- Internals ----

function statWorkflow(root: string, name: string): WorkflowInfo | null {
  const file = join(root, name);
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    const parsed = parseWorkflow(name, readFileSync(file).toString('utf8'));
    return { ...parsed.info, size: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function resolveContained(projectDirectory: string, path: string): string {
  const rootReal = realpathSync(workflowsRoot(projectDirectory));
  const target = resolve(rootReal, path);
  if (target !== rootReal && !target.startsWith(rootReal + sep)) {
    throw new Error('path escapes the workflows library');
  }
  return target;
}

function uniquePath(projectDirectory: string, slug: string): string {
  const taken = new Set(listWorkflows(projectDirectory).map((info) => info.path.toLowerCase()));
  let candidate = `${slug}.md`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    candidate = `${slug}-${n}.md`;
  }
  return candidate;
}

function snippetFor(body: string, token: string): string {
  const at = body.indexOf(token);
  if (at < 0) return body.slice(0, 400);
  const start = Math.max(0, at - 80);
  return (start > 0 ? '…' : '') + body.slice(start, start + 400);
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '');
  return slug === '' ? 'workflow' : slug;
}

export function normalizeLinks(links: unknown): string[] | null {
  if (links === undefined) return [];
  if (!Array.isArray(links)) return null;
  const cleaned: string[] = [];
  for (const link of links) {
    if (typeof link !== 'string' || link.trim() === '') return null;
    if (link.length > MAX_LINK_CHARS) return null;
    cleaned.push(link.trim());
  }
  return cleaned.length <= MAX_LINKS ? cleaned : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
