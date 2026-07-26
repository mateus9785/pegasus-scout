import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as cheerio from 'cheerio'
import { PlaywrightMapsPage } from '../src/discovery/playwrightMapsPage.js'
import { buildQueryText, parsePlaceRef } from '../src/discovery/mapsUrl.js'
import { humanPause } from '../src/browser/humanize.js'
import { getLogger } from '../src/logger/logger.js'

/**
 * Captura HTML real do Google Maps para dentro de tests/fixtures/maps/.
 *
 * Existe porque parser escrito de memoria contra um DOM que voce nao esta olhando e
 * parser errado. O ciclo e: capturar -> escrever/ajustar parser -> teste unitario
 * verde contra o HTML real -> recapturar quando o Google mudar.
 *
 * As fixtures VAO para o git (o .gitignore ignora data/, nao tests/): sao a unica
 * forma de os testes rodarem sem rede, e o diff entre duas capturas mostra
 * exatamente o que o Google mudou.
 *
 * Uso:
 *   npx tsx scripts/capture-fixtures.ts "pet shop" "Brasilia" DF
 */

const OUT_DIR = path.resolve(import.meta.dirname, '../tests/fixtures/maps')
const HEADED = process.env['SCOUT_CAPTURE_HEADED'] === 'true'

async function main(): Promise<void> {
  const log = getLogger()
  const [niche = 'pet shop', city = 'Brasilia', state = 'DF'] = process.argv.slice(2)

  await mkdir(OUT_DIR, { recursive: true })

  const maps = await PlaywrightMapsPage.open({ headless: !HEADED })
  try {
    const query = buildQueryText(niche, city, state)
    log.info({ query }, 'buscando')
    await maps.search(query, { lat: -15.7942, lng: -47.8822 }, 14)

    await maps.scrollFeed({ maxScrolls: 6 })
    const feedHtml = await maps.getFeedHtml()
    await writeFile(path.join(OUT_DIR, 'feed.html'), feedHtml, 'utf-8')
    log.info({ bytes: feedHtml.length }, 'feed.html gravado')

    // Descobre os hrefs dos primeiros cards direto do HTML capturado, para nao
    // depender de mais nenhum seletor aqui.
    const $ = cheerio.load(feedHtml)
    const hrefs = $('a[href*="/maps/place/"]')
      .map((_, el) => $(el).attr('href'))
      .get()
      .filter((h): h is string => Boolean(h))

    log.info({ total: hrefs.length }, 'cards encontrados no feed')

    // Tres fichas: uma qualquer, e as duas seguintes -- a variacao entre elas
    // (com site / sem site / sem avaliacao) e o que os testes precisam cobrir.
    const alvos = hrefs.slice(0, 3)
    for (const [i, href] of alvos.entries()) {
      const url = href.startsWith('http') ? href : `https://www.google.com${href}`
      const ref = parsePlaceRef(url)
      log.info({ i, ftid: ref.ftid, nome: ref.nameFromUrl }, 'capturando ficha')

      const html = await maps.getPlaceHtml(url)
      await writeFile(path.join(OUT_DIR, `detail-${i + 1}.html`), html, 'utf-8')
      await writeFile(
        path.join(OUT_DIR, `detail-${i + 1}.url.txt`),
        url,
        'utf-8',
      )
      await humanPause()
    }

    log.info(`fixtures gravadas em ${OUT_DIR}`)
  } finally {
    await maps.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
