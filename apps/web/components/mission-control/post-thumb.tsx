"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * PostThumb — a TikTok post cover for the content-verification grid. Shows the
 * cached cover image when present; if it's missing or fails to load (e.g. a
 * locally-cached cover got cleared), it degrades to a warm gradient with a play
 * glyph instead of a broken-image icon. Mirrors Avatar's onError fallback.
 */
export function PostThumb({ src, className }: { src?: string | null; className?: string }) {
  const [errored, setErrored] = useState(false);

  if (src && !errored) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setErrored(true)}
        className={cn("w-full h-full object-cover", className)}
      />
    );
  }
  return (
    <div className={cn("w-full h-full grid place-items-center bg-gradient-to-br from-brand to-brand-2", className)}>
      <span className="text-white/70 text-[26px]" aria-hidden>
        ▶
      </span>
    </div>
  );
}
