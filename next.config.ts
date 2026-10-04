import type { NextConfig } from "next";
// Side effect: throws on boot if any required env var is missing.
import "./lib/env";

const nextConfig: NextConfig = {
  reactCompiler: true,
};

export default nextConfig;
