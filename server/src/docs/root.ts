import { join } from 'node:path';
import { DOCS_DIRNAME } from './constants.js';

export function docsRoot(projectDirectory: string): string {
  return join(projectDirectory, DOCS_DIRNAME);
}
