/** Join Tailwind-style class names — filters falsy values. */
export function cn(...args: Array<string | number | undefined | null | false>): string {
  return args.filter(Boolean).join(" ");
}
