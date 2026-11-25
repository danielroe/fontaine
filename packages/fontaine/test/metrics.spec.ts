import { fromUrl } from '@capsizecss/unpack'
import { create } from 'fontkitten'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMetricsForFamily, readMetrics, readVariationWidths } from '../src/metrics'

const mockFont = {
  ascent: 2000,
  descent: -500,
  lineGap: 200,
  unitsPerEm: 2048,
  xWidthAvg: 1000,
}

vi.mock('@capsizecss/unpack', () => ({
  fromUrl: vi.fn(),
}))

vi.mock('@capsizecss/unpack/fs', () => ({
  fromFile: vi.fn(),
}))

vi.mock('fontkitten', () => ({
  create: vi.fn(),
}))

describe('readMetrics', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should cache url requests and only make one network call for concurrent requests', async () => {
    const url = 'https://example.com/font.ttf'

    let resolvePromise: (value: any) => void
    const delayedPromise = new Promise((resolve) => {
      resolvePromise = resolve
    })

    vi.mocked(fromUrl).mockReturnValue(delayedPromise as Promise<any>)

    const promises = Array.from({ length: 200 }, () => readMetrics(url))

    resolvePromise!(mockFont)

    const results = await Promise.all(promises)

    expect(fromUrl).toHaveBeenCalledTimes(1)

    results.forEach((result) => {
      expect(result).toEqual(mockFont)
    })
  })

  it('should return null for a source already cached as having no metrics', async () => {
    const source = 'Definitely Not A Real Font Family'

    expect(await getMetricsForFamily(source)).toBeNull()
    expect(await readMetrics(source)).toBeNull()
    expect(fromUrl).not.toHaveBeenCalled()
  })
})

