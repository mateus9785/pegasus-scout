import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { RowDataPacket } from 'mysql2/promise'
import { closePools, testPool, truncateScoutTables } from '../helpers/testDb.js'
import { makeProspectInput, makeSearchInput } from '../helpers/factories.js'
import { upsertProspect, patchProspect, findPendingForStage, setStageStatus } from '../../src/db/repositories/prospectRepo.js'
import { createSearch, finishSearch, linkProspect } from '../../src/db/repositories/searchRepo.js'
import { upsertSignal, listSignals } from '../../src/db/repositories/signalRepo.js'
import { block, isBlocked } from '../../src/db/repositories/blocklistRepo.js'
import { cacheGeocode, getCachedGeocode } from '../../src/db/repositories/geocodeRepo.js'
import { assertSchema, findMissingTables, REQUIRED_TABLES } from '../../src/db/assertSchema.js'
import { loadEnv } from '../../src/config/env.js'

beforeEach(async () => {
  await truncateScoutTables()
})

afterAll(async () => {
  await closePools()
})

describe('upsertProspect', () => {
  it('insere na primeira vez e reconhece como novo', async () => {
    const db = testPool()
    const result = await upsertProspect(db, makeProspectInput({ dedupeKey: 'chave-a' }))

    expect(result.isNew).toBe(true)
    expect(result.id).toBeGreaterThan(0)
  })

  it('e idempotente: o mesmo dedupe_key volta o mesmo id e nao conta como novo', async () => {
    const db = testPool()
    const input = makeProspectInput({ dedupeKey: 'chave-b', name: 'Pet Shop Original' })

    const first = await upsertProspect(db, input)
    const second = await upsertProspect(db, { ...input, name: 'Pet Shop Renomeado' })

    expect(second.id).toBe(first.id)
    expect(second.isNew).toBe(false)

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT name, last_seen_at, first_seen_at FROM scout_prospects WHERE id = ?',
      [first.id],
    )
    // O nome e sobrescrito (a empresa pode ter mudado de nome no Maps)...
    expect(rows[0]?.['name']).toBe('Pet Shop Renomeado')
    // ...e a data da primeira vez que a vimos e preservada.
    expect(rows[0]?.['first_seen_at']).toBeInstanceOf(Date)
    expect(rows[0]?.['last_seen_at']).toBeInstanceOf(Date)

    const [count] = await db.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM scout_prospects',
    )
    expect(Number(count[0]?.['total'])).toBe(1)
  })

  it('nao apaga dado bom quando o run seguinte vem com campo nulo', async () => {
    const db = testPool()
    const input = makeProspectInput({
      dedupeKey: 'chave-c',
      phoneRaw: '(61) 3333-4444',
      phoneE164: '+556133334444',
      phoneKind: 'fixed',
      website: 'https://petshop.com.br',
    })

    const { id } = await upsertProspect(db, input)

    // Segunda passada: o painel do Maps nao mostrou telefone nem site desta vez.
    await upsertProspect(db, {
      ...input,
      phoneRaw: null,
      phoneE164: null,
      phoneKind: 'unknown',
      website: null,
    })

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT phone_e164, phone_kind, website FROM scout_prospects WHERE id = ?',
      [id],
    )
    expect(rows[0]?.['phone_e164']).toBe('+556133334444')
    expect(rows[0]?.['phone_kind']).toBe('fixed')
    expect(rows[0]?.['website']).toBe('https://petshop.com.br')
  })

  it('distingue empresas diferentes pela chave natural', async () => {
    const db = testPool()
    const a = await upsertProspect(db, makeProspectInput({ dedupeKey: 'chave-d1' }))
    const b = await upsertProspect(db, makeProspectInput({ dedupeKey: 'chave-d2' }))

    expect(b.id).not.toBe(a.id)
    expect(b.isNew).toBe(true)
  })
})

describe('patchProspect', () => {
  it('atualiza so as chaves presentes e ignora undefined', async () => {
    const db = testPool()
    const { id } = await upsertProspect(
      db,
      makeProspectInput({ dedupeKey: 'chave-patch', website: 'https://a.com' }),
    )

    await patchProspect(db, id, {
      chatWidget: 'tawk',
      whatsappPhoneE164: '+5561999998888',
      whatsappSource: 'site_link',
    })

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT website, chat_widget, whatsapp_phone_e164, whatsapp_source FROM scout_prospects WHERE id = ?',
      [id],
    )
    expect(rows[0]?.['website']).toBe('https://a.com')
    expect(rows[0]?.['chat_widget']).toBe('tawk')
    expect(rows[0]?.['whatsapp_phone_e164']).toBe('+5561999998888')
    expect(rows[0]?.['whatsapp_source']).toBe('site_link')
  })

  it('nao roda UPDATE quando o patch esta vazio', async () => {
    const db = testPool()
    const { id } = await upsertProspect(db, makeProspectInput({ dedupeKey: 'chave-vazia' }))
    await expect(patchProspect(db, id, {})).resolves.toBeUndefined()
  })
})

