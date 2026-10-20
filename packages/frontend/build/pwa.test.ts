// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { precacheManifest } from './pwa'

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function built(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'fms-pwa-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('driver app precache (FMS-34)', () => {
  it('lists every built file as a root URL with a content revision, sorted', () => {
    const out = built({ 'index.html': '<html>', 'assets/index-abc.js': 'js', 'icons/icon-192.png': 'png', 'offline.html': 'off' })
    const manifest = precacheManifest(out)
    expect(manifest.map((e) => e.url)).toEqual(['/assets/index-abc.js', '/icons/icon-192.png', '/index.html', '/offline.html'])
    expect(manifest.every((e) => /^[0-9a-f]{16}$/.test(e.revision))).toBe(true)
  })

  it('leaves out the worker itself, source maps and Vite metadata', () => {
    const out = built({ 'index.html': '<html>', 'sw.js': 'old worker', 'assets/index-abc.js.map': '{}', '.vite/manifest.json': '{}' })
    expect(precacheManifest(out).map((e) => e.url)).toEqual(['/index.html'])
  })

  it('a changed file changes its revision, so a new build replaces the cached copy', () => {
    const a = precacheManifest(built({ 'index.html': 'one' }))[0].revision
    const b = precacheManifest(built({ 'index.html': 'two' }))[0].revision
    expect(a).not.toBe(b)
  })
})
