import { describe, expect, it } from 'vitest'
import {
  extractBrazilPhones,
  formatBrazilPhone,
  isServiceNumber,
  parseBrazilPhone,
  isLocalAreaCode,
} from '../../src/utils/phone.js'

describe('parseBrazilPhone', () => {
  it('normaliza os formatos que o Maps e os sites usam', () => {
    const esperado = { e164: '+5561999998888', kind: 'mobile', areaCode: 61 }

    expect(parseBrazilPhone('(61) 99999-8888')).toEqual(esperado)
    expect(parseBrazilPhone('61 99999 8888')).toEqual(esperado)
    expect(parseBrazilPhone('+55 61 99999-8888')).toEqual(esperado)
    expect(parseBrazilPhone('5561999998888')).toEqual(esperado)
    expect(parseBrazilPhone('  61999998888  ')).toEqual(esperado)
  })

  it('classifica fixo e celular pela quantidade de digitos', () => {
    expect(parseBrazilPhone('(11) 3333-4444')).toEqual({
      e164: '+551133334444',
      kind: 'fixed',
      areaCode: 11,
    })
    expect(parseBrazilPhone('(11) 93333-4444')?.kind).toBe('mobile')
  })

  it('acrescenta o nono digito em celular no formato pre-2016', () => {
    // Numero antigo de 8 digitos comecando com 9: hoje so existe com o 9 na frente.
    expect(parseBrazilPhone('(61) 8888-7777')).toEqual({
      e164: '+5561988887777',
      kind: 'mobile',
      areaCode: 61,
    })
    expect(parseBrazilPhone('(61) 9999-8888')?.e164).toBe('+5561999998888')
  })

  it('remove o zero de operadora', () => {
    expect(parseBrazilPhone('0 61 3333-4444')?.e164).toBe('+556133334444')
  })

  it('rejeita DDD que nao existe', () => {
    // 20, 23, 26, 29, 30... nao sao DDDs validos no Brasil.
    expect(parseBrazilPhone('(20) 3333-4444')).toBeNull()
    expect(parseBrazilPhone('(00) 99999-8888')).toBeNull()
  })

  it('rejeita numero de servico, que nao tem WhatsApp', () => {
    expect(parseBrazilPhone('0800 123 4567')).toBeNull()
    expect(parseBrazilPhone('4004-1234')).toBeNull()
    expect(isServiceNumber('0300 777 8899')).toBe(true)
    expect(isServiceNumber('(61) 3333-4444')).toBe(false)
  })

  it('rejeita ruido que parece telefone', () => {
    expect(parseBrazilPhone(null)).toBeNull()
    expect(parseBrazilPhone(undefined)).toBeNull()
    expect(parseBrazilPhone('')).toBeNull()
    expect(parseBrazilPhone('sem telefone')).toBeNull()
    expect(parseBrazilPhone('123')).toBeNull()
    // CNPJ tem 14 digitos.
    expect(parseBrazilPhone('12.345.678/0001-99')).toBeNull()
    // Fixo nao comeca com 1 nem com 6-9 em 8 digitos... 1 e invalido.
    expect(parseBrazilPhone('(61) 1234-5678')).toBeNull()
    // Com 9 digitos, o primeiro tem de ser 9.
    expect(parseBrazilPhone('(61) 83333-4444')).toBeNull()
  })
})

describe('extractBrazilPhones', () => {
  it('acha varios telefones num bloco de texto e nao repete', () => {
    const texto = `
      Fale com a gente: (61) 3333-4444
      WhatsApp: +55 61 99999-8888
      Ou no mesmo whats: 61999998888
      Central: 0800 555 1234
    `
    const encontrados = extractBrazilPhones(texto)
    expect(encontrados.map((p) => p.e164)).toEqual(['+556133334444', '+5561999998888'])
  })

  it('devolve lista vazia quando nao ha telefone', () => {
    expect(extractBrazilPhones('Rua das Flores, 123 - CEP 70000-000')).toEqual([])
  })
})

describe('isLocalAreaCode', () => {
  it('reconhece DDD da UF', () => {
    expect(isLocalAreaCode('+556133334444', 'DF')).toBe(true)
    expect(isLocalAreaCode('+5511933334444', 'SP')).toBe(true)
    expect(isLocalAreaCode('+5548999998888', 'SC')).toBe(true)
  })

  it('reconhece DDD de outro estado', () => {
    // Caso real: a Cobasi de Brasilia anuncia WhatsApp com DDD 11.
    expect(isLocalAreaCode('+5511933505743', 'DF')).toBe(false)
    expect(isLocalAreaCode('+556133334444', 'SP')).toBe(false)
  })

  it('aceita UF em minusculas', () => {
    expect(isLocalAreaCode('+556133334444', 'df')).toBe(true)
  })

  it('devolve null quando nao da para decidir, e nao false', () => {
    // A diferenca importa: "nao sei" nao pode virar penalidade no scoring.
    expect(isLocalAreaCode(null, 'DF')).toBeNull()
    expect(isLocalAreaCode('+556133334444', null)).toBeNull()
    expect(isLocalAreaCode('+556133334444', 'XX')).toBeNull()
    expect(isLocalAreaCode('nao e telefone', 'DF')).toBeNull()
  })
})

describe('formatBrazilPhone', () => {
  it('formata para leitura no relatorio', () => {
    expect(formatBrazilPhone('+5561999998888')).toBe('(61) 99999-8888')
    expect(formatBrazilPhone('+556133334444')).toBe('(61) 3333-4444')
  })

  it('devolve a entrada intacta quando nao e um E.164 brasileiro', () => {
    expect(formatBrazilPhone('+14155552671')).toBe('+14155552671')
  })
})
