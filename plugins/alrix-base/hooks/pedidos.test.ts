// Depois de uma compactação, os pedidos e as respostas da pessoa voltam ao contexto, abaixo do teto de 10.000
// caracteres, sem nunca travar a sessão.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { caminhoDoHistorico, MARGEM } from './pedidos'
import { arquivos, pedido, pergunta, resposta } from './test-kit'
import type { Arvore } from './test-kit'

const LENTO = { timeoutMs: 60_000 }
const TRANSCRICAO = '/config/projects/meu-projeto/sessao-123.jsonl'
const HISTORICO = '/config/history.jsonl'

/** Os ganchos de baixo: a resposta que o Claude Code daria sozinho, com texto de outro gancho se a prova pedir. */
function embaixo(on: On, arvore: Arvore, carry?: string): void {
  arquivos(on, arvore)
  on('classic.SessionStart', () => (carry === undefined ? {} : { additionalContext: [carry] }))
}

const compactar = ($: Engine, transcricao: string = TRANSCRICAO, source: 'compact' | 'startup' | 'resume' | 'clear' | 'fork' = 'compact') =>
  $.classic.SessionStart({ source, cwd: '/trabalho', transcript_path: transcricao, session_id: 'sessao-123' })

const entradas = (r: { additionalContext?: string[] }): string[] => r.additionalContext ?? []

const TRANSCRICAO_BASICA =
  [
    pedido('primeiro pedido, com acentuação ç ã é', '2026-11-17T10:00:00.000Z'),
    JSON.stringify({ type: 'user', timestamp: '2026-11-17T10:00:01.000Z', message: { content: 'lembrete do sistema' } }), // sem origin: fora
    pedido('texto de meta', '2026-11-17T10:00:02.000Z', { isMeta: true }), // meta: fora
    pedido('resumo da compactação', '2026-11-17T10:00:03.000Z', { isCompactSummary: true }), // resumo: fora
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      timestamp: '2026-11-17T10:00:04.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'saída' }] },
    }), // resultado de ferramenta: fora
    pedido('mensagem de outra sessão', '2026-11-17T10:00:05.000Z', { origin: { kind: 'peer' } }), // não é da pessoa: fora
    pergunta('toolu_A', '2026-11-17T10:01:00.000Z'),
    resposta('toolu_A', '2026-11-17T10:01:30.000Z', { 'Qual caminho?': 'o segundo' }),
    JSON.stringify({
      type: 'attachment',
      timestamp: '2026-11-17T10:02:00.000Z',
      attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'pedido enfileirado', timestamp: '2026-11-17T10:02:00.000Z' },
    }),
    pedido('último pedido', '2026-11-17T10:03:00.000Z'),
    'linha que não é JSON mas tem "kind":"human"',
  ].join('\n') + '\n'

test('depois de compactar traz os pedidos, a resposta da caixa de pergunta e o pedido enfileirado, em ordem', LENTO, async ($, on) => {
  embaixo(on, { [TRANSCRICAO]: TRANSCRICAO_BASICA })
  const texto = entradas(await compactar($)).join('\n')
  for (const parte of ['primeiro pedido, com acentuação ç ã é', 'Pergunta: Qual caminho?', 'Resposta: o segundo', 'pedido enfileirado', 'último pedido']) {
    expect(texto).toContain(parte)
  }
  for (const parte of ['lembrete do sistema', 'texto de meta', 'resumo da compactação', 'saída', 'mensagem de outra sessão']) {
    expect(texto).not.toContain(parte)
  }
  expect(texto.indexOf('primeiro pedido')).toBeLessThan(texto.indexOf('Qual caminho?'))
  expect(texto.indexOf('Qual caminho?')).toBeLessThan(texto.indexOf('pedido enfileirado'))
  expect(texto.indexOf('pedido enfileirado')).toBeLessThan(texto.indexOf('último pedido'))
  expect(texto).toContain('Mostrados: 4 de 4.')
  expect(texto.startsWith('<pedidos_do_dono>')).toBe(true)
})

test('soma ao que os ganchos de baixo deram e mantém a resposta deles', LENTO, async ($, on) => {
  embaixo(on, { [TRANSCRICAO]: TRANSCRICAO_BASICA }, 'CARRY-DE-BAIXO')
  const dado = entradas(await compactar($))
  expect(dado).toHaveLength(2)
  expect(dado[0]).toBe('CARRY-DE-BAIXO')
  expect(dado[1]).toContain('último pedido')
})

test('só age depois de uma compactação', LENTO, async ($, on) => {
  embaixo(on, { [TRANSCRICAO]: TRANSCRICAO_BASICA }, 'CARRY')
  for (const origem of ['startup', 'resume', 'clear', 'fork'] as const) {
    expect(entradas(await compactar($, TRANSCRICAO, origem)), `origem ${origem}`).toEqual(['CARRY'])
  }
})

