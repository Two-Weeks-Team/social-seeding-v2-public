/**
 * @ss/contracts — the single source of truth for shapes that cross a boundary
 * (DB ⇄ capability ⇄ agent ⇄ workflow ⇄ web API ⇄ webhook).
 *
 * Rule: if two packages need to agree on a shape, the Zod schema lives here.
 * Nothing in here imports from another @ss/* package.
 */
export * from "./campaign";
export * from "./creator";
export * from "./outreach";
export * from "./policy";
export * from "./shipment";
export * from "./events";
export * from "./analytics";
export * from "./report";
export * from "./lead";
export * from "./message";
