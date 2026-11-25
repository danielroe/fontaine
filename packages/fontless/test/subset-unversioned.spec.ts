import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { build } from 'vite'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Simulates a layout where the versions of `subset-font` and harfbuzz cannot be read. It
// lives on its own so the mock cannot leak into the other suites.
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => ({
    resolve: {
      paths: () => [],
    },
  }),
}))

const fixture = fileURLToPath(new URL('fixtures/font.woff2', import.meta.url))
const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })))
})

describe('subsetting without a known subsetter version', () => {
  it('should not report a version', async () => {
    const { getSubsetterVersion } = await import('../src/subset')

    expect(getSubsetterVersion()).toBeUndefined()
  })

  it('should subset local fonts without caching them', { timeout: 20_000 }, async () => {
    const { fontless } = await import('../src')
    const root = await fsp.mkdtemp(join(tmpdir(), 'fontless-subset-'))
    const outDir = join(root, 'dist')
    scratchDirs.push(root)
    await fsp.writeFile(join(root, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body></body></html>')
    await fsp.writeFile(join(root, 'style.css'), `body { font-family: 'Inter' }`)
    const cache = createStorage({
      driver: memoryDriver(),
    })

    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        fontless({
          cache,
          families: [
            {
              name: 'Inter',
              src: [
                { url: pathToFileURL(fixture).href, format: 'woff2' },
              ],
              glyphs: 'Hand',
            },
          ],
        }),
      ],
      build: { outDir },
    })
    const [file] = await Array.fromAsync(fsp.glob('**/*.woff2', { cwd: outDir }))

    expect((await fsp.readFile(join(outDir, file!))).length).toBeLessThan((await fsp.readFile(fixture)).length)
    expect((await cache.getKeys()).filter(key => key.startsWith('data:subsets:'))).toEqual([])
  })
})
