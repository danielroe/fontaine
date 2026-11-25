import type { Provider, ProviderContext } from 'unifont'
import type { InlineConfig } from 'vite'
import type { FontlessOptions } from '../src/types'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMetrics, readVariationWidths } from 'fontaine'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { createServer } from 'vite'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { fontless } from '../src'

vi.mock('fontaine', async (importOriginal) => {
  const fontaine = await importOriginal<typeof import('fontaine')>()
  return {
    ...fontaine,
    readMetrics: vi.fn(fontaine.readMetrics),
    readVariationWidths: vi.fn(fontaine.readVariationWidths),
  }
})

const scratchDirs: string[] = []
const variableFont = new URL('../../fontaine/test/fixtures/archivo-variable.woff2', import.meta.url)
const metrics = {
  ascent: 1000,
  descent: -250,
  lineGap: 0,
  unitsPerEm: 1000,
  xWidthAvg: 500,
}

afterEach(() => {
  vi.mocked(readMetrics).mockRestore()
  vi.mocked(readVariationWidths).mockRestore()
})

afterAll(async () => {
  await Promise.all(scratchDirs.map(dir => fsp.rm(dir, { recursive: true, force: true })))
})

function createStubProvider(url: string, weight: number | [number, number] = 400) {
  return Object.assign(
    (_ctx: ProviderContext) => ({
      resolveFont: () => ({
        fonts: [
          {
            src: [
              { url, format: 'woff2' },
            ],
            weight,
          },
        ],
      }),
    }),
    { _name: 'stub', _options: {} },
  ) as unknown as Provider
}

async function transformStyles(url: string, options: FontlessOptions = {}, project: { family?: string, weight?: [number, number], config?: InlineConfig } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), 'fontless-metrics-')))
  scratchDirs.push(root)
  await fsp.writeFile(join(root, 'style.css'), `body { font-family: '${project.family ?? 'Switzer'}', sans-serif }`)
  await fsp.mkdir(join(root, 'public/fonts'), { recursive: true })
  await fsp.copyFile(variableFont, join(root, 'public/fonts/archivo variable.woff2'))

  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    ...project.config,
    plugins: [
      fontless({
        provider: 'stub',
        providers: {
          stub: () => createStubProvider(url, project.weight),
        },
        cache: false,
        ...options,
      }),
    ],
  })

  try {
    return (await server.transformRequest('/style.css'))!.code
  }
  finally {
    await server.close()
  }
}

describe('fallback metrics', () => {
  it('should retry reading metrics from the font', async () => {
    const url = 'https://cdn.example.com/switzer-flaky.woff2'
    const read = vi.mocked(readMetrics)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(metrics)

    const code = await transformStyles(url)

    expect(code).toContain('Switzer Fallback: Arial')
    expect(read.mock.calls.filter(([source]) => source === url)).toHaveLength(2)
  })

  it('should fail when metrics cannot be read from the font', async () => {
    await expect(transformStyles('https://127.0.0.1:1/switzer.woff2'))
      .rejects
      .toThrow('Could not read metrics for `Switzer` from `https://127.0.0.1:1/switzer.woff2`.')
  })

  it('should read metrics of remote fonts from the cache', async () => {
    const url = 'https://cdn.example.com/switzer.woff2'
    const read = vi.mocked(readMetrics).mockResolvedValue(metrics)
    const cache = createStorage({
      driver: memoryDriver(),
    })

    const first = await transformStyles(url, { cache })
    const second = await transformStyles(url, { cache })

    for (const code of [first, second]) {
      expect(code).toContain('Switzer Fallback: Arial')
      expect(code).toContain('size-adjust: 112.1577%')
    }
    expect(read.mock.calls.filter(([source]) => source === url)).toHaveLength(1)
  })
})

describe('variable font fallback metrics', () => {
  function archivo(src: string): FontlessOptions {
    return {
      families: [
        {
          name: 'Archivo',
          src,
          weight: [100, 900],
          stretch: '62% 125%',
          fallbackInstances: [
            { weight: 700, stretch: '125%' },
          ],
        },
      ],
    }
  }

  it('should measure a font served from the public directory', async () => {
    const code = await transformStyles('', archivo('/fonts/archivo%20variable.woff2?v=1'), { family: 'Archivo' })

    expect(code).toContain('Archivo Fallback: Arial')
    expect(code).toContain('size-adjust: 125.8173%')
    expect(code).toContain('font-stretch: 125%')
  })

  it('should generate the default fallback instances for a family that sets none', async () => {
    const code = await transformStyles('', {
      defaults: {
        fallbackInstances: [
          { weight: 700, stretch: '125%' },
        ],
      },
      families: [
        {
          name: 'Archivo',
          src: '/fonts/archivo%20variable.woff2',
          weight: [100, 900],
          stretch: '62% 125%',
        },
      ],
    }, { family: 'Archivo' })

    expect(code).toContain('size-adjust: 125.8173%')
    expect(code).toContain('font-stretch: 125%')
    expect(code).not.toContain('size-adjust: 98.3373%')
  })

  it('should not measure a root-relative font that is not in the public directory', async () => {
    const missing = await transformStyles('', archivo('/fonts/missing.woff2'), { family: 'Archivo' })
    const disabled = await transformStyles('', archivo('/fonts/archivo%20variable.woff2'), {
      family: 'Archivo',
      config: { publicDir: false },
    })

    for (const code of [missing, disabled]) {
      expect(code).toContain('Archivo Fallback: Arial')
      expect(code).not.toContain('font-stretch: 125%')
    }
  })

  it('should read the variation widths of remote fonts from the cache', async () => {
    const url = 'https://cdn.example.com/switzer-variable.woff2'
    vi.mocked(readMetrics).mockResolvedValue(metrics)
    const read = vi.mocked(readVariationWidths).mockResolvedValue([1, 1.2])
    const cache = createStorage({
      driver: memoryDriver(),
    })

    const first = await transformStyles(url, { cache }, {
      weight: [100, 900],
    })
    const second = await transformStyles(url, { cache }, {
      weight: [100, 900],
    })

    for (const code of [first, second]) {
      expect(code).toContain('local(\\"Arial Bold\\")')
      expect(code).toContain('font-weight: 700')
    }
    expect(read.mock.calls).toEqual([
      [
        url,
        [
          { wght: 400, wdth: 100 },
          { wght: 700, wdth: 100 },
        ],
      ],
    ])
  })

  it('should cache that a remote font has no variation widths', async () => {
    const url = 'https://cdn.example.com/switzer-static.woff2'
    vi.mocked(readMetrics).mockResolvedValue(metrics)
    const read = vi.mocked(readVariationWidths).mockResolvedValue(null)
    const cache = createStorage({
      driver: memoryDriver(),
    })

    const first = await transformStyles(url, { cache }, {
      weight: [100, 900],
    })
    const second = await transformStyles(url, { cache }, {
      weight: [100, 900],
    })

    for (const code of [first, second]) {
      expect(code).toContain('Switzer Fallback: Arial')
      expect(code).not.toContain('font-weight: 700')
    }
    expect(read).toHaveBeenCalledTimes(1)
  })
})
