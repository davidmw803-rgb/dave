/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // poly-ui is a separate Next.js project living in this repo as a subfolder.
  // Skip type-checking it during the root build (its own build runs with its
  // own tsconfig).
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config) => {
    config.watchOptions = { ...config.watchOptions, ignored: ['**/poly-ui/**'] };
    return config;
  },
};

module.exports = nextConfig;
