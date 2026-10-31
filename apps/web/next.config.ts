import type { NextConfig } from 'next';

// The browser only ever talks to this origin; /api/* is proxied to the TERO API so the admin
// session cookie is first-party and no CORS configuration is needed.
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Uploads (up to 500 MB, Vault up to 2 GB) pass through this proxy: the defaults (10 MB body, 30 s) cut them off.
    proxyClientMaxBodySize: '2100mb',
    proxyTimeout: 30 * 60 * 1000,
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default config;
