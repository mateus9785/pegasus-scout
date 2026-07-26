import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { parseRawArgs, wantsHelp } from '../config/searchParams.js'
import { assertConnection, closePools, getPool } from '../db/pool.js'
import { assertSchema } from '../db/assertSchema.js'
import { OPORTUNIDADE_LABEL } from '../scoring/score.js'
import type { Oportunidade } from '../scoring/score.js'
import { formatBrazilPhone } from '../utils/phone.js'
import { getLogger } from '../logger/logger.js'

const HELP = `
Uso: npm run scout -- report [opcoes]

Gera um Markdown com as empresas mais promissoras, o motivo de cada nota e o que
vender para cada uma.

  --top <n>   Quantas empresas listar (default 20)

O arquivo sai em tests/reports/. E o entregavel que voce le e julga: se a ordem
nao fizer sentido para voce, os pesos em src/scoring/score.ts estao errados.
`

const OUT_DIR = path.resolve(import.meta.dirname, '../../tests/reports')

type ReportRow = RowDataPacket & {
  id: number
  name: string
  category: string | null
  city: string | null
  state: string | null
  website: string | null
  phone_e164: string | null
  whatsapp_phone_e164: string | null
  instagram_url: string | null
  chat_widget: string | null
  ecommerce_platform: string | null
  rating: string | null
  reviews_count: number | null
  fit_score: number | null
  automation_verdict: string
  maps_url: string | null
  segmento: string | null
  porte: string | null
  resumo: string | null
  gancho_abordagem: string | null
  motivos: string | null
  oportunidades: string | null
}

const SELECT_SQL = `
SELECT p.id, p.name, p.category, p.city, p.state, p.website, p.phone_e164,
       p.whatsapp_phone_e164, p.instagram_url, p.chat_widget, p.ecommerce_platform,
       p.rating, p.reviews_count, p.fit_score, p.automation_verdict, p.maps_url,
       b.segmento, b.porte, b.resumo, b.gancho_abordagem,
       (SELECT s.evidence FROM scout_prospect_signals s
         WHERE s.prospect_id = p.id AND s.stage = 'scoring' AND s.signal_key = 'motivos') AS motivos,
       (SELECT GROUP_CONCAT(s2.signal_value ORDER BY s2.signal_key SEPARATOR ',')
          FROM scout_prospect_signals s2
         WHERE s2.prospect_id = p.id AND s2.stage = 'scoring'
           AND s2.signal_key LIKE 'oportunidade_%') AS oportunidades
  FROM scout_prospects p
  LEFT JOIN scout_prospect_briefs b ON b.prospect_id = p.id
 WHERE p.fit_score IS NOT NULL
   AND p.pipeline_status <> 'descartado'
 ORDER BY p.fit_score DESC, p.reviews_count DESC
 LIMIT ?
`

const DESCARTADOS_SQL = `
SELECT p.name, p.chat_widget, p.website
  FROM scout_prospects p
 WHERE p.pipeline_status = 'descartado'
 ORDER BY p.name
`

