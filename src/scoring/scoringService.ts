import type { RowDataPacket } from 'mysql2/promise'
import type { Queryable } from '../types/domain.js'
import { scoreProspect, SCORE_VERSION } from './score.js'
import type { ScoreInput, ScoreResult } from './score.js'
import { clearStageSignals, upsertSignal } from '../db/repositories/signalRepo.js'
import { isLocalAreaCode } from '../utils/phone.js'
import { childLogger } from '../logger/logger.js'

const log = childLogger({ stage: 'scoring' })

/**
 * Monta o ScoreInput a partir do banco e grava o resultado.
 *
 * A leitura junta prospect + sinais + brief numa consulta so por prospect em vez de
 * N+1: um `score` sobre mil empresas com tres consultas cada seria lento sem motivo,
 * e o scoring roda de novo a cada mudanca de peso.
 */

type ScoringRow = RowDataPacket & {
  id: number
  name: string
  website: string | null
  chat_widget: string | null
  ecommerce_platform: string | null
  whatsapp_phone_e164: string | null
  phone_e164: string | null
  instagram_url: string | null
  reviews_count: number | null
  rating: string | number | null
  porte: string | null
  catalogo: string | null
  sinais: string | null
  state: string | null
}

const SELECT_SQL = `
SELECT p.id, p.name, p.website, p.chat_widget, p.ecommerce_platform, p.state,
       p.whatsapp_phone_e164, p.phone_e164, p.instagram_url, p.reviews_count, p.rating,
       b.porte, b.catalogo,
       GROUP_CONCAT(CONCAT(s.signal_key, '=', COALESCE(s.signal_value, '')) SEPARATOR '||') AS sinais
  FROM scout_prospects p
  LEFT JOIN scout_prospect_briefs b ON b.prospect_id = p.id
  LEFT JOIN scout_prospect_signals s ON s.prospect_id = p.id AND s.stage <> 'scoring'
 WHERE p.enrichment_status IN ('done', 'failed', 'skipped')
   AND p.pipeline_status <> 'descartado'
 GROUP BY p.id, b.id
 ORDER BY p.id ASC
 LIMIT ?
`

export type ScoreSummary = {
  processados: number
  qualificados: number
  descartados: number
  indefinidos: number
  mediaScore: number
}

export async function runScoring(db: Queryable, limit: number): Promise<ScoreSummary> {
  const [rows] = await db.query<ScoringRow[]>(SELECT_SQL, [limit])

  const summary: ScoreSummary = {
    processados: 0,
    qualificados: 0,
    descartados: 0,
    indefinidos: 0,
    mediaScore: 0,
  }
  let somaScore = 0

  for (const row of rows) {
    const sinais = parseSignalBlob(row.sinais)
    const input = buildScoreInput(row, sinais)
    const result = scoreProspect(input)

    await persistScore(db, row.id, result)

    summary.processados += 1
    somaScore += result.score
    if (result.verdict === 'provavelmente_automatizado') summary.descartados += 1
    else if (result.verdict === 'provavelmente_manual') summary.qualificados += 1
    else summary.indefinidos += 1
  }

  summary.mediaScore = summary.processados > 0 ? Math.round(somaScore / summary.processados) : 0
  log.info(summary, 'scoring encerrado')
  return summary
}

/** `chave=valor||chave2=valor2` -> Map. Formato vem do GROUP_CONCAT acima. */
function parseSignalBlob(blob: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!blob) return map
  for (const part of blob.split('||')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    map.set(part.slice(0, index), part.slice(index + 1))
  }
  return map
}

export function buildScoreInput(
  row: Pick<
    ScoringRow,
    | 'website'
    | 'chat_widget'
    | 'ecommerce_platform'
    | 'whatsapp_phone_e164'
    | 'instagram_url'
    | 'reviews_count'
    | 'rating'
    | 'porte'
    | 'catalogo'
    | 'state'
    | 'phone_e164'
  >,
  sinais: Map<string, string>,
): ScoreInput {
  const meios = sinais.get('meios_pagamento')
  const avaliacoesSinal = sinais.get('volume_avaliacoes')

  return {
    temWidgetChat: row.chat_widget !== null,
    widgetChatNome: row.chat_widget,
    temWhatsapp: row.whatsapp_phone_e164 !== null || sinais.has('whatsapp_no_site'),
    temBotaoWhatsappPlugin: sinais.has('botao_whatsapp'),
    temSiteProprio: row.website !== null,
    siteForaDoAr: sinais.has('site_fora_do_ar'),
    siteEmPlataformaTerceiro: sinais.has('site_em_plataforma_terceiro'),
    plataformaEcommerce: row.ecommerce_platform,
    construtorDeSite: sinais.get('construtor_de_site') ?? null,
    meiosPagamento: meios && meios !== '' ? meios.split(',') : [],
    temInstagram: row.instagram_url !== null,
    avaliacoes:
      row.reviews_count ?? (avaliacoesSinal ? Number(avaliacoesSinal) || null : null),
    nota: row.rating !== null ? Number(row.rating) : null,
    horarioDeclarado: sinais.has('horario_declarado_maps'),
    porteLlm: row.porte,
    catalogoLlm: row.catalogo,
    contatoLocal: isLocalAreaCode(row.whatsapp_phone_e164 ?? row.phone_e164, row.state),
  }
}

async function persistScore(db: Queryable, prospectId: number, result: ScoreResult): Promise<void> {
  // Descartar automaticamente quem ja tem automacao evita que ele reapareca no
  // relatorio e no lote da Etapa 2. Nao apaga nada: o prospect fica no banco com o
  // motivo registrado, e da para reverter mudando pipeline_status.
  const pipelineStatus =
    result.verdict === 'provavelmente_automatizado' ? 'descartado' : 'qualificado'

  await db.query(
    `UPDATE scout_prospects
        SET fit_score = ?, automation_verdict = ?, score_version = ?,
            scored_at = CURRENT_TIMESTAMP, pipeline_status = ?
      WHERE id = ?`,
    [result.score, result.verdict, result.version, pipelineStatus, prospectId],
  )

  await clearStageSignals(db, prospectId, 'scoring')

  for (const [i, oportunidade] of result.oportunidades.entries()) {
    await upsertSignal(db, {
      prospectId,
      stage: 'scoring',
      key: `oportunidade_${i + 1}`,
      value: oportunidade,
      confidence: 1,
    })
  }

  // Os motivos vao para um sinal so, em ordem de peso: e o "por que esse ficou em
  // primeiro" que o relatorio imprime.
  await upsertSignal(db, {
    prospectId,
    stage: 'scoring',
    key: 'motivos',
    value: `${result.score}/100`,
    evidence: result.motivos
      .toSorted((a, b) => Math.abs(b.peso) - Math.abs(a.peso))
      .map((m) => `${m.peso > 0 ? '+' : ''}${m.peso}  ${m.motivo}`)
      .join('\n'),
    confidence: 1,
  })
}

export { SCORE_VERSION }
