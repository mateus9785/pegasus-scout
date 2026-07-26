import type { ProspectInput, SearchInput } from '../../src/types/domain.js'

let seq = 0

export function makeProspectInput(overrides: Partial<ProspectInput> = {}): ProspectInput {
  seq += 1
  return {
    source: 'google_maps',
    dedupeKey: `ftid-teste-${seq}`,
    placeFtid: `0x94:0x${seq}`,
    name: `Empresa Teste ${seq}`,
    category: 'Pet shop',
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:teste${seq}`,
    phoneRaw: null,
    phoneE164: null,
    phoneKind: 'unknown',
    website: null,
    domain: null,
    address: 'Rua Teste, 100 - Brasilia, DF',
    city: 'Brasilia',
    state: 'DF',
    lat: -15.7942,
    lng: -47.8822,
    rating: 4.5,
    reviewsCount: 120,
    hours: null,
    ...overrides,
  }
}

export function makeSearchInput(overrides: Partial<SearchInput> = {}): SearchInput {
  return {
    niche: 'pet shop',
    city: 'Brasilia',
    state: 'DF',
    queryText: 'pet shop em Brasilia, DF',
    centerLat: -15.7942,
    centerLng: -47.8822,
    radiusKm: 5,
    tileCount: 1,
    maxResults: 40,
    params: { origem: 'teste' },
    ...overrides,
  }
}
