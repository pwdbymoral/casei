import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

const withSerwist = withSerwistInit({
  disable: process.env.NODE_ENV === "development",
  swDest: "public/sw.js",
  swSrc: "src/app/sw.ts",
});

const nextConfig: NextConfig = {
  output: "standalone",
};

export default withSerwist(nextConfig);
