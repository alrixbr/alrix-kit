// As partes puras do Codex: disponível em cada ramo, o equipamento dos kits, o pedido e a conferência do fim.
import { expect, test } from 'claude-code/testing'

import { alteradosFora, disponivel, juntarEquipamento, lerSaidaLimite, montarPedido, motivoAgora, motivoIndisponivel, textoFim } from './codex.ts'
import type { BaldeCodex, Kit, LeituraCodex } from './contrato.ts'

const BALDE: BaldeCodex = { id: 'codex', nome: null, modelo: null, limiteAtingido: null, gastoBarrado: false, janelaA: null, janelaB: null, temCredito: null, plano: 'pro' }
const BOA: LeituraCodex = { ok: true, lidoEm: 1, usoComumLiberado: true, geral: BALDE, baldes: [BALDE], modelos: [{ id: 'gpt-6.1-sol', nome: 'Sol', esforcos: ['high'] }] }

test('disponível só quando tudo diz que pode', () => {
  expect(disponivel(BOA, 'gpt-6.1-sol')).toBe(true)
  expect(motivoIndisponivel(BOA, 'gpt-6.1-sol')).toBeNull()
})

test('cada ramo que tira o Codex', () => {
  const casos: [LeituraCodex | null, string][] = [
    [null, 'ainda não foi lido'],
    [{ ok: false, motivo: 'sem-codex' }, 'sem-codex'],
    [{ ...BOA, usoComumLiberado: null }, 'não está liberado'],
    [{ ...BOA, usoComumLiberado: false }, 'não está liberado'],
    [{ ...BOA, geral: { ...BALDE, limiteAtingido: 'primary' } }, 'limite do Codex foi atingido'],
    [{ ...BOA, geral: { ...BALDE, gastoBarrado: true } }, 'gasto do Codex está barrado'],
    [{ ...BOA, modelos: null }, 'catálogo'],
    [BOA, 'não está no catálogo'],
  ]
  casos.forEach(([leitura, motivo], i) => {
    const modelo = i === casos.length - 1 ? 'gpt-6-astra' : 'gpt-6.1-sol'
    expect(disponivel(leitura, modelo)).toBe(false)
    expect(motivoIndisponivel(leitura, modelo)).toContain(motivo)
  })
  // gastoBarrado null não barra: só true barra
  expect(disponivel({ ...BOA, geral: { ...BALDE, gastoBarrado: null } }, 'gpt-6.1-sol')).toBe(true)
})

test('depois de um limite estourado o Codex fica fora', () => {
  expect(motivoAgora({ leitura: null, lidoEm: 0, fora: 'limite' }, 'gpt-6.1-sol')).toContain('estourou o limite')
  expect(motivoAgora({ leitura: BOA, lidoEm: 0, fora: null }, 'gpt-6.1-sol')).toBeNull()
})

test('a última linha JSON da saída do codex-limite', () => {
  expect(lerSaidaLimite(`aviso qualquer\n${JSON.stringify(BOA)}\n`)?.ok).toBe(true)
  expect(lerSaidaLimite('nada aqui')).toBeNull()
})

const kit = (id: string, codex?: Kit['codex']): Kit => ({ id, nome: id, quandoUsar: 'x', ferramentas: [], escreve: false, shell: false, ...(codex ? { codex } : {}) })

test('o equipamento dos kits é somado sem repetição, e a chave vai como veio', () => {
  const kits = [
    kit('a', { config: ['web_search="live"', 'plugins.extra@extra.enabled=false'], habilitar: ['x'] }),
    kit('b', { config: ['web_search="live"', 'mcp_servers.pc.enabled=false'], desabilitar: ['y'] }),
    kit('c'),
  ]
  expect(juntarEquipamento(kits)).toEqual({
    config: ['web_search="live"', 'plugins.extra@extra.enabled=false', 'mcp_servers.pc.enabled=false'],
    habilitar: ['x'],
    desabilitar: ['y'],
  })
  expect(juntarEquipamento([kit('c')])).toEqual({})
})

test('o pedido de uma execução nova e o de uma retomada', () => {
  expect(montarPedido({ modelo: 'gpt-6.1-sol', esforco: 'high', pasta: 'C:/proj', escreve: true, kits: [kit('c')], codexHome: '' })).toEqual({
    modelo: 'gpt-6.1-sol',
    esforco: 'high',
    pasta: 'C:/proj',
    escreve: true,
  })
  expect(montarPedido({ modelo: 'gpt-6.1-sol', esforco: 'low', pasta: 'C:/proj', escreve: false, kits: [], retomar: 'thr-1', codexHome: 'D:/codex' })).toEqual({
    modelo: 'gpt-6.1-sol',
    esforco: 'low',
    pasta: 'C:/proj',
    escreve: false,
    retomar: 'thr-1',
    codexHome: 'D:/codex',
  })
})

test('o que mudou fora do território é só informação; sem git, diz que não soube', () => {
  expect(alteradosFora(['src/a.ts', 'README.md'], 'C:/proj', ['c:/proj/src'])).toEqual({ fora: ['c:/proj/readme.md'], semGit: false })
  expect(alteradosFora(null, 'C:/proj', ['c:/proj/src'])).toEqual({ fora: [], semGit: true })
  const texto = textoFim('rev', { n: 1, pasta: 'C:/t/1', fase: 'terminou', iniciadoEm: 0, final: 'C:/t/1/final.md', alteradosFora: ['c:/proj/readme.md'], semGit: false, entregue: true }, false)
  expect(texto).toContain('C:/t/1/final.md')
  expect(texto).toContain('c:/proj/readme.md')
  expect(texto).toContain('nada foi desfeito')
})
