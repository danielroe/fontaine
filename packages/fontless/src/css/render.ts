import type { RemoteFontSource } from 'unifont'
import type { FallbackInstance, FontSource, NormalizedFontFaceData } from '../types'
import { extname, relative } from 'node:path/posix'
import { setTimeout as sleep } from 'node:timers/promises'
import { generateFontFace as generateFallbackFontFace, getMetricsForFamily, readMetrics, readVariationWidths } from 'fontaine'
import { isFetchableURL } from '../url'

export function generateFontFace(family: string, font: NormalizedFontFaceData): string {
  return [
    '@font-face {',
    `  font-family: '${family}';`,
    `  src: ${renderFontSrc(font.src)};`,
    `  font-display: ${font.display || 'swap'};`,
    font.unicodeRange && `  unicode-range: ${font.unicodeRange};`,
    font.weight && `  font-weight: ${Array.isArray(font.weight)
      ? font.weight.join(' ')
      : font.weight};`,
    font.style && `  font-style: ${font.style};`,
    font.stretch && `  font-stretch: ${font.stretch};`,
    font.featureSettings && `  font-feature-settings: ${font.featureSettings};`,
    font.variationSettings && `  font-variation-settings: ${font.variationSettings};`,
    font.ascentOverride && `  ascent-override: ${font.ascentOverride};`,
    font.descentOverride && `  descent-override: ${font.descentOverride};`,
    font.lineGapOverride && `  line-gap-override: ${font.lineGapOverride};`,
    font.sizeAdjust && `  size-adjust: ${font.sizeAdjust};`,
    `}`,
  ].filter(Boolean).join('\n')
}

/** Metrics a provider may report for a face. Only `unitsPerEm` is guaranteed to be present. */
interface ProviderFontMetrics {
  unitsPerEm: number
  ascent?: number
  descent?: number
  lineGap?: number
  capHeight?: number
  xHeight?: number
  xWidthAvg?: number
}

type FallbackMetrics = Pick<Required<ProviderFontMetrics>, 'ascent' | 'descent' | 'lineGap' | 'unitsPerEm' | 'xWidthAvg'>

const OPTIONAL_METRICS = [
  'ascent',
  'descent',
  'lineGap',
  'capHeight',
  'xHeight',
  'xWidthAvg',
] as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Metrics reported by the provider that resolved this face, if any. Not every version of
 * `unifont` returns them, so the shape is validated before use.
 */
function readProviderMetrics(data: NormalizedFontFaceData): ProviderFontMetrics | undefined {
  const candidate = (data as { metrics?: unknown }).metrics
  if (!candidate || typeof candidate !== 'object') {
    return
  }
  const metrics = candidate as Record<string, unknown>
  if (!isFiniteNumber(metrics.unitsPerEm) || metrics.unitsPerEm <= 0) {
    return
  }
  const result: ProviderFontMetrics = { unitsPerEm: metrics.unitsPerEm }
  for (const key of OPTIONAL_METRICS) {
    const value = metrics[key]
    if (isFiniteNumber(value)) {
      result[key] = value
    }
  }
  return result
}

/**
 * Complete a provider's metrics into the set the fallback faces are derived from, filling gaps
 * from the metrics database where the family is known there.
 *
 * `ascent`, `descent` and `lineGap` are all needed, since each is divided by the em square to
 * produce one of the `*-override` descriptors. `xWidthAvg` only drives `size-adjust`, and zero
 * leaves the fallback at its natural width. Database values are in that font's own em square, so
 * they are scaled into the provider's before being mixed in.
 */
function resolveProviderMetrics(data: NormalizedFontFaceData, knownMetrics: FallbackMetrics | null): FallbackMetrics | undefined {
  const metrics = readProviderMetrics(data)
  if (!metrics) {
    return
  }
  const scale = knownMetrics
    ? metrics.unitsPerEm / knownMetrics.unitsPerEm
    : 0
  const fill = (key: keyof FallbackMetrics) => knownMetrics
    ? knownMetrics[key] * scale
    : undefined

  const ascent = metrics.ascent ?? fill('ascent')
  const descent = metrics.descent ?? fill('descent')
  const lineGap = metrics.lineGap ?? fill('lineGap')
  if (ascent === undefined || descent === undefined || lineGap === undefined) {
    return
  }
  return {
    ascent,
    descent,
    lineGap,
    unitsPerEm: metrics.unitsPerEm,
    xWidthAvg: metrics.xWidthAvg ?? fill('xWidthAvg') ?? 0,
  }
}

export interface FontFallbackOptions {
  /** Read metrics from a font source. Defaults to `readMetrics` from `fontaine`. */
  readMetrics?: (source: string) => Promise<Awaited<ReturnType<typeof readMetrics>>>
  /**
   * Read how wide a variable font is at each variation, relative to its default instance.
   * Defaults to `readVariationWidths` from `fontaine`.
   */
  readVariationWidths?: (source: string, variations: Array<Record<string, number>>) => Promise<number[] | null>
}

