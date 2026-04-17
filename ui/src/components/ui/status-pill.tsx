import { cn } from "@/lib/utils";

const TONES: Record<string, string> = {
  active: "bg-success/10 text-success border-success/30",
  running: "bg-accent/10 text-accent border-accent/30",
  pending: "bg-muted text-muted-foreground border-border",
  stopped: "bg-muted text-muted-foreground border-border",
  completed: "bg-success/10 text-success border-success/30",
  failed: "bg-danger/10 text-danger border-danger/30",
  cancelled: "bg-warning/10 text-warning border-warning/30",
  default: "bg-muted text-muted-foreground border-border",
};

export function StatusPill({ status }: { status: string }) {
  const tone = TONES[status] ?? TONES.default;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        tone,
      )}
    >
      {status}
    </span>
  );
}