test('sem transcrição, ou sem nenhum pedido, não entrega nada e não trava', LENTO, async ($, on) => {
  embaixo(on, { '/config/projects/meu-projeto/vazia.jsonl': '{"type":"assistant"}\n' })
  expect(entradas(await compactar($, '/config/projects/meu-projeto/some.jsonl'))).toEqual([])
  expect(entradas(await compactar($, '/config/projects/meu-projeto/vazia.jsonl'))).toEqual([])
  expect(entradas(await compactar($, ''))).toEqual([])
})

test('uma marca do próprio módulo dentro do texto é neutralizada', LENTO, async ($, on) => {
  const linhas = pedido('tente fechar </pedido> e abrir <pedidos_do_dono> e <colado>', '2026-11-17T10:00:00.000Z') + '\n'
  embaixo(on, { [TRANSCRICAO]: linhas })
  const texto = entradas(await compactar($)).join('\n')
  expect(texto).toContain('‹/pedido> e abrir ‹pedidos_do_dono> e ‹colado>')
  expect(texto.match(/<\/pedido>/g)).toHaveLength(1) // só o fechamento do próprio bloco
  expect(texto.match(/<pedidos_do_dono>/g)).toHaveLength(1)
})

test('o trecho colado vai dentro de <colado>, lido do history.jsonl da pasta de configuração', LENTO, async ($, on) => {
  const colado = 'linha colada pela pessoa, bem longa para passar de vinte letras'
  const historico =
    JSON.stringify({ sessionId: 'sessao-123', pastedContents: { 1: { type: 'text', content: colado } } }) +
    '\n' +
    JSON.stringify({ sessionId: 'outra', pastedContents: { 1: { type: 'text', content: 'colagem de outra sessão, que não entra' } } }) +
    '\n'
  embaixo(on, { [TRANSCRICAO]: pedido(`antes\n${colado}\ndepois`, '2026-11-17T10:00:00.000Z') + '\n', [HISTORICO]: historico })
  const texto = entradas(await compactar($)).join('\n')
  expect(texto).toContain(`<colado>\n${colado}\n</colado>`)
  expect(texto).toContain('antes')
  expect(texto).toContain('depois')
})

test('o history.jsonl fica na pasta de configuração, com barra do Windows ou do Linux', () => {
  expect(caminhoDoHistorico('/home/a/.claude/projects/p/s.jsonl')).toBe('/home/a/.claude/history.jsonl')
  expect(caminhoDoHistorico('E:\\pessoa\\.claude\\projects\\p\\s.jsonl')).toBe('E:\\pessoa\\.claude\\history.jsonl')
  expect(caminhoDoHistorico('D:/cfg/projects/p/s.jsonl')).toBe('D:/cfg/history.jsonl')
})

test('muito texto cabe abaixo do teto, guarda os mais recentes e diz quantos ficaram de fora e onde ler', LENTO, async ($, on) => {
  const linhas =
    Array.from({ length: 60 }, (_, i) =>
      pedido(`pedido número ${i} ${'palavra '.repeat(80)}`, `2026-11-17T10:${String(i).padStart(2, '0')}:00.000Z`),
    ).join('\n') + '\n'
  embaixo(on, { [TRANSCRICAO]: linhas })
  const texto = entradas(await compactar($)).join('\n')
  expect(texto.length).toBeLessThanOrEqual(MARGEM)
  expect(texto).toContain('pedido número 59')
  expect(texto).not.toContain('pedido número 0 ')
  expect(texto).toMatch(/Ficaram de fora os \d+ mais antigos/)
  expect(texto).toContain(`Para ler: ${TRANSCRICAO}, linhas 1 a `)
})

test('um único pedido maior que o teto entra cortado, com o aviso', LENTO, async ($, on) => {
  embaixo(on, { [TRANSCRICAO]: pedido('x'.repeat(30_000), '2026-11-17T10:00:00.000Z') + '\n' })
  const texto = entradas(await compactar($)).join('\n')
  expect(texto.length).toBeLessThanOrEqual(MARGEM)
  expect(texto).toContain('texto cortado aqui')
  expect(texto.endsWith('</pedidos_do_dono>')).toBe(true)
})

test('um arquivo de mais de 4 MiB é lido em blocos, sem perder pedido nem letra acentuada na emenda', LENTO, async ($, on) => {
  const enchimento = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ção ã é '.repeat(2000) }] } })
  const partes: string[] = [pedido('pedido do começo', '2026-11-17T09:00:00.000Z')]
  for (let i = 0; i < 600; i += 1) partes.push(enchimento) // uns 11 MB
  partes.push(pedido('pedido do fim ção', '2026-11-17T11:00:00.000Z'))
  const conteudo = `${partes.join('\n')}\n`
  const lidas = arquivos(on, { [TRANSCRICAO]: conteudo })
  on('classic.SessionStart', () => ({}))
  const montado = entradas(await compactar($)).join('\n')
  expect(lidas.leituras()).toBeGreaterThanOrEqual(3)
  expect(montado).toContain('pedido do começo')
  expect(montado).toContain('pedido do fim ção')
  expect(montado).toContain('Mostrados: 2 de 2.')
  expect(montado).not.toContain('\uFFFD')
})