interface FontFallbackFaceOptions extends FontFallbackOptions {
  /** Instances of a variable font to generate fallbacks for. Defaults to its bold weight. */
  instances?: FallbackInstance[]
  /**
   * The face to read a variable font from, where another face of the family shares the axes
   * of `data` and its file is more representative of the text the family renders.
   */
  measure?: NormalizedFontFaceData
}

const METRICS_RETRIES = 2
const METRICS_RETRY_DELAY = 500

async function readFromSource<T>(family: string, source: string, read: (source: string) => Promise<T>): Promise<T> {
  for (let retries = METRICS_RETRIES; ; retries--) {
    try {
      return await read(source)
    }
    catch (error) {
      if (retries <= 0) {
        throw new Error(`Could not read metrics for \`${family}\` from \`${source}\`.`, { cause: error })
      }
      await sleep(METRICS_RETRY_DELAY)
    }
  }
}

const REGULAR_WEIGHT = 400
const NORMAL_STRETCH = 100
const BOLD_WEIGHT = 700
/** The lightest weight browsers render with the bold face of a family that has only regular and bold. */
const BOLD_THRESHOLD = 600

const NUMBER_RE = /\d+(?:\.\d+)?/g

/** The values a descriptor covers, where an absent or `normal` descriptor covers its initial value. */
function parseRange(value: unknown, initial: number): [min: number, max: number] | undefined {
  if (value === undefined || value === 'normal') {
    return [initial, initial]
  }
  const [min, max = min, ...rest] = String(value).match(NUMBER_RE)?.map(Number) || []
  return min !== undefined && !rest.length && min <= max!
    ? [min, max!]
    : undefined
}

function isRange(range: [min: number, max: number] | undefined): boolean {
  return !!range && range[0] < range[1]
}

function isWithin(value: number, range: [min: number, max: number] | undefined): boolean {
  return !!range && value >= range[0] && value <= range[1]
}

interface VariableFontInstance {
  weight?: number
  /** A percentage. */
  stretch?: number
}

function selectFallbackInstances(data: NormalizedFontFaceData, instances: FallbackInstance[] = [
  { weight: BOLD_WEIGHT },
]): VariableFontInstance[] {
  const weights = parseRange(data.weight, REGULAR_WEIGHT)
  const stretches = parseRange(data.stretch, NORMAL_STRETCH)
  if (!isRange(weights) && !isRange(stretches)) {
    return []
  }
  return instances
    .map(({ weight, stretch }) => ({
      weight,
      stretch: stretch === undefined
        ? undefined
        : Number.parseFloat(stretch),
    }))
    .filter(({ weight, stretch }) => (weight ?? stretch) !== undefined && isWithin(weight ?? REGULAR_WEIGHT, weights) && isWithin(stretch ?? NORMAL_STRETCH, stretches))
}

interface FallbackInstanceFace {
  /** Whether the instance is rendered with the bold face of a fallback font. */
  bold: boolean
  /** The average advance width of the font at this instance, relative to the one its metrics describe. */
  width: number
  descriptors: Record<string, string | number>
}

/**
 * Measure how wide a variable font is at each instance, leaving out those that cannot be
 * measured. The bold weight of a family in the metrics database is taken from there, and
 * every other instance is read from `source`. `regular` is whether the metrics the widths
 * will scale describe the regular instance of the font, as opposed to its default one.
 */
async function measureFallbackInstances(family: string, instances: VariableFontInstance[], source: string | undefined, knownBold: number | undefined, regular: boolean, read: NonNullable<FontFallbackOptions['readVariationWidths']>): Promise<FallbackInstanceFace[]> {
  const measured = instances.filter(({ weight, stretch }) => !knownBold || weight !== BOLD_WEIGHT || (stretch ?? NORMAL_STRETCH) !== NORMAL_STRETCH)
  const widths = measured.length && source
    ? await readFromSource(family, source, url => read(url, [
        { wght: REGULAR_WEIGHT, wdth: NORMAL_STRETCH },
        ...measured.map(({ weight = REGULAR_WEIGHT, stretch = NORMAL_STRETCH }) => ({ wght: weight, wdth: stretch })),
      ]))
    : null

  const faces: FallbackInstanceFace[] = []
  for (const instance of instances) {
    const index = measured.indexOf(instance)
    if (index !== -1 && !widths) {
      continue
    }
    faces.push({
      bold: (instance.weight ?? REGULAR_WEIGHT) >= BOLD_THRESHOLD,
      width: index === -1
        ? knownBold!
        : widths![index + 1]! / (regular ? widths![0]! : 1),
      descriptors: {
        ...(instance.weight !== undefined && { 'font-weight': instance.weight }),
        ...(instance.stretch !== undefined && { 'font-stretch': `${instance.stretch}%` }),
      },
    })
  }
  return faces
}

