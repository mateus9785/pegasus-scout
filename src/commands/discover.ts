import { parseSearchArgs, wantsHelp } from '../config/searchParams.js'
import { assertConnection, closePools, getPool } from '../db/pool.js'
import { assertSchema } from '../db/assertSchema.js'
import { geocodeCity } from '../discovery/geocoder.js'
import { runDiscovery } from '../discovery/discoveryService.js'
import { PlaywrightMapsPage } from '../discovery/playwrightMapsPage.js'
import { buildTiles } from '../discovery/tiling.js'
import { getLogger } from '../logger/logger.js'

const HELP = `
Uso: npm run scout -- discover --niche <nicho> --city <cidade> [opcoes]

  --niche <texto>      Nicho a buscar. Obrigatorio.  ex: "pet shop"
  --city <texto>       Cidade. Obrigatorio.          ex: "Brasilia"
  --state <UF>         Sigla da UF.                  ex: DF
  --radius-km <n>      Raio da varredura (default 5)
  --tile-km <n>        Lado de cada tile (default 2). Menor = mais buscas.
  --max <n>            Teto de empresas neste run (default 60)
  --lat <n> --lng <n>  Centro explicito, pula o geocoding
  --no-details         Nao abre a ficha de cada empresa. Rapido, mas sem site --
                       e sem site o enrichment nao tem o que analisar.

Rodar duas vezes o mesmo comando nao duplica nada: a chave natural de cada
empresa faz o segundo run apenas atualizar o que mudou.
`

export async function run(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(HELP)
    return
  }

  const log = getLogger()
  const params = parseSearchArgs(argv)

  await assertConnection()
  await assertSchema()
  const db = getPool()

  let center = params.center
  if (!center) {
    const hit = await geocodeCity(db, params.city, params.state)
    log.info(
      { cidade: params.city, lat: hit.lat, lng: hit.lng, cache: hit.fromCache },
      'centro resolvido',
    )
    center = { lat: hit.lat, lng: hit.lng }
  }

  const tiles = buildTiles(center, params.radiusKm, { tileKm: params.tileKm })
  process.stdout.write(
    [
      '',
      `  Nicho    : ${params.niche}`,
      `  Cidade   : ${params.city}${params.state ? ` - ${params.state}` : ''}`,
      `  Centro   : ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`,
      `  Raio     : ${params.radiusKm} km em ${tiles.length} tile(s) de ${params.tileKm} km`,
      `  Teto     : ${params.maxResults} empresas`,
      `  Fichas   : ${params.withDetails ? 'sim (pega o site)' : 'nao (--no-details)'}`,
      '',
    ].join('\n'),
  )

  const maps = await PlaywrightMapsPage.open()
  try {
    const result = await runDiscovery(db, maps, params, center, (e) => {
      process.stdout.write(
        `\r  tile ${e.tile + 1}/${e.totalTiles} · ${e.found} empresas (${e.novos} novas)   `,
      )
    })

    process.stdout.write(
      [
        '',
        '',
        `  ✔ Busca #${result.searchId} — ${result.status}`,
        `    ${result.discoveredCount} empresas: ${result.newCount} novas, ${result.updatedCount} ja conhecidas`,
        `    ${result.tilesVisitados}/${tiles.length} tiles varridos`,
        '',
        '  Proximo passo: npm run scout -- enrich',
        '',
      ].join('\n'),
    )

    if (result.error) {
      process.stderr.write(`  Avisos:\n${result.error}\n\n`)
    }
    if (result.status === 'failed') process.exitCode = 1
  } finally {
    await maps.close()
    await closePools()
  }
}
