import { cn } from "@/lib/utils";

export function Code({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.78rem]",
        className,
      )}
      {...props}
    />
  );
}