describe('readVariationWidths', () => {
  let sources = 0

  function variationStore(regions: Array<[start: number, peak: number, end: number]>, deltaSets: number[][]) {
    return {
      variationRegionList: { variationRegions: regions.map(([startCoord, peakCoord, endCoord]) => [{ startCoord, peakCoord, endCoord }]) },
      itemVariationData: [{ regionIndexes: regions.map((_, index) => index), deltaSets: deltaSets.map(deltas => ({ deltas })) }],
    }
  }

  function fakeFont(font: Record<string, unknown> = {}) {
    return {
      isCollection: false,
      variationAxes: { wght: { name: 'Weight', min: 100, default: 400, max: 900 } },
      hasGlyphForCodePoint: () => true,
      glyphForCodePoint: () => ({ id: 0, advanceWidth: 500 }),
      HVAR: { itemVariationStore: variationStore([[0, 1, 1]], [[100]]), advanceWidthMapping: null },
      ...font,
    } as never
  }

  function measure(font: Record<string, unknown>, variations: Array<Record<string, number>>) {
    vi.mocked(create).mockReturnValue(fakeFont(font))
    return readVariationWidths(new URL(`./fixtures/archivo-variable.woff2?${sources++}`, import.meta.url), variations)
  }

  async function measureRounded(font: Record<string, unknown>, variations: Array<Record<string, number>>) {
    return (await measure(font, variations))!.map(width => +width.toFixed(4))
  }

  it('should interpolate advance widths along an axis', async () => {
    expect(await measureRounded({}, [{}, { wght: 400 }, { wght: 650 }, { wght: 900 }, { wght: 2000 }, { wght: 100 }]))
      .toEqual([1, 1, 1.1, 1.2, 1.2, 1])
  })

  it('should map axis values through `avar`', async () => {
    const correspondence = [[-1, -1], [0, 0], [0.5, 0.8], [1, 1]].map(([fromCoord, toCoord]) => ({ fromCoord, toCoord }))
    expect(await measureRounded({ avar: { segment: [{ correspondence }] } }, [{ wght: 100 }, { wght: 650 }, { wght: 775 }]))
      .toEqual([1, 1.16, 1.18])
  })

  it('should normalise an axis whose default is its maximum', async () => {
    const font = {
      variationAxes: { wght: { name: 'Weight', min: 100, default: 900, max: 900 } },
      HVAR: { itemVariationStore: variationStore([[-1, -1, 0]], [[-100]]), advanceWidthMapping: null },
    }
    expect(await measureRounded(font, [{ wght: 900 }, { wght: 500 }, { wght: 100 }])).toEqual([1, 0.9, 0.8])
  })

  it('should apply regions that do not constrain an axis in full', async () => {
    const regions: Array<[number, number, number]> = [[1, 0.5, 1], [0, 1, 0.5], [-1, 0.5, 1], [0, 0, 0], [0, 0.5, 1]]
    const font = { HVAR: { itemVariationStore: variationStore(regions, [[10, 20, 30, 40, 100]]), advanceWidthMapping: null } }
    expect(await measureRounded(font, [{ wght: 400 }, { wght: 525 }, { wght: 650 }, { wght: 775 }, { wght: 900 }]))
      .toEqual([1.2, 1.3, 1.4, 1.3, 1.2])
  })

  it('should look up advance deltas through the advance width mapping', async () => {
    const itemVariationStore = variationStore([[0, 1, 1]], [[100], [50]])
    const font = (mapData: Array<{ outerIndex: number, innerIndex: number }>) => ({
      glyphForCodePoint: () => ({ id: 5, advanceWidth: 500 }),
      HVAR: { itemVariationStore, advanceWidthMapping: { mapCount: mapData.length, mapData } },
    })
    expect(await measureRounded(font([{ outerIndex: 0, innerIndex: 0 }, { outerIndex: 0, innerIndex: 1 }]), [{ wght: 900 }])).toEqual([1.1])
    expect(await measureRounded(font([{ outerIndex: 0, innerIndex: 9 }]), [{ wght: 900 }])).toEqual([1])
    expect(await measureRounded(font([{ outerIndex: 9, innerIndex: 0 }]), [{ wght: 900 }])).toEqual([1])
  })

  it('should measure every glyph of a font without Latin letters', async () => {
    const advances: Record<number, number> = { 0x20: 600, 0x410: 400 }
    const font = {
      hasGlyphForCodePoint: (codePoint: number) => codePoint in advances,
      characterSet: [0x20, 0x410],
      glyphForCodePoint: (codePoint: number) => ({ id: codePoint === 0x20 ? 0 : 1, advanceWidth: advances[codePoint] }),
      HVAR: { itemVariationStore: variationStore([[0, 1, 1]], [[100], [0]]), advanceWidthMapping: null },
    }
    expect(await measureRounded(font, [{ wght: 900 }])).toEqual([1.1])
  })

  it.each([
    ['a font collection', { isCollection: true }],
    ['a font without variation axes', { variationAxes: {} }],
    ['a font without an `HVAR` table', { HVAR: undefined }],
    ['a font without advance widths', { glyphForCodePoint: () => ({ id: 0, advanceWidth: 0 }) }],
  ])('should not measure %s', async (_, font) => {
    expect(await measure(font, [{ wght: 700 }])).toBeNull()
  })

  it('should parse a font once for concurrent reads of the same variations', async () => {
    const source = new URL('./fixtures/archivo-variable.woff2?concurrent', import.meta.url)
    vi.mocked(create).mockClear().mockReturnValue(fakeFont())

    const results = await Promise.all(Array.from({ length: 20 }, () => readVariationWidths(source, [{ wght: 900 }])))

    expect(create).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
    expect(results[0]![0]).toBeCloseTo(1.2)
  })

  it('should measure the variations as they were when read', async () => {
    const source = new URL('./fixtures/archivo-variable.woff2?mutated', import.meta.url)
    vi.mocked(create).mockReturnValue(fakeFont())
    const variations = [{ wght: 400 }]
    const widths = readVariationWidths(source, variations)
    variations[0]!.wght = 900

    expect(await widths).toEqual([1])
    expect(await readVariationWidths(source, [{ wght: 400 }])).toEqual([1])
  })

  it('should not cache a font that could not be parsed', async () => {
    const source = new URL('./fixtures/archivo-variable.woff2?unparsed', import.meta.url)
    vi.mocked(create).mockReturnValue(fakeFont()).mockImplementationOnce(() => {
      throw new Error('Unknown font format')
    })
    await expect(readVariationWidths(source, [{ wght: 900 }])).rejects.toThrow('Unknown font format')
    expect((await readVariationWidths(source, [{ wght: 900 }]))![0]).toBeCloseTo(1.2)
  })
})
