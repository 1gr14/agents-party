import { Engine } from '@point0/engine'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

/**
 * Point0 engine for the package's web UI — a pure client SPA (`ssr: false`). We never run the Point0 server: the static
 * client bundle is served by the package's own node:http server (src/server/http.ts) alongside the party HTTP API.
 * Build only the client side: `point0 build --engine ./web/src/engine.ts --side client` → `web/dist`.
 */
export const engine = Engine.create({
  file: import.meta.url,
  ssr: false,
  pointsGlob: '**/*.{ts,tsx}',
  generate: { meta: './generated/point0/meta.ts', assetsTypes: './generated/point0/assets.d.ts' },
  viteConfig: ({ plugins }) => ({
    // No sourcemaps: this static bundle ships inside the npm package — keep it lean.
    build: { sourcemap: false },
    plugins: [...plugins, react({ include: /\.(jsx|js|tsx|ts)$/ }), tailwindcss()],
  }),
  server: {
    scope: 'root',
    entry: { main: './index.server.ts' },
    points: async () => await import('./generated/point0/points.server'),
    generate: { points: './generated/point0/points.server.ts' },
    outdir: '../dist-server',
  },
  client: {
    scope: 'root',
    indexHtml: './index.html',
    app: async () => await import('./app.client'),
    points: async () => await import('./generated/point0/points.client'),
    generate: {
      points: './generated/point0/points.client.ts',
      routes: { outfile: './generated/point0/routes.ts', origin: 'process.env.CLIENT_URL' },
    },
    outdir: '../dist',
  },
})
