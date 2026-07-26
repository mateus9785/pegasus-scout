import type { RowDataPacket } from 'mysql2/promise'
import type { Queryable } from '../../types/domain.js'

/**
 * Registro de opt-out. Na Etapa 1 ele so filtra quem nao deve nem ser consultado,
 * mas existe desde ja porque a Etapa 2 tem de checar isto antes de qualquer envio,
 * e um registro de opt-out que mora num arquivo na maquina de alguem nao e um
 * registro de opt-out.
 */

export type BlockReason = 'opt_out' | 'manual' | 'cliente' | 'concorrente' | 'invalido' | 'denuncia'

export async function isBlocked(
  db: Queryable,
  target: { phoneE164?: string | null; domain?: string | null },
): Promise<boolean> {
  const phone = target.phoneE164 ?? null
  const domain = target.domain ?? null
  if (!phone && !domain) return false

  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT 1 FROM scout_blocklist
      WHERE (? IS NOT NULL AND phone_e164 = ?)
         OR (? IS NOT NULL AND domain = ?)
      LIMIT 1`,
    [phone, phone, domain, domain],
  )
  return rows.length > 0
}

export async function block(
  db: Queryable,
  target: { phoneE164?: string | null; domain?: string | null },
  reason: BlockReason = 'manual',
  notes?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO scout_blocklist (phone_e164, domain, reason, notes)
     VALUES (?, ?, ?, ?) AS novo
     ON DUPLICATE KEY UPDATE reason = novo.reason, notes = novo.notes`,
    [target.phoneE164 ?? null, target.domain ?? null, reason, notes ?? null],
  )
}
