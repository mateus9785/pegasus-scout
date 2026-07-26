import { canonicalCompanyName, slugify } from '../utils/text.js'

/**
 * A chave natural que torna o re-scraping idempotente.
 *
 * Preferencia absoluta pelo ftid do Google (`0x94ce...:0x8f2b...`), que e o
 * identificador estavel do lugar. Quando ele nao vem -- e nao vem sempre, o card
 * do painel varia de layout -- cai para nome canonico + coordenada arredondada.
 *
 * Cinco casas decimais equivalem a ~1 metro. Arredondar e essencial: o Maps
 * devolve a coordenada com precisao variavel entre o card e a ficha, e sem o
 * arredondamento a mesma loja geraria duas chaves diferentes entre dois runs.
 *
 * Sem ftid E sem coordenada, resta o nome. E fraco (duas filiais com o mesmo nome
 * colidem), entao o prefixo `nome:` deixa explicito no banco quais registros tem
 * chave fraca e merecem revisao manual.
 */

const COORD_PRECISION = 5

export function buildDedupeKey(input: {
  placeFtid: string | null
  name: string
  lat: number | null
  lng: number | null
}): string {
  if (input.placeFtid && input.placeFtid.trim() !== '') {
    return `ftid:${input.placeFtid.trim()}`
  }

  const name = canonicalCompanyName(input.name)
  const slug = slugify(name) || 'sem-nome'

  if (input.lat !== null && input.lng !== null) {
    const lat = input.lat.toFixed(COORD_PRECISION)
    const lng = input.lng.toFixed(COORD_PRECISION)
    return `geo:${slug}@${lat},${lng}`
  }

  return `nome:${slug}`
}

/** Chave fraca = colisao possivel entre filiais. O relatorio sinaliza esses casos. */
export function isWeakDedupeKey(key: string): boolean {
  return key.startsWith('nome:')
}
