import type { Font } from '@capsizecss/unpack'
import type { Font as FontFile } from 'fontkitten'
import type { FontFaceMetrics } from './css'

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fromUrl } from '@capsizecss/unpack'
import { fromFile } from '@capsizecss/unpack/fs'
import { create } from 'fontkitten'

import { isStylesheetRelative, withoutQuotes } from './css'

const metricCache: Record<string, FontFaceMetrics | null> = {}

// Metric-compatible families that are missing from `@capsizecss/metrics`.
const metricAliases: Record<string, string> = {
  'liberation sans': 'Arimo',
  'liberation serif': 'Tinos',
  'liberation mono': 'Cousine',
}

type RequiredFontMetrics = Pick<Font, 'ascent' | 'descent' | 'lineGap' | 'unitsPerEm' | 'xWidthAvg'> & { category?: string }

function filterRequiredMetrics(font: RequiredFontMetrics): FontFaceMetrics {
  return {
    ascent: font.ascent,
    descent: font.descent,
    lineGap: font.lineGap,
    unitsPerEm: font.unitsPerEm,
    xWidthAvg: font.xWidthAvg,
    category: font.category,
  }
}

/**
 * Retrieves the font metrics for a given font family from the metrics collection. Uses caching to avoid redundant calculations.
 * @param {string} family - The name of the font family for which metrics are requested.
 * @returns {Promise<FontFaceMetrics | null>} - A promise that resolves with the filtered font metrics or null if not found. See {@link FontFaceMetrics}.
 * @async
 */
export async function getMetricsForFamily(family: string): Promise<FontFaceMetrics | null> {
  family = withoutQuotes(family)

  if (family in metricCache)
    return metricCache[family] ?? null

  try {
    const alias = metricAliases[family.toLowerCase()]
    const name = fontFamilyToCamelCase(alias ?? family)
    const { entireMetricsCollection } = await import('#capsize-font-metrics') as any as typeof import('@capsizecss/metrics/entireMetricsCollection')
    const metrics = entireMetricsCollection[name as keyof typeof entireMetricsCollection]

    /* v8 ignore next 4 */
    if (!('descent' in metrics)) {
      metricCache[family] = null
      return null
    }

    const filteredMetrics = filterRequiredMetrics(metrics)
    if (!alias) {
      filteredMetrics.fullName = metrics.fullName
      filteredMetrics.postscriptName = metrics.postscriptName
    }
    const bold = (metrics.variants as { 700?: NonNullable<FontFaceMetrics['bold']> } | undefined)?.[700]
    if (bold) {
      filteredMetrics.bold = alias ? { xWidthAvg: bold.xWidthAvg } : bold
    }
    metricCache[family] = filteredMetrics
    return filteredMetrics
  }
  catch {
    metricCache[family] = null
    return null
  }
}

const urlRequestCache = new Map<string, Promise<Font>>()

// A Windows drive letter is a valid URL scheme, so reject paths before parsing.
function parseSourceURL(source: URL | string): URL | null {
  return typeof source === 'string' ? (isAbsolute(source) ? null : URL.parse(source)) : source
}

/**
 * Reads font metrics from a source URL, which may be a `file:` URL or a remote one. A string
 * that is not a URL, such as a bare path or a root-relative one, resolves to `null`.
 * It caches the results to optimise subsequent requests for the same source.
 * @param {URL | string} _source - The source URL from which to read the font metrics.
 * @returns {Promise<FontFaceMetrics | null>} - A promise that resolves to the filtered font metrics or null if the source cannot be processed.
 * @async
 */
export async function readMetrics(_source: URL | string): Promise<FontFaceMetrics | null> {
  const source = typeof _source !== 'string' && 'href' in _source ? _source.href : _source

  if (source in metricCache)
    return metricCache[source] ?? null

  const url = parseSourceURL(_source)
  if (!url)
    return null

  let metrics: Font
  if (url.protocol === 'file:') {
    metrics = await fromFile(fileURLToPath(source))
  }
  else {
    if (urlRequestCache.has(source)) {
      metrics = await urlRequestCache.get(source)!
    }
    else {
      const requestPromise = fromUrl(source).catch((error) => {
        urlRequestCache.delete(source)
        throw error
      })
      urlRequestCache.set(source, requestPromise)

      metrics = await requestPromise
    }
  }

  const filteredMetrics = filterRequiredMetrics(metrics)
  metricCache[source] = filteredMetrics
  return filteredMetrics
}

