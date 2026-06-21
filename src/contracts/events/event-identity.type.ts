/**
 * Run-scoped identity stamped onto every lifecycle event payload
 * (agent, workflow, supervisor) and every stream event.
 *
 * Every emitted event carries this so consumers correlating events to
 * a run — cost ledgers, trip archives, trace UIs — never need to
 * smuggle the id through an out-of-band closure.
 *
 * - `runId` — id of the run that emitted this event.
 * - `rootRunId` — id of the outermost run this one belongs to. Equal
 *   to `runId` for a standalone run; for a run nested under a
 *   composite (`asTool`) it points at the top-level run so a flat
 *   query can reconstruct the whole tree. (Nested propagation lands
 *   in a follow-up; until then `rootRunId === runId` always.)
 */
export type EventIdentity = { runId: string; rootRunId: string };

/**
 * The payload shape an emitter call site supplies — everything the
 * event carries EXCEPT the run identity, which the central `emit`
 * chokepoint injects. Keeps call sites from hand-threading `runId`
 * on every emission.
 */
export type WithoutIdentity<T> = Omit<T, keyof EventIdentity>;
