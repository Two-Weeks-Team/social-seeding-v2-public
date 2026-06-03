export { getDb, getMongoClient, closeMongo } from "./client";
// Re-export ObjectId so consumers can construct ids without taking a
// direct `mongodb` dep (P5-C1 needed this for crm.search tests).
export { ObjectId } from "mongodb";
export { Collections } from "./collections";
export { campaignRepo } from "./repositories/campaign.repo";
export { creatorRepo } from "./repositories/creator.repo";
export { workspaceRepo, defaultPolicy, type PlanName } from "./repositories/workspace.repo";
export { approvalRepo } from "./repositories/approval.repo";
export { traceRepo, type PersistedSpan, type PersistedTraceDoc } from "./repositories/trace.repo";
export { shipmentRepo } from "./repositories/shipment.repo";
export { reportRepo } from "./repositories/report.repo";
export { leadRepo, leadCampaignRepo } from "./repositories/lead.repo";
export { messageRepo, type ThreadSummary } from "./repositories/message.repo";
export {
  importV1Workspaces,
  type ImporterOpts,
  type ImportResult,
} from "./imports/v1-workspaces";
