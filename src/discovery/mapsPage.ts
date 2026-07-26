import type { LatLng } from '../utils/geo.js'

/**
 * A fronteira entre "dirigir o navegador" e "entender HTML".
 *
 * O contrato devolve string de HTML, nunca elemento nem dado ja extraido. E o que
 * permite os parsers serem funcoes puras testadas contra fixtures salvas em disco,
 * sem rede e sem navegador -- e o que permite trocar o Google Maps pela Places API
 * oficial mais tarde implementando esta mesma interface.
 *
 * Se algum metodo aqui comecar a devolver objeto de dominio em vez de HTML, essa
 * propriedade se perde.
 */
export interface MapsPage {
  /** Abre a busca no ponto e zoom dados. Trata consentimento de cookies. */
  search(query: string, center: LatLng, zoom: number): Promise<void>

  /** Rola o painel de resultados. Devolve se chegou ao fim real da lista. */
  scrollFeed(options?: { maxScrolls?: number }): Promise<{ reachedEnd: boolean }>

  /** innerHTML do painel de resultados. */
  getFeedHtml(): Promise<string>

  /** Abre a ficha de um lugar e devolve o innerHTML do painel de detalhe. */
  getPlaceHtml(placeUrl: string): Promise<string>

  /** URL atual, para extrair o centro do mapa como fallback de coordenada. */
  currentUrl(): string

  close(): Promise<void>
}
