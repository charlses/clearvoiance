import { DocsSidebar } from "@/components/docs-sidebar";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-8 px-4 sm:px-6 lg:px-8">
        <aside className="hidden lg:block">
          <DocsSidebar />
        </aside>
        <main className="min-w-0 flex-1 py-10 lg:pl-6">
          <article className="prose prose-sm max-w-3xl dark:prose-invert lg:prose-base">
            {children}
          </article>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
