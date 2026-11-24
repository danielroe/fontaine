import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { describe, expect, it, vi } from 'vitest'
import { createFontlessStorage } from '../src/storage'

const interrupt = vi.hoisted(() => ({ writes: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (!interrupt.writes) {
        return fs.writeFile(...args)
      }
      await fs.writeFile(args[0], String(args[1]).slice(0, 1))
      throw new Error('interrupted')
    },
  }
})

const scratchDir = () => mkdtemp(join(tmpdir(), 'fontless-cache-'))

describe('createFontlessStorage', () => {
  it('should default to a directory alongside vite\'s cacheDir', async () => {
    const dir = await scratchDir()
    const storage = createFontlessStorage(undefined, { root: join(dir, 'src'), cacheDir: join(dir, 'node_modules/.vite') })

    await storage.setItem('key', 'value')

    expect(await readdir(join(dir, 'node_modules/.cache/fontless/meta'))).toEqual(['key'])
  })

  it('should fall back to a node_modules cache directory when no cacheDir is given', async () => {
    const root = await scratchDir()
    const storage = createFontlessStorage(undefined, { root })

    await storage.setItem('key', 'value')

    expect(await readdir(join(root, 'node_modules/.cache/fontless/meta'))).toEqual(['key'])
  })

  it('should accept an absolute directory without a root', async () => {
    const dir = await scratchDir()
    const storage = createFontlessStorage(dir)

    await storage.setItem('key', 'value')

    expect(await readdir(dir)).toEqual(['key'])
  })

  it('should write to a custom directory resolved from the root', async () => {
    const root = await scratchDir()
    const storage = createFontlessStorage('.cache/fonts', { root })

    await storage.setItem('key', 'value')

    expect(await readdir(join(root, '.cache/fonts'))).toEqual(['key'])
    expect(await storage.getItem('key')).toBe('value')
  })

  it('should accept a directory via object syntax', async () => {
    const root = await scratchDir()
    const storage = createFontlessStorage({ dir: 'custom' }, { root })

    await storage.setItem('key', 'value')

    expect(await readdir(join(root, 'custom'))).toEqual(['key'])
  })

  it('should not persist to disk when cache is disabled', async () => {
    const root = await scratchDir()
    const storage = createFontlessStorage(false, { root })

    await storage.setItem('key', 'value')

    expect(await storage.getItem('key')).toBe('value')
    expect(await readdir(root)).toEqual([])
  })

  it('should not read back an interrupted write', async () => {
    const dir = await scratchDir()
    const storage = createFontlessStorage(dir)

    interrupt.writes = true
    try {
      await expect(storage.setItemRaw('key', 'value')).rejects.toThrow('interrupted')
    }
    finally {
      interrupt.writes = false
    }

    expect(await storage.getItemRaw('key')).toBeNull()
  })

  it('should use a provided unstorage instance as-is', () => {
    const custom = createStorage({ driver: memoryDriver() })
    expect(createFontlessStorage(custom)).toBe(custom)
  })
})
