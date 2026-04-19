"use client";

import { ThemeProvider } from "next-themes";

/**
 * Top-level providers. next-themes handles dark mode via the `.dark` class
 * on <html>; our Tailwind globals.css hooks into that with a custom
 * variant so `dark:` utilities work without a config file.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
