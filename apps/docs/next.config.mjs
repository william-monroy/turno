import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The Markdown of each page, for agents and the "copy as Markdown" button (lib/source.ts).
  async rewrites() {
    return [{ source: "/:path*.md", destination: "/llms.mdx/:path*.md" }];
  },
};

export default createMDX()(config);
