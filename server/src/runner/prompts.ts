// The worker's prompts: the card is the work order; the runtime's own
// tools are the surface. The per-worker opening verb and working rules
// (the coder's are v1's), the stage's outcome brief (S36), and the stage
// ordering the drive loop uses to skip ahead.

import type { Card, Pipeline, PipelineStage, PipelineStep } from '../wire/models.js';

/** A stage's forward order in its pipeline (absent = last, so unknown stages never skip ahead). */
export function stageOrderOf(pipeline: Pipeline, stageId: string): number {
  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  return index >= 0 ? index : pipeline.stages.length;
}

/** The worker's brief: the card is the work order; the runtime's own tools are the surface. */
export function promptFor(agentKind: string, card: Card, step: PipelineStep, outcomeBrief?: string): string {
  const instructions = step.instructions?.trim() !== '' ? step.instructions!.trim() : defaultInstructionOf(agentKind);
  const blockers =
    card.blockedBy.length > 0 ? `\n\nBlockers (already satisfied): ${card.blockedBy.join(', ')}` : '';
  const [verb, closing] = briefOf(agentKind);
  return [
    `${verb} card ${card.id}: ${card.title}`,
    '',
    card.description.trim() !== '' ? card.description : '(no description)',
    blockers,
    '',
    `Instructions: ${instructions}`,
    ...(outcomeBrief !== undefined ? ['', outcomeBrief] : []),
    '',
    closing,
  ]
    .filter((part) => part !== undefined)
    .join('\n');
}

/**
 * The agent brief's outcome section (S36): the stage's named outcomes and
 * what each does. Present only when the stage defines outcomes.
 */
export function outcomeBriefOf(pipeline: Pipeline, stage: PipelineStage | undefined): string | undefined {
  const rules = stage?.outcomes ?? [];
  if (rules.length === 0) return undefined;
  const lines = rules.map((rule) => {
    const target =
      rule.toStageId !== undefined
        ? `the card returns to ${
            pipeline.stages.find((candidate) => candidate.id === rule.toStageId)?.label ?? rule.toStageId
          }`
        : 'the pipeline proceeds to the next step';
    return `- ${rule.outcome} — ${target}`;
  });
  return [
    "Outcomes: when the work is done, call `composer_report_outcome` with exactly one of this stage's outcome names:",
    ...lines,
    stage?.requiresOutcome === true
      ? 'This stage requires the call: a finished turn without it fails the step.'
      : 'The call is optional: a finished turn without it proceeds.',
  ].join('\n');
}

function defaultInstructionOf(agentKind: string): string {
  switch (agentKind) {
    case 'tester':
      return 'Verify the card.';
    case 'reviewer':
      return 'Review the card.';
    case 'security':
      return 'Security-review the card.';
    default:
      return 'Implement the card.';
  }
}

/** Per-worker opening verb and working rules (the coder's are v1's). */
function briefOf(agentKind: string): [string, string] {
  switch (agentKind) {
    case 'tester':
      return [
        'Verify',
        'Work in the current directory with your own file and shell tools. Confirm the implementation matches the card, write or extend the tests that prove it, and make the relevant checks pass.',
      ];
    case 'reviewer':
      return [
        'Review',
        'Review the working tree\'s change against the card — git diff is the first look. Judge correctness and fit; do not edit anything. Finish with a clear verdict: approved, or the changes the card still needs.',
      ];
    case 'security':
      return [
        'Security-review',
        'Security-review the working tree\'s change — git diff is the first look. Report the risks the change could introduce; never fix anything. Finish with a clear verdict: no findings, or each finding with its file and what must change.',
      ];
    default:
      return [
        'Implement',
        'Work in the current directory with your own file and shell tools. Keep the change minimal and make the relevant checks pass.',
      ];
  }
}
