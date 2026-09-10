// The predefined executor catalogs the pipeline editor offers (S33/S37):
// the shipped pipeline agents and the reusable runtime (terminal) steps.
// Agents own their behavior/instructions/tools; a step simply selects one.
// Runtime steps are server-authoritative shell presets a command step can
// pick (the editor still shows the resolved command for fine-tuning).

export interface PipelineAgentCatalogEntry {
  /** The agent kind a step references (`agentKind` on the wire). */
  id: string;
  label: string;
  /** A short, read-only description shown in the step editor. */
  description: string;
}

export interface RuntimeStepCatalogEntry {
  /** The preset's stable id (used only for selection; the command is copied). */
  id: string;
  label: string;
  /** The shell command the preset resolves to (runs in the project directory). */
  command: string;
  description: string;
}

/** A sidebar group the pipeline editor organizes pipelines under. */
export interface PipelineCategoryCatalogEntry {
  /** The category a pipeline references (`category` on the wire). */
  id: string;
  label: string;
  /** A short, read-only description shown in the editor. */
  description: string;
}

export const PIPELINE_AGENTS: readonly PipelineAgentCatalogEntry[] = [
  {
    id: 'coder',
    label: 'Coder',
    description: 'Implements the card in the project, writes or extends tests, and makes the checks pass.',
  },
  {
    id: 'tester',
    label: 'Tester',
    description: 'Verifies the implementation matches the card and makes the relevant checks pass.',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Reviews the working-tree change against the card (read-only) and reports a verdict.',
  },
  {
    id: 'security',
    label: 'Security',
    description: 'Security-reviews the change for risks it could introduce (read-only).',
  },
];

export const PIPELINE_CATEGORIES: readonly PipelineCategoryCatalogEntry[] = [
  {
    id: 'coding',
    label: 'Coding',
    description: 'Implementation, review, and delivery of code changes.',
  },
  {
    id: 'documentation',
    label: 'Documentation',
    description: 'Writing and maintaining project docs.',
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Investigation and comparison work.',
  },
  {
    id: 'release',
    label: 'Release',
    description: 'Versioning, changelogs, and shipping.',
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Environments, tooling, and operations.',
  },
];

export const RUNTIME_STEPS: readonly RuntimeStepCatalogEntry[] = [
  {
    id: 'create-branch',
    label: 'Create branch',
    command: 'git switch -c composer-change',
    description: 'Checkout to a new branch.',
  },
  {
    id: 'create-worktree',
    label: 'Create worktree',
    command: 'git worktree add ../composer-worktree -b composer-change',
    description: 'Create a linked working tree on a new branch.',
  },
  {
    id: 'open-pr',
    label: 'Open pull request',
    command: 'gh pr create --fill',
    description: 'Open a pull request for the current branch (gh).',
  },
  {
    id: 'run-tests',
    label: 'Run tests',
    command: 'pnpm test',
    description: 'Run the project test suite.',
  },
  {
    id: 'build',
    label: 'Build',
    command: 'pnpm build',
    description: 'Build the project.',
  },
  {
    id: 'lint',
    label: 'Lint',
    command: 'pnpm lint',
    description: 'Run the linter.',
  },
  {
    id: 'typecheck',
    label: 'Type-check',
    command: 'pnpm typecheck',
    description: 'Run the type checker.',
  },
];