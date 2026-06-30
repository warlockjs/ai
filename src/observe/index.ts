// Observe — generic, panoptic-agnostic observability seam. Core defines
// the structural `Observer` + a tiny registry; observability tools
// (panoptic, …) implement `Observer` and register themselves, so flows
// can route their completed reports without core importing any tool.

export {
  clearObservers,
  getObservers,
  isObserveAll,
  registerObserver,
  setObserveAll,
} from "./observer-registry";
export { notifyObservers, resolveObservers } from "./resolve-observers";

export type { Observer } from "./observer.contract";
export type { FlowObserveOption } from "./resolve-observers";
