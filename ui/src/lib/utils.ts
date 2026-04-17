import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Small helper used by every component; Tailwind class merging. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Relative time like "2m ago". Consistent, compact, no external lib. */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return `${Math.max(0, Math.round(diff))}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

/** Human-friendly bytes. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** ns → ms, rounded to 1 decimal. Handles undefined cleanly. */
export function nsToMs(ns?: number | null): string {
  if (ns == null) return "—";
  return `${(ns / 1_000_000).toFixed(1)}ms`;
}
