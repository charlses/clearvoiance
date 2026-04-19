"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface Section {
  title: string;
  items: Array<{ href: string; label: string }>;
}

const SECTIONS: Section[] = [
  {
    title: "Get started",
    items: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/concepts", label: "Core concepts" },
    ],
  },
  {
    title: "Capture",
    items: [{ href: "/docs/monitors", label: "Monitors (remote control)" }],
  },
  {
    title: "Self-host",
    items: [{ href: "/docs/deployment", label: "Deployment" }],
  },
];

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <ScrollArea className="h-[calc(100vh-3.5rem)] w-56 shrink-0 border-r border-border bg-muted/20 lg:sticky lg:top-14">
      <nav className="px-4 py-6 lg:px-5">
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-6">
            <h4 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h4>
            <ul className="space-y-1">
              {section.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "block rounded-md px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-background font-medium text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </ScrollArea>
  );
}
