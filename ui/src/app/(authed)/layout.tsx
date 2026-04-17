import { AuthGate } from "@/components/auth-gate";
import { Sidebar } from "@/components/sidebar";

/**
 * Shared layout for every page that lives behind the API key. Adds the
 * sidebar nav + gate. Login/logout live outside this group.
 */
export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <div className="flex min-h-screen flex-1">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-auto">{children}</main>
      </div>
    </AuthGate>
  );
}
