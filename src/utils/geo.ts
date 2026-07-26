/** Raio medio da Terra em km. */
const EARTH_RADIUS_KM = 6371

export type LatLng = { lat: number; lng: number }

const toRad = (deg: number): number => (deg * Math.PI) / 180

/** Distancia haversine em km. Usada para medir o quao longe do centro o resultado esta. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Desloca um ponto por um offset em km. Aproximacao plana -- exata o bastante em escala urbana. */
export function offsetKm(origin: LatLng, eastKm: number, northKm: number): LatLng {
  const dLat = northKm / 111.32
  // Um grau de longitude encurta conforme se afasta do equador.
  const kmPerDegreeLng = 111.32 * Math.cos(toRad(origin.lat))
  const dLng = kmPerDegreeLng === 0 ? 0 : eastKm / kmPerDegreeLng
  return { lat: origin.lat + dLat, lng: origin.lng + dLng }
}

/**
 * Nivel de zoom do Maps que enquadra aproximadamente um raio em km.
 *
 * O zoom vai na URL (`/@lat,lng,15z`) e determina quantos resultados o Maps
 * devolve: zoom baixo cobre area demais e ele agrega/omite estabelecimentos
 * pequenos, zoom alto cobre pouco. A tabela e empirica.
 */
export function zoomForRadiusKm(radiusKm: number): number {
  if (radiusKm <= 0.5) return 17
  if (radiusKm <= 1) return 16
  if (radiusKm <= 2) return 15
  if (radiusKm <= 4) return 14
  if (radiusKm <= 8) return 13
  if (radiusKm <= 16) return 12
  return 11
}