export async function run(argv: string[]): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(HELP)
    return
  }

  const { values } = parseRawArgs(argv)
  const top = typeof values.top === 'string' ? Math.max(1, Number(values.top) || 20) : 20

  await assertConnection()
  await assertSchema()
  const db = getPool()

  try {
    const [rows] = await db.query<ReportRow[]>(SELECT_SQL, [top])
    const [descartados] = await db.query<RowDataPacket[]>(DESCARTADOS_SQL)

    if (rows.length === 0) {
      process.stdout.write(
        '\n  Nenhuma empresa pontuada. Rode `npm run scout -- score` primeiro.\n\n',
      )
      return
    }

    const markdown = buildMarkdown(rows, descartados, top)

    await mkdir(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `prospeccao-${stamp()}.md`)
    await writeFile(file, markdown, 'utf-8')

    // Imprime tambem no terminal: o valor do relatorio e ser lido agora, nao
    // encontrado num diretorio depois.
    process.stdout.write(`\n${markdown}\n`)
    process.stdout.write(`  Salvo em: ${file}\n\n`)
    getLogger().info({ file, empresas: rows.length }, 'relatorio gerado')
  } finally {
    await closePools()
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Data local em YYYY-MM-DD-HHmm, para o nome do arquivo ordenar sozinho. */
function stamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

function buildMarkdown(rows: ReportRow[], descartados: RowDataPacket[], top: number): string {
  const out: string[] = []

  out.push(`# Prospeccao — top ${Math.min(top, rows.length)}`)
  out.push('')
  out.push(
    'Score deterministico a partir de dados publicos. O veredito sobre o atendimento e',
    'uma HIPOTESE: nenhuma mensagem foi enviada a ninguem nesta etapa. Confirmar o tempo',
    'de resposta e se quem responde e humano e trabalho da Etapa 2.',
  )
  out.push('')

  out.push('| # | Empresa | Score | Cidade | WhatsApp | Site | Vender o que |')
  out.push('|---|---------|-------|--------|----------|------|--------------|')
  for (const [i, r] of rows.entries()) {
    const wa = r.whatsapp_phone_e164 ? formatBrazilPhone(r.whatsapp_phone_e164) : '—'
    const site = r.website ? new URL(r.website).hostname.replace(/^www\./, '') : '—'
    const vender = parseOportunidades(r.oportunidades)
      .map((o) => OPORTUNIDADE_LABEL[o].split(' (')[0])
      .join(' + ')
    out.push(
      `| ${i + 1} | ${escapePipe(r.name)} | **${r.fit_score}** | ${r.city ?? '—'}${r.state ? `-${r.state}` : ''} | ${wa} | ${site} | ${vender || '—'} |`,
    )
  }
  out.push('')

  out.push('---')
  out.push('')
  for (const [i, r] of rows.entries()) {
    out.push(`## ${i + 1}. ${r.name} — ${r.fit_score}/100`)
    out.push('')
    out.push(`- **Categoria:** ${r.category ?? '—'}`)
    out.push(`- **Local:** ${r.city ?? '—'}${r.state ? ` - ${r.state}` : ''}`)
    out.push(
      `- **Reputacao:** ${r.rating ? `${Number(r.rating).toFixed(1)}★` : 'sem nota'}${r.reviews_count ? ` (${r.reviews_count} avaliacoes)` : ''}`,
    )
    out.push(`- **Telefone:** ${r.phone_e164 ? formatBrazilPhone(r.phone_e164) : '—'}`)
    out.push(
      `- **WhatsApp:** ${r.whatsapp_phone_e164 ? formatBrazilPhone(r.whatsapp_phone_e164) : '—'}`,
    )
    out.push(`- **Site:** ${r.website ?? '—'}`)
    out.push(`- **Instagram:** ${r.instagram_url ?? '—'}`)
    out.push(`- **Loja virtual:** ${r.ecommerce_platform ?? '—'}`)
    out.push(`- **Widget de chat:** ${r.chat_widget ?? 'nenhum detectado'}`)
    out.push(`- **Veredito:** ${r.automation_verdict.replaceAll('_', ' ')}`)
    if (r.maps_url) out.push(`- **Maps:** ${r.maps_url}`)
    out.push('')

    const oportunidades = parseOportunidades(r.oportunidades)
    if (oportunidades.length > 0) {
      out.push('**O que vender:**')
      out.push('')
      for (const o of oportunidades) out.push(`- ${OPORTUNIDADE_LABEL[o]}`)
      out.push('')
    }

    if (r.segmento || r.resumo) {
      out.push('**Analise do site:**')
      out.push('')
      if (r.segmento) out.push(`- Segmento: ${r.segmento}`)
      if (r.porte) out.push(`- Porte estimado: ${r.porte}`)
      if (r.resumo) out.push(`- ${r.resumo}`)
      out.push('')
    }
    if (r.gancho_abordagem) {
      out.push(`**Gancho de abordagem:** ${r.gancho_abordagem}`)
      out.push('')
    }

    if (r.motivos) {
      out.push('<details><summary>Como o score foi formado</summary>')
      out.push('')
      out.push('```')
      out.push(r.motivos)
      out.push('```')
      out.push('')
      out.push('</details>')
      out.push('')
    }
  }

  if (descartados.length > 0) {
    out.push('---')
    out.push('')
    out.push(`## Descartadas (${descartados.length}) — ja tem atendimento automatizado`)
    out.push('')
    out.push('Nao abordar. Dizer "vi que voce atende manualmente" para quem tem um bot')
    out.push('instalado queima a empresa e o remetente.')
    out.push('')
    for (const d of descartados) {
      out.push(
        `- **${escapePipe(String(d['name']))}** — widget: ${d['chat_widget'] ?? '?'}${d['website'] ? ` (${d['website']})` : ''}`,
      )
    }
    out.push('')
  }

  return out.join('\n')
}

function parseOportunidades(blob: string | null): Oportunidade[] {
  if (!blob) return []
  const validas = new Set(Object.keys(OPORTUNIDADE_LABEL))
  return [...new Set(blob.split(','))].filter((o): o is Oportunidade => validas.has(o))
}

function escapePipe(value: string): string {
  return value.replaceAll('|', '\\|')
}