describe('findPendingForStage / setStageStatus', () => {
  it('so devolve quem tem o insumo do estagio', async () => {
    const db = testPool()
    // Sem site: enrichment nao tem o que fazer.
    await upsertProspect(db, makeProspectInput({ dedupeKey: 'sem-site', website: null }))
    const comSite = await upsertProspect(
      db,
      makeProspectInput({ dedupeKey: 'com-site', website: 'https://b.com' }),
    )

    const pending = await findPendingForStage(db, 'enrichment', 10)
    expect(pending.map((p) => p.id)).toEqual([comSite.id])
  })

  it('sai da fila depois de marcado como done e grava o timestamp', async () => {
    const db = testPool()
    const { id } = await upsertProspect(
      db,
      makeProspectInput({ dedupeKey: 'fila', website: 'https://c.com' }),
    )

    await setStageStatus(db, id, 'enrichment', 'done')

    expect(await findPendingForStage(db, 'enrichment', 10)).toHaveLength(0)

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT enrichment_status, enriched_at FROM scout_prospects WHERE id = ?',
      [id],
    )
    expect(rows[0]?.['enrichment_status']).toBe('done')
    expect(rows[0]?.['enriched_at']).toBeInstanceOf(Date)
  })

  it('reprocessa falhas somente com retryFailed', async () => {
    const db = testPool()
    const { id } = await upsertProspect(
      db,
      makeProspectInput({ dedupeKey: 'falhou', website: 'https://d.com' }),
    )
    await setStageStatus(db, id, 'enrichment', 'failed')

    expect(await findPendingForStage(db, 'enrichment', 10)).toHaveLength(0)
    expect(await findPendingForStage(db, 'enrichment', 10, { retryFailed: true })).toHaveLength(1)
  })
})

describe('juncao busca x prospect', () => {
  it('duas buscas no mesmo lugar compartilham o prospect sem duplicar', async () => {
    const db = testPool()
    const searchA = await createSearch(db, makeSearchInput({ niche: 'pet shop' }))
    const searchB = await createSearch(db, makeSearchInput({ niche: 'agropecuaria' }))

    // A mesma empresa cai nos dois nichos -- caso real, nao hipotetico.
    const input = makeProspectInput({ dedupeKey: 'compartilhada' })
    const first = await upsertProspect(db, input)
    const again = await upsertProspect(db, input)

    await linkProspect(db, searchA, first.id, { position: 3, isNew: true })
    await linkProspect(db, searchB, again.id, { position: 7, isNew: false })

    const [prospects] = await db.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM scout_prospects',
    )
    expect(Number(prospects[0]?.['total'])).toBe(1)

    const [links] = await db.query<RowDataPacket[]>(
      'SELECT search_id, position FROM scout_search_prospects ORDER BY search_id',
    )
    expect(links).toHaveLength(2)
    expect(links.map((l) => l['position'])).toEqual([3, 7])
  })

  it('tiles sobrepostos nao estouram a chave primaria da juncao', async () => {
    const db = testPool()
    const searchId = await createSearch(db, makeSearchInput())
    const { id } = await upsertProspect(db, makeProspectInput({ dedupeKey: 'fronteira' }))

    await linkProspect(db, searchId, id, { position: 1, tileIndex: 0, isNew: true })
    // Mesmo lugar aparecendo no tile vizinho.
    await linkProspect(db, searchId, id, { position: 9, tileIndex: 1, isNew: false })

    const [links] = await db.query<RowDataPacket[]>(
      'SELECT position, tile_index FROM scout_search_prospects WHERE prospect_id = ?',
      [id],
    )
    expect(links).toHaveLength(1)
    // A primeira posicao vista e preservada.
    expect(links[0]?.['position']).toBe(1)
    expect(links[0]?.['tile_index']).toBe(0)
  })

  it('finishSearch grava contadores e status', async () => {
    const db = testPool()
    const searchId = await createSearch(db, makeSearchInput())
    await finishSearch(db, searchId, {
      status: 'completed',
      discoveredCount: 30,
      newCount: 12,
      updatedCount: 18,
    })

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT status, discovered_count, new_count, updated_count, finished_at FROM scout_searches WHERE id = ?',
      [searchId],
    )
    expect(rows[0]?.['status']).toBe('completed')
    expect(rows[0]?.['discovered_count']).toBe(30)
    expect(rows[0]?.['new_count']).toBe(12)
    expect(rows[0]?.['updated_count']).toBe(18)
    expect(rows[0]?.['finished_at']).toBeInstanceOf(Date)
  })
})

