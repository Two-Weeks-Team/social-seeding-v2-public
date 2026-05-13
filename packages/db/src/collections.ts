/**
 * Collection names. Two groups:
 *  - SHARED_*  : owned by v1; v2 reads (and carefully writes additive fields). See FREEZE.md §3/§7.
 *  - V2_*      : new in v2.
 */
export const Collections = {
  // --- shared with v1 (do not break schema) ---
  SHARED_TIKTOK_ACCOUNTS: "accounts_tiktok",
  SHARED_TIKTOK_POSTS: "posts_tiktok",
  SHARED_CRM_ACCOUNTS: "crm_accounts",
  SHARED_CRM_ENRICHMENT: "crm_enrichment",
  SHARED_BLACKLIST: "influencer_blacklist", // v1 collection name (matches ~/social-seeding/src/app/api/blacklist/*)
  SHARED_WORKSPACES: "workspaces",
  SHARED_WORKSPACE_MEMBERS: "workspace_members",
  SHARED_USER_TOKENS: "user_tokens", // Gmail OAuth tokens
  SHARED_TEMPLATES: "templates",
  SHARED_UNIFIED_EMAILS: "unified_emails",
  SHARED_USER_USAGE: "user_usage", // monthly per-action counters (rate limiter)
  SHARED_WORKSPACE_USAGE: "workspace_usage",
  SHARED_USAGE_LIMIT_OVERRIDES: "usage_limit_overrides", // admin overrides (tombstone-aware)

  // --- new in v2 ---
  V2_CAMPAIGNS: "v2_campaigns",
  V2_CREATOR_TRACKS: "v2_creator_tracks",
  V2_WORKSPACE_POLICIES: "v2_workspace_policies",
  V2_APPROVALS: "v2_approvals",
  V2_AGENT_TRACES: "v2_agent_traces", // per-run observability
  V2_COST_LEDGER: "v2_cost_ledger",
  V2_OUTBOX: "v2_outbox", // gmail.send idempotency + scheduled-send queue (drained by creator-track)
  V2_GMAIL_WATCHES: "v2_gmail_watches", // per-user Gmail Pub/Sub watch state (lastHistoryId)
  V2_SUPPRESSION_LIST: "v2_suppression_list", // unsubscribed / bounced recipients — gmail.send checks pre-send
  V2_SHIPMENTS: "v2_shipments", // Phase 3 — one row per creator-track shipment + carrier event timeline
} as const;
export type CollectionName = (typeof Collections)[keyof typeof Collections];
