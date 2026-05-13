/**
 * @ss/contracts — the single source of truth for shapes that cross a boundary
 * (DB ⇄ capability ⇄ agent ⇄ workflow ⇄ web API ⇄ webhook).
 *
 * Rule: if two packages need to agree on a shape, the Zod schema lives here.
 * Nothing in here imports from another @ss/* package.
 */
export * from "./campaign.js";
export * from "./creator.js";
export * from "./outreach.js";
export * from "./policy.js";
export * from "./events.js";