describe('sinais', () => {
  it('re-enriquecer atualiza o sinal em vez de duplicar', async () => {
    const db = testPool()
    const { id } = await upsertProspect(db, makeProspectInput({ dedupeKey: 'sinais' }))

    await upsertSignal(db, {
      prospectId: id,
      stage: 'enrichment',
      key: 'chat_widget',
      value: 'tawk',
      confidence: 0.9,
      evidence: '<script src="embed.tawk.to/...">',
    })
    await upsertSignal(db, {
      prospectId: id,
      stage: 'enrichment',
      key: 'chat_widget',
      value: 'jivochat',
      confidence: 1,
      evidence: '<script src="code.jivosite.com/...">',
    })

    const signals = await listSignals(db, id)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.signal_value).toBe('jivochat')
    expect(Number(signals[0]?.confidence)).toBe(1)
  })

  it('o mesmo signal_key em estagios diferentes convive', async () => {
    const db = testPool()
    const { id } = await upsertProspect(db, makeProspectInput({ dedupeKey: 'sinais-2' }))

    await upsertSignal(db, { prospectId: id, stage: 'enrichment', key: 'whatsapp', value: 'site' })
    await upsertSignal(db, { prospectId: id, stage: 'social', key: 'whatsapp', value: 'bio' })

    expect(await listSignals(db, id)).toHaveLength(2)
  })

  it('trunca evidencia gigante em vez de estourar a coluna', async () => {
    const db = testPool()
    const { id } = await upsertProspect(db, makeProspectInput({ dedupeKey: 'sinais-3' }))

    await upsertSignal(db, {
      prospectId: id,
      stage: 'enrichment',
      key: 'html_minificado',
      evidence: 'x'.repeat(50_000),
    })

    const signals = await listSignals(db, id)
    expect(signals[0]?.evidence?.length).toBe(2000)
  })

  it('apaga o prospect e leva os sinais junto (ON DELETE CASCADE)', async () => {
    const db = testPool()
    const { id } = await upsertProspect(db, makeProspectInput({ dedupeKey: 'cascade' }))
    await upsertSignal(db, { prospectId: id, stage: 'enrichment', key: 'k', value: 'v' })

    await db.query('DELETE FROM scout_prospects WHERE id = ?', [id])

    const [rows] = await db.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM scout_prospect_signals WHERE prospect_id = ?',
      [id],
    )
    expect(Number(rows[0]?.['total'])).toBe(0)
  })
})

describe('blocklist', () => {
  it('bloqueia por telefone e por dominio, e ignora alvo vazio', async () => {
    const db = testPool()

    expect(await isBlocked(db, {})).toBe(false)
    expect(await isBlocked(db, { phoneE164: '+5561999990000' })).toBe(false)

    await block(db, { phoneE164: '+5561999990000' }, 'opt_out', 'pediu para nao receber')
    await block(db, { domain: 'concorrente.com.br' }, 'concorrente')

    expect(await isBlocked(db, { phoneE164: '+5561999990000' })).toBe(true)
    expect(await isBlocked(db, { domain: 'concorrente.com.br' })).toBe(true)
    expect(await isBlocked(db, { domain: 'outro.com.br' })).toBe(false)
    // Basta um dos dois casar.
    expect(await isBlocked(db, { phoneE164: '+5500000000000', domain: 'concorrente.com.br' })).toBe(
      true,
    )
  })
})

describe('cache de geocoding', () => {
  it('grava e le, e o segundo grava sobrescreve', async () => {
    const db = testPool()
    expect(await getCachedGeocode(db, 'Brasilia, DF')).toBeNull()

    await cacheGeocode(db, 'Brasilia, DF', {
      lat: -15.7942,
      lng: -47.8822,
      displayName: 'Brasilia, Distrito Federal',
    })

    const hit = await getCachedGeocode(db, 'Brasilia, DF')
    expect(hit?.lat).toBeCloseTo(-15.7942, 4)
    expect(hit?.lng).toBeCloseTo(-47.8822, 4)
    expect(hit?.displayName).toContain('Brasilia')

    await cacheGeocode(db, 'Brasilia, DF', { lat: -16, lng: -48, displayName: 'Corrigido' })
    expect((await getCachedGeocode(db, 'Brasilia, DF'))?.displayName).toBe('Corrigido')
  })
})

describe('assertSchema', () => {
  it('nao acha nenhuma tabela faltando no banco de teste migrado', async () => {
    expect(await findMissingTables(loadEnv().DB_NAME_TEST)).toEqual([])
  })

  it('reporta a tabela ausente quando alguem esquece de rodar a migracao', async () => {
    const db = testPool()
    const dbName = loadEnv().DB_NAME_TEST

    // Simula o cenario real: o schema.sql ganhou uma tabela nova e ninguem rodou
    // `npm run migrate`. Renomear (em vez de dropar) mantem o teste reversivel e
    // nao depende de recriar DDL aqui.
    await db.query('RENAME TABLE scout_blocklist TO scout_blocklist_ausente')
    try {
      expect(await findMissingTables(dbName)).toEqual(['scout_blocklist'])
      await expect(assertSchema(dbName)).rejects.toThrow(/scout_blocklist/)
    } finally {
      await db.query('RENAME TABLE scout_blocklist_ausente TO scout_blocklist')
    }

    expect(await findMissingTables(dbName)).toEqual([])
  })

  it('a lista de tabelas exigidas cobre as oito do schema', () => {
    expect(REQUIRED_TABLES).toHaveLength(8)
  })
})
