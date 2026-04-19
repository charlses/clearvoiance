"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One-liner install block with a copy button. Tiny state machine: click
 * copies to clipboard + flashes the icon for 1.5s. Avoids pulling in a
 * toast library for a single micro-interaction.
 */
export function InstallBlock({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  function onCopy() {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 font-mono text-sm",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="text-accent" aria-hidden="true">
          $
        </span>
        <span className="truncate">{command}</span>
      </span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
      >
        {copied ? (
          <>
            <Check className="size-3.5 text-success" aria-hidden="true" />
            <span>Copied</span>
          </>
        ) : (
          <>
            <Copy className="size-3.5" aria-hidden="true" />
            <span>Copy</span>
          </>
        )}
      </button>
    </div>
  );
}
