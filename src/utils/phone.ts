import type { PhoneKind } from '../types/domain.js'

/**
 * Normalizacao de telefone brasileiro para E.164.
 *
 * Nao usa libphonenumber de proposito: o dominio aqui e um pais so, as regras
 * cabem em 60 linhas testaveis, e a dependencia pesa ~500KB. Se o projeto sair do
 * Brasil, troque este arquivo -- e a unica coisa que sabe de DDD.
 *
 * As regras que importam:
 *  - Celular tem 9 digitos apos o DDD e comeca com 9. Fixo tem 8 e comeca com 2-5.
 *  - Numeros antigos de celular com 8 digitos (comecando com 6-9) ganharam um 9 na
 *    frente em 2016. O Google Maps ainda devolve alguns no formato antigo, e sem
 *    esse ajuste o numero simplesmente nao existe mais.
 *  - 0800 e afins nao tem DDD e nao existem no WhatsApp. Sao reconhecidos e
 *    descartados em vez de virarem um E.164 invalido.
 */

/** DDDs validos no Brasil. Um "DDD" fora desta lista e ruido de parsing. */
const VALID_AREA_CODES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
])

export type ParsedPhone = {
  e164: string
  kind: PhoneKind
  areaCode: number
}

/** Prefixos de servico (nao geograficos): nao tem DDD e nao tem WhatsApp. */
const SERVICE_PREFIXES = ['0800', '0300', '0500', '0900', '4004', '3003']

export function isServiceNumber(raw: string): boolean {
  const digits = onlyDigits(raw)
  return SERVICE_PREFIXES.some((p) => digits.startsWith(p))
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * Devolve null quando o texto nao contem um telefone brasileiro utilizavel --
 * incluindo os casos em que contem algo parecido (CNPJ, CEP, numero de servico).
 */
export function parseBrazilPhone(raw: string | null | undefined): ParsedPhone | null {
  if (!raw) return null

  let digits = onlyDigits(raw)
  if (digits.length === 0) return null

  if (isServiceNumber(raw)) return null

  // Tira o codigo do pais se vier, e o zero de operadora (0xx) que aparece em
  // sites brasileiros no formato "0 61 3333-4444".
  if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2)
  if (digits.startsWith('0') && digits.length >= 11) digits = digits.slice(1)

  if (digits.length < 10 || digits.length > 11) return null

  const areaCode = Number(digits.slice(0, 2))
  if (!VALID_AREA_CODES.has(areaCode)) return null

  let subscriber = digits.slice(2)

  if (subscriber.length === 8) {
    const first = subscriber[0]!
    if (first >= '6' && first <= '9') {
      // Celular no formato pre-2016: acrescenta o nono digito.
      subscriber = `9${subscriber}`
    } else if (first < '2' || first > '5') {
      // Nem celular antigo nem fixo valido (fixo comeca em 2-5).
      return null
    }
  } else if (subscriber.length === 9) {
    // Com 9 digitos, so celular existe -- e celular sempre comeca com 9.
    if (subscriber[0] !== '9') return null
  }

  const kind: PhoneKind = subscriber.length === 9 ? 'mobile' : 'fixed'
  return { e164: `+55${areaCode}${subscriber}`, kind, areaCode }
}

/**
 * Extrai todos os telefones distintos de um bloco de texto (pagina de contato,
 * bio de rede social). Ordem de aparicao preservada.
 */
export function extractBrazilPhones(text: string): ParsedPhone[] {
  // Casa formatos comuns: (61) 99999-8888, 61 3333 4444, +55 61 99999-8888.
  const candidates = text.match(/(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/g) ?? []

  const seen = new Set<string>()
  const out: ParsedPhone[] = []
  for (const candidate of candidates) {
    const parsed = parseBrazilPhone(candidate)
    if (parsed && !seen.has(parsed.e164)) {
      seen.add(parsed.e164)
      out.push(parsed)
    }
  }
  return out
}

/**
 * DDDs de cada UF.
 *
 * Serve para uma verificacao que se mostrou essencial na primeira varredura real: a
 * Cobasi de Brasilia anunciava um WhatsApp com DDD 11 (Sao Paulo). Nao e o telefone
 * da loja -- e a central da rede nacional. Comercio local de verdade atende num DDD
 * local, e um numero de outro estado e sinal de que quem responde e um call center
 * corporativo, nao a pessoa que decide a compra.
 */
const DDD_BY_UF: Record<string, readonly number[]> = {
  AC: [68], AL: [82], AP: [96], AM: [92, 97],
  BA: [71, 73, 74, 75, 77], CE: [85, 88], DF: [61], ES: [27, 28],
  GO: [62, 64], MA: [98, 99], MT: [65, 66], MS: [67],
  MG: [31, 32, 33, 34, 35, 37, 38], PA: [91, 93, 94], PB: [83],
  PR: [41, 42, 43, 44, 45, 46], PE: [81, 87], PI: [86, 89],
  RJ: [21, 22, 24], RN: [84], RS: [51, 53, 54, 55], RO: [69], RR: [95],
  SC: [47, 48, 49], SE: [79], SP: [11, 12, 13, 14, 15, 16, 17, 18, 19], TO: [63],
}

/**
 * O DDD pertence a UF?
 *
 * `null` quando nao da para dizer (sem UF, sem telefone, UF desconhecida) -- e nao
 * `false`, porque "nao sei" e "e de fora" levam a decisoes diferentes no scoring.
 */
export function isLocalAreaCode(e164: string | null, uf: string | null): boolean | null {
  if (!e164 || !uf) return null
  const dddsDaUf = DDD_BY_UF[uf.toUpperCase()]
  if (!dddsDaUf) return null

  const parsed = parseBrazilPhone(e164)
  if (!parsed) return null
  return dddsDaUf.includes(parsed.areaCode)
}

/** +5561999998888 -> (61) 99999-8888. Usado nos relatorios, nao no banco. */
export function formatBrazilPhone(e164: string): string {
  const digits = onlyDigits(e164)
  if (!digits.startsWith('55') || digits.length < 12) return e164

  const areaCode = digits.slice(2, 4)
  const subscriber = digits.slice(4)
  const split = subscriber.length === 9 ? 5 : 4
  return `(${areaCode}) ${subscriber.slice(0, split)}-${subscriber.slice(split)}`
}
