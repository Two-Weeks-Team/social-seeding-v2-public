import { cn } from "@/lib/cn";

/**
 * Avatar — deterministic muted initials chip. Used for creators (with @handle)
 * and the user, so we NEVER show raw IDs as the visual identity. Color is
 * derived from the seed string against a restrained, palette-harmonious set.
 */
const PALETTE = [
  "#7a5c46", // cocoa
  "#5a7d8c", // slate teal
  "#7d6a9c", // muted plum
  "#8a6c2e", // bronze
  "#5c6a84", // indigo slate
  "#3f6b4a", // forest
  "#9a5a48", // terracotta
  "#6b5650", // taupe
];

function pick(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] as string;
}

function initial(name: string): string {
  const t = name.replace(/^@/, "").trim();
  return (t[0] ?? "?").toUpperCase();
}

const SIZE = { sm: 24, md: 32, lg: 40 } as const;

export function Avatar({
  name,
  src,
  size = "md",
  className,
}: {
  name: string;
  /** Optional profile image URL (e.g. TikTok avatarThumb). Falls back to initials. */
  src?: string | null;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const px = SIZE[size];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={px}
        height={px}
        className={cn("rounded-full object-cover shrink-0 bg-surface-2", className)}
        style={{ width: px, height: px }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={cn("inline-grid place-items-center rounded-full text-white font-bold shrink-0", className)}
      style={{ width: px, height: px, background: pick(name), fontSize: px * 0.38 }}
      aria-hidden
    >
      {initial(name)}
    </span>
  );
}
