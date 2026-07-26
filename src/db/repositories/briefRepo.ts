import type { RowDataPacket } from 'mysql2/promise'
import type { Queryable } from '../../types/domain.js'
import type { LlmAnalysis } from '../../enrichment/llmAnalyzer.js'

export async function upsertBrief(
  db: Queryable,
  prospectId: number,
  analyzerVersion: string,
  model: string,
  analysis: LlmAnalysis,
): Promise<void> {
  await db.query(
    `INSERT INTO scout_prospect_briefs (
       prospect_id, analyzer_version, model, segmento, vende_json, catalogo,
       vende_online, atende_por_whatsapp, sinais_automacao_json, dores_json,
       integracoes_json, porte, resumo, gancho_abordagem, confianca
     ) VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?) AS novo
     ON DUPLICATE KEY UPDATE
       model                 = novo.model,
       segmento              = novo.segmento,
       vende_json            = novo.vende_json,
       catalogo              = novo.catalogo,
       vende_online          = novo.vende_online,
       atende_por_whatsapp   = novo.atende_por_whatsapp,
       sinais_automacao_json = novo.sinais_automacao_json,
       dores_json            = novo.dores_json,
       integracoes_json      = novo.integracoes_json,
       porte                 = novo.porte,
       resumo                = novo.resumo,
       gancho_abordagem      = novo.gancho_abordagem,
       confianca             = novo.confianca`,
    [
      prospectId,
      analyzerVersion,
      model,
      analysis.segmento,
      JSON.stringify(analysis.vende),
      analysis.catalogo,
      analysis.vende_online,
      analysis.atende_por_whatsapp,
      JSON.stringify(analysis.sinais_de_automacao),
      JSON.stringify(analysis.dores_de_atendimento),
      JSON.stringify(analysis.integracoes_uteis),
      analysis.porte_estimado,
      analysis.resumo,
      analysis.gancho_abordagem,
      analysis.confianca,
    ],
  )
}

export type BriefRow = RowDataPacket & {
  prospect_id: number
  segmento: string | null
  catalogo: string
  porte: string
  resumo: string | null
  gancho_abordagem: string | null
  confianca: string | null
  integracoes_json: unknown
  dores_json: unknown
}

export async function getBrief(db: Queryable, prospectId: number): Promise<BriefRow | null> {
  const [rows] = await db.query<BriefRow[]>(
    `SELECT * FROM scout_prospect_briefs WHERE prospect_id = ? ORDER BY updated_at DESC LIMIT 1`,
    [prospectId],
  )
  return rows[0] ?? null
}

export async function hasBrief(
  db: Queryable,
  prospectId: number,
  analyzerVersion: string,
): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 FROM scout_prospect_briefs WHERE prospect_id = ? AND analyzer_version = ? LIMIT 1`,
    [prospectId, analyzerVersion],
  )
  return rows.length > 0
}
