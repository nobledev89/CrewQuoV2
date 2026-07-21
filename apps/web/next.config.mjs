/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Shared workspace packages ship raw TS/TSX — let Next compile them.
  transpilePackages: ['@crewquo/shared', '@crewquo/ui'],
};

export default nextConfig;
