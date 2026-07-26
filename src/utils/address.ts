import { squish } from './text.js'

/**
 * Quebra o endereco que o Google Maps devolve num campo unico.
 *
 * O formato observado e:
 *   "SHCN CLN 206 Bloco D Loja 24 - Asa Norte, Brasilia - DF, 70390-100"
 *
 * Nao ha garantia de que todas as partes venham -- endereco de MEI as vezes tem so
 * a rua. Por isso cada campo e opcional e a funcao nunca lanca: cidade e UF sao
 * usadas para filtrar prospect fora da regiao pedida, e errar isso e melhor que
 * derrubar a busca.
 */

export type ParsedAddress = {
  full: string
  city: string | null
  state: string | null
  postalCode: string | null
}

const UF = /\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/

export function parseBrazilAddress(raw: string | null | undefined): ParsedAddress | null {
  if (!raw) return null
  const full = squish(raw)
  if (full === '') return null

  const postalMatch = full.match(/\b(\d{5})-?(\d{3})\b/)
  const postalCode = postalMatch ? `${postalMatch[1]}-${postalMatch[2]}` : null

  // A UF aparece depois da cidade, separada por " - ". Procurar pela sigla e
  // depois olhar para tras e mais confiavel que contar virgulas: a quantidade de
  // virgulas antes da cidade varia com o tipo de logradouro.
  const stateMatch = full.match(new RegExp(`-\\s*${UF.source}`))
  const state = stateMatch?.[1] ?? full.match(UF)?.[1] ?? null

  let city: string | null = null
  if (stateMatch?.index !== undefined) {
    const beforeState = full.slice(0, stateMatch.index)
    // Ultimo trecho antes da UF, cortado por virgula ou por " - ".
    const parts = beforeState.split(/,|\s-\s/).map(squish).filter(Boolean)
    city = parts.at(-1) ?? null
  }

  return { full, city, state, postalCode }
}
