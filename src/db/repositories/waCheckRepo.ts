import type { RowDataPacket } from 'mysql2/promise'
import type { Queryable, WhatsappCheckInput } from '../../types/domain.js'

/**
 * Resultado do check PASSIVO de WhatsApp Web. Nao ha nenhuma coluna de mensagem
 * aqui, e isso e intencional: a Etapa 1 nunca envia nada. O upsert e por
 * (prospect_id, phone_e164) para que re-checar atualize a ficha em vez de
 * empilhar historico -- o que interessa e o estado atual do perfil.
 */

export async function upsertWhatsappCheck(
  db: Queryable,
  input: WhatsappCheckInput,
): Promise<void> {
  await db.query(
    `INSERT INTO scout_whatsapp_checks (
       prospect_id, phone_e164, exists_on_whatsapp, is_business, has_catalog,
       has_away_message_hint, profile_description, business_category,
       declared_hours_json, status, error, checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CURRENT_TIMESTAMP) AS novo
     ON DUPLICATE KEY UPDATE
       exists_on_whatsapp    = novo.exists_on_whatsapp,
       is_business           = novo.is_business,
       has_catalog           = novo.has_catalog,
       has_away_message_hint = novo.has_away_message_hint,
       profile_description   = novo.profile_description,
       business_category     = novo.business_category,
       declared_hours_json   = novo.declared_hours_json,
       status                = novo.status,
       error                 = novo.error,
       checked_at            = CURRENT_TIMESTAMP`,
    [
      input.prospectId,
      input.phoneE164,
      input.existsOnWhatsapp,
      input.isBusiness,
      input.hasCatalog,
      input.hasAwayMessageHint,
      input.profileDescription,
      input.businessCategory,
      input.declaredHours ? JSON.stringify(input.declaredHours) : null,
      input.status,
      input.error ?? null,
    ],
  )
}

export type WhatsappCheckRow = RowDataPacket & {
  prospect_id: number
  phone_e164: string
  exists_on_whatsapp: number | null
  is_business: number | null
  has_catalog: number | null
  status: string
}

export async function getWhatsappCheck(
  db: Queryable,
  prospectId: number,
): Promise<WhatsappCheckRow | null> {
  const [rows] = await db.query<WhatsappCheckRow[]>(
    `SELECT * FROM scout_whatsapp_checks WHERE prospect_id = ? ORDER BY checked_at DESC LIMIT 1`,
    [prospectId],
  )
  return rows[0] ?? null
}

/** Quantos numeros foram consultados hoje. Alimenta o teto diario de seguranca. */
export async function countChecksToday(db: Queryable): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM scout_whatsapp_checks WHERE DATE(checked_at) = CURDATE()`,
  )
  return Number(rows[0]?.['total'] ?? 0)
}
