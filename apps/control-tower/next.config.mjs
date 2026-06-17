import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle (`.next/standalone`) for a slim runtime image.
  output: 'standalone',
  // Pin the trace root to this app so the standalone bundle is self-contained and
  // doesn't hoist to the monorepo root (there are multiple lockfiles above us).
  outputFileTracingRoot: appDir,
  webpack: (config) => {
    // The engine uses explicit `.ts` import extensions (the node strip-types
    // convention — see README). Teach webpack to resolve them so Next can bundle
    // the shared engine without rewriting every import.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.ts': ['.ts', '.tsx', '.js'],
      '.js': ['.js', '.ts', '.tsx'],
      '.mjs': ['.mjs', '.mts'],
    };
    return config;
  },
};

export default nextConfig;