// Relative frequency of each character in English text, which `xWidthAvg` is weighted by.
// https://github.com/seek-oss/capsize/blob/master/packages/unpack/src/weightings.ts
const characterFrequency: Array<[character: string, frequency: number]> = [
  [' ', 0.154],
  ['e', 0.0922],
  ['t', 0.0672],
  ['a', 0.0668],
  ['i', 0.0588],
  ['n', 0.0578],
  ['o', 0.0571],
  ['r', 0.0526],
  ['s', 0.0469],
  ['h', 0.0351],
  ['l', 0.0304],
  ['d', 0.0298],
  ['c', 0.0232],
  ['u', 0.0207],
  ['m', 0.0181],
  ['f', 0.017],
  ['p', 0.0163],
  ['g', 0.0155],
  ['y', 0.0123],
  ['b', 0.0114],
  ['w', 0.011],
  ['v', 0.0076],
  ['k', 0.0046],
  ['x', 0.0025],
  ['z', 0.0011],
  ['j', 0.0009],
  ['q', 0.0008],
]

interface VariationRegionAxis {
  startCoord: number
  peakCoord: number
  endCoord: number
}

/** The variation tables `fontkitten` parses but does not type. */
interface VariationTables {
  avar?: { segment: Array<{ correspondence: Array<{ fromCoord: number, toCoord: number }> }> }
  HVAR?: {
    itemVariationStore: {
      variationRegionList: { variationRegions: VariationRegionAxis[][] }
      itemVariationData: Array<{ regionIndexes: number[], deltaSets: Array<{ deltas: number[] }> }>
    }
    advanceWidthMapping: { mapCount: number, mapData: Array<{ outerIndex: number, innerIndex: number }> } | null
  }
}

/**
 * Maps axis values onto the normalised scale, from -1 to 1, that variation data is stored in.
 * https://learn.microsoft.com/en-us/typography/opentype/spec/otvaroverview#coordinate-scales-and-normalization
 */
function normaliseVariation(font: FontFile & VariationTables, variation: Record<string, number>): number[] {
  return Object.entries(font.variationAxes).map(([tag, axis], index) => {
    const { min, default: initial, max } = axis!
    const value = Math.min(max, Math.max(min, variation[tag] ?? initial))
    const coord = value < initial
      ? (value - initial) / (initial - min)
      : (value - initial) / (max - initial || 1)

    const map = font.avar?.segment[index]?.correspondence || []
    const next = map.findIndex(pair => pair.fromCoord >= coord)
    if (next < 1)
      return coord
    const from = map[next - 1]!
    const to = map[next]!
    return from.toCoord + (coord - from.fromCoord) * (to.toCoord - from.toCoord) / (to.fromCoord - from.fromCoord)
  })
}

/**
 * How much of a variation region's delta applies at `coords`, from 0 to 1.
 * https://learn.microsoft.com/en-us/typography/opentype/spec/otvaroverview#algorithm-for-interpolation-of-instance-values
 */
function regionScalar(region: VariationRegionAxis[], coords: number[]): number {
  return region.reduce((scalar, { startCoord: start, peakCoord: peak, endCoord: end }, index) => {
    const coord = coords[index]!
    if (peak === 0 || start > peak || peak > end || (start < 0 && end > 0) || coord === peak)
      return scalar
    if (coord <= start || coord >= end)
      return 0
    return scalar * (coord < peak ? (coord - start) / (peak - start) : (end - coord) / (end - peak))
  }, 1)
}

function advanceDelta(table: NonNullable<VariationTables['HVAR']>, glyph: number, coords: number[]): number {
  const { itemVariationStore: store, advanceWidthMapping: mapping } = table
  const { outerIndex, innerIndex } = mapping
    ? mapping.mapData[Math.min(glyph, mapping.mapCount - 1)]!
    : { outerIndex: 0, innerIndex: glyph }
  const data = store.itemVariationData[outerIndex]
  const deltas = data?.deltaSets[innerIndex]?.deltas || []
  return deltas.reduce((sum, delta, index) => {
    return sum + delta * regionScalar(store.variationRegionList.variationRegions[data!.regionIndexes[index]!]!, coords)
  }, 0)
}

