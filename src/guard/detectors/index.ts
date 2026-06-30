// Built-in zero-dependency detectors
export { injection } from "./injection";
export { pii } from "./pii";
export { topic } from "./topic";

// Optional moderation detector (lazily-imported `openai` peer)
export { moderation } from "./moderation";
