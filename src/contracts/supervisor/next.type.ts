import type { EndSentinel } from "../end.type";

/**
 * The legal return shape of a supervisor's dispatch decision — what
 * both `route` callbacks and router agents produce for `next`:
 *
 * - `string` — single agent key; supervisor dispatches that one agent.
 * - `string[]` — fan-out; supervisor dispatches all listed keys in
 *   parallel via `Promise.all`.
 * - `EndSentinel` — the framework-global `END` constant; terminates.
 *
 * Shape decides dispatch; there is no separate "strategy" enum.
 *
 * @example
 * import { END, type Next } from "@warlock.js/ai";
 *
 * const single: Next = "triage";
 * const fanOut: Next = ["orderLookup", "billingLookup"];
 * const stop:   Next = END;
 */
export type Next = string | string[] | EndSentinel;
