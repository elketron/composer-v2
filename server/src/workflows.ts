// The agent workflow library (S34): recorded procedures ("stored
// procedures") under the project's `.composer/workflows/` directory — one
// markdown file per workflow, frontmatter plus a `## Steps` ordered list.
// A worker agent records one while it works (start_recording → add_step →
// stop_recording over MCP) and later retrieves and follows it via
// workflow_search / workflow_read. Files are the truth: the processor
// performs the writes inside the command path and publishes metadata
// events; content reaches clients over REST reads. The library is flat
// (no subdirectories); every access enforces containment like the
// knowledge store's. The workflow's text representation (parse,
// serialization, scored match) lives on the domain object
// (domain/workflow.ts); this library is the I/O.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkflowInfo, WorkflowStep } from './wire/models.js';
import { invalidLibraryPath, slugify, uniqueSlugPath } from './domain/markdown.js';
import { Workflow, type RecordParts, type RecordedStep } from './domain/workflow.js';
import type { MutationResult } from './filesystem/commit.js';
import { isWithinRoot } from './filesystem/containment.js';
import { containedTarget, deleteContainedFile, ensureLibraryRoot, writeContainedFile } from './filesystem/contained-file.js';

const WORKFLOWS_DIRNAME = 'workflows';
const WORKFLOWS_ROOT_DIRNAME = '.composer';
/** 256 KiB per workflow; procedures are procedures, not logs. */
export const MAX_WORKFLOW_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 10;
/** A recording may not grow past a pipeline's own step ceiling. */
export const MAX_WORKFLOW_STEPS = 64;
export const MAX_LINKS = 20;
const MAX_LINK_CHARS = 200;

export type WorkflowResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type { RecordParts, RecordedStep } from './domain/workflow.js';

/** The workflows root of a project directory (not required to exist yet). */
export function workflowsRoot(projectDirectory: string): string {
  return join(projectDirectory, WORKFLOWS_ROOT_DIRNAME, WORKFLOWS_DIRNAME);
}

export interface ParsedWorkflow {
  info: Omit<WorkflowInfo, 'size' | 'updatedAt'>;
  steps: WorkflowStep[];
  body: string;
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
  const workflow = Workflow.fromFile(path, raw);
  let size = 0;
  let updatedAt = '';
  try {
    const stat = statSync(resolveContained(projectDirectory, path));
    size = stat.size;
    updatedAt = stat.mtime.toISOString();
  } catch {
    // Read already succeeded; the stat is display metadata only.
  }
  return { ok: true, value: { info: { ...workflow.info(), size, updatedAt }, content: raw } };
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
    const workflow = Workflow.fromFile(info.path, read.value.content);
    const score = workflow.score(tokens);
    if (score === null) continue;
    results.push({ info, snippet: workflow.snippet(tokens[0]!), score });
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
): MutationResult<WorkflowInfo & { path: string }> {
  const title = parts.title.trim();
  if (title === '') return { ok: false, error: 'a workflow needs a title' };
  if (parts.steps.length === 0) return { ok: false, error: 'a workflow needs at least one step' };
  const content = Workflow.toMarkdown(parts);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WORKFLOW_BYTES) {
    return { ok: false, error: `workflow exceeds the ${Math.floor(MAX_WORKFLOW_BYTES / 1024)} KiB limit` };
  }
  const taken = new Set(listWorkflows(projectDirectory).map((info) => info.path.toLowerCase()));
  const path = uniqueSlugPath(taken, slugify(title, 'workflow'));
  const ensured = ensureLibraryRoot(workflowsRoot(projectDirectory), 'workflow', path);
  if (!ensured.ok) return ensured;
  const resolved = containedTarget(ensured.real, path, 'workflows library');
  if (!resolved.ok) return resolved;
  const written = writeContainedFile(ensured.real, resolved.target, content, 'workflow', path);
  if (!written.ok) return written;
  const workflow = Workflow.fromFile(path, content);
  return {
    ok: true,
    value: { ...workflow.info(), size: bytes, updatedAt: new Date().toISOString() },
    rollback: written.rollback,
  };
}

/** Deletes one workflow; it must exist. */
export function deleteWorkflow(projectDirectory: string, path: string): MutationResult<null> {
  const invalid = invalidWorkflowPath(path);
  if (invalid !== null) return { ok: false, error: invalid };
  let target: string;
  try {
    target = resolveContained(projectDirectory, path);
    statSync(target);
  } catch {
    return { ok: false, error: `not a readable workflow: ${path}` };
  }
  const deleted = deleteContainedFile(target, 'workflow', path);
  if (!deleted.ok) return deleted;
  return { ok: true, value: null, rollback: deleted.rollback };
}

// ---- Format ----

/**
 * A workflow path addresses one file of the flat library: a clean `.md`
 * name (no separators, no traversal) — the knowledge store's rule.
 */
export function invalidWorkflowPath(path: string): string | null {
  return invalidLibraryPath(path, 'workflow', 'workflows');
}

/** Parses a workflow file (the domain object's repr). */
export function parseWorkflow(path: string, raw: string): ParsedWorkflow {
  const workflow = Workflow.fromFile(path, raw);
  return { info: workflow.info(), steps: [...workflow.steps], body: workflow.body };
}

/** Serializes a recording into the file format (the inverse of parseWorkflow). */
export function serializeWorkflow(parts: RecordParts): string {
  return Workflow.toMarkdown(parts);
}

// ---- Internals ----

function statWorkflow(root: string, name: string): WorkflowInfo | null {
  const file = join(root, name);
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    const workflow = Workflow.fromFile(name, readFileSync(file).toString('utf8'));
    return { ...workflow.info(), size: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function resolveContained(projectDirectory: string, path: string): string {
  const rootReal = realpathSync(workflowsRoot(projectDirectory));
  const target = resolve(rootReal, path);
  if (!isWithinRoot(rootReal, target)) {
    throw new Error('path escapes the workflows library');
  }
  return target;
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
