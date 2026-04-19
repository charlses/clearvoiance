import Link from "next/link";
import {
  ArrowRight,
  Activity,
  Database,
  Gauge,
  Plug,
  Rewind,
  ShieldCheck,
} from "lucide-react";

import { CodeBlock } from "@/components/landing/code-block";
import { InstallBlock } from "@/components/landing/install-block";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const EXPRESS_QUICKSTART = `import express from "express";
import { createClient } from "@clearvoiance/node";
import { captureHttp } from "@clearvoiance/node/http/express";
import { patchOutbound } from "@clearvoiance/node/outbound";

const client = createClient({
  engine: { url: process.env.CLEARVOIANCE_ENGINE_URL!, apiKey: process.env.CLEARVOIANCE_API_KEY! },
  session: { name: "checkout-api" },
});
await client.start();
patchOutbound(client);           // record every http.request + fetch

const app = express();
app.use(captureHttp(client));    // inbound HTTP, routed + headers + body
app.listen(3000);
`;

const REPLAY_EXAMPLE = `$ clearvoiance replay start \\
    --source sess_abc \\
    --target http://staging:3000 \\
    --speedup 12

→ replay started: rep_xyz
→ dispatching 42 310 events at 12× over 5m

$ clearvoiance replay results rep_xyz --db
┌───────────────────────────────┬──────┬──────────┬──────────┐
│ endpoint                      │ p95  │ db time  │ deadlocks│
│ POST   /api/leads             │ 810  │ 46 412ms │ 4        │  ← N+1 + lock wait
│ GET    /api/stats             │ 210  │    812ms │ 0        │
│ POST   /webhooks/stripe       │  48  │    103ms │ 0        │
└───────────────────────────────┴──────┴──────────┴──────────┘
`;

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <FeatureGrid />
        <QuickstartSection />
        <ReplaySection />
        <AdaptersSection />
        <CallToAction />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Soft gradient wash so the top of the page doesn't feel flat. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-24 -z-10 h-96 bg-[radial-gradient(ellipse_at_top,theme(colors.accent-subtle),transparent_60%)] opacity-70"
      />
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
        <div className="flex flex-col items-start gap-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
            Phase 6 shipped · Phase 7 adapters live
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl md:text-6xl">
            Replay real production traffic
            <span className="text-accent">.</span>{" "}
            <span className="text-muted-foreground">Find breaking points before users do.</span>
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            clearvoiance captures every input to your backend — HTTP, WebSockets,
            cron, queues, outbound calls, DB queries — and replays it at N× speed
            against a hermetic clone. With per-event DB correlation: every slow
            query traces back to the exact request that caused it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" asChild>
              <Link href="/docs/quickstart">
                Get started <ArrowRight />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a
                href="https://github.com/charlses/clearvoiance"
                target="_blank"
                rel="noreferrer noopener"
              >
                View on GitHub
              </a>
            </Button>
          </div>
          <div className="w-full max-w-xl">
            <InstallBlock command="npm install @clearvoiance/node" />
          </div>
        </div>
      </div>
    </section>
  );
}

