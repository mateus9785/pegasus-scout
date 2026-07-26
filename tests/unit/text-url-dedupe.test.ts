import { describe, expect, it } from 'vitest'
import { canonicalCompanyName, normalizeText, slugify, squish } from '../../src/utils/text.js'
import { extractDomain, isOwnWebsite, absolutize, stripTracking } from '../../src/utils/url.js'
import { buildDedupeKey, isWeakDedupeKey } from '../../src/discovery/dedupeKey.js'

describe('normalizeText', () => {
  it('remove acento e cedilha e baixa a caixa', () => {
    expect(normalizeText('Óptica Visão & Ação')).toBe('optica visao & acao')
    expect(normalizeText('CONSTRUÇÃO')).toBe('construcao')
    expect(normalizeText('  Pão de Açúcar  ')).toBe('pao de acucar')
  })
})

describe('squish', () => {
  it('colapsa espaco, tab e quebra de linha', () => {
    expect(squish('  Pet   Shop\n\tAlfa  ')).toBe('Pet Shop Alfa')
  })
})

describe('slugify', () => {
  it('gera slug estavel', () => {
    expect(slugify('Óptica Visão & Ação')).toBe('optica-visao-acao')
    expect(slugify('---Pet Shop---')).toBe('pet-shop')
  })

  it('trunca nomes absurdamente longos', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
})

describe('canonicalCompanyName', () => {
  it('descarta sufixo de razao social, que varia entre fontes', () => {
    // O Maps mostra "Pet Shop Alfa"; o site assina "PET SHOP ALFA LTDA".
    expect(canonicalCompanyName('PET SHOP ALFA LTDA')).toBe('pet shop alfa')
    expect(canonicalCompanyName('Alfa Comercio ME')).toBe('alfa comercio')
    expect(canonicalCompanyName('Beta S/A')).toBe('beta')
    expect(canonicalCompanyName('Gama EIRELI')).toBe('gama')
  })

  it('nao come palavra que apenas contem o sufixo', () => {
    // "Meire" contem "me", mas nao e sufixo -- a fronteira \b protege isso.
    expect(canonicalCompanyName('Salao Meire')).toBe('salao meire')
  })
})

describe('extractDomain', () => {
  it('tira www e baixa a caixa', () => {
    expect(extractDomain('https://WWW.PetShop.com.br/contato')).toBe('petshop.com.br')
    expect(extractDomain('petshop.com.br')).toBe('petshop.com.br')
  })

  it('devolve null para entrada invalida', () => {
    expect(extractDomain(null)).toBeNull()
    expect(extractDomain('')).toBeNull()
    expect(extractDomain('   ')).toBeNull()
  })

  it('recusa palavra solta, que new URL() aceitaria como hostname', () => {
    // O campo "site" do Maps as vezes traz texto digitado pela propria empresa.
    // Sem esta guarda, o enrichment tentaria resolver DNS de "consulte".
    expect(extractDomain('consulte')).toBeNull()
    expect(extractDomain('em breve')).toBeNull()
    expect(extractDomain('nao-e-url')).toBeNull()
    // Sufixo de uma letra nao existe.
    expect(extractDomain('loja.x')).toBeNull()
  })
})

describe('isOwnWebsite', () => {
  it('aceita site proprio', () => {
    expect(isOwnWebsite('https://petshopalfa.com.br')).toBe(true)
    expect(isOwnWebsite('https://loja.petshopalfa.com.br')).toBe(true)
  })

  it('recusa presenca em plataforma de terceiro', () => {
    // Se isto passasse, o detector de widget acharia o chat do Instagram e
    // classificaria a empresa como "ja automatizada" por engano.
    expect(isOwnWebsite('https://instagram.com/petshopalfa')).toBe(false)
    expect(isOwnWebsite('https://www.facebook.com/petshopalfa')).toBe(false)
    expect(isOwnWebsite('https://wa.me/5561999998888')).toBe(false)
    expect(isOwnWebsite('https://linktr.ee/petshopalfa')).toBe(false)
    expect(isOwnWebsite('https://petshopalfa.business.site')).toBe(false)
    expect(isOwnWebsite('https://www.ifood.com.br/delivery/petshopalfa')).toBe(false)
  })

  it('recusa agregadores link-in-bio menos conhecidos', () => {
    // Caso real: uma pet shop de Brasilia tinha linkr.bio no campo de site do Maps.
    // Analisar aquela pagina acharia o widget de chat do agregador e concluiria que
    // a empresa ja tem atendimento automatizado -- descartando um alvo bom.
    expect(isOwnWebsite('https://linkr.bio/petshopalfa')).toBe(false)
    expect(isOwnWebsite('https://bio.link/petshopalfa')).toBe(false)
    expect(isOwnWebsite('https://beacons.ai/petshopalfa')).toBe(false)
    expect(isOwnWebsite('https://taplink.cc/petshopalfa')).toBe(false)
  })

  it('recusa marketplace e agenda de terceiro', () => {
    expect(isOwnWebsite('https://www.doctoralia.com.br/x')).toBe(false)
    expect(isOwnWebsite('https://produto.mercadolivre.com.br/x')).toBe(false)
    expect(isOwnWebsite('https://trinks.com/salao-x')).toBe(false)
  })

  it('recusa entrada vazia', () => {
    expect(isOwnWebsite(null)).toBe(false)
    expect(isOwnWebsite('nao-e-url ')).toBe(false)
  })
})

describe('absolutize', () => {
  it('resolve href relativo', () => {
    expect(absolutize('/contato', 'https://a.com.br/loja')).toBe('https://a.com.br/contato')
    expect(absolutize('contato', 'https://a.com.br/loja/')).toBe('https://a.com.br/loja/contato')
  })

  it('mantem href absoluto', () => {
    expect(absolutize('https://b.com', 'https://a.com')).toBe('https://b.com/')
  })
})

describe('stripTracking', () => {
  it('remove query e fragmento', () => {
    expect(stripTracking('https://a.com.br/p?utm_source=ig&fbclid=x#top')).toBe(
      'https://a.com.br/p',
    )
  })
})

describe('buildDedupeKey', () => {
  it('prefere o ftid do Google quando existe', () => {
    expect(
      buildDedupeKey({ placeFtid: '0x94ce:0x8f2b', name: 'Pet Alfa', lat: -15.79, lng: -47.88 }),
    ).toBe('ftid:0x94ce:0x8f2b')
  })

  it('sem ftid, usa nome canonico + coordenada arredondada', () => {
    const key = buildDedupeKey({
      placeFtid: null,
      name: 'PET SHOP ALFA LTDA',
      lat: -15.794212,
      lng: -47.882166,
    })
    expect(key).toBe('geo:pet-shop-alfa@-15.79421,-47.88217')
  })

  it('e estavel entre runs com precisao de coordenada diferente', () => {
    // O card do painel e a ficha de detalhe devolvem precisoes diferentes para o
    // mesmo lugar. Sem arredondar, a mesma loja viraria dois registros.
    const a = buildDedupeKey({ placeFtid: null, name: 'Pet Alfa', lat: -15.7942119, lng: -47.8821663 })
    const b = buildDedupeKey({ placeFtid: null, name: 'Pet Alfa', lat: -15.7942123, lng: -47.8821659 })
    expect(a).toBe(b)
  })

  it('sem coordenada, cai para o nome e marca a chave como fraca', () => {
    const key = buildDedupeKey({ placeFtid: null, name: 'Pet Alfa', lat: null, lng: null })
    expect(key).toBe('nome:pet-alfa')
    expect(isWeakDedupeKey(key)).toBe(true)
  })

  it('chave por ftid ou por coordenada nao e considerada fraca', () => {
    expect(isWeakDedupeKey('ftid:0x1:0x2')).toBe(false)
    expect(isWeakDedupeKey('geo:pet-alfa@-15.79421,-47.88217')).toBe(false)
  })

  it('nao explode com nome vazio', () => {
    expect(buildDedupeKey({ placeFtid: null, name: '', lat: null, lng: null })).toBe('nome:sem-nome')
  })
})
