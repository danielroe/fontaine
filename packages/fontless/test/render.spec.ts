import { describe, expect, it, vi } from 'vitest'

import { generateFontFace, generateFontFallbacks, parseFont, relativiseFontSources } from '../src/css/render'

describe('rendering @font-face', () => {
  it('should add declarations for `font-family`', () => {
    const css = generateFontFace('Inter', {
      src: [{ name: 'Inter Var' }, { url: '/inter.woff2' }],
      weight: [400, 700],
    })
    expect(css).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Inter';
        src: local("Inter Var"), url("/inter.woff2");
        font-display: swap;
        font-weight: 400 700;
      }"
    `)
  })
  it('should support additional properties', () => {
    const css = generateFontFace('Helvetica Neue', {
      src: [{ url: '/helvetica-neue.woff2' }],
      stretch: 'expanded',
      display: 'fallback',
      style: 'italic',
      weight: '400',
    })
    expect(css).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Helvetica Neue';
        src: url("/helvetica-neue.woff2");
        font-display: fallback;
        font-weight: 400;
        font-style: italic;
        font-stretch: expanded;
      }"
    `)
  })
  it('should omit `format()` when the format is unknown', () => {
    // `parseFont` leaves `format` undefined when the extension is not recognised,
    // which covers cache-busted and extensionless provider URLs
    const css = generateFontFace('Inter', {
      src: [parseFont('/inter.woff2?v=3.19') as never, parseFont('https://fonts.example.com/l/font?kit=abc') as never],
    })
    expect(css).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Inter';
        src: url("/inter.woff2?v=3.19"), url("https://fonts.example.com/l/font?kit=abc");
        font-display: swap;
      }"
    `)
  })
  it('should quote `format()` values that are not keywords', () => {
    const css = generateFontFace('Inter', {
      src: [{ url: '/inter.woff2', format: 'woff2-variations' }],
    })
    expect(css).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Inter';
        src: url("/inter.woff2") format("woff2-variations");
        font-display: swap;
      }"
    `)
  })
  it('should render metric override descriptors', () => {
    const css = generateFontFace('Inter', {
      src: [{ url: '/inter.woff2' }],
      ascentOverride: '90%',
      descentOverride: '20%',
      lineGapOverride: '0%',
      sizeAdjust: '105%',
    })
    expect(css).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Inter';
        src: url("/inter.woff2");
        font-display: swap;
        ascent-override: 90%;
        descent-override: 20%;
        line-gap-override: 0%;
        size-adjust: 105%;
      }"
    `)
  })
  it('should render feature and variation settings', () => {
    const css = generateFontFace('Inter', {
      src: [{ url: '/inter.woff2' }],
      featureSettings: '"cv11" 1',
      variationSettings: '"opsz" 32',
    })
    expect(css).toContain('font-feature-settings: "cv11" 1;')
    expect(css).toContain('font-variation-settings: "opsz" 32;')
  })
  it('should render `tech()` as an unquoted keyword', () => {
    const css = generateFontFace('Trickster', {
      src: [{ url: '/trickster.otf', format: 'opentype', tech: 'color-COLRv1' }],
    })
    expect(css).toMatchInlineSnapshot(`
      "@font-face {
        font-family: 'Trickster';
        src: url("/trickster.otf") format(opentype) tech(color-COLRv1);
        font-display: swap;
      }"
    `)
  })
})

describe('generateFontFallbacks', () => {
  it('should generate a fallback face for a family without known metrics', async () => {
    const [css] = await generateFontFallbacks('Inter', { src: [{ url: '/inter.woff2' }] }, [
      { name: 'Inter Fallback: Some Unknown Font', font: 'Some Unknown Font' },
    ])

    expect(css).toContain('font-family: "Inter Fallback: Some Unknown Font"')
    expect(css).toContain('local("Some Unknown Font")')
  })

  it('should generate no fallbacks when none are requested', async () => {
    expect(await generateFontFallbacks('Inter', { src: [{ url: '/inter.woff2' }] })).toEqual([])
  })

  it('should carry the face `unicode-range` onto each fallback', async () => {
    const css = await generateFontFallbacks('Inter', { src: [{ url: '/inter.woff2' }], unicodeRange: ['U+0000-00FF', 'U+0131'] }, [
      { name: 'Inter Fallback: Arial', font: 'Arial' },
      { name: 'Inter Fallback: Georgia', font: 'Georgia' },
    ])
    expect(css).toHaveLength(2)
    for (const face of css) {
      expect(face).toContain('unicode-range: U+0000-00FF, U+0131;')
    }
  })

  it('should use metrics reported by the provider', async () => {
    const [css] = await generateFontFallbacks('Some Unresolvable Font', {
      src: [{ url: '/unreadable.woff2' }],
      metrics: { unitsPerEm: 1000, ascent: 1000, descent: -250, lineGap: 0, xWidthAvg: 500 },
    } as never, [
      { name: 'Some Unresolvable Font Fallback: Arial', font: 'Arial' },
    ])

    expect(css).toContain('font-family: "Some Unresolvable Font Fallback: Arial"')
    expect(css).toContain('ascent-override: 89.1602%')
    expect(css).toContain('descent-override: 22.29%')
    expect(css).toContain('size-adjust: 112.1577%')
  })

  it('should leave `size-adjust` alone when the provider reports no average width', async () => {
    const [css] = await generateFontFallbacks('Some Unresolvable Font', {
      src: [{ url: '/unreadable.woff2' }],
      metrics: { unitsPerEm: 1000, ascent: 1000, descent: -250, lineGap: 0 },
    } as never, [
      { name: 'Some Unresolvable Font Fallback: Arial', font: 'Arial' },
    ])

    expect(css).toContain('size-adjust: 100%')
    expect(css).toContain('ascent-override: 100%')
  })

  it('should complete partial provider metrics from the metrics database', async () => {
    const [ascentFromProvider] = await generateFontFallbacks('Inter', {
      src: [{ url: '/unreadable.woff2' }],
      metrics: { unitsPerEm: 2000, ascent: 2000 },
    } as never, [
      { name: 'Inter Fallback: Arial', font: 'Arial' },
    ])

    expect(ascentFromProvider).toContain('ascent-override: 93.3538%')
    expect(ascentFromProvider).toContain('descent-override: 22.518%')

    const [descentFromProvider] = await generateFontFallbacks('Inter', {
      src: [{ url: '/unreadable.woff2' }],
      metrics: { unitsPerEm: 2000, descent: -500 },
    } as never, [
      { name: 'Inter Fallback: Arial', font: 'Arial' },
    ])

    expect(descentFromProvider).toContain('descent-override: 23.3384%')
  })

  it('should ignore provider metrics that cannot produce fallback descriptors', async () => {
    for (const metrics of [
      null,
      'nope',
      {},
      { unitsPerEm: 0, ascent: 1000, descent: -250, lineGap: 0 },
      { unitsPerEm: -1000, ascent: 1000, descent: -250, lineGap: 0 },
      { unitsPerEm: Number.POSITIVE_INFINITY, ascent: 1000, descent: -250, lineGap: 0 },
      { unitsPerEm: 1000, ascent: Number.NaN, descent: -250, lineGap: 0 },
      { unitsPerEm: 1000, ascent: 1000, capHeight: 700, xHeight: 500 },
    ]) {
      expect(await generateFontFallbacks('Some Unresolvable Font', { src: [{ url: '/unreadable.woff2' }], metrics } as never, [
        { name: 'Some Unresolvable Font Fallback: Arial', font: 'Arial' },
      ])).toEqual([])
    }
  })
})

describe('variable font fallbacks', () => {
  const variableFont = new URL('../../fontaine/test/fixtures/archivo-variable.woff2', import.meta.url).href
  const arial = [{ name: 'Archivo Fallback: Arial', font: 'Arial' }]

  function describeFaces(css: string[]) {
    return css.map(face => ['src', 'size-adjust', 'font-weight', 'font-stretch']
      .map(descriptor => face.match(new RegExp(`^  ${descriptor}: (local\\("[^"]+"\\)|[^;,]+)`, 'm'))?.[1])
      .filter(Boolean)
      .join(' '))
  }

  function sizeAdjust(face: string) {
    return Number.parseFloat(face.match(/size-adjust: ([\d.]+)%/)![1]!)
  }

  it('should add a bold fallback face for a variable font', async () => {
    const css = await generateFontFallbacks('Archivo', { src: [{ url: '/archivo.woff2' }], weight: [100, 900], unicodeRange: ['U+0000-00FF'] }, arial)

    expect(css).toHaveLength(2)
    expect(css[1]).toMatchInlineSnapshot(`
      "@font-face {
        font-family: "Archivo Fallback: Arial";
        src: local("Arial Bold"), local("Arial-Bold"), local("Arial-BoldMT");
        size-adjust: 98.3373%;
        ascent-override: 89.2845%;
        descent-override: 21.3551%;
        line-gap-override: 0%;
        font-weight: 700;
        unicode-range: U+0000-00FF;
      }
      "
    `)
  })

  it('should not change the fallbacks of a static font', async () => {
    const src = [{ url: variableFont }]
    const instances = [{ weight: 700 }, { weight: 800 }, { stretch: '125%' as const }]
    const fallbacks = await generateFontFallbacks('Archivo', { src }, arial)

    expect(describeFaces(fallbacks)).toEqual(['local("Arial") 98.6988%'])
    for (const face of [{ weight: 400 }, { weight: '700' }, { weight: [700, 700] as [number, number] }, { weight: 700, stretch: 'expanded' }, { stretch: '125%' }]) {
      expect(await generateFontFallbacks('Archivo', { src, ...face }, arial, { instances })).toEqual(fallbacks)
    }
    expect((await generateFontFallbacks('Archivo', { src, weight: [100, 900] }, arial))[0]).toBe(fallbacks[0])
  })

  it('should measure the requested instances that a face covers from its font file', async () => {
    const css = await generateFontFallbacks('Archivo', { src: [{ url: variableFont }], weight: '100 900', stretch: '62% 125%' }, arial, {
      instances: [{ weight: 700 }, { weight: 800 }, { weight: 700, stretch: '125%' }, { weight: 600 }, { weight: 300 }, { stretch: '75%' }, { weight: 950 }, { stretch: '150%' }, {}],
    })

    expect(describeFaces(css)).toEqual([
      'local("Arial") 98.6988%',
      'local("Arial Bold") 98.3373% 700',
      'local("Arial Bold") 103.7208% 800',
      'local("Arial Bold") 125.8173% 700 125%',
      'local("Arial Bold") 95.2736% 600',
      'local("Arial") 96.8729% 300',
      'local("Arial") 78.0034% 75%',
    ])
  })

  it('should not generate width instances for a face without a `font-stretch` range', async () => {
    const css = await generateFontFallbacks('Archivo', { src: [{ url: variableFont }], weight: [100, 900] }, arial, {
      instances: [{ weight: 700, stretch: '125%' }, { stretch: '125%' }],
    })

    expect(css).toHaveLength(1)
  })

  it('should accept instances at the fixed value of an axis a face does not vary', async () => {
    const src = [{ url: variableFont }]
    const implicit = await generateFontFallbacks('Archivo', { src, weight: [100, 900] }, arial)

    expect(await generateFontFallbacks('Archivo', { src, weight: [100, 900], stretch: '100%' }, arial)).toEqual(implicit)
    expect(describeFaces(await generateFontFallbacks('Archivo', { src, weight: [100, 900] }, arial, { instances: [{ weight: 700, stretch: '100%' }] })))
      .toEqual(['local("Arial") 98.6988%', 'local("Arial Bold") 98.3373% 700 100%'])
    expect(describeFaces(await generateFontFallbacks('Archivo', { src, weight: 700, stretch: '62% 125%' }, arial, { instances: [{ weight: 700, stretch: '125%' }, { weight: 800, stretch: '125%' }] })))
      .toEqual(['local("Arial") 98.6988%', 'local("Arial Bold") 125.8173% 700 125%'])
  })

  it('should measure a family without known metrics against its default instance', async () => {
    const css = await generateFontFallbacks('Some Unknown Variable Font', { src: [{ url: variableFont }], weight: [100, 900] }, arial)

    expect(describeFaces(css)).toEqual([expect.stringContaining('local("Arial")'), expect.stringMatching(/^local\("Arial Bold"\) .* 700$/)])
    expect(sizeAdjust(css[1]!) / sizeAdjust(css[0]!)).toBeCloseTo(1.0355 * 913 / 983, 3)
  })

  it('should measure a family with provider metrics against its regular instance', async () => {
    const css = await generateFontFallbacks('Some Unknown Variable Font', {
      src: [{ url: variableFont }],
      weight: [100, 900],
      metrics: { unitsPerEm: 1000, ascent: 1000, descent: -250, lineGap: 0, xWidthAvg: 500 },
    } as never, arial)

    expect(sizeAdjust(css[1]!) / sizeAdjust(css[0]!)).toBeCloseTo(1.0762 * 913 / 983, 3)
  })

  it('should not use the bold face of a fallback without bold metrics', async () => {
    const css = await generateFontFallbacks('Archivo', { src: [{ url: variableFont }], weight: [100, 900] }, [
      { name: 'Archivo Fallback: Noto Color Emoji', font: 'Noto Color Emoji' },
    ], { instances: [{ weight: 700 }, { weight: 600 }, { weight: 500 }, { weight: 300 }] })

    expect(describeFaces(css)).toEqual(['local("Noto Color Emoji") 100%', 'local("Noto Color Emoji") 100% 500', 'local("Noto Color Emoji") 100% 300'])
  })

  it('should skip instances whose font file cannot be measured', async () => {
    const instances = [{ weight: 700 }, { weight: 800 }]
    const expected = ['local("Arial") 98.6988%', 'local("Arial Bold") 98.3373% 700']

    expect(describeFaces(await generateFontFallbacks('Archivo', { src: [{ url: '/archivo.woff2' }], weight: [100, 900] }, arial, { instances }))).toEqual(expected)
    expect(describeFaces(await generateFontFallbacks('Archivo', { src: [{ name: 'Archivo' }], weight: [100, 900] }, arial, { instances }))).toEqual(expected)
  })

  it('should measure instances from another face of the family', async () => {
    const css = await generateFontFallbacks('Archivo', { src: [{ url: '/archivo-latin-ext.woff2' }], weight: [100, 900] }, arial, {
      instances: [{ weight: 800 }],
      measure: { src: [{ url: variableFont }], weight: [100, 900] },
    })

    expect(describeFaces(css)).toEqual(['local("Arial") 98.6988%', 'local("Arial Bold") 103.7208% 800'])
  })

  it('should read a variable font without known metrics from the face it is measured from', async () => {
    const latin = { src: [{ url: variableFont }], weight: [100, 900] as [number, number] }
    const latinExt = { src: [{ url: '/archivo-latin-ext.woff2' }], weight: [100, 900] as [number, number] }
    const fallbacks = await generateFontFallbacks('Some Unknown Variable Font', latin, arial)

    expect(fallbacks).toHaveLength(2)
    expect(await generateFontFallbacks('Some Unknown Variable Font', latinExt, arial, { measure: latin })).toEqual(fallbacks)
  })

  it('should read a static font without known metrics from its own file', async () => {
    const face = { src: [{ url: new URL('fixtures/font.woff2', import.meta.url).href }] }
    const fallbacks = await generateFontFallbacks('Some Unknown Static Font', face, arial)

    expect(fallbacks).toHaveLength(1)
    expect(await generateFontFallbacks('Some Unknown Static Font', face, arial, { measure: { src: [{ url: variableFont }] } })).toEqual(fallbacks)
  })

  it('should read variation widths from the original URL of a font', async () => {
    const readVariationWidths = vi.fn(async () => [0.8, 1.2])
    const css = await generateFontFallbacks('Archivo', {
      src: [{ url: '/_fonts/archivo.woff2', originalURL: 'https://cdn.example.com/archivo.woff2' }],
      weight: [100, 900],
    }, arial, { instances: [{ weight: 300 }], readVariationWidths })

    expect(readVariationWidths).toHaveBeenCalledExactlyOnceWith('https://cdn.example.com/archivo.woff2', [{ wght: 400, wdth: 100 }, { wght: 300, wdth: 100 }])
    expect(sizeAdjust(css[1]!) / sizeAdjust(css[0]!)).toBeCloseTo(1.5, 3)
  })
})

describe('relativiseFontSources', () => {
  it('should rewrite root-relative URLs relative to the stylesheet', () => {
    const font = relativiseFontSources({ src: [{ url: '/assets/_fonts/inter.woff2' }] }, '/css')

    expect(font.src).toEqual([{ url: '../assets/_fonts/inter.woff2' }])
  })

  it('should leave local and already-relative sources untouched', () => {
    const src = [{ name: 'Inter Var' }, { url: './inter.woff2' }, { url: 'https://cdn.example.com/inter.woff2' }]

    expect(relativiseFontSources({ src }, '/css').src).toEqual(src)
  })
})
