import type { FontFaceData, Provider } from 'unifont'
import type { FontFamilyInjectionPluginOptions, FontFamilyUsage } from '../src/utils'
import { describe, expect, it, vi } from 'vitest'
import { createResolver } from '../src/resolve'
import { transformCSS } from '../src/utils'

const font = { src: [{ url: '/inter.woff2', format: 'woff2' }] }

function transform(code: string, options: Partial<FontFamilyInjectionPluginOptions> = {}, opts?: { relative?: boolean }) {
  return transformCSS({
    dev: true,
    fontsToPreload: new Map<string, Set<string>>(),
    resolveFontFace: () => ({ fonts: [font] }),
    ...options,
  }, code, '/css/style.css', opts).then(result => result.toString())
}

describe('transformCSS', () => {
  it('should insert after `@layer` statements but not after a `@layer` block', async () => {
    const withPrelude = await transform(`@layer base;\n:root { font-family: 'Inter' }`)
    expect(withPrelude.indexOf('@font-face')).toBeGreaterThan(withPrelude.indexOf('@layer base;'))

    const withBlock = await transform(`@layer { :root { font-family: 'Inter' } }`)
    expect(withBlock.indexOf('@font-face')).toBeLessThan(withBlock.indexOf('@layer'))
  })

  it('should not inject anything when the family resolves to no fonts', async () => {
    const code = `:root { font-family: 'Inter' }`

    expect(await transform(code, { resolveFontFace: () => ({ fonts: [] }) })).toBe(code)
    expect(await transform(code, { resolveFontFace: () => undefined })).toBe(code)
  })

  it('should rewrite font URLs relative to the stylesheet when asked', async () => {
    const result = await transform(`:root { font-family: 'Inter' }`, {}, { relative: true })

    expect(result).toContain('url("../inter.woff2")')
  })

  it('should not preload fonts that have no remote source', async () => {
    const fontsToPreload = new Map<string, Set<string>>()
    await transform(`:root { font-family: 'Inter' }`, {
      fontsToPreload,
      resolveFontFace: () => ({ fonts: [{ src: [{ name: 'Inter Var' }] }] }),
      selectFontsToPreload: (_family, fonts) => fonts,
    })

    expect(fontsToPreload.size).toBe(0)
  })

  it('should emit fallbacks without the primary `@font-face` when `fallbacksOnly` is set', async () => {
    const result = await transform(`:root { font-family: 'Poppins' }`, {
      resolveFontFace: () => ({
        fonts: [{ src: [{ url: '/poppins.woff2', format: 'woff2' }] }],
        fallbacks: ['Arial'],
        fallbacksOnly: true,
      }),
    })

    expect(result).toContain(`font-family: "Poppins Fallback: Arial"`)
    expect(result).toContain(`font-family: 'Poppins', "Poppins Fallback: Arial"`)
    expect(result).not.toContain(`font-family: 'Poppins';`)
  })

  it('should leave a non-global family alone when its `@font-face` is in scope', async () => {
    const code = `@font-face { font-family: 'Inter'; src: local("Inter") }\n:root { font-family: 'Inter' }`

    expect(await transform(code, {
      globalFamilies: new Set(['Poppins']),
      resolveFontFace: () => ({ fonts: [font], fallbacks: ['Arial'] }),
    })).toBe(code)
  })

  it('should emit only fallbacks for a global family, even when its `@font-face` is in scope', async () => {
    const fontsToPreload = new Map<string, Set<string>>()
    const result = await transform([
      `@font-face { font-family: 'Geist Mono'; src: local("Geist Mono") }`,
      `:root { --font-mono: 'Geist Mono', monospace }`,
    ].join('\n'), {
      processCSSVariables: true,
      globalFamilies: new Set(['Geist Mono']),
      fontsToPreload,
      selectFontsToPreload: (_family, fonts) => fonts,
      resolveFontFace: () => ({
        fonts: [{ src: [{ url: '/geist-mono.woff2', format: 'woff2' }] }],
        fallbacks: ['Courier New'],
      }),
    })

    expect(result).toContain(`font-family: "Geist Mono Fallback: Courier New"`)
    expect(result).toContain(`--font-mono: 'Geist Mono', "Geist Mono Fallback: Courier New", monospace`)
    expect(result.match(/font-family:\s*'Geist Mono';/g)).toHaveLength(1)
    expect(fontsToPreload.size).toBe(0)
  })

  it('should not add fallbacks again to a usage site it has already rewritten', async () => {
    const options: Partial<FontFamilyInjectionPluginOptions> = {
      globalFamilies: new Set(['Poppins']),
      resolveFontFace: () => ({ fonts: [font], fallbacks: ['Arial'] }),
    }
    const once = await transform(`@font-face { font-family: 'Poppins'; src: local("Poppins") }\n:root { font-family: 'Poppins' }`, options)

    expect(await transform(once, options)).toBe(once)

    const minified = `@font-face{font-family:Poppins;src:local(Poppins)}:root{font-family:Poppins,Poppins Fallback\\: Arial}`
    expect(await transform(minified, options)).toBe(minified)
  })

  it('should not emit a fallback `@font-face` again when it is already in scope', async () => {
    const options: Partial<FontFamilyInjectionPluginOptions> = {
      processCSSVariables: true,
      globalFamilies: new Set(['Poppins']),
      resolveFontFace: () => ({ fonts: [font], fallbacks: ['Arial'] }),
    }
    const once = await transform(`@layer base;\n:root { font-family: 'Poppins' }`, options)

    expect(await transform(`${once}\n:root { --font-sans: 'Poppins' }`, options))
      .toBe(`${once}\n:root { --font-sans: 'Poppins', "Poppins Fallback: Arial" }`)
  })

  it('should emit the primary `@font-face` alongside fallbacks by default', async () => {
    const result = await transform(`:root { font-family: 'Poppins' }`, {
      resolveFontFace: () => ({
        fonts: [{ src: [{ url: '/poppins.woff2', format: 'woff2' }] }],
        fallbacks: ['Arial'],
      }),
    })

    expect(result).toContain(`font-family: 'Poppins';`)
    expect(result).toContain(`font-family: "Poppins Fallback: Arial"`)
    expect(result).toContain(`font-family: 'Poppins', "Poppins Fallback: Arial"`)
  })

  it('should not register preloads when `fallbacksOnly` is set', async () => {
    const fontsToPreload = new Map<string, Set<string>>()
    await transform(`:root { font-family: 'Poppins' }`, {
      fontsToPreload,
      selectFontsToPreload: (_family, fonts) => fonts,
      resolveFontFace: () => ({
        fonts: [{ src: [{ url: '/poppins.woff2', format: 'woff2' }] }],
        fallbacks: ['Arial'],
        fallbacksOnly: true,
      }),
    })

    expect(fontsToPreload.size).toBe(0)
  })

  it('should leave usage sites untouched when `fallbacksOnly` is set and no fallbacks resolve', async () => {
    const result = await transform(`:root { font-family: 'Poppins' }`, {
      resolveFontFace: () => ({
        fonts: [{ src: [{ url: '/poppins.woff2', format: 'woff2' }] }],
        fallbacks: [],
        fallbacksOnly: true,
      }),
    })

    expect(result).not.toContain('@font-face')
    expect(result).toBe(`:root { font-family: 'Poppins' }`)
  })

  it('should minify generated declarations outside dev', async () => {
    const result = await transform(`:root { font-family: 'Inter' }`, { dev: false })

    expect(result).toContain('@font-face{font-family:Inter')
  })

  it('should keep the unminified declaration when minification produces no output', async () => {
    const result = await transform(`:root { font-family: 'Inter' }`, {
      dev: false,
      lightningcssOptions: { include: 0, exclude: 0, targets: { chrome: 1 << 16 } } as any,
      resolveFontFace: () => ({ fonts: [{ src: [{ url: '/inter.woff2', format: 'woff2' }], unicodeRange: ['U+0000-00FF'] }] }),
    })

    expect(result).toContain('@font-face')
  })

  it('should fall back to unminified CSS when minification throws', async () => {
    const result = await transform(`:root { font-family: 'Inter' }`, {
      dev: false,
      lightningcssOptions: { targets: { chrome: 'not-a-version' } } as any,
    })

    expect(result).toContain('font-family: \'Inter\';')
  })

  it('should expose every family a stylesheet uses', async () => {
    const exposed: Array<[string, FontFamilyUsage[]]> = []
    await transform(`h1 { font-family: 'Poppins', sans-serif } p { font-family: 'Unknown' }`, {
      exposeUsage: (id, usages) => void exposed.push([id, usages]),
      resolveFontFace: family => family === 'Poppins'
        ? { fonts: [{ src: [{ url: '/poppins.woff2', format: 'woff2' }] }], fallbacks: ['Arial'] }
        : undefined,
      selectFontsToPreload: (_family, fonts) => fonts,
    })

    expect(exposed).toHaveLength(1)
    expect(exposed[0]![0]).toBe('/css/style.css')
    expect(exposed[0]![1]).toEqual(expect.arrayContaining([
      { fontFamily: 'Poppins', resolved: true, fallbacks: ['Arial'], preloads: ['/poppins.woff2'] },
      { fontFamily: 'Unknown', resolved: false, fallbacks: [], preloads: [] },
    ]))
  })

  it('should expose a stylesheet that uses no families', async () => {
    const exposed: Array<[string, FontFamilyUsage[]]> = []
    await transform(`body { color: red }`, { exposeUsage: (id, usages) => void exposed.push([id, usages]) })

    expect(exposed).toEqual([['/css/style.css', []]])
  })

  it('should expose no fallbacks for a usage when none could be generated', async () => {
    let exposed: FontFamilyUsage[] = []
    await transform(`:root { font-family: 'Unknown Font' }`, {
      exposeUsage: (_id, usages) => void (exposed = usages),
      resolveFontFace: () => ({ fonts: [font], fallbacks: ['Arial'] }),
    })

    expect(exposed).toEqual([{ fontFamily: 'Unknown Font', resolved: true, fallbacks: [], preloads: [] }])
  })
})

