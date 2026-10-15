import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

// A function config so `tsup --out-dir <dir>` also sends the web assets there, not into dist/
export default defineConfig(options => {
  const out = options.outDir ?? 'dist'
  return {
    entry: ['src/entrypoints/cli.tsx'],
    format: ['esm'],
    target: 'node22',
    outDir: out,
    clean: true,
    minify: true,
    treeshake: true,
    // Code split per dynamic import(): /taste, /brain, voice and the highlighter load on first use
    splitting: true,
    define: {
      __DARCE_VERSION__: JSON.stringify(pkg.version),
    },
    banner: {
      js: '#!/usr/bin/env node'
    },
    // The brain view (/brain) is a small web page served from dist/brain
    async onSuccess() {
      mkdirSync(join(out, 'brain'), { recursive: true })
      await build({ entryPoints: ['src/brain/web/app.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: join(out, 'brain/app.js'), logLevel: 'warning' })
      copyFileSync('src/brain/web/index.html', join(out, 'brain/index.html'))
      // The taste studio (/taste) the same way, from dist/taste
      mkdirSync(join(out, 'taste'), { recursive: true })
      await build({ entryPoints: ['src/taste/web/app.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', outfile: join(out, 'taste/app.js'), logLevel: 'warning' })
      copyFileSync('src/taste/web/index.html', join(out, 'taste/index.html'))
    },
  }
})
