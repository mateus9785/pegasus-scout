import { loadEnv } from '../../src/config/env.js'
import { getPool, closePools } from '../../src/db/pool.js'
import type { Queryable } from '../../src/types/domain.js'

/** Pool apontando para DB_NAME_TEST. Nunca para o banco de trabalho. */
export function testPool(): Queryable {
  return getPool(loadEnv().DB_NAME_TEST)
}

export { closePools }

/**
 * Ordem de truncate importa: as FKs sao ON DELETE CASCADE, mas TRUNCATE nao
 * dispara cascade e e recusado em tabela referenciada por FK. Por isso o
 * FOREIGN_KEY_CHECKS=0 em volta -- e por isso a lista vai das filhas para as
 * pais, que mantem o comportamento correto mesmo se alguem remover o toggle.
 */
const TABLES_CHILD_FIRST = [
  'scout_search_prospects',
  'scout_prospect_signals',
  'scout_prospect_briefs',
  'scout_whatsapp_checks',
  'scout_searches',
  'scout_prospects',
  'scout_blocklist',
  'scout_geocode_cache',
] as const

export async function truncateScoutTables(): Promise<void> {
  const db = testPool()
  await db.query('SET FOREIGN_KEY_CHECKS = 0')
  try {
    for (const table of TABLES_CHILD_FIRST) {
      await db.query(`TRUNCATE TABLE ${table}`)
    }
  } finally {
    await db.query('SET FOREIGN_KEY_CHECKS = 1')
  }
}
