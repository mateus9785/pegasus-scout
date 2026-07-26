import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseFeed } from '../../src/discovery/parseFeed.js'
import { parseDetail } from '../../src/discovery/parseDetail.js'
import { parseMapCenter, parsePlaceRef, buildQueryText, buildSearchUrl } from '../../src/discovery/mapsUrl.js'
import { parseBrazilAddress } from '../../src/utils/address.js'
import { parseBrazilPhone } from '../../src/utils/phone.js'

/**
 * Estes testes rodam contra HTML capturado do Google Maps de verdade
 * (`npx tsx scripts/capture-fixtures.ts`), nao contra HTML inventado.
 *
 * E a diferenca entre um teste que prova que o parser funciona e um teste que prova
 * que o parser concorda com o que eu imaginei que a pagina fosse.
 */

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/maps')
const read = (file: string): string => readFileSync(path.join(FIXTURES, file), 'utf-8')

describe('parseFeed contra o feed real do Maps', () => {
  const items = parseFeed(read('feed.html'))

  it('acha todos os cards do painel', () => {
    // A captura rolou 6 vezes e trouxe 40 resultados.
    expect(items.length).toBeGreaterThanOrEqual(20)
  })

  it('extrai nome de todos, sem vazio', () => {
    expect(items.every((i) => i.name.trim().length > 0)).toBe(true)
  })

  it('extrai o ftid do href para praticamente todos', () => {
    const comFtid = items.filter((i) => i.placeFtid !== null)
    expect(comFtid.length / items.length).toBeGreaterThan(0.9)
    expect(comFtid[0]?.placeFtid).toMatch(/^0x[0-9a-f]+:0x[0-9a-f]+$/)
  })

  it('extrai coordenada do href', () => {
    const comCoord = items.filter((i) => i.lat !== null && i.lng !== null)
    expect(comCoord.length / items.length).toBeGreaterThan(0.9)
    // Brasilia.
    expect(comCoord[0]!.lat!).toBeGreaterThan(-16.5)
    expect(comCoord[0]!.lat!).toBeLessThan(-15)
    expect(comCoord[0]!.lng!).toBeLessThan(-47)
  })

  it('separa categoria de endereco na linha de informacao', () => {
    const petz = items.find((i) => i.name.includes('Petz Brasília W3 Norte'))
    expect(petz).toBeDefined()
    expect(petz?.category).toBe('Pet Shop')
    expect(petz?.addressHint).toContain('Comércio Residencial Norte')
    // O endereco nao deve trazer a categoria colada.
    expect(petz?.addressHint).not.toContain('Pet Shop')
  })

  it('nao deixa o status de funcionamento virar categoria', () => {
    for (const item of items) {
      expect(item.category ?? '').not.toMatch(/^(Aberto|Fechado)/)
    }
  })

  it('extrai o telefone do card e nao confunde com a nota', () => {
    const petz = items.find((i) => i.name.includes('Petz Brasília W3 Norte'))
    expect(petz?.phoneRaw).toBe('+556132217386')

    const pegada = items.find((i) => i.name.includes('Pegada Animal'))
    expect(pegada?.phoneRaw).toBe('+5561981265889')
  })

  it('descarta 0800 como telefone de contato', () => {
    // "+PET | Hospital Veterinario" anuncia 0800 062 3036, que nao tem WhatsApp.
    const pet = items.find((i) => i.name.startsWith('+PET'))
    expect(pet).toBeDefined()
    expect(pet?.phoneRaw).toBeNull()
  })

  it('nao confunde o DDD entre parenteses com contagem de avaliacoes', () => {
    // "(61) 3221-7386" nao pode ser lido como 61 avaliacoes.
    const petz = items.find((i) => i.name.includes('Petz Brasília W3 Norte'))
    expect(petz?.reviewsCount).not.toBe(61)
  })

  it('extrai a nota como numero decimal', () => {
    const comNota = items.filter((i) => i.rating !== null)
    expect(comNota.length).toBeGreaterThan(0)
    for (const item of comNota) {
      expect(item.rating!).toBeGreaterThan(0)
      expect(item.rating!).toBeLessThanOrEqual(5)
    }
    expect(items.find((i) => i.name.includes('Pegada Animal'))?.rating).toBe(4.9)
  })

  it('registra o status de funcionamento', () => {
    const comStatus = items.filter((i) => i.openStatus !== null)
    expect(comStatus.length).toBeGreaterThan(0)
    expect(comStatus.map((i) => i.openStatus)).toContain('Aberto')
  })

  it('mantem a posicao no ranking e nao repete href', () => {
    expect(items.map((i) => i.position)).toEqual(items.map((_, i) => i))
    expect(new Set(items.map((i) => i.mapsUrl)).size).toBe(items.length)
  })

  it('devolve lista vazia para HTML sem cards, sem lancar', () => {
    expect(parseFeed('<div role="feed"></div>')).toEqual([])
    expect(parseFeed('')).toEqual([])
  })
})

