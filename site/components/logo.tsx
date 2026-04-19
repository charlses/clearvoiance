import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Minimal wordmark. Not a graphic logo yet — that's a designer's job. The
 * square glyph is a stylized "cv" / signal-chart so it reads as both the
 * initials and the product concept (a captured waveform) from a distance.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}
      aria-label="clearvoiance"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-6 text-accent"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="22" height="22" rx="5" className="fill-accent" />
        <path
          d="M5 14 L9 10 L12 13 L15 8 L19 12"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-accent-foreground"
        />
      </svg>
      <span>clearvoiance</span>
    </Link>
  );
}
