import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { build, type Plugin, type ResolvedConfig } from 'vite'

/**
 * The driver app's service worker (FMS-34), without a PWA framework: after
 * the app is built, list its files with a content hash (the precache), then
 * bundle src/service-worker.ts into /sw.js with that list and a build id.
 * The worker's bytes change whenever any file does, so browsers pick up a
 * new build; each build caches into its own cache and deletes the last.
 */

/** Not precached: the worker itself, source maps, Vite's own metadata. */
const SKIP = [/^sw\.js$/, /\.map$/, /^\.vite\//]

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** `/assets/index-abc.js` and a content revision for every built file the driver app may need offline. */
export function precacheManifest(outDir: string): { url: string; revision: string }[] {
  return filesUnder(outDir)
    .map((path) => relative(outDir, path).split(sep).join('/'))
    .filter((file) => !SKIP.some((skip) => skip.test(file)))
    .sort()
    .map((file) => ({ url: `/${file}`, revision: hash(readFileSync(join(outDir, file))).slice(0, 16) }))
}

export function driverPwa(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'fms-driver-pwa',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir)
      const manifest = precacheManifest(outDir)
      const buildId = hash(JSON.stringify(manifest)).slice(0, 12)
      // A separate build of one file, no plugins: this one does not run again for it.
      await build({
        configFile: false,
        root: config.root,
        logLevel: 'warn',
        resolve: { alias: config.resolve.alias },
        define: { __PRECACHE_MANIFEST__: JSON.stringify(manifest), __BUILD_ID__: JSON.stringify(buildId) },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          lib: { entry: resolve(config.root, 'src/service-worker.ts'), formats: ['iife'], name: 'fmsDriverServiceWorker', fileName: () => 'sw.js' },
        },
      })
      config.logger.info(`driver app: sw.js precaches ${manifest.length} files (build ${buildId})`)
    },
  }
}
