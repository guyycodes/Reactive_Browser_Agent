/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained deployment at .next/standalone so the
  // Dockerfile's runner stage can ship without node_modules. Cuts the
  // final image from ~400 MB to ~120 MB.
  output: "standalone",
  reactStrictMode: true,
  // Proxy screenshot fetches to the agent's /static route (Commit 6c-2).
  // The reviewer UI renders `<img src="/api/static/runs/<runId>/<file>">`
  // which stays same-origin from the browser's perspective (CORS-free)
  // and is rewritten server-side onto the agent's compose DNS name. The
  // agent port (3001) therefore stays internal to `agent-net`; only
  // :3000 is touched by browsers.
  async rewrites() {
    return [
      {
        source: "/api/static/runs/:runId/:filename",
        destination: "http://agent:3001/static/runs/:runId/:filename",
      },
    ];
  },
};
export default nextConfig;
