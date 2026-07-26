import type { RowDataPacket } from 'mysql2/promise'
import { getPool } from './pool.js'
import { SchemaError } from '../errors.js'
import { loadEnv } from '../config/env.js'

/**
 * O DDL das tabelas scout_* vive em artificialstudio/backend/src/db/schema.sql,
 * que e a fonte unica. Este projeto NAO duplica DDL nem roda migracao propria --
 * duas definicoes do mesmo schema divergem em semanas. Ele so verifica se as
 * tabelas estao lá e, se nao estiverem, diz o comando exato que resolve.
 */

export const REQUIRED_TABLES = [
  'scout_geocode_cache',
  'scout_searches',
  'scout_prospects',
  'scout_search_prospects',
  'scout_prospect_signals',
  'scout_prospect_briefs',
  'scout_whatsapp_checks',
  'scout_blocklist',
] as const

export async function findMissingTables(database?: string): Promise<string[]> {
  const env = loadEnv()
  const dbName = database ?? env.DB_NAME

  const [rows] = await getPool(dbName).query<RowDataPacket[]>(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name IN (${REQUIRED_TABLES.map(() => '?').join(', ')})`,
    [dbName, ...REQUIRED_TABLES],
  )

  const present = new Set(rows.map((r) => String(r['name'])))
  return REQUIRED_TABLES.filter((t) => !present.has(t))
}

export async function assertSchema(database?: string): Promise<void> {
  const missing = await findMissingTables(database)
  if (missing.length === 0) return

  throw new SchemaError(
    `Faltam ${missing.length} de ${REQUIRED_TABLES.length} tabelas scout_* no banco: ${missing.join(', ')}.`,
    'Rode `npm run migrate` dentro de artificialstudio/backend/ — o DDL delas fica no schema.sql daquele projeto.',
  )
}
