import { parseBatchArgs, wantsHelp } from '../config/searchParams.js'
import { assertConnection, closePools, getPool } from '../db/pool.js'
import { assertSchema } from '../db/assertSchema.js'
import { runScoring, SCORE_VERSION } from '../scoring/scoringService.js'

const HELP = `
Uso: npm run scout -- score [opcoes]

Pontua cada empresa enriquecida de 0 a 100 e classifica a oportunidade.

  --limit <n>   Quantas pontuar neste run (default 500)

O score e deterministico e versionado (${SCORE_VERSION}): rodar de novo com os
mesmos dados da o mesmo resultado, e cada nota vem com a lista de motivos que a
formaram. Quem tem widget de chat detectado e marcado como descartado, porque
abordar quem ja tem automacao dizendo "vi que voce atende manualmente" queima a
empresa.
`

export async function run(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(HELP)
    return
  }

  const { limit } = parseBatchArgs(argv, 500)

  await assertConnection()
  await assertSchema()
  const db = getPool()

  try {
    const summary = await runScoring(db, limit)

    if (summary.processados === 0) {
      process.stdout.write(
        '\n  Nenhuma empresa enriquecida para pontuar. Rode `npm run scout -- enrich` primeiro.\n\n',
      )
      return
    }

    process.stdout.write(
      [
        '',
        `  ✔ ${summary.processados} empresas pontuadas (${SCORE_VERSION})`,
        '',
        `    ${summary.qualificados} qualificadas   (atendimento provavelmente manual)`,
        `    ${summary.descartados} descartadas    (ja tem automacao)`,
        `    ${summary.indefinidos} indefinidas    (sem sinal suficiente)`,
        '',
        `    score medio: ${summary.mediaScore}/100`,
        '',
        '  Proximo passo: npm run scout -- report',
        '',
      ].join('\n'),
    )
  } finally {
    await closePools()
  }
}
