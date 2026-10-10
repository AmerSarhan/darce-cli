import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'
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
  // The brain view (/brain) is a small web page served from dist/brain
  async onSuccess() {
    mkdirSync('dist/brain', { recursive: true })
    await build({ entryPoints: ['src/brain/web/app.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: 'dist/brain/app.js', logLevel: 'warning' })
    copyFileSync('src/brain/web/index.html', 'dist/brain/index.html')
    // The taste studio (/taste) the same way, from dist/taste
    mkdirSync('dist/taste', { recursive: true })
    await build({ entryPoints: ['src/taste/web/app.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: 'dist/taste/app.js', logLevel: 'warning' })
    copyFileSync('src/taste/web/index.html', 'dist/taste/index.html')
  },
})
