// The file-backed repositories' ports (SRV-003): the processor depends on
// these interfaces, not the concrete filesystem modules. The real modules
// (`docs/index.ts`, `workflows.ts`, `knowledge.ts`) are injected at boot and
// as constructor defaults, so the write path — and its compensation — is
// testable against a stub without touching the disk.

import type { MutationResult } from '../filesystem/commit.js';
import type { DocInfo, WorkflowInfo } from '../wire/models.js';
import type { RecordParts } from '../domain/workflow.js';

export interface DocsRepository {
  save(directory: string, path: string, content: string): MutationResult<DocInfo>;
  rename(directory: string, path: string, to: string): MutationResult<DocInfo>;
  remove(directory: string, path: string): MutationResult<null>;
}

export interface WorkflowRepository {
  save(directory: string, parts: RecordParts): MutationResult<WorkflowInfo & { path: string }>;
  remove(directory: string, path: string): MutationResult<null>;
}

export interface FileRepositories {
  docs: DocsRepository;
  workflows: WorkflowRepository;
}