import { codeToHtml } from "shiki";

import { cn } from "@/lib/utils";

/**
 * Server component. Renders a code block with shiki — the same highlighter
 * rehype-pretty-code uses in MDX, so code on the landing page looks
 * identical to code in the docs. Server-rendered so there's no FOUC.
 */
export async function CodeBlock({
  code,
  lang = "ts",
  filename,
  className,
}: {
  code: string;
  lang?: string;
  filename?: string;
  className?: string;
}) {
  const [dark, light] = await Promise.all([
    codeToHtml(code, {
      lang,
      theme: "github-dark-dimmed",
    }),
    codeToHtml(code, {
      lang,
      theme: "github-light",
    }),
  ]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      {filename ? (
        <div className="flex items-center justify-between border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
          <span>{filename}</span>
          <span className="text-[0.6rem] uppercase tracking-wider">{lang}</span>
        </div>
      ) : null}
      <div className="relative">
        <div
          className="hidden dark:block"
          dangerouslySetInnerHTML={{ __html: dark }}
        />
        <div
          className="block dark:hidden"
          dangerouslySetInnerHTML={{ __html: light }}
        />
      </div>
    </div>
  );
}
