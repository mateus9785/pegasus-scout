import { parseSearchArgs, parseRawArgs, wantsHelp } from '../config/searchParams.js'
import { assertConnection, closePools, getPool } from '../db/pool.js'
import { assertSchema } from '../db/assertSchema.js'
import { geocodeCity } from '../discovery/geocoder.js'
import { runDiscovery } from '../discovery/discoveryService.js'
import { PlaywrightMapsPage } from '../discovery/playwrightMapsPage.js'
import { runEnrichment } from '../enrichment/enrichmentService.js'
import { runScoring } from '../scoring/scoringService.js'
import { getLogger } from '../logger/logger.js'

const HELP = `
Uso: npm run scout -- run --niche <nicho> --city <cidade> [opcoes]

Roda a Etapa 1 inteira em sequencia: discover -> enrich -> score.
Aceita as mesmas opcoes de cada comando.

  --niche, --city, --state, --radius-km, --tile-km, --max, --lat, --lng
  --with-llm     Liga a analise das paginas pelo CLI claude
  --no-details   Nao abre a ficha de cada empresa no Maps

Depois, veja o resultado com:  npm run scout -- report

Cada estagio grava no banco antes de o proximo comecar, entao interromper no meio
nao perde o que ja foi feito -- e rodar de novo continua de onde parou.
`

export async function run(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(HELP)
    return
  }

  const log = getLogger()
  const params = parseSearchArgs(argv)
  const { values } = parseRawArgs(argv)
  const withLlm = values['with-llm'] === true || values['force-llm'] === true

  await assertConnection()
  await assertSchema()
  const db = getPool()

  try {
    let center = params.center
    if (!center) {
      const hit = await geocodeCity(db, params.city, params.state)
      center = { lat: hit.lat, lng: hit.lng }
    }

    process.stdout.write(`\n  [1/3] Mapeando "${params.niche}" em ${params.city}...\n`)
    const maps = await PlaywrightMapsPage.open()
    let descoberta
    try {
      descoberta = await runDiscovery(db, maps, params, center, (e) => {
        process.stdout.write(`\r        tile ${e.tile + 1}/${e.totalTiles} · ${e.found} empresas   `)
      })
    } finally {
      await maps.close()
    }
    process.stdout.write(
      `\r        ${descoberta.discoveredCount} empresas (${descoberta.newCount} novas)          \n`,
    )

    process.stdout.write(`\n  [2/3] Lendo o site de cada uma${withLlm ? ' + analise por LLM' : ''}...\n`)
    const enriquecimento = await runEnrichment(
      db,
      { limit: params.maxResults, retryFailed: false, withLlm, forceLlm: false },
      (done, total) => process.stdout.write(`\r        ${done}/${total}   `),
    )
    process.stdout.write(
      `\r        ${enriquecimento.ok} lidas, ${enriquecimento.comWidgetChat} ja automatizadas, ${enriquecimento.comWhatsapp} com WhatsApp          \n`,
    )

    process.stdout.write('\n  [3/3] Pontuando...\n')
    const scoring = await runScoring(db, params.maxResults * 2)

    process.stdout.write(
      [
        '',
        `  ✔ Etapa 1 concluida para "${params.niche}" em ${params.city}`,
        '',
        `    ${scoring.qualificados} qualificadas (atendimento provavelmente manual)`,
        `    ${scoring.descartados} descartadas (ja tem automacao)`,
        `    ${scoring.indefinidos} indefinidas`,
        `    score medio: ${scoring.mediaScore}/100`,
        '',
        '  Veja o resultado:  npm run scout -- report',
        '',
      ].join('\n'),
    )

    log.info({ descoberta, enriquecimento, scoring }, 'run completo')
  } finally {
    await closePools()
  }
}