function measureVariationWidths(buffer: Buffer, variations: Array<Record<string, number>>): number[] | null {
  const font = create(buffer) as (FontFile & VariationTables) | Exclude<ReturnType<typeof create>, FontFile>
  if (font.isCollection || !font.HVAR || !Object.keys(font.variationAxes).length)
    return null

  const table = font.HVAR
  // A font that is a subset without Latin letters is measured by every glyph it has instead.
  const sample = characterFrequency.map(([character, frequency]): [number, number] => [character.codePointAt(0)!, frequency])
  const glyphs = (sample.every(([codePoint]) => font.hasGlyphForCodePoint(codePoint)) ? sample : font.characterSet.map((codePoint): [number, number] => [codePoint, 1]))
    .map(([codePoint, weight]) => {
      const glyph = font.glyphForCodePoint(codePoint)
      return { id: glyph.id, advance: glyph.advanceWidth, weight }
    })
  const defaultWidth = glyphs.reduce((sum, glyph) => sum + glyph.advance * glyph.weight, 0)
  if (!defaultWidth)
    return null

  return variations.map((variation) => {
    const coords = normaliseVariation(font, variation)
    return glyphs.reduce((sum, glyph) => sum + (glyph.advance + advanceDelta(table, glyph.id, coords)) * glyph.weight, 0) / defaultWidth
  })
}

const variationWidthCache = new Map<string, Promise<number[] | null>>()

/**
 * Reads how wide text set in a variable font is at each of `variations`, as the ratio of its
 * average advance width there to that at the default instance of the font.
 *
 * A variation maps OpenType axis tags to values, such as `{ wght: 700, wdth: 125 }`. Axes it
 * leaves out stay at their default, and axes the font does not have are ignored.
 *
 * Resolves to `null` for a string that is not a URL, a static font, or a variable font
 * without an `HVAR` table.
 * @param {URL | string} _source - The source URL of the font, which may be a `file:` URL or a remote one.
 * @param {Array<Record<string, number>>} variations - The variations to measure.
 * @returns {Promise<number[] | null>} - A promise that resolves to one ratio per variation, in the order given.
 */
export function readVariationWidths(_source: URL | string, variations: Array<Record<string, number>>): Promise<number[] | null> {
  const url = parseSourceURL(_source)
  if (!url)
    return Promise.resolve(null)

  const key = JSON.stringify([url.href, variations])
  let widths = variationWidthCache.get(key)
  if (!widths) {
    const requested = variations.map(variation => ({ ...variation }))
    const buffer = url.protocol === 'file:'
      ? readFile(fileURLToPath(url))
      : fetch(url).then(async response => Buffer.from(await response.arrayBuffer()))
    widths = buffer.then(buffer => measureVariationWidths(buffer, requested)).catch((error) => {
      variationWidthCache.delete(key)
      throw error
    })
    variationWidthCache.set(key, widths)
  }
  return widths
}

/**
 * Reads font metrics for a `src` URL declared in a stylesheet.
 *
 * A scheme-less, non-rooted URL is resolved against the stylesheet first, then handed to
 * `resolvePath` if that yields no metrics: bare package specifiers and webpack's `~` prefix
 * look identical to stylesheet-relative paths, and only the caller's resolver can map them.
 *
 * `resolvePath` returns a location rather than a URL, so an absolute path it returns is a file
 * on disk. Without a resolver `source` is still the URL the stylesheet declared, where a leading
 * slash means the document root.
 */
export async function readMetricsForSource(source: string, importer: string | undefined, resolvePath?: (path: string) => string | URL): Promise<FontFaceMetrics | null> {
  if (importer && isAbsolute(importer) && isStylesheetRelative(source)) {
    const metrics = await readMetrics(new URL(source, pathToFileURL(importer))).catch(() => null)
    if (metrics)
      return metrics
  }

  if (!resolvePath)
    return readMetrics(source)

  const resolved = resolvePath(source)
  return readMetrics(typeof resolved === 'string' && isAbsolute(resolved) ? pathToFileURL(resolved) : resolved)
}

// inline `@capsizecss/metrics`
// https://github.com/seek-oss/capsize/blob/66344699ff7759a661a78d0629375714c6f308b0/packages/metrics/src/index.ts
function fontFamilyToCamelCase(str: string) {
  return str
    .split(/[\s|-]/)
    .filter(Boolean)
    .map(
      (s, i) =>
        `${s.charAt(0)[i > 0 ? 'toUpperCase' : 'toLowerCase']()}${s.slice(1)}`,
    )
    .join('')
}
