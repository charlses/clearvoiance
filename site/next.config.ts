import type { NextConfig } from "next";
import createMDX from "@next/mdx";

// Turbopack enforces JSON-serializable mdx-loader options, so plugins are
// passed as module-specifier strings. Syntax highlighting happens in
// mdx-components.tsx via a shiki-powered <pre> override (server-rendered,
// zero client JS).
const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: [["remark-gfm", {}]],
    rehypePlugins: [["rehype-slug", {}]],
  },
});

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
};

export default withMDX(nextConfig);
