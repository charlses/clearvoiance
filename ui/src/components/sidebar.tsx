"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  CircleUser,
  Cog,
  Database,
  Gauge,
  History,
  LogOut,
  PlayCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/monitors", label: "Monitors", icon: Activity },
  { href: "/sessions", label: "Sessions", icon: History },
  { href: "/replays", label: "Replays", icon: PlayCircle },
  { href: "/settings", label: "Settings", icon: Cog },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  async function logout() {
    // Best-effort server-side logout; the cookie clears regardless.
    try {
      await api.logout();
    } catch {
      /* ignore — the redirect below still signs the user out client-side */
    }
    router.replace("/login");
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-muted/40 p-3">
      <div className="mb-6 flex items-center gap-2 px-2 text-sm font-semibold">
        <Database className="h-4 w-4 text-accent" />
        <span>clearvoiance</span>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition",
                active
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <CircleUser className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={me.data?.email}>
            {me.data?.email ?? "…"}
          </span>
        </div>
        <button
          type="button"
          onClick={logout}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition hover:bg-background/60 hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </div>
    </aside>
  );
}
