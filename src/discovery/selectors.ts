/**
 * O unico ponto de fragilidade do scraper, concentrado de proposito.
 *
 * O Google Maps troca nomes de classe a cada deploy (`.hfpxzc`, `.F7nice` sao
 * gerados). Por isso a ordem de preferencia de cada seletor e:
 *
 *   1. `data-item-id` -- atributos semanticos que o Google usa ha anos para os
 *      campos da ficha (`authority` para site, `phone:tel:` para telefone). Sao o
 *      que mais dura.
 *   2. `role` e `aria-label` -- acessibilidade nao pode quebrar sem que o Maps
 *      fique inutilizavel para leitor de tela, o que da uma estabilidade indireta.
 *   3. classe gerada -- ultimo recurso, esperando quebrar.
 *
 * `required: true` significa "se nenhum candidato casar, o layout mudou": o
 * comando `check:selectors` reprova e o discovery aborta em vez de gravar
 * centenas de registros vazios no banco.
 */

export type SelectorSpec = {
  key: string
  /** Em ordem de preferencia. O primeiro que casar ganha. */
  candidates: string[]
  required: boolean
  description: string
}

export const MAPS_SELECTORS = {
  consentAccept: {
    key: 'consentAccept',
    candidates: [
      'button[aria-label*="Aceitar tudo"]',
      'button[aria-label*="Accept all"]',
      '#L2AGLb',
      'form[action*="consent"] button',
    ],
    required: false,
    description: 'Botao de consentimento de cookies. Aparece so na primeira visita do perfil.',
  },

  feed: {
    key: 'feed',
    candidates: ['div[role="feed"]', 'div[aria-label^="Resultados"]'],
    required: true,
    description: 'Painel lateral com a lista de resultados. E o container que rola.',
  },

  feedCardLink: {
    key: 'feedCardLink',
    candidates: [
      'div[role="feed"] a[href*="/maps/place/"]',
      'a.hfpxzc',
      'a[aria-label][href*="/maps/place/"]',
    ],
    required: true,
    description: 'Ancora de cada card. O href carrega ftid e coordenada.',
  },

  feedEndMarker: {
    key: 'feedEndMarker',
    candidates: ['span.HlvSq', 'div[role="feed"] > div:last-child p'],
    required: false,
    description: 'Texto "Voce chegou ao final da lista". Confirma que a rolagem terminou.',
  },

  detailPanel: {
    key: 'detailPanel',
    candidates: ['div[role="main"][aria-label]', 'div[role="main"]'],
    required: true,
    description: 'Painel da ficha do lugar. O aria-label e o nome do estabelecimento.',
  },

  detailName: {
    key: 'detailName',
    candidates: ['h1.DUwDvf', 'div[role="main"] h1'],
    required: true,
    description: 'Nome do estabelecimento na ficha.',
  },

  detailWebsite: {
    key: 'detailWebsite',
    candidates: ['a[data-item-id="authority"]', 'a[aria-label^="Website"]', 'a[data-tooltip="Abrir site"]'],
    required: false,
    description: 'Link do site. Muitas empresas nao tem -- ausencia e sinal, nao erro.',
  },

  detailPhone: {
    key: 'detailPhone',
    candidates: [
      'button[data-item-id^="phone:tel:"]',
      'button[aria-label^="Telefone:"]',
      'button[data-tooltip="Copiar numero de telefone"]',
    ],
    required: false,
    description: 'Telefone. O data-item-id ja traz o numero: phone:tel:+556133334444.',
  },

  detailAddress: {
    key: 'detailAddress',
    candidates: [
      'button[data-item-id="address"]',
      'button[aria-label^="Endereco:"]',
      'button[data-tooltip="Copiar endereco"]',
    ],
    required: false,
    description: 'Endereco completo.',
  },

  detailPlusCode: {
    key: 'detailPlusCode',
    candidates: ['button[data-item-id="oloc"]', 'button[aria-label^="Plus code:"]'],
    required: false,
    description: 'Plus code. Fallback de localizacao quando nao ha coordenada na URL.',
  },

  detailCategory: {
    key: 'detailCategory',
    candidates: ['button[jsaction*="category"]', 'div[role="main"] button.DkEaL'],
    required: false,
    description: 'Categoria do negocio segundo o Google ("Pet shop", "Otica").',
  },

  detailRating: {
    key: 'detailRating',
    candidates: ['div.F7nice span[aria-hidden="true"]', 'span[role="img"][aria-label*="estrela"]'],
    required: false,
    description: 'Nota media. Ausente quando o lugar nao tem avaliacao.',
  },

  detailReviewsCount: {
    key: 'detailReviewsCount',
    candidates: [
      'div.F7nice span[aria-label*="avaliac"]',
      'button[jsaction*="reviewChart"] span',
      'span[aria-label*="avaliac"]',
    ],
    required: false,
    description: 'Quantidade de avaliacoes. Proxy de volume de clientes.',
  },

  detailHoursTable: {
    key: 'detailHoursTable',
    candidates: ['table.eK4R0e', 'div[aria-label*="Sexta-feira"] table', 'table[aria-label*="horario"]'],
    required: false,
    description: 'Tabela de horario de funcionamento, um tr por dia da semana.',
  },
} as const satisfies Record<string, SelectorSpec>

export type MapsSelectorKey = keyof typeof MAPS_SELECTORS

export const REQUIRED_MAPS_SELECTORS = Object.values(MAPS_SELECTORS).filter((s) => s.required)
