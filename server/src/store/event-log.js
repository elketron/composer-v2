// Bundling shim — see event-store.js for why it exists.
export {
  initializeEventLog,
  persistEvent,
  replayProject,
  replayGlobalEvents,
  listProjectIds,
} from './event-log.ts';
