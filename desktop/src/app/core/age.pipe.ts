import { Pipe, PipeTransform } from '@angular/core';

import { ageLabel } from './age';

/** Relative age for card timestamps ("5m ago"); the ladder lives in core/age. */
@Pipe({ name: 'age', pure: true })
export class AgePipe implements PipeTransform {
  transform(iso: string): string {
    return ageLabel(iso);
  }
}
