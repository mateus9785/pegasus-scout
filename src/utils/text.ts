/**
 * Faixa dos diacriticos combinantes, que o NFD separa das letras base.
 *
 * Montado via `new RegExp` com escapes numa string em vez de um literal `/[..]/`
 * de proposito: num literal, esses caracteres ficam invisiveis no editor e
 * qualquer copia/cola ou normalizacao de arquivo os corrompe sem deixar rastro --
 * e o sintoma seria "de repente acento parou de ser removido".
 */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')

/** Minusculas sem acento, para comparar nomes vindos de fontes diferentes. */
export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim()
}

/** Colapsa espacos, tabs e quebras de linha num unico espaco. */
export function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Slug estavel: minusculo, sem acento, so [a-z0-9-]. */
export function slugify(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * Remove sufixos de razao social que variam entre fontes ("Pet Shop Alfa LTDA" no
 * site vs "Pet Shop Alfa" no Maps) para nao tratar a mesma empresa como duas.
 */
const LEGAL_SUFFIXES = /\b(ltda|me|mei|eireli|s\/?a|epp|cia|filial|matriz)\b\.?/g

export function canonicalCompanyName(value: string): string {
  return squish(normalizeText(value).replace(LEGAL_SUFFIXES, '').replace(/[^a-z0-9 ]/g, ' '))
}
