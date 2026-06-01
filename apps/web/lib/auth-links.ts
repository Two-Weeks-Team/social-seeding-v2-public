/**
 * Single source of truth for the Google sign-in entry URL. The landing topbar,
 * the hero CTA, and the sign-in page all point here so the OAuth start path is
 * defined once. Server-rendered `<a href>` — no client JS.
 */
export function googleLoginHref(returnUrl = "/campaigns"): string {
  return `/api/auth/google/start?returnUrl=${encodeURIComponent(returnUrl)}`;
}
