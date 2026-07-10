import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/testing/**'],
  outDir: 'dist',
  format: 'esm',
  unbundle: true,
  dts: true,
  sourcemap: false,
  clean: true,
  platform: 'node',
  target: 'es2022',
  tsconfig: './tsconfig.build.json',
  external: ['bun:test', 'bun:sqlite'],
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
