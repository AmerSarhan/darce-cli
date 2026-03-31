import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/entrypoints/cli.tsx'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  minify: true,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env node'
  },
})
