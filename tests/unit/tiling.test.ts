import { describe, expect, it } from 'vitest'
import { buildTiles } from '../../src/discovery/tiling.js'
import { distanceKm, offsetKm, zoomForRadiusKm } from '../../src/utils/geo.js'

const BRASILIA = { lat: -15.7942, lng: -47.8822 }

describe('distanceKm', () => {
  it('mede zero para o mesmo ponto', () => {
    expect(distanceKm(BRASILIA, BRASILIA)).toBeCloseTo(0, 6)
  })

  it('bate com uma distancia conhecida (Brasilia -> Sao Paulo, ~873 km)', () => {
    const saoPaulo = { lat: -23.5505, lng: -46.6333 }
    expect(distanceKm(BRASILIA, saoPaulo)).toBeGreaterThan(850)
    expect(distanceKm(BRASILIA, saoPaulo)).toBeLessThan(900)
  })

  it('e simetrica', () => {
    const outro = { lat: -15.8, lng: -47.9 }
    expect(distanceKm(BRASILIA, outro)).toBeCloseTo(distanceKm(outro, BRASILIA), 9)
  })
})

describe('offsetKm', () => {
  it('deslocar 5 km resulta em 5 km de distancia', () => {
    expect(distanceKm(BRASILIA, offsetKm(BRASILIA, 5, 0))).toBeCloseTo(5, 1)
    expect(distanceKm(BRASILIA, offsetKm(BRASILIA, 0, 5))).toBeCloseTo(5, 1)
  })

  it('leste aumenta a longitude e norte aumenta a latitude', () => {
    expect(offsetKm(BRASILIA, 3, 0).lng).toBeGreaterThan(BRASILIA.lng)
    expect(offsetKm(BRASILIA, 0, 3).lat).toBeGreaterThan(BRASILIA.lat)
  })
})

describe('zoomForRadiusKm', () => {
  it('quanto maior o raio, menor o zoom', () => {
    const zooms = [0.5, 1, 2, 4, 8, 16, 50].map(zoomForRadiusKm)
    for (let i = 1; i < zooms.length; i += 1) {
      expect(zooms[i]!).toBeLessThan(zooms[i - 1]!)
    }
  })
})

describe('buildTiles', () => {
  it('raio que cabe num tile gera uma unica busca centrada', () => {
    const tiles = buildTiles(BRASILIA, 2, { tileKm: 2 })
    expect(tiles).toHaveLength(1)
    expect(tiles[0]?.center).toEqual(BRASILIA)
    expect(tiles[0]?.distanceFromCenterKm).toBe(0)
  })

  it('raio maior que o tile gera varias buscas', () => {
    const tiles = buildTiles(BRASILIA, 6, { tileKm: 2 })
    expect(tiles.length).toBeGreaterThan(1)
  })

  it('nenhum tile cai fora do raio pedido', () => {
    const raio = 5
    for (const tile of buildTiles(BRASILIA, raio, { tileKm: 2 })) {
      expect(tile.distanceFromCenterKm).toBeLessThanOrEqual(raio + 1e-9)
    }
  })

  it('os tiles se sobrepoem, para nao perder quem esta na fronteira', () => {
    const tiles = buildTiles(BRASILIA, 6, { tileKm: 2 })
    const passo = tiles
      .map((t) => t.distanceFromCenterKm)
      .filter((d) => d > 0)
      .toSorted((a, b) => a - b)[0]!

    // Passo menor que o lado do tile e a definicao de sobreposicao.
    expect(passo).toBeLessThan(2)
  })

  it('respeita o teto de tiles e mantem o miolo da regiao', () => {
    const tiles = buildTiles(BRASILIA, 40, { tileKm: 2, maxTiles: 9 })
    expect(tiles).toHaveLength(9)

    // Ordenado do centro para fora: o primeiro e o centro exato.
    expect(tiles[0]?.distanceFromCenterKm).toBe(0)
    const distancias = tiles.map((t) => t.distanceFromCenterKm)
    expect(distancias.toSorted((a, b) => a - b)).toEqual(distancias)
  })

  it('reindexa em sequencia depois de ordenar e cortar', () => {
    const tiles = buildTiles(BRASILIA, 10, { tileKm: 2, maxTiles: 5 })
    expect(tiles.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('todos os tiles usam o zoom do tamanho do tile, nao do raio total', () => {
    const tiles = buildTiles(BRASILIA, 20, { tileKm: 2 })
    const esperado = zoomForRadiusKm(2)
    expect(tiles.every((t) => t.zoom === esperado)).toBe(true)
  })
})
