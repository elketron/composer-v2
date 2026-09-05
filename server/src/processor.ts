// Command validation → canonical events (v1 architecture.md §Server
// command validation). Same validation order, same rejection messages, and
// the same emitted event lists as v1 for the domains v2 keeps. Human drags
// are never blocked by automation toggles.

import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Bus } from './bus.js';
import type { Command, CommandOutcome, Rejection } from './wire/commands.js';
import { nowIso } from './wire/envelope.js';
import {
  cardTypeCsName,
  isLaneValid,
  stageCsName,
  subStateFor,
  type Card,
  type CardType,
  type Project,
  type Stage,
  type SubStateStatus,
} from './wire/models.js';

export class Processor {
  private bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  /**
   * Validates a command in the given project scope and, on success,
   * publishes the canonical events (persisted, folded, fanned out) before
   * resolving. S0 handles the project domain; the rest join per slice.
   */
  async execute(projectId: string | undefined, command: Command): Promise<CommandOutcome> {
    switch (command.type) {
      case 'requestProjectCreate':
        return this.createProject(command.name, command.directory);
      case 'requestProjectSetDirectory':
        return this.setProjectDirectory(projectId, command.projectId, command.directory);
      case 'requestProjectActivate':
        return this.activateProject(command.projectId);
      case 'requestCardCreate':
        return this.createCards(projectId, [command.card]);
      case 'requestCardsCreate':
        return this.createCards(projectId, command.cards);
      case 'requestCardMove':
        return this.moveCard(projectId, command.cardId, command.toLane, command.override, command.comment);
      case 'requestCardTypeChange':
        return this.changeCardType(projectId, command.cardId, command.toType);
      case 'requestCardArchive':
        return this.archiveCard(projectId, command.cardId);
      case 'requestSubStateUpdate':
        return this.updateSubState(projectId, command.cardId, command.stage, command.status);
      case 'requestAutomationToggle':
        return this.toggleAutomation(projectId, command.lane, command.on);
      default:
        return rejected('invalidCommand', `${command.type} is not implemented yet`);
    }
  }

