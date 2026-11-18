// As contas da tela, sem o motor: nomes, durações e as linhas do time a partir de uma leitura do estado.
import { expect, test } from 'claude-code/testing'

import type { EquipeBarrada, EquipeEspecialista, EquipePulso } from '../types'
import { curto, linhaFaixa, ondeEscreve } from './faixa.tsx'
import { duracao, escolher, linhasEquipe, nomeEsforco, nomeModelo, textoModo } from './tela.tsx'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 11, 2, 0, 0)

const esp = (nome: string, mudar: Partial<EquipeEspecialista> = {}): EquipeEspecialista => ({
  nome,
  tipo: `alrix-equipe:${nome}`,
  motor: 'claude',
  destino: 'pc',
  descricao: `Especialista ${nome}.`,
  projeto: 'proj',
  pastaProjeto: 'c:/proj',
  modelo: 'sonnet',
  esforco: 'high',
  kits: ['codigo'],
  ferramentas: ['Read', 'Edit'],
  skills: [],
  servidoresMcp: [],
  escreve: true,
  abreAjudante: false,
  texto: '',
  pesos: { dossie: 0, projeto: 0, tipo: 0, licoes: 0, kits: 0, devolucao: 0, fatos: 0, total: 0 },
  territorio: ['c:/proj/src'],
  naoToque: [],
  estado: 'pronto',
  criadoEm: T0,
  agentIds: [],
  emExecucao: [],
  barradas: 0,
  ampliacoes: [],
  ...mudar,
})
const PARADO: EquipePulso = { agora: T0, inicio: {}, fim: {} }
const barrada = (especialista: string, pendente = true): EquipeBarrada => ({ especialista, ferramenta: 'Write', alvo: 'c:/proj/docs/x.md', motivo: 'fora', em: T0, pendente })

test('nomes de modelo e de esforço como o dono fala', () => {
  expect(nomeModelo('fable')).toBe('Fable')
  expect(nomeModelo('claude-fable-5-2')).toBe('Fable')
  expect(nomeModelo('claude-sonnet-5-5')).toBe('Sonnet')
  expect(nomeModelo('gpt-6-astra')).toBe('Astra')
  expect(nomeModelo('gpt-6.1-sol')).toBe('Sol')
  expect(nomeModelo('outro')).toBe('Outro')
  expect(nomeEsforco('xhigh')).toBe('muito alto')
  expect(nomeEsforco('low')).toBe('baixo')
})

test('duração para ler de relance', () => {
  expect(duracao(20_000)).toBe('menos de 1 min')
  expect(duracao(14 * MIN + 59_000)).toBe('14 min')
  expect(duracao(65 * MIN)).toBe('1 h 05 min')
  expect(duracao(-5)).toBe('menos de 1 min')
})

test('cada linha diz quem, com que modelo e esforço, e o que está fazendo', () => {
  const time = [
    esp('sênior', { modelo: 'fable', estado: 'trabalhando', agentIds: ['a1'], emExecucao: ['a1'] }),
    esp('prova', { esforco: 'low' }),
    esp('feito', { estado: 'terminou', agentIds: ['a2'] }),
    esp('fora', { estado: 'dispensado' }),
  ]
  const pulso: EquipePulso = { agora: T0 + 14 * MIN, inicio: { sênior: T0, feito: T0 }, fim: { feito: T0 + 31 * MIN } }
  expect(linhasEquipe(time, [], pulso)).toEqual([
    // de quem trabalha vai também o começo da rodada: a barra de estado refaz o tempo com o relógio dela
    { marca: 'rodando', nome: 'sênior', motor: 'Fable · alto', estado: 'há 14 min', desde: T0 },
    { marca: 'pronto', nome: 'prova', motor: 'Sonnet · baixo', estado: 'esperando ser chamado' },
    { marca: 'terminou', nome: 'feito', motor: 'Sonnet · alto', estado: 'terminou em 31 min' },
  ])
})

