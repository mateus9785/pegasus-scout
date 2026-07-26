import type { RowDataPacket } from 'mysql2/promise'
import type { Queryable, SignalInput, SignalStage } from '../../types/domain.js'

/**
 * Sinais sao a memoria auditavel do robo: cada um guarda O QUE foi detectado, com
 * que confianca, e o trecho de evidencia que provou. Serve para depurar detector
 * que errou e, na parte legal, para registrar a origem de cada dado coletado.
 *
 * `evidence` e truncada em 2000 caracteres na gravacao. Um site minificado tem
 * linhas de 200KB, e guardar isso por sinal por empresa inflaria a tabela sem
 * ganho -- o comeco do trecho basta para identificar de onde veio.
 */
const MAX_EVIDENCE = 2000

export async function upsertSignal(db: Queryable, input: SignalInput): Promise<void> {
  await db.query(
    `INSERT INTO scout_prospect_signals (
       prospect_id, stage, signal_key, signal_value, confidence, evidence, source_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?) AS novo
     ON DUPLICATE KEY UPDATE
       signal_value = novo.signal_value,
       confidence   = novo.confidence,
       evidence     = novo.evidence,
       source_url   = novo.source_url`,
    [
      input.prospectId,
      input.stage,
      input.key,
      input.value ?? null,
      input.confidence ?? 1.0,
      input.evidence ? input.evidence.slice(0, MAX_EVIDENCE) : null,
      input.sourceUrl ?? null,
    ],
  )
}

export async function upsertSignals(db: Queryable, inputs: SignalInput[]): Promise<void> {
  for (const input of inputs) await upsertSignal(db, input)
}

export type SignalRow = RowDataPacket & {
  stage: SignalStage
  signal_key: string
  signal_value: string | null
  confidence: string | number
  evidence: string | null
  source_url: string | null
}

export async function listSignals(db: Queryable, prospectId: number): Promise<SignalRow[]> {
  const [rows] = await db.query<SignalRow[]>(
    `SELECT stage, signal_key, signal_value, confidence, evidence, source_url
       FROM scout_prospect_signals
      WHERE prospect_id = ?
      ORDER BY stage, signal_key`,
    [prospectId],
  )
  return rows
}

/** Remove os sinais de um estagio antes de reprocessa-lo, para nao deixar sinal orfao. */
export async function clearStageSignals(
  db: Queryable,
  prospectId: number,
  stage: SignalStage,
): Promise<void> {
  await db.query(`DELETE FROM scout_prospect_signals WHERE prospect_id = ? AND stage = ?`, [
    prospectId,
    stage,
  ])
}