describe('fallback unicode-range', () => {
  const subsets = [['U+0000-00FF', 'U+0131'], ['U+0100-02BA'], ['U+0400-045F']]
  const faces = ['normal', 'italic'].flatMap(style => subsets.map((unicodeRange, index) => ({
    src: [{ url: `/eb-garamond-${style}-${index}.woff2`, format: 'woff2' }],
    style,
    unicodeRange,
  })))
  const code = `:root { --font-sans: "EB Garamond", "Noto Serif TC", ui-serif, Georgia, serif; }`

  function fallbackFaces(css: string) {
    return css.match(/@font-face\s*\{\s*font-family:\s*"?EB Garamond Fallback[^}]*\}/g) ?? []
  }

  it('should limit fallback faces to the characters the primary faces cover', async () => {
    const result = await transform(code, {
      processCSSVariables: true,
      resolveFontFace: () => ({ fonts: faces, fallbacks: ['Noto Serif TC', 'Georgia'] }),
    })

    const fallbacks = fallbackFaces(result)
    expect(fallbacks).toHaveLength(2)
    expect(fallbacks[0]).toContain('font-family: "EB Garamond Fallback: Noto Serif TC"')
    expect(fallbacks[1]).toContain('font-family: "EB Garamond Fallback: Georgia"')
    for (const fallback of fallbacks) {
      expect(fallback).toContain('unicode-range: U+0000-02BA, U+0400-045F;')
    }
    expect(result).toContain(`--font-sans: "EB Garamond", "EB Garamond Fallback: Noto Serif TC", "EB Garamond Fallback: Georgia", "Noto Serif TC"`)
  })

  it('should keep the fallback `unicode-range` when minified', async () => {
    const result = await transform(code, {
      dev: false,
      processCSSVariables: true,
      resolveFontFace: () => ({ fonts: faces, fallbacks: ['Noto Serif TC', 'Georgia'] }),
    })

    const fallbacks = fallbackFaces(result)
    expect(fallbacks).toHaveLength(2)
    for (const fallback of fallbacks) {
      expect(fallback).toContain('unicode-range:U+0-2BA,U+400-45F}')
    }
  })

  it('should limit fallback faces when only fallbacks are emitted', async () => {
    const result = await transform(code, {
      processCSSVariables: true,
      resolveFontFace: () => ({ fonts: faces, fallbacks: ['Georgia'], fallbacksOnly: true }),
    })

    expect(result).not.toContain(`font-family: 'EB Garamond';`)
    expect(fallbackFaces(result)).toEqual([expect.stringContaining('unicode-range: U+0000-02BA, U+0400-045F;')])
  })

  it('should not limit fallback faces when a primary face has no `unicode-range`', async () => {
    const result = await transform(code, {
      processCSSVariables: true,
      resolveFontFace: () => ({ fonts: [...faces, { src: [{ url: '/eb-garamond.woff2', format: 'woff2' }] }], fallbacks: ['Georgia'] }),
    })

    const fallbacks = fallbackFaces(result)
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).not.toContain('unicode-range')
  })

  it('should limit fallback faces to a family-level `unicodeRange`', async () => {
    const provider = () => Object.assign(
      () => ({ resolveFont: () => ({ fonts: faces as FontFaceData[] }) }),
      { _name: 'test', _options: {} },
    ) as unknown as Provider
    const resolver = await createResolver({
      options: { providers: { test: provider } },
      providers: { test: provider },
      normalizeFontData: faces => faces as FontFaceData[],
    })

    const result = await transform(code, {
      processCSSVariables: true,
      resolveFontFace: (family, fallbackOptions) => resolver(family, { name: family, unicodeRange: 'U+0000-007F, U+2013' }, fallbackOptions),
    })

    const fallbacks = fallbackFaces(result)
    expect(fallbacks.length).toBeGreaterThan(0)
    for (const fallback of fallbacks) {
      expect(fallback).toContain('unicode-range: U+0000-007F, U+2013;')
    }
  })
})

describe('variable font fallbacks', () => {
  const variable = { weight: [100, 900] as [number, number], stretch: '62% 125%' }
  const latin = { ...variable, src: [{ url: '/archivo-latin.woff2', format: 'woff2' }], unicodeRange: ['U+0000-00FF, U+0131'] }
  const latinExt = { ...variable, src: [{ url: '/archivo-latin-ext.woff2', format: 'woff2' }], unicodeRange: ['U+0100-02BA'] }
  const code = `:root { font-family: 'Archivo', sans-serif }`

  function fallbackFaces(css: string) {
    return css.match(/@font-face\s*\{\s*font-family:\s*"Archivo Fallback[^}]*\}/g) ?? []
  }

  it('should generate the fallback instances a family resolves with', async () => {
    const readVariationWidths = vi.fn(async () => [1, 1.5])
    const result = await transform(code, {
      readVariationWidths,
      resolveFontFace: () => ({ fonts: [latin], fallbacks: ['Arial'], fallbackInstances: [{ weight: 700, stretch: '125%' }] }),
    })

    expect(readVariationWidths).toHaveBeenCalledExactlyOnceWith('/archivo-latin.woff2', [{ wght: 400, wdth: 100 }, { wght: 700, wdth: 125 }])
    expect(fallbackFaces(result)).toEqual([
      expect.not.stringContaining('font-weight'),
      expect.stringMatching(/local\("Arial Bold"\)[^}]*font-weight: 700;\s*font-stretch: 125%;/),
    ])
  })

  it('should only emit fallback instances for fallbacks not already in scope', async () => {
    const result = await transform(`@font-face { font-family: "Archivo Fallback: Arial"; src: local("Arial") }\n${code}`, {
      readVariationWidths: async () => [1, 1.5],
      resolveFontFace: () => ({ fonts: [latin], fallbacks: ['Arial', 'Times New Roman'], fallbackInstances: [{ weight: 800 }] }),
    })

    expect(fallbackFaces(result).filter(face => face.includes('Arial'))).toEqual(['@font-face { font-family: "Archivo Fallback: Arial"; src: local("Arial") }'])
    expect(fallbackFaces(result).filter(face => face.includes('Times New Roman'))).toEqual([
      expect.stringContaining('src: local("Times New Roman")'),
      expect.stringMatching(/local\("Times New Roman Bold"\)[^}]*font-weight: 800;/),
    ])
    expect(result).toContain(`font-family: 'Archivo', "Archivo Fallback: Arial", "Archivo Fallback: Times New Roman", sans-serif`)
  })

  it('should measure every face of a variable font from an upright one that covers Basic Latin', async () => {
    const readVariationWidths = vi.fn(async (source: string) => [1, source === '/archivo-latin.woff2' ? 1.5 : 2])
    const result = await transform(code, {
      readVariationWidths,
      resolveFontFace: () => ({
        fonts: [
          { ...latinExt, style: 'italic' },
          { ...latin, src: [{ url: '/archivo-latin-italic.woff2', format: 'woff2' }], style: 'italic' },
          { ...latinExt, style: 'normal' },
          latin,
        ],
        fallbacks: ['Arial'],
        fallbackInstances: [{ weight: 800 }],
      }),
    })

    expect(new Set(readVariationWidths.mock.calls.map(([source]) => source))).toEqual(new Set(['/archivo-latin.woff2']))
    expect(fallbackFaces(result)).toHaveLength(2)
  })

  it('should measure faces that declare different axis ranges separately', async () => {
    const condensed = { ...latinExt, src: [{ url: '/archivo-condensed.woff2', format: 'woff2' }], stretch: '62% 100%' }
    const light = { ...latinExt, src: [{ url: '/archivo-light.woff2', format: 'woff2' }], weight: [100, 800] as [number, number] }
    const widths: Record<string, number> = { '/archivo-latin.woff2': 1.5, '/archivo-condensed.woff2': 2, '/archivo-light.woff2': 2.5 }
    const readVariationWidths = vi.fn(async (source: string) => [1, widths[source]!])
    const result = await transform(code, {
      readVariationWidths,
      resolveFontFace: () => ({ fonts: [condensed, light, latin], fallbacks: ['Arial'], fallbackInstances: [{ weight: 800 }] }),
    })

    expect(new Set(readVariationWidths.mock.calls.map(([source]) => source))).toEqual(new Set(Object.keys(widths)))
    expect(fallbackFaces(result)).toHaveLength(4)
  })
})

describe('system font stacks', () => {
  it('should surface only the first non-generic family of each preflight stack', async () => {
    const resolved: string[] = []
    await transform(`
      .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace }
      .font-sans { font-family: ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji' }
      .font-sans-v3 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif }
      .font-serif { font-family: ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif }
    `, {
      resolveFontFace: (family) => {
        resolved.push(family)
        return { fonts: [font] }
      },
    })

    expect(resolved).toEqual(['SFMono-Regular', 'Apple Color Emoji', '-apple-system', 'Georgia'])
  })
})
