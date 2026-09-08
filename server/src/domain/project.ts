// The project (dual representation): `fromWire`/`toWire()` around an
// immutable instance; the fold replaces instances with `with()` as project
// events land.

import type { Project as ProjectJson } from '../wire/models.js';

export class Project {
  readonly id: string;
  readonly name: string;
  readonly directory?: string;
  readonly createdAt: string;
  readonly archivedAt?: string;

  constructor(json: ProjectJson) {
    this.id = json.id;
    this.name = json.name;
    if (json.directory !== undefined) this.directory = json.directory;
    this.createdAt = json.createdAt;
    if (json.archivedAt !== undefined) this.archivedAt = json.archivedAt;
  }

  static fromWire(json: ProjectJson): Project {
    return new Project(json);
  }

  toWire(): ProjectJson {
    return {
      id: this.id,
      name: this.name,
      ...(this.directory !== undefined ? { directory: this.directory } : {}),
      createdAt: this.createdAt,
      ...(this.archivedAt !== undefined ? { archivedAt: this.archivedAt } : {}),
    };
  }

  get isArchived(): boolean {
    return this.archivedAt !== undefined;
  }

  with(changes: Partial<ProjectJson>): Project {
    const merged: Record<string, unknown> = { ...this.toWire() };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return new Project(merged as unknown as ProjectJson);
  }
}
