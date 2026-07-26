import { distanceKm, offsetKm, zoomForRadiusKm } from '../utils/geo.js'
import type { LatLng } from '../utils/geo.js'

/**
 * Por que dividir a busca em tiles em vez de fazer uma so com raio grande:
 *
 * O painel de resultados do Google Maps para de carregar por volta de 100-120
 * itens, independente de quantos existam na regiao. Uma unica busca de "pet shop
 * em Sao Paulo" nunca vai devolver os milhares que existem -- ela devolve os ~120
 * que o Maps decidiu rankear e para.
 *
 * A saida e varrer a area com varias buscas centradas em pontos diferentes, cada
 * uma com zoom apertado. Os tiles se sobrepoem de proposito (passo = 70% do lado):
 * um estabelecimento na fronteira entre dois tiles seria perdido por ambos se a
 * grade fosse justa. A duplicata resultante e resolvida de graca pelo upsert por
 * dedupe_key.
 */

export type Tile = {
  index: number
  center: LatLng
  zoom: number
  /** Distancia do centro do tile ao centro da busca, em km. */
  distanceFromCenterKm: number
}

export type TilingOptions = {
  /** Lado de cada tile em km. Menor = mais tiles = mais tempo e mais risco de bloqueio. */
  tileKm?: number
  /** Teto de tiles. Protege contra um `--radius-km 200` gerando centenas de buscas. */
  maxTiles?: number
}

const DEFAULT_TILE_KM = 2
const DEFAULT_MAX_TILES = 25
const OVERLAP_FACTOR = 0.7

export function buildTiles(
  center: LatLng,
  radiusKm: number,
  options: TilingOptions = {},
): Tile[] {
  const tileKm = options.tileKm ?? DEFAULT_TILE_KM
  const maxTiles = options.maxTiles ?? DEFAULT_MAX_TILES

  // Raio pequeno o bastante para caber num tile: uma busca so.
  if (radiusKm <= tileKm) {
    return [{ index: 0, center, zoom: zoomForRadiusKm(radiusKm), distanceFromCenterKm: 0 }]
  }

  const step = tileKm * OVERLAP_FACTOR
  const stepsPerSide = Math.ceil(radiusKm / step)
  const zoom = zoomForRadiusKm(tileKm)

  const tiles: Tile[] = []
  for (let row = -stepsPerSide; row <= stepsPerSide; row += 1) {
    for (let col = -stepsPerSide; col <= stepsPerSide; col += 1) {
      const tileCenter = offsetKm(center, col * step, row * step)
      const distance = distanceKm(center, tileCenter)

      // Grade quadrada recortada em circulo: sem isto, os cantos varreriam area
      // fora do raio que o usuario pediu.
      if (distance > radiusKm) continue

      tiles.push({ index: 0, center: tileCenter, zoom, distanceFromCenterKm: distance })
    }
  }

  // Do centro para fora: se o teto cortar, o que sobra e o miolo da regiao, que e
  // onde a densidade de comercio costuma estar.
  tiles.sort((a, b) => a.distanceFromCenterKm - b.distanceFromCenterKm)

  return tiles.slice(0, maxTiles).map((tile, index) => ({ ...tile, index }))
}
