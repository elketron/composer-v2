// The step-type registry (S37 redesign): the single place that describes
// what a pipeline step can be — palette groups, presets, icons, and the
// node/inspector vocabulary. Today's kinds (agent, command, human) plus the
// terminal completion pseudo-node are the first entries; later built-in
// steps slot in by adding registry entries (and, when unavoidable, one new
// `PipelineStepKind`), not by reworking the editor. Nothing outside this
// file may hardcode step-kind switches for authoring purposes.

import type { LucideIconData } from 'lucide-angular';
import { Bot, Check, SquareCheck, Terminal } from 'lucide-angular';

import type { PipelineAgentCatalogEntry, PipelineStepKind, RuntimeStepCatalogEntry } from '../core/models/pipeline.models';

/** The fields a palette preset fills on a fresh step draft (everything but the id; completion presets fill nothing). */
export type StepPresetPatch = {
  kind?: PipelineStepKind;
  boardVisible?: boolean;
  agentKind?: string;
  instructions?: string;
  command?: string;
  description?: string;
};

/** One palette entry: a named starting point for a new step. */
export interface StepPreset {
  /** Stable preset id (`preset-…` for local ones, catalog ids otherwise). */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** The draft fields the preset fills (kind is required). */
  readonly patch: StepPresetPatch;
}

/** One palette column: a step type with the presets it offers. */
export interface StepTypeMeta {
  /** The wire kind the type authors ('completion' is the terminal pseudo-node). */
  readonly kind: PipelineStepKind | 'completion';
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIconData;
  readonly presets: readonly StepPreset[];
}

/** The node badge vocabulary per step kind (the mockup's type badges). */
export const STEP_KIND_BADGES: Readonly<Record<PipelineStepKind | 'completion', string>> = {
  agent: 'Agent',
  command: 'Set',
  human: 'Approval',
  completion: 'Completion',
};

/** One justfile recipe (the server reads it from the project directory). */
export interface JustRecipeEntry {
  readonly name: string;
  readonly description: string;
}

/**
 * The static palette: agents/approval/completion presets are fixed; the Set
 * column takes the catalog's runtime steps plus the project's justfile
 * recipes (`just <name>` command steps).
 */
export function paletteModel(
  agents: readonly PipelineAgentCatalogEntry[],
  runtimeSteps: readonly RuntimeStepCatalogEntry[],
  justRecipes: readonly JustRecipeEntry[] = [],
): readonly StepTypeMeta[] {
  const agentPresets: readonly StepPreset[] = [
    ...agents.map((agent) => ({
      id: `preset-agent-${agent.id}`,
      label: agent.label,
      description: agent.description,
      patch: { kind: 'agent', agentKind: agent.id } as StepPresetPatch,
    })),
    {
      id: 'preset-agent-custom',
      label: 'Custom agent',
      description: 'An agent step you configure from scratch.',
      patch: { kind: 'agent', agentKind: 'coder' },
    },
  ];

  const commandPresets: readonly StepPreset[] = [
    ...runtimeSteps.map((preset) => ({
      id: `preset-runtime-${preset.id}`,
      label: preset.label,
      description: preset.description,
      patch: { kind: 'command', command: preset.command, description: preset.label } as StepPresetPatch,
    })),
    ...justRecipes.map((recipe) => ({
      id: `preset-just-${recipe.name}`,
      label: `just ${recipe.name}`,
      description: recipe.description || 'Run the justfile recipe.',
      patch: { kind: 'command', command: `just ${recipe.name}`, description: recipe.name } as StepPresetPatch,
    })),
    {
      id: 'preset-command-custom',
      label: 'Custom command',
      description: 'A shell command step you write yourself.',
      patch: { kind: 'command' },
    },
  ];

  return [
    {
      kind: 'agent',
      label: 'Agent step',
      description: 'Run an AI agent with tools and instructions.',
      icon: Bot,
      presets: agentPresets,
    },
    {
      kind: 'human',
      label: 'Approval step',
      description: 'Require human approval.',
      icon: SquareCheck,
      presets: [
        {
          id: 'preset-approval-simple',
          label: 'Simple approval',
          description: 'A single approve/reject gate.',
          patch: { kind: 'human', description: 'Approve to continue.' },
        },
        {
          id: 'preset-approval-checklist',
          label: 'Approval with checklist',
          description: 'Approve against a checklist.',
          patch: { kind: 'human', description: 'Approve once every checklist item holds.' },
        },
      ],
    },
    {
      kind: 'command',
      label: 'Set step',
      description: 'Predefined operations.',
      icon: Terminal,
      presets: commandPresets,
    },
    {
      kind: 'completion',
      label: 'Completion step',
      description: 'Finish the pipeline.',
      icon: Check,
      presets: [
        {
          id: 'preset-completion-mark',
          label: 'Mark complete',
          description: 'The card is done when it reaches this step.',
          patch: {},
        },
        {
          id: 'preset-completion-custom',
          label: 'Custom completion',
          description: 'Rename the completion lane.',
          patch: {},
        },
      ],
    },
  ];
}

/** The default preset a bare "+ add step" uses (a coder agent). */
export const DEFAULT_STEP_PRESET: StepPreset = {
  id: 'preset-default',
  label: 'Coder',
  patch: { kind: 'agent', agentKind: 'coder' },
};
