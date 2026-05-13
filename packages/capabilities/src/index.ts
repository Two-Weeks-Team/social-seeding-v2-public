/**
 * Importing this module registers every capability as a side effect.
 * Add new capability files here.
 */
export * from "./registry.js";

import "./tiktok/search.js";
import "./tiktok/get-creator.js";
import "./gmail/send.js";
import "./blacklist/check.js";
import "./crm/enrich.js";
