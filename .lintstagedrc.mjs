export default {
  '*.{js,mjs,ts,tsx}': ['bun run format:fix', 'bun run lint:fix'],
  '*.{json,jsonc,md,mdx,yaml,yml,css,scss,less}': ['bun run format:fix'],
}
