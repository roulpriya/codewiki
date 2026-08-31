const apiOrigin = process.env.API_ORIGIN ?? `http://127.0.0.1:${process.env.API_PORT ?? "3001"}`;

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