/**
 * Generate metric-adjusted `@font-face` rules for each fallback, derived from the metrics of
 * `data`. The rules carry the `unicode-range` of `data`, if it has one.
 *
 * A variable font gains a further rule per fallback for each instance in `options.instances`,
 * sized to the font at that instance and matched by `font-weight` and `font-stretch`.
 */
export async function generateFontFallbacks(family: string, data: NormalizedFontFaceData, fallbacks?: Array<{ name: string, font: string }>, options: FontFallbackFaceOptions = {}): Promise<string[]> {
  if (!fallbacks?.length)
    return []

  const requestedInstances = selectFallbackInstances(data, options.instances)
  const fontURL = ((requestedInstances.length && options.measure) || data).src.find((s): s is RemoteFontSource => 'url' in s)
  const source = fontURL && (fontURL.originalURL || fontURL.url)
  const knownMetrics = await getMetricsForFamily(family)
  const regularMetrics = resolveProviderMetrics(data, knownMetrics) || knownMetrics
  const metrics = regularMetrics || (source && await readFromSource(family, source, options.readMetrics ?? readMetrics))

  if (!metrics)
    return []

  const knownBold = knownMetrics?.bold && knownMetrics.bold.xWidthAvg / knownMetrics.xWidthAvg
  const instances = await measureFallbackInstances(family, requestedInstances, source, knownBold, !!regularMetrics, options.readVariationWidths ?? readVariationWidths)

  const css: string[] = []
  for (const fallback of fallbacks) {
    const fallbackMetrics = await getMetricsForFamily(fallback.font) || undefined
    css.push(generateFallbackFontFace(metrics, {
      ...fallback,
      metrics: fallbackMetrics,
      ...(data.unicodeRange?.length && {
        'unicode-range': data.unicodeRange.join(', '),
      }),
    }))
    for (const instance of instances) {
      if (instance.bold && !fallbackMetrics?.bold) {
        continue
      }
      css.push(generateFallbackFontFace({ ...metrics, xWidthAvg: metrics.xWidthAvg * instance.width }, {
        ...fallback,
        metrics: fallbackMetrics,
        bold: instance.bold,
        ...instance.descriptors,
        ...(data.unicodeRange?.length && {
          'unicode-range': data.unicodeRange.join(', '),
        }),
      }))
    }
  }
  return css
}

const formatMap: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  otf: 'opentype',
  ttf: 'truetype',
  eot: 'embedded-opentype',
  svg: 'svg',
}
const extensionMap = Object.fromEntries(Object.entries(formatMap).map(([key, value]) => [value, key]))
export function formatToExtension(format?: string): string | undefined {
  return format && format in extensionMap
    ? `.${extensionMap[format]}`
    : undefined
}

export function parseFont(font: string): RemoteFontSource | { name: string } {
  // render as `url("url/to/font") format("woff2")`
  if (font.startsWith('/') || isFetchableURL(font)) {
    const extension = extname(font).slice(1)
    const format = formatMap[extension]

    return {
      url: font,
      format,
    } satisfies RemoteFontSource as RemoteFontSource
  }

  // render as `local("Font Name")`
  return { name: font }
}

// https://drafts.csswg.org/css-fonts-4/#font-format-values
const fontFormatKeywords = new Set([
  'collection',
  'embedded-opentype',
  'opentype',
  'svg',
  'truetype',
  'woff',
  'woff2',
])

function renderFontSrc(sources: Exclude<FontSource, string>[]) {
  return sources.map((src) => {
    if ('url' in src) {
      let rendered = `url("${src.url}")`
      // `format()` takes a `<font-format>` keyword, or a string for values outside
      // that set (such as the legacy `woff2-variations`).
      if (src.format) {
        rendered += ` format(${fontFormatKeywords.has(src.format)
          ? src.format
          : `"${src.format}"`})`
      }
      // `tech()` takes `<font-tech>` keywords only — never a string.
      if (src.tech) {
        rendered += ` tech(${src.tech})`
      }
      return rendered
    }
    return `local("${src.name}")`
  }).join(', ')
}

export function relativiseFontSources(font: NormalizedFontFaceData, relativeTo: string): NormalizedFontFaceData {
  return {
    ...font,
    src: font.src.map((source) => {
      if ('name' in source)
        return source
      if (!source.url.startsWith('/'))
        return source
      return {
        ...source,
        url: relative(relativeTo, source.url),
      }
    }),
  } satisfies NormalizedFontFaceData
}
