import Link from "next/link";
import { Package } from "lucide-react";

import { GithubIcon } from "@/components/icons/github";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/concepts", label: "Concepts" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <Button
            asChild
            size="icon"
            variant="ghost"
            aria-label="npm"
            className="h-8 w-8"
          >
            <a
              href="https://www.npmjs.com/package/@clearvoiance/node"
              target="_blank"
              rel="noreferrer noopener"
            >
              <Package />
            </a>
          </Button>
          <Button
            asChild
            size="icon"
            variant="ghost"
            aria-label="GitHub"
            className="h-8 w-8"
          >
            <a
              href="https://github.com/charlses/clearvoiance"
              target="_blank"
              rel="noreferrer noopener"
            >
              <GithubIcon className="size-4" />
            </a>
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
