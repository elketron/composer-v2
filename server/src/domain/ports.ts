// The whole-source ports the domain transitions depend on (SRV-022): a
// clock and an id generator, injected by the application layer so a
// transition is pure — identical state and a command produce identical
// pending events. The production values are `nowIso` (wire/envelope) and
// `randomUUID` (node:crypto); the domains don't reach either directly.

/** RFC 3339 now, with microseconds. */
export type Clock = () => string;

/** A fresh unique id (a uuid). */
export type IdGenerator = () => string;