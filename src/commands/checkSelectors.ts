import { MAPS_SELECTORS } from '../discovery/selectors.js'
import type { SelectorSpec } from '../discovery/selectors.js'
import { PlaywrightMapsPage } from '../discovery/playwrightMapsPage.js'
import { buildQueryText } from '../discovery/mapsUrl.js'
import { parseFeed } from '../discovery/parseFeed.js'
import { parseDetail } from '../discovery/parseDetail.js'
import { getLogger } from '../logger/logger.js'
import { parseSearchArgs } from '../config/searchParams.js'

/**
 * O canario do scraper.
 *
 * O driver do Playwright e a unica parte do projeto sem teste automatizado: depende
 * de rede, de sessao e do DOM do Google, que muda sem aviso. Este comando e o
 * substituto -- abre uma busca real e reporta, seletor por seletor, se casou.
 *
 * O valor esta em transformar a falha futura de "o discover gravou 40 empresas sem
 * telefone e ninguem notou" em "check:selectors reprovou apontando detailPhone".
 * Rode antes de qualquer varredura grande, e sempre que os numeros vierem estranhos.
 */

type Result = {
  spec: SelectorSpec
  matched: string | null
  count: number
}

async function checkOn(
  page: import('playwright').Page,
  specs: SelectorSpec[],
): Promise<Result[]> {
  const out: Result[] = []
  for (const spec of specs) {
    let matched: string | null = null
    let count = 0
    for (const candidate of spec.candidates) {
      count = await page.locator(candidate).count()
      if (count > 0) {
        matched = candidate
        break
      }
    }
    out.push({ spec, matched, count })
  }
  return out
}

export async function run(argv: string[]): Promise<void> {
  const log = getLogger()
  const params = parseSearchArgs(argv, { defaultNiche: 'pet shop', defaultCity: 'Brasilia' })

  const maps = await PlaywrightMapsPage.open()
  const results: Result[] = []

  try {
    const query = buildQueryText(params.niche, params.city, params.state)
    // Coordenada aproximada e suficiente: o objetivo e ter um feed populado na
    // tela, nao varrer uma regiao.
    await maps.search(query, params.center ?? { lat: -15.7942, lng: -47.8822 }, 14)

    const feedSpecs = [
      MAPS_SELECTORS.feed,
      MAPS_SELECTORS.feedCardLink,
      MAPS_SELECTORS.feedEndMarker,
    ]
    results.push(...(await checkOn(maps.rawPage, feedSpecs)))

    // Alem de contar seletor, prova que o parser extrai dado de verdade. Seletor
    // que casa mas devolve campo vazio e a falha mais sorrateira: nada quebra.
    const feedHtml = await maps.getFeedHtml()
    const items = parseFeed(feedHtml)
    const comNome = items.filter((i) => i.name !== '').length
    const comFtid = items.filter((i) => i.placeFtid !== null).length
    const comCategoria = items.filter((i) => i.category !== null).length
    const comTelefone = items.filter((i) => i.phoneRaw !== null).length

    const primeiro = items[0]
    let detailReport = '  (nenhum card no feed — nao deu para checar a ficha)'
    if (primeiro?.mapsUrl) {
      const url = primeiro.mapsUrl.startsWith('http')
        ? primeiro.mapsUrl
        : `https://www.google.com${primeiro.mapsUrl}`
      const detailHtml = await maps.getPlaceHtml(url)

      results.push(
        ...(await checkOn(maps.rawPage, [
          MAPS_SELECTORS.detailPanel,
          MAPS_SELECTORS.detailName,
          MAPS_SELECTORS.detailWebsite,
          MAPS_SELECTORS.detailPhone,
          MAPS_SELECTORS.detailAddress,
          MAPS_SELECTORS.detailCategory,
          MAPS_SELECTORS.detailRating,
          MAPS_SELECTORS.detailPlusCode,
          MAPS_SELECTORS.detailHoursTable,
        ])),
      )

      const detail = parseDetail(detailHtml, url)
      detailReport = [
        `  ficha de "${detail.name || '(sem nome)'}"`,
        `    categoria : ${detail.category ?? '—'}`,
        `    site      : ${detail.website ?? '—'}`,
        `    telefone  : ${detail.phoneRaw ?? '—'}`,
        `    endereco  : ${detail.address ?? '—'}`,
        `    nota      : ${detail.rating ?? '—'}`,
        `    horario   : ${detail.hours ? `${Object.keys(detail.hours).length} dia(s)` : '—'}`,
      ].join('\n')
    }

    render(results, {
      total: items.length,
      comNome,
      comFtid,
      comCategoria,
      comTelefone,
      detailReport,
    })
  } finally {
    await maps.close()
  }

  const quebrados = results.filter((r) => r.spec.required && r.matched === null)
  if (quebrados.length > 0) {
    process.stderr.write(
      `\n${quebrados.length} seletor(es) obrigatorio(s) quebrado(s). Atualize src/discovery/selectors.ts.\n\n`,
    )
    process.exitCode = 1
    return
  }
  log.info('todos os seletores obrigatorios casaram')
}

function render(
  results: Result[],
  summary: {
    total: number
    comNome: number
    comFtid: number
    comCategoria: number
    comTelefone: number
    detailReport: string
  },
): void {
  const width = Math.max(...results.map((r) => r.spec.key.length))
  const lines: string[] = ['', '  Seletores:', '']

  for (const r of results) {
    const marca = r.matched ? '✔' : r.spec.required ? '✖' : '·'
    const detalhe = r.matched
      ? `${r.count} elemento(s) via  ${r.matched}`
      : r.spec.required
        ? 'NENHUM candidato casou'
        : 'ausente (opcional)'
    lines.push(`  ${marca} ${r.spec.key.padEnd(width)}  ${detalhe}`)
  }

  lines.push(
    '',
    '  Extracao do feed:',
    '',
    `    cards         : ${summary.total}`,
    `    com nome      : ${summary.comNome}`,
    `    com ftid      : ${summary.comFtid}`,
    `    com categoria : ${summary.comCategoria}`,
    `    com telefone  : ${summary.comTelefone}`,
    '',
    '  Extracao da ficha:',
    '',
    summary.detailReport,
    '',
  )

  process.stdout.write(lines.join('\n'))
}
