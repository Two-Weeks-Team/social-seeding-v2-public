/**
 * Pure helper extracted out of `campaign-canvas.tsx` so SERVER components
 * (e.g. `app/(mission-control)/campaigns/[id]/page.tsx`) can call it
 * directly. Next 16 forbids invoking a non-component export of a
 * `"use client"` module from server code; this file has no client
 * directive and no React imports, so it crosses the boundary cleanly.
 *
 * Behaviour is identical to the previous in-canvas definition — drives
 * the outreach-stage node status + the per-track-state badge cluster in
 * the canvas.
 */
import type { CreatorTrack } from "@ss/contracts";

export type TrackStateBuckets = Record<CreatorTrack["state"], number>;

export function bucketTracksByState(tracks: ReadonlyArray<CreatorTrack>): TrackStateBuckets {
  const out: TrackStateBuckets = {
    candidate: 0,
    shortlisted: 0,
    outreach_sent: 0,
    in_conversation: 0,
    agreed: 0,
    address_collected: 0,
    shipped: 0,
    delivered: 0,
    posted: 0,
    verified: 0,
    declined: 0,
    no_response: 0,
    flaked: 0,
  };
  for (const t of tracks) out[t.state]++;
  return out;
}
