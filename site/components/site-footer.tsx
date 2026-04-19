import Link from "next/link";

import { Logo } from "@/components/logo";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              Capture real production traffic, replay at N× against a
              hermetic clone, find breaking points before users do.
            </p>
          </div>
          <FooterColumn title="Product">
            <FooterLink href="/docs">Documentation</FooterLink>
            <FooterLink href="/docs/quickstart">Quickstart</FooterLink>
            <FooterLink href="/docs/concepts">Concepts</FooterLink>
          </FooterColumn>
          <FooterColumn title="Community">
            <FooterLink
              href="https://github.com/charlses/clearvoiance"
              external
            >
              GitHub
            </FooterLink>
            <FooterLink
              href="https://www.npmjs.com/package/@clearvoiance/node"
              external
            >
              npm package
            </FooterLink>
            <FooterLink
              href="https://github.com/charlses/clearvoiance/issues"
              external
            >
              Issues
            </FooterLink>
          </FooterColumn>
          <FooterColumn title="Legal">
            <FooterLink
              href="https://github.com/charlses/clearvoiance/blob/main/LICENSE"
              external
            >
              Apache-2.0
            </FooterLink>
          </FooterColumn>
        </div>
        <div className="mt-10 flex flex-col items-start justify-between gap-2 border-t border-border pt-6 text-xs text-muted-foreground md:flex-row md:items-center">
          <p>© {new Date().getFullYear()} clearvoiance contributors.</p>
          <p>Self-hostable. Apache-2.0. Built in the open.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      <ul className="mt-3 space-y-2 text-sm">{children}</ul>
    </div>
  );
}

function FooterLink({
  href,
  children,
  external = false,
}: {
  href: string;
  children: React.ReactNode;
  external?: boolean;
}) {
  if (external) {
    return (
      <li>
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          {children}
        </a>
      </li>
    );
  }
  return (
    <li>
      <Link
        href={href}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        {children}
      </Link>
    </li>
  );
}
