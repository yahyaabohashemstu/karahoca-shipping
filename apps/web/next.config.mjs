/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Emits .next/standalone — a self-contained server with only the modules it
  // actually imports. Cuts the runtime image from ~1.1 GB to ~180 MB, which
  // matters on a single Hetzner box hosting everything.
  output: 'standalone',

  poweredByHeader: false,

  eslint: { ignoreDuringBuilds: true },

  /*
   * Local development against a deployed API.
   *
   * Set KH_DEV_API_PROXY=https://track.karahoca.com and NEXT_PUBLIC_API_URL=/api/v1
   * and the browser talks to localhost only, so the deployed CORS_ORIGINS list
   * does not have to be widened to include a developer's laptop — which is a
   * production config change made for a local convenience, and the kind that
   * gets left behind.
   *
   * WebSockets are not proxied by rewrites, so the realtime feed will show as
   * disconnected. That is honest: it exercises the stale-data banner.
   */
  async rewrites() {
    const target = process.env.KH_DEV_API_PROXY;
    if (!target) return [];
    return [
      { source: '/api/:path*', destination: `${target}/api/:path*` },
      { source: '/t/:path*', destination: `${target}/t/:path*` },
    ];
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            // The dashboard never needs the operator's own location.
            value: 'geolocation=(), microphone=(), camera=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