test('ajudantes em paralelo, Codex rodando e Codex que falhou', () => {
  const exec = (fase: 'rodando' | 'falhou') => ({ n: 1, pasta: 'p', fase, iniciadoEm: T0, entregue: false })
  const time = [
    esp('dois', { estado: 'trabalhando', emExecucao: ['a1', 'a2'] }),
    esp('astra', { motor: 'codex', tipo: '', modelo: 'gpt-6-astra', estado: 'trabalhando', codex: { execucoes: [exec('rodando')] } }),
    esp('sol', { motor: 'codex', tipo: '', modelo: 'gpt-6.1-sol', codex: { execucoes: [exec('falhou')] } }),
  ]
  const linhas = linhasEquipe(time, [], PARADO)
  expect(linhas[0]?.estado).toBe('trabalhando · 2 em paralelo')
  expect(linhas[0]?.sufixo).toBe(' · 2 em paralelo')
  expect(linhas[1]).toMatchObject({ marca: 'rodando', motor: 'Astra · alto' })
  expect(linhas[2]).toMatchObject({ marca: 'alerta', estado: 'a execução falhou' })
})

test('escrita recusada pendente marca a linha; resolvida, não', () => {
  const time = [esp('a'), esp('b')]
  const linhas = linhasEquipe(time, [barrada('a'), barrada('a'), barrada('b', false)], PARADO)
  expect(linhas[0]).toMatchObject({ marca: 'alerta', alerta: '2 escritas recusadas' })
  expect(linhas[1]).toEqual({ marca: 'pronto', nome: 'b', motor: 'Sonnet · alto', estado: 'esperando ser chamado' })
})

test('quando o time não cabe, ficam primeiro quem pede atenção e quem roda, na ordem do time', () => {
  const linhas = linhasEquipe(
    [esp('p1'), esp('t1', { estado: 'terminou' }), esp('r1', { estado: 'trabalhando', emExecucao: ['x'] }), esp('p2'), esp('al')],
    [barrada('al')],
    PARADO,
  )
  const { visiveis, resto } = escolher(linhas, 3)
  expect(visiveis.map(l => l.nome)).toEqual(['p1', 'r1', 'al'])
  expect(resto).toBe(2)
  expect(escolher(linhas, 5)).toEqual({ visiveis: linhas, resto: 0 })
})

test('a faixa de cima só fala do que não tem lugar na linha da Equipe', () => {
  const nada = { avisos: [{ em: T0, caso: 'x', visto: true }], codex: { leitura: null, lidoEm: 0, fora: null } }
  const cheia = { avisos: [{ em: T0, caso: 'x', visto: false }], codex: { leitura: null, lidoEm: 0, fora: 'limite' } }
  expect(linhaFaixa(nada, false)).toBeUndefined()
  // sem time não há linha da Equipe: o aviso novo aparece aqui
  expect(linhaFaixa(cheia, false)).toBe('Codex fora do cardápio (limite) · 1 aviso novo em /equipe')
  // com time, a contagem de avisos já está junto do modo
  expect(linhaFaixa(cheia, true)).toBe('Codex fora do cardápio (limite)')
  expect(linhaFaixa({ ...cheia, codex: nada.codex }, true)).toBeUndefined()
})

test('o modo, no fim da primeira linha, conta os casos só no modo aviso', () => {
  expect(textoModo('aviso', 0)).toBe('modo aviso')
  expect(textoModo('aviso', 1)).toBe('modo aviso · 1 caso anotado')
  expect(textoModo('aviso', 4)).toBe('modo aviso · 4 casos anotados')
  expect(textoModo('barrar', 4)).toBe('modo barrar')
})

test('caminho curto e onde escreve', () => {
  expect(curto('c:/users/pessoa/projetos/alrix-equipe/mod')).toBe('…/alrix-equipe/mod')
  expect(curto('c:/proj')).toBe('c:/proj')
  expect(ondeEscreve(esp('a'))).toBe('escreve em …/proj/src')
  expect(ondeEscreve(esp('a', { territorio: ['c:/p/a/b', 'c:/p/c/d', 'c:/p/e/f'] }))).toBe('escreve em …/a/b, …/c/d e mais 1')
  expect(ondeEscreve(esp('a', { escreve: false, territorio: [] }))).toBe('só lê, não escreve arquivo')
})
