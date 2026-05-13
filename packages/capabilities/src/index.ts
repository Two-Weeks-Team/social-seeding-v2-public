/**
 * Importing this module registers every capability as a side effect.
 * Add new capability files here.
 */
export * from "./registry";
export * from "./usage";
// re-export the V1 fetcher seam so test code can inject fakes via @ss/capabilities
export { setTikTokFetcher, getTikTokFetcher, type TikTokFetcher, type RawCreator, type TikTokPost } from "./tiktok/get-creator";
// re-export the Gmail client seam + tokenManager so tests in other packages
// (notably @ss/workflows creator-track) can inject fakes without depending on
// internal module paths.
export {
  setGmailClientFactory,
  getGmailClientFactory,
  defaultGmailClientFactory,
  normalizeGmailMessage,
  tokenManager,
  type GmailClient,
  type GmailClientFactory,
  type GmailMessage,
  type GmailMessageRef,
  type GmailHistoryDelta,
  type GmailSendInput,
} from "./gmail/client";
// Pub/Sub helpers — used by the apps/web webhook.
export {
  verifyPubSubAuth,
  parsePubSubMessage,
  buildPubSubMessage,
  type GmailNotification,
  type PubSubAuthHeaders,
  type PubSubAuthOpts,
  type PubSubMessage,
} from "./gmail/pubsub";
// Unsubscribe-token verify is consumed by apps/web's /unsubscribe page.
export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  type SignUnsubscribeOptions,
  type UnsubscribeTokenPayload,
  type UnsubscribeVerifyResult,
} from "./gmail/unsubscribe-token";
// Suppression list — apps/web's /unsubscribe page writes; gmail.send reads.
export {
  isSuppressed,
  suppressionAdd,
  suppressionCheck,
  type SuppressionReason,
} from "./suppression/check";
// Carrier seam — same shape as Gmail / TikTok seams; tests inject fakes.
export {
  defaultCarrierClientFactory,
  getCarrierClientFactory,
  setCarrierClientFactory,
  type CarrierClient,
  type CarrierClientFactory,
  type CarrierCreateInput,
  type CarrierCreateResult,
  type CarrierTrackResult,
} from "./shipment/carrier";

import "./tiktok/search";
import "./tiktok/get-creator";
import "./gmail/send";
import "./blacklist/check";
import "./crm/enrich";
import "./outreach/extract-facts";
import "./outreach/judge";
import "./ranking/score";
import "./shipment/create";
import "./shipment/track";
import "./suppression/check";
import "./templates/render";
import "./workspace/policy";
