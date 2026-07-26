import { parseBatchArgs, wantsHelp } from '../config/searchParams.js'
import { assertConnection, closePools, getPool } from '../db/pool.js'
import { assertSchema } from '../db/assertSchema.js'
import { runEnrichment } from '../enrichment/enrichmentService.js'

const HELP = `
Uso: npm run scout -- enrich [opcoes]

Le o site de cada empresa descoberta e detecta como o atendimento dela funciona
hoje: widget de chat, link de WhatsApp, plataforma de e-commerce, meio de pagamento,
redes sociais, e-mail.

  --limit <n>        Quantas empresas processar neste run (default 50)
  --retry-failed     Reprocessa tambem as que falharam antes
  --force-llm        Regera a analise por LLM mesmo de quem ja tem uma. Implica --with-llm.
  --with-llm         Alem dos detectores, roda o CLI \`claude\` para analisar o
                     conteudo da pagina: o que a empresa vende, porte, dor de
                     atendimento e o gancho de abordagem. Mais lento.

Sinais que importam:
  widget de chat detectado  -> ja tem atendimento automatizado, DESCARTAR
  wa.me sem widget          -> atendimento manual, ALVO BOM
  plataforma de e-commerce  -> tem o que integrar, ALVO OTIMO
`

export async function run(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(HELP)
    return
  }

  const options = parseBatchArgs(argv)

  await assertConnection()
  await assertSchema()
  const db = getPool()

  try {
    const summary = await runEnrichment(db, options, (done, total, nome) => {
      process.stdout.write(`\r  ${done}/${total}  ${nome.slice(0, 40).padEnd(42)}`)
    })

    if (summary.processados === 0) {
      process.stdout.write(
        [
          '',
          '  Nenhuma empresa pendente com site.',
          '',
          '  Rode `npm run scout -- discover` primeiro, ou use --retry-failed para',
          '  reprocessar as que falharam.',
          '',
        ].join('\n'),
      )
      return
    }

    process.stdout.write(
      [
        '',
        '',
        `  ✔ ${summary.ok}/${summary.processados} empresas processadas`,
        `    ${summary.falhas} falha(s) temporaria(s) — recuperaveis com --retry-failed`,
        `    ${summary.bloqueados} na blocklist`,
        '',
        '  O que foi encontrado:',
        `    ${summary.comWidgetChat} com widget de chat  (ja automatizadas — descartar)`,
        `    ${summary.comWhatsapp} com WhatsApp          (atendimento manual — alvo)`,
        `    ${summary.comEcommerce} com e-commerce        (tem o que integrar)`,
        `    ${summary.siteForaDoAr} com site fora do ar   (maturidade digital baixa — alvo)`,
        `    ${summary.semSiteProprio} so em plataforma de terceiro (sem site proprio)`,
        ...(options.withLlm
          ? [
              '',
              `  Analise por LLM: ${summary.briefs} briefs gerados, ${summary.falhasLlm} falhas`,
            ]
          : []),
        '',
        '  Proximo passo: npm run scout -- score',
        '',
      ].join('\n'),
    )
  } finally {
    await closePools()
  }
}
