/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  // R3F and Three.js ship ESM-only packages that must be transpiled by Next.js.
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
  async headers() {
    return [
      {
        // HSTS applied to every route — tells browsers to only connect via HTTPS
        // for the next 2 years and to include all subdomains.
        // Safe to set in dev (HTTP localhost ignores HSTS) and required in prod.
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Widget and verify API must be embeddable from any origin (FR-10).
        // These headers override the default X-Frame-Options so third-party
        // tenant websites can embed the widget as an iframe.
        // HSTS above still applies — these rules are additive, not replacing.
        source: "/(widget|api/verify)/:path*",
        headers: [
          { key: "X-Frame-Options", value: "ALLOWALL" },
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
