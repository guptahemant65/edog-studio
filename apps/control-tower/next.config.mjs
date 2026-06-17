/** @type {import('next').NextConfig} */
const nextConfig = {
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
