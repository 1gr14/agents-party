import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/**/*.ts', 'src/**/*.tsx', '!src/**/*.test.ts', '!src/**/*.test.tsx', '!src/testing/**'],
  outDir: 'dist',
  format: 'esm',
  unbundle: true,
  dts: true,
  sourcemap: false,
  clean: true,
  platform: 'node',
  target: 'es2022',
  tsconfig: './tsconfig.build.json',
  // React & the presentational deps stay external (optional peers) — the CLI never pulls them; only `agents-party/ui`
  // does, and its consumer (the site) provides them. `diff2html` is the same: only the diff modal imports it.
  external: [
    'bun:test',
    'bun:sqlite',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'clsx',
    'tailwind-merge',
    'class-variance-authority',
    'lucide-react',
    'diff2html',
  ],
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
