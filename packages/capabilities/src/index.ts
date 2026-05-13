/**
 * Importing this module registers every capability as a side effect.
 * Add new capability files here.
 */
export * from "./registry";
export * from "./usage";
// re-export the V1 fetcher seam so test code can inject fakes via @ss/capabilities
export { setTikTokFetcher, getTikTokFetcher, type TikTokFetcher, type RawCreator, type TikTokPost } from "./tiktok/get-creator";

import "./tiktok/search";
import "./tiktok/get-creator";
import "./gmail/send";
import "./blacklist/check";
import "./crm/enrich";
import "./outreach/extract-facts";
import "./ranking/score";
import "./templates/render";
import "./workspace/policy";
