import type { MDXComponents } from "mdx/types";
import { codeToHtml } from "shiki";

import { cn } from "@/lib/utils";

/**
 * MDX overrides. The <pre> override server-renders the code block via
 * shiki in BOTH dark and light themes; our globals.css hides the inactive
 * theme based on the .dark class. Zero client JS. Matches the landing
 * page's <CodeBlock> so code looks the same everywhere.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props) => (
      <h1 className="mt-0 text-3xl font-semibold tracking-tight" {...props} />
    ),
    h2: (props) => (
      <h2 className="mt-10 border-b border-border pb-1 text-xl font-semibold tracking-tight" {...props} />
    ),
    h3: (props) => (
      <h3 className="mt-6 text-base font-semibold tracking-tight" {...props} />
    ),
    a: ({ className, href, ...rest }) => (
      <a
        href={href}
        className={cn("text-accent underline-offset-4 hover:underline", className)}
        {...rest}
      />
    ),
    ul: (props) => <ul className="ml-5 list-disc space-y-1" {...props} />,
    ol: (props) => <ol className="ml-5 list-decimal space-y-1" {...props} />,
    // The async pre override below returns a Promise — legal in RSC but
    // its type isn't ReactNode, so we widen here.
    pre: (async (props: PreProps) => <MDXPre {...props} />) as unknown as MDXComponents["pre"],
    ...components,
  };
}

interface PreProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
}

/**
 * Server-side shiki highlighter for MDX code blocks. Extracts language
 * from the nested <code className="language-xxx"> node (MDX's default
 * shape) and renders both theme variants; the inactive one is hidden via
 * globals.css.
 */
async function MDXPre(props: PreProps) {
  const childEl = (props.children as { props?: { className?: string; children?: string } })?.props;
  const raw = typeof childEl?.children === "string" ? childEl.children : "";
  const lang = (childEl?.className ?? "").match(/language-([\w-]+)/)?.[1] ?? "text";

  if (!raw) return <pre {...props} />;

  const [dark, light] = await Promise.all([
    codeToHtml(raw, { lang, theme: "github-dark-dimmed" }).catch(() =>
      codeToHtml(raw, { lang: "text", theme: "github-dark-dimmed" }),
    ),
    codeToHtml(raw, { lang, theme: "github-light" }).catch(() =>
      codeToHtml(raw, { lang: "text", theme: "github-light" }),
    ),
  ]);

  return (
    <div className="not-prose my-5 overflow-hidden rounded-xl border border-border bg-card">
      <div
        className="hidden dark:block"
        dangerouslySetInnerHTML={{ __html: dark }}
      />
      <div
        className="block dark:hidden"
        dangerouslySetInnerHTML={{ __html: light }}
      />
    </div>
  );
}
