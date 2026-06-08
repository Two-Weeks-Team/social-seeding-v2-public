/**
 * AP2 i18n helper — minimal, dependency-free wrapper around the 4-locale
 * message JSON files under `apps/web/messages/{ko,en,ja,zh}/ap2.json`.
 *
 * Why no `next-intl`:
 *   The v2 web app does not yet depend on next-intl (see apps/web/package.json).
 *   Adding it requires non-trivial wiring (NextIntlClientProvider,
 *   middleware.ts locale negotiation, app/[locale]/ structure). Per
 *   "Build ONLY What's Asked" + "Scope Discipline", we ship a small wrapper
 *   that matches next-intl's `useTranslations()` shape so the future swap is
 *   one-file mechanical.
 *
 * The keys (`approvals.ap2.*`) are identical to what `next-intl` would consume.
 */
import en from "@/messages/en/ap2.json";
import ko from "@/messages/ko/ap2.json";
import ja from "@/messages/ja/ap2.json";
import zh from "@/messages/zh/ap2.json";
import type { AP2Locale } from "./mandate";

type Messages = typeof en;

const BUNDLES: Record<AP2Locale, Messages> = {
  en: en as Messages,
  ko: ko as Messages,
  ja: ja as Messages,
  zh: zh as Messages,
};

/** Walk a dotted key path against a message bundle, returning the string or null. */
function pick(bundle: unknown, dotted: string): string | null {
  const parts = dotted.split(".");
  let cur: unknown = bundle;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : null;
}

/** Interpolate `{name}` placeholders against a value bag. */
function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const v = values[name];
    return v === undefined ? `{${name}}` : String(v);
  });
}

/**
 * Compatible with `next-intl`'s `useTranslations(prefix)` return shape: a
 * function `(key, values?) => string`. Internal calls in the AP2 UI go
 * through `t("button_sign_all", { ... })`, fully namespaced.
 */
export function createTranslator(
  locale: AP2Locale,
  prefix: string = "approvals.ap2",
): (key: string, values?: Record<string, string | number>) => string {
  const bundle = BUNDLES[locale] ?? BUNDLES.en;
  return (key, values) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const template = pick(bundle, path) ?? pick(BUNDLES.en, path) ?? key;
    return interpolate(template, values);
  };
}

/**
 * Negotiate the locale from a session / header / cookie. Falls back to English,
 * which is the default demo and judge-facing locale.
 */
export function negotiateLocale(input: string | null | undefined): AP2Locale {
  if (!input) return "en";
  const lower = input.toLowerCase();
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return "en";
}

/**
 * Format a Date per locale (D34) — used by the wait-time + expires-in displays
 * in AP2-UX.md §3.2 + §7.1.
 */
export function formatDateTime(date: Date, locale: AP2Locale): string {
  return new Intl.DateTimeFormat(
    locale === "ko"
      ? "ko-KR"
      : locale === "en"
        ? "en-US"
        : locale === "ja"
          ? "ja-JP"
          : "zh-CN",
    { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

/** Relative time formatter, e.g. "12 minutes ago". */
export function formatRelativeMinutes(
  minutesAgo: number,
  locale: AP2Locale,
): string {
  const rtf = new Intl.RelativeTimeFormat(
    locale === "ko"
      ? "ko-KR"
      : locale === "en"
        ? "en-US"
        : locale === "ja"
          ? "ja-JP"
          : "zh-CN",
    { numeric: "auto", style: "short" },
  );
  return rtf.format(-Math.max(0, Math.round(minutesAgo)), "minute");
}