  private async createProject(name: string, directory?: string): Promise<CommandOutcome> {
    const trimmed = name.trim();
    if (trimmed === '') {
      return rejected('invalidCommand', 'Project name is required');
    }
    if (
      [...this.bus.state.projects.values()].some(
        (project) => project.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      return rejected('invalidCommand', `Project '${trimmed}' already exists`);
    }
    const resolved = resolveDirectory(directory);
    if (directory !== undefined && directory.trim() !== '' && resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      resolved !== null &&
      [...this.bus.state.projects.values()].some((project) =>
        sameDirectory(project.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }

    const project: Project = {
      id: allocateId([...this.bus.state.projects.keys()], 'P'),
      name: trimmed,
      ...(resolved !== null ? { directory: resolved } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.bus.publish(project.id, 'projectCreated', { project });
    await this.bus.publish(project.id, 'projectActivated', { projectId: project.id });
    return ok();
  }

  private async setProjectDirectory(
    scope: string | undefined,
    commandProjectId: string,
    directory: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = this.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    const resolved = resolveDirectory(directory);
    if (resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      [...this.bus.state.projects.values()].some(
        (other) => other.id !== commandProjectId && sameDirectory(other.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }
    if (sameDirectory(project.directory, resolved)) {
      return ok();
    }
    await this.bus.publish(commandProjectId, 'projectDirectoryChanged', {
      projectId: commandProjectId,
      directory: resolved,
    });
    return ok();
  }

  private async activateProject(projectId: string): Promise<CommandOutcome> {
    if (!this.bus.state.projects.has(projectId)) {
      return rejected('unknownProject', `Unknown project ${projectId}`);
    }
    await this.bus.publish(projectId, 'projectActivated', { projectId });
    return ok();
  }

  // ---- Cards ----

  /**
   * Creates one or more cards (v1 `create_cards`): the scope must exist and
   * every `blockedBy` must reference a card that exists at command time
   * (in-batch cross-references are planner-ticket territory, not this).
   * Events publish per card, so each allocation sees the previous one.
   */
  private async createCards(scope: string | undefined, cards: Card[]): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    if (cards.length === 0) {
      return rejected('invalidCommand', 'No cards to create');
    }
    const existing = this.cardsOf(scope);
    for (const card of cards) {
      if (card.blockedBy.some((id) => !existing.has(id))) {
        return rejected('invalidCommand', `blockedBy of '${card.title}' references unknown cards`);
      }
    }

    const now = nowIso();
    for (const card of cards) {
      const created: Card = {
        ...card,
        id: card.id !== '' ? card.id : this.allocateCardId(scope),
        projectId: scope,
        subState: Object.keys(card.subState).length > 0 ? card.subState : subStateFor(card.type),
        createdAt: isSet(card.createdAt) ? card.createdAt : now,
        updatedAt: now,
      };
      existing.set(created.id, created);
      await this.bus.publish(scope, 'cardCreated', { card: created });
      if (isBlockedIn(existing, created)) {
        await this.bus.publish(scope, 'dependencyStateChanged', {
          cardId: created.id,
          blocked: true,
          blockedBy: created.blockedBy,
        });
      }
    }
    return ok();
  }

  /**
   * Moves a card (v1 `move_card`): lane must be valid for the type, the
   * same lane is a no-op, and unsatisfied blockers reject unless
   * overridden. Dependents whose blocked-ness flips get a
   * dependencyStateChanged.
   */
  private async moveCard(
    scope: string | undefined,
    cardId: string,
    toLane: Stage,
    override: boolean,
    comment: string | undefined,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const { projectId, card } = found;
    if (!isLaneValid(card.type, toLane)) {
      return rejected(
        'invalidLane',
        `Lane ${stageCsName(toLane)} is not valid for ${cardTypeCsName(card.type)} cards`,
      );
    }
    if (card.stage === toLane) {
      return ok();
    }
    const before = this.cardsOf(projectId);
    if (!override && isBlockedIn(before, card)) {
      return rejected('blocked', `Card ${cardId} has unsatisfied blockers`);
    }

    await this.bus.publish(projectId, 'cardMoved', {
      cardId: card.id,
      from: card.stage,
      to: toLane,
      ...(comment !== undefined ? { comment } : {}),
    });
    const moved: Card = { ...card, stage: toLane };
    await this.appendDependencyTransitions(projectId, before, moved);
    return ok();
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets sub-state. */
  private async changeCardType(
    scope: string | undefined,
    cardId: string,
    toType: CardType,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    if (found.card.type === toType) {
      return ok();
    }
    await this.bus.publish(found.projectId, 'cardTypeChanged', {
      cardId: found.card.id,
      from: found.card.type,
      to: toType,
    });
    return ok();
  }

  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */
  private async archiveCard(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    await this.bus.publish(found.projectId, 'cardArchived', { cardId: found.card.id });
    return ok();
  }

  /** Updates one sub-state key (v1 `update_sub_state`); unvalidated passthrough. */
  private async updateSubState(
    scope: string | undefined,
    cardId: string,
    stage: string,
    status: SubStateStatus,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    await this.bus.publish(found.projectId, 'subStateUpdated', {
      cardId: found.card.id,
      stage,
      status,
    });
    return ok();
  }

  /** Toggles a lane's automation (v1 `toggle_automation`); per project. */
  private async toggleAutomation(
    scope: string | undefined,
    lane: Stage,
    on: boolean,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    await this.bus.publish(scope, 'automationToggled', { lane, on });
    return ok();
  }

  // ---- Card helpers ----

  private findCard(
    scope: string | undefined,
    cardId: string,
  ): { projectId: string; card: Card } | null {
    if (scope === undefined) return null;
    const card = this.cardsOf(scope).get(cardId);
    return card ? { projectId: scope, card } : null;
  }

  private cardsOf(projectId: string): Map<string, Card> {
    const cards = this.bus.state.byProject.get(projectId)?.cards;
    const copy = new Map<string, Card>();
    for (const [id, card] of cards ?? []) {
      copy.set(id, structuredClone(card));
    }
    return copy;
  }

  private allocateCardId(projectId: string): string {
    return allocateId(this.cardsOf(projectId).keys(), 'T');
  }

  /**
   * After a move, re-evaluates the moved card's dependents and emits
   * dependencyStateChanged for those whose blocked-ness flipped (v1
   * `append_dependency_transitions`).
   */
  private async appendDependencyTransitions(
    projectId: string,
    before: Map<string, Card>,
    moved: Card,
  ): Promise<void> {
    const after = new Map(before);
    after.set(moved.id, moved);
    for (const dependent of before.values()) {
      if (!dependent.blockedBy.includes(moved.id)) continue;
      const was = isBlockedIn(before, dependent);
      const now = isBlockedIn(after, dependent);
      if (was !== now) {
        await this.bus.publish(projectId, 'dependencyStateChanged', {
          cardId: dependent.id,
          blocked: now,
          blockedBy: dependent.blockedBy,
        });
      }
    }
  }
}

function ok(): CommandOutcome {
  return { ok: true };
}

function rejected(code: Rejection['code'], message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

/** Blocked while any blocker exists and is not done (missing blockers don't block). */
function isBlockedIn(cardsById: Map<string, Card>, card: Card): boolean {
  return card.blockedBy.some((id) => {
    const blocker = cardsById.get(id);
    return blocker !== undefined && blocker.stage !== 'done';
  });
}

/** A timestamp the client actually set (v1's DEFAULT_TIMESTAMP sentinel → absent here). */
function isSet(timestamp: string): boolean {
  return timestamp !== '' && Date.parse(timestamp) > 0;
}

/** One past the highest numeric suffix in use ("P-3" → "P-4"). */
function allocateId(ids: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of ids) {
    const match = /^[A-Z]+-(\d+)$/.exec(id);
    if (match && match[1] !== undefined) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}-${max + 1}`;
}

/** Resolves a directory-ish string to an existing absolute path, else null. */
function resolveDirectory(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const path = isAbsolute(value) ? value : join(process.cwd(), value);
  const normalized = normalize(path).replace(/[/\\]+$/, '');
  try {
    return statSync(normalized).isDirectory() ? normalized : null;
  } catch {
    return null;
  }
}

function sameDirectory(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return trimEndingSeparator(left) === trimEndingSeparator(right);
}

function trimEndingSeparator(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? path : trimmed;
}
