import { Pipe, PipeTransform } from '@angular/core';

/** Relative age for card timestamps: "just now", "5m ago", "1h ago", "3d ago". */
@Pipe({ name: 'age', pure: true })
export class AgePipe implements PipeTransform {
  transform(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
