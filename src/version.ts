// Injected at build time by tsup (see tsup.config.ts); falls back when running from source.
declare const __DARCE_VERSION__: string | undefined

export const VERSION = typeof __DARCE_VERSION__ !== 'undefined' ? __DARCE_VERSION__ : 'dev'
