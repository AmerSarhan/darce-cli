import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig({
  entry: ['src/entrypoints/cli.tsx'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  minify: true,
  treeshake: true,
  define: {
    __DARCE_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: '#!/usr/bin/env node'
  },
})
