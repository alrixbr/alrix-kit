// O relógio a cada pedido: uma linha com dia da semana, data, hora e fuso, somada ao que os outros ganchos já deram.
import { expect, mock, test } from 'claude-code/testing'

import { linhaDoRelogio } from './relogio'

// 17/11/2026 23:40 na hora do próprio computador (o teste não depende do fuso de quem roda).
const AGORA = new Date(2026, 10, 17, 23, 40, 15)

test('a linha traz o dia da semana, a data, a hora e o fuso', () => {
  const linha = linhaDoRelogio(AGORA)
  expect(linha).toMatch(/^Relógio do computador quando este pedido chegou: terça, 17\/11\/2026 23:40 \(UTC[+-]\d\d:\d\d\)\.$/)
})

test('o fuso bate com o do computador', () => {
  const fuso = -AGORA.getTimezoneOffset()
  const esperado = `${fuso >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(fuso) / 60)).padStart(2, '0')}:${String(Math.abs(fuso) % 60).padStart(2, '0')}`
  expect(linhaDoRelogio(AGORA)).toContain(`(UTC${esperado})`)
})

test('cada dia da semana tem o seu nome', () => {
  const nomes = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
  // 15/11/2026 é domingo
  nomes.forEach((nome, i) => expect(linhaDoRelogio(new Date(2026, 10, 15 + i, 9, 5))).toContain(` ${nome}, `))
})

test('no pedido, a hora vem do relógio do motor e soma ao que já havia', async ($, on) => {
  mock.clock(on, { now: AGORA.getTime() })
  on('classic.UserPromptSubmit', () => ({ additionalContext: ['ANTES'] }))
  const resposta = await $.classic.UserPromptSubmit({ prompt: 'oi', cwd: '/trabalho' })
  expect(resposta.additionalContext).toHaveLength(2)
  expect(resposta.additionalContext?.[0]).toBe('ANTES')
  expect(resposta.additionalContext?.[1]).toBe(linhaDoRelogio(AGORA))
})