describe('parseDetail contra fichas reais do Maps', () => {
  it('extrai os campos da ficha do Petz', () => {
    const url = read('detail-2.url.txt')
    const detail = parseDetail(read('detail-2.html'), url)

    expect(detail.name).toBe('Petz Brasília W3 Norte')
    expect(detail.category).toBe('Pet Shop')
    expect(detail.website).toBe('https://www.petz.com.br/loja/petz-brasilia-w3-norte')
    expect(detail.phoneRaw).toBe('(61) 3221-7386')
    expect(detail.address).toContain('Comércio Residencial Norte')
    expect(detail.address).toContain('DF')
    expect(detail.plusCode).toContain('Asa Norte')
    expect(detail.rating).toBe(4.5)
    expect(detail.placeFtid).toBe('0x935a3ba166e617b7:0x9c45d544da2cd97a')
    expect(detail.lat).toBeCloseTo(-15.7825, 3)
    expect(detail.lng).toBeCloseTo(-47.8872, 3)
  })

  it('pega o caminho completo do site, nao so o dominio do aria-label', () => {
    // O aria-label diz apenas "Website: petz.com.br" -- usar ele perderia a loja.
    const detail = parseDetail(read('detail-2.html'), read('detail-2.url.txt'))
    expect(detail.website).toContain('/loja/')
  })

  it('extrai horario declarado, mesmo parcial (a tabela vem colapsada)', () => {
    const detail = parseDetail(read('detail-2.html'), read('detail-2.url.txt'))
    expect(detail.hours).not.toBeNull()
    expect(Object.keys(detail.hours!).length).toBeGreaterThan(0)
    expect(Object.values(detail.hours!)[0]).toMatch(/\d{2}:\d{2}/)
  })

  it('funciona nas outras duas fichas capturadas', () => {
    for (const n of [1, 3]) {
      const detail = parseDetail(read(`detail-${n}.html`), read(`detail-${n}.url.txt`))
      expect(detail.name.length).toBeGreaterThan(0)
      expect(detail.website).toMatch(/^https?:\/\//)
      expect(detail.address).toBeTruthy()
      expect(detail.placeFtid).toMatch(/^0x[0-9a-f]+:0x[0-9a-f]+$/)
    }
  })

  it('normaliza o telefone da ficha para E.164', () => {
    const detail = parseDetail(read('detail-3.html'), read('detail-3.url.txt'))
    expect(parseBrazilPhone(detail.phoneRaw)?.e164).toBe('+5561981265889')
    expect(parseBrazilPhone(detail.phoneRaw)?.kind).toBe('mobile')
  })

  it('reconhece 0800 na ficha e o rejeita na normalizacao', () => {
    const detail = parseDetail(read('detail-1.html'), read('detail-1.url.txt'))
    expect(detail.phoneRaw).toContain('0800')
    expect(parseBrazilPhone(detail.phoneRaw)).toBeNull()
  })

  it('nao lanca com HTML vazio', () => {
    const detail = parseDetail('<div role="main"></div>')
    expect(detail.name).toBe('')
    expect(detail.website).toBeNull()
    expect(detail.hours).toBeNull()
    expect(detail.lat).toBeNull()
  })
})

describe('mapsUrl', () => {
  it('monta a URL de busca com idioma pt-BR fixo', () => {
    const url = buildSearchUrl('pet shop em Brasilia, DF', { lat: -15.7942, lng: -47.8822 }, 14)
    expect(url).toContain('/maps/search/')
    expect(url).toContain('@-15.7942000,-47.8822000,14z')
    // Sem hl=pt-BR os rotulos vem em ingles e parseDetail para de achar campo.
    expect(url).toContain('hl=pt-BR')
    expect(url).toContain('gl=BR')
  })

  it('monta o texto da busca com e sem UF', () => {
    expect(buildQueryText('pet shop', 'Brasilia', 'DF')).toBe('pet shop em Brasilia, DF')
    expect(buildQueryText('otica', 'Goiania', null)).toBe('otica em Goiania')
  })

  it('extrai o centro do mapa da URL', () => {
    expect(parseMapCenter('https://www.google.com/maps/search/x/@-15.7942,-47.8822,14z')).toEqual({
      lat: -15.7942,
      lng: -47.8822,
    })
    expect(parseMapCenter('https://www.google.com/maps')).toBeNull()
  })

  it('degrada sem lancar quando o href nao tem os marcadores esperados', () => {
    const ref = parsePlaceRef('https://www.google.com/maps/place/Loja+X/')
    expect(ref.ftid).toBeNull()
    expect(ref.lat).toBeNull()
    expect(ref.nameFromUrl).toBe('Loja X')
  })
})

describe('parseBrazilAddress', () => {
  it('separa cidade, UF e CEP do endereco do Maps', () => {
    const parsed = parseBrazilAddress(
      'Comércio Residencial Norte, 502 SHCN - Asa Norte, Brasília - DF, 70390-100',
    )
    expect(parsed?.city).toBe('Brasília')
    expect(parsed?.state).toBe('DF')
    expect(parsed?.postalCode).toBe('70390-100')
  })

  it('aceita CEP sem hifen', () => {
    expect(parseBrazilAddress('Rua X, 1 - Centro, Goiânia - GO, 74000000')?.postalCode).toBe(
      '74000-000',
    )
  })

  it('sobrevive a endereco incompleto', () => {
    const parsed = parseBrazilAddress('SHCN CLN 206 Bloco D')
    expect(parsed?.full).toBe('SHCN CLN 206 Bloco D')
    expect(parsed?.city).toBeNull()
    expect(parsed?.postalCode).toBeNull()
  })

  it('devolve null para entrada vazia', () => {
    expect(parseBrazilAddress(null)).toBeNull()
    expect(parseBrazilAddress('   ')).toBeNull()
  })
})