function FeatureGrid() {
  const features = [
    {
      icon: Activity,
      title: "Capture everything",
      body:
        "HTTP, Socket.io, node-cron, BullMQ, outbound HTTP + fetch, Postgres queries — one SDK, one stream.",
    },
    {
      icon: Rewind,
      title: "Replay at N× speed",
      body:
        "A 1-hour capture runs in 5 minutes at 12× with virtual users, JWT re-signing, Starlark body mutators.",
    },
    {
      icon: ShieldCheck,
      title: "Hermetic by default",
      body:
        "Outbound calls get served from a mock pack during replay. Zero real emails, zero real Stripe charges.",
    },
    {
      icon: Database,
      title: "DB correlation",
      body:
        "Every slow query + lock wait + deadlock ties back to the exact replay event that caused it. The killer feature.",
    },
    {
      icon: Gauge,
      title: "Self-hostable",
      body:
        "One Go engine + ClickHouse + MinIO + Postgres via docker-compose. Your data stays yours. Apache-2.0.",
    },
    {
      icon: Plug,
      title: "Every stack",
      body:
        "Express, Koa, Fastify, Strapi, Socket.io, node-cron, BullMQ, pg, Prisma — more languages next.",
    },
  ];

  return (
    <section className="border-t border-border bg-muted/30 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight">
          Built for the load tests that actually matter.
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Synthetic load scripts are always wrong. Real traffic replayed at
          compressed time is weird in exactly the ways production will be.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <Card key={title}>
              <CardHeader>
                <div className="flex size-10 items-center justify-center rounded-lg bg-accent-subtle text-accent">
                  <Icon className="size-5" />
                </div>
                <CardTitle className="mt-3">{title}</CardTitle>
                <CardDescription>{body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

async function QuickstartSection() {
  return (
    <section className="py-20">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 md:grid-cols-2 lg:px-8">
        <div className="space-y-5">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-accent">
            <span className="size-1 rounded-full bg-accent" /> 01 — Capture
          </div>
          <h2 className="text-3xl font-semibold tracking-tight">
            Drop the SDK into your backend.
          </h2>
          <p className="text-muted-foreground">
            A capture session opens on <code>client.start()</code>. The
            adapters wrap your framework so every inbound request + every
            outbound call + every DB query flows to the engine as a
            correlated event.
          </p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>• Works with Express, Koa, Fastify, Strapi, Socket.io, node-cron, BullMQ.</li>
            <li>• WAL drains captured events across engine restarts — zero loss.</li>
            <li>• Header denylist redacts <code>Authorization</code> / <code>Cookie</code> by default.</li>
          </ul>
        </div>
        <div className="md:pl-4">
          <CodeBlock
            filename="apps/api/server.ts"
            lang="ts"
            code={EXPRESS_QUICKSTART}
          />
        </div>
      </div>
    </section>
  );
}

async function ReplaySection() {
  return (
    <section className="border-t border-border bg-muted/30 py-20">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 md:grid-cols-2 lg:px-8">
        <div className="order-2 md:order-1 md:pr-4">
          <CodeBlock lang="bash" code={REPLAY_EXAMPLE} />
        </div>
        <div className="order-1 space-y-5 md:order-2">
          <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-accent">
            <span className="size-1 rounded-full bg-accent" /> 02 — Replay + observe
          </div>
          <h2 className="text-3xl font-semibold tracking-tight">
            Run it at 12×. See what your DB saw.
          </h2>
          <p className="text-muted-foreground">
            The replay engine schedules every captured event at compressed
            time. The DB observer polls <code>pg_stat_activity</code> for
            queries carrying <code>application_name = &apos;clv:&lt;event_id&gt;&apos;</code>
            and joins each slow query back to the originating request.
          </p>
          <p className="text-muted-foreground">
            Output: &ldquo;Under 12× load, <code>POST /api/leads</code> caused 4
            deadlocks and 46s of DB time, dominated by an N+1 on
            <code>leads_email_key</code>. Here&apos;s the plan. Here&apos;s the
            captured event. Here&apos;s the reproducer.&rdquo;
          </p>
          <Button asChild variant="outline">
            <Link href="/docs/concepts">
              How it works <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function AdaptersSection() {
  const rows: Array<{ category: string; items: string[] }> = [
    {
      category: "HTTP",
      items: ["Express", "Koa", "Fastify", "Strapi"],
    },
    {
      category: "Sockets",
      items: ["Socket.io"],
    },
    {
      category: "Queues & cron",
      items: ["BullMQ", "node-cron"],
    },
    {
      category: "Outbound",
      items: ["http / https", "fetch (undici)"],
    },
    {
      category: "Databases",
      items: ["node-postgres / Knex", "Prisma"],
    },
    {
      category: "Detection",
      items: ["autoInstrument()"],
    },
  ];

  return (
    <section className="py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight">
          Adapters, not monkey-patches.
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Each integration is a first-class subpath import. Install only what
          you use — framework peer deps are all optional. Non-Node SDKs
          (Python, Go, Ruby) coming after the OSS launch.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ category, items }) => (
            <Card key={category}>
              <CardHeader>
                <CardTitle>{category}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {items.map((item) => (
                    <li key={item} className="flex items-center gap-2">
                      <span className="size-1 rounded-full bg-accent" aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function CallToAction() {
  return (
    <section className="border-t border-border py-20">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Ready to stop load-testing your fantasies?
        </h2>
        <p className="max-w-xl text-muted-foreground">
          Self-host in under five minutes. Or just drop the SDK in, stream to
          a dev engine, and watch real production behavior replay against
          staging.
        </p>
        <InstallBlock command="npm install @clearvoiance/node" />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" asChild>
            <Link href="/docs/quickstart">
              Read the quickstart <ArrowRight />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a
              href="https://github.com/charlses/clearvoiance"
              target="_blank"
              rel="noreferrer noopener"
            >
              Star on GitHub
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}
