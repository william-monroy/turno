import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The Markdown of each page, for agents and the "copy as Markdown" button (lib/source.ts).
  // Pages that moved keep their old address.
  async redirects() {
    return [
      { source: "/docs/browser-alternatives", destination: "/docs/browser/alternatives", permanent: true },
      { source: "/es/docs/browser-alternatives", destination: "/es/docs/browser/alternatives", permanent: true },
    ];
  },
  async rewrites() {
    return [{ source: "/:path*.md", destination: "/llms.mdx/:path*.md" }];
  },
};

export default createMDX()(config);
