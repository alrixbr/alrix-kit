// O que o dono vê quando algo fora do time pede a atenção dele (a faixa acima do campo de texto) e quando ele
// pede (o painel /equipe, só leitura). O time do dia a dia, com as recusas e o modo, aparece sob o campo de
// texto: tela.tsx. Desenhar só lê o estado (escrever enquanto desenha é recusado pelo motor).
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { EquipeAviso, EquipeBarrada, EquipeCodex, EquipeEspecialista, EquipePulso } from '../types'
import { rodando, vivos } from './capacidade.ts'
import { lerAvisos, lerBarradas, lerCodex, lerFila, lerLiberacao, lerPulso, lerTime } from './estado.ts'
import { GLIFO, linhasEquipe } from './tela.tsx'
import type { Marca } from './tela.tsx'

type FaixaInput = Extract<RenderInput, { component: 'AbovePrompt' }>
type PainelInput = Extract<RenderInput, { component: 'Pane' }>

export const PAINEL = 'equipe'
export const TITULO = 'Equipe'

export type Leitura = {
  time: EquipeEspecialista[]
  barradas: EquipeBarrada[]
  avisos: EquipeAviso[]
  codex: EquipeCodex
  pulso: EquipePulso
}

const plural = (n: number, um: string, varios: string): string => `${n} ${n === 1 ? um : varios}`

/**
 * A linha da faixa: só o que não tem lugar na linha da Equipe, sob o campo de texto. A escrita recusada fica
 * na linha de quem a tentou, e, com time, a contagem de avisos fica junto do modo; undefined quando não sobra nada.
 */
export function linhaFaixa(l: Pick<Leitura, 'avisos' | 'codex'>, temTime: boolean): string | undefined {
  const avisos = temTime ? 0 : l.avisos.filter(a => !a.visto).length
  const partes: string[] = []
  if (l.codex.fora !== null) partes.push('Codex fora do cardápio (limite)')
  if (avisos) partes.push(plural(avisos, 'aviso novo em /equipe', 'avisos novos em /equipe'))
  return partes.length ? partes.join(' · ') : undefined
}

async function ler($: EngineInterface): Promise<Leitura> {
  return {
    time: await lerTime($),
    barradas: await lerBarradas($),
    avisos: await lerAvisos($),
    codex: await lerCodex($),
    pulso: await lerPulso($),
  }
}

/** A faixa acima do prompt; o que outros mods desenham ali fica logo abaixo. */
export async function desenharFaixa($: EngineInterface, e: FaixaInput, next: (e: FaixaInput) => Promise<RenderElement>): Promise<RenderElement> {
  if (e.props.hasSurvey) return next(e)
  const l = { avisos: await lerAvisos($), codex: await lerCodex($) }
  const linha = linhaFaixa(l, vivos(await lerTime($)).length > 0)
  if (linha === undefined) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  const abaixo = await next(e)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>Equipe</Text>
        <Text dimColor>{' │ '}</Text>
        {l.codex.fora !== null ? <Text color="warning">{linha}</Text> : <Text dimColor>{linha}</Text>}
      </Text>
      {abaixo}
    </Box>
  )
}

const MODOS: Record<string, string> = {
  aviso: 'o que seria barrado só é anotado; o time liberado já segue o território da ficha',
  barrar: 'o que foge da ficha é recusado de verdade',
  desligado: 'o mod não faz nada',
}

/** O fim de um caminho, para caber numa linha: "…/alrix-equipe/mod". */
export function curto(caminho: string, partes = 2): string {
  const pedacos = caminho.replace(/\\/g, '/').split('/').filter(Boolean)
  return pedacos.length <= partes ? caminho : `…/${pedacos.slice(-partes).join('/')}`
}

/** Onde o especialista escreve, numa frase. */
export function ondeEscreve(x: EquipeEspecialista): string {
  if (!x.escreve || x.territorio.length === 0) return 'só lê, não escreve arquivo'
  const mostra = x.territorio.slice(0, 2).map(c => curto(c)).join(', ')
  return `escreve em ${mostra}${x.territorio.length > 2 ? ` e mais ${x.territorio.length - 2}` : ''}`
}

/** O resumo do alto do painel. A memória livre fica fora: ela só é lida quando uma ferramenta pede, e velha engana. */
export function resumoPainel(l: Pick<Leitura, 'time'>, teto: number): string {
  return `${vivos(l.time).length} de ${teto} no time · ${rodando(l.time)} trabalhando`
}

/** O painel /equipe, só leitura. */
export async function desenharPainel($: EngineInterface, e: PainelInput, modo: string, teto: number): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const l = await ler($)
  const fila = await lerFila($)
  const liberacao = await lerLiberacao($)
  const linhas = linhasEquipe(l.time, l.barradas, l.pulso)
  const porNome = new Map(l.time.map(x => [x.nome, x] as const))
  const larguraNome = Math.max(0, ...linhas.map(x => x.nome.length)) + 3
  const larguraMotor = Math.max(0, ...linhas.map(x => x.motor.length)) + 3
  const dispensados = l.time.filter(x => x.estado === 'dispensado').map(x => x.nome)
  const pendentes = l.barradas.filter(b => b.pendente).slice(-5)
  // Todos os avisos da sessão ficam no painel: chamar `time` marca como vistos, e o dono ainda precisa lê-los.
  const novos = l.avisos.filter(a => !a.visto).length
  const temCodex = l.codex.fora !== null || l.time.some(x => x.motor === 'codex' && x.estado !== 'dispensado')
  const cor = (m: Marca): 'claude' | 'success' | 'warning' | undefined => (m === 'rodando' ? 'claude' : m === 'terminou' ? 'success' : m === 'alerta' ? 'warning' : undefined)
  const titulo = (texto: string): RenderElement => (
    <Box flexDirection="column">
      <Text> </Text>
      <Text bold>{texto}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{resumoPainel(l, teto)}</Text>
      <Text dimColor wrap="truncate-end">{`Modo ${modo}: ${MODOS[modo] ?? ''}`}</Text>
      <Text dimColor wrap="truncate-end">{liberacao === 'sessao' ? 'Sessão liberada: time novo entra sem cartão' : 'Cada time novo pede o seu cartão'}</Text>
      {titulo('Time')}
      {linhas.length === 0 ? <Text dimColor>Nenhum especialista nesta sessão.</Text> : null}
      {linhas.map(x => {
        const esp = porNome.get(x.nome)
        const c = cor(x.marca)
        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {c === undefined ? <Text dimColor>{`${GLIFO[x.marca]} `}</Text> : <Text color={c}>{`${GLIFO[x.marca]} `}</Text>}
              {x.marca === 'rodando' ? <Text bold>{x.nome.padEnd(larguraNome)}</Text> : <Text>{x.nome.padEnd(larguraNome)}</Text>}
              <Text dimColor>{x.motor.padEnd(larguraMotor)}</Text>
              {x.marca === 'rodando' ? <Text>{x.estado}</Text> : <Text dimColor>{x.estado}</Text>}
            </Text>
            {esp === undefined ? null : <Text dimColor wrap="truncate-end">{`  ${esp.objetivo || esp.descricao}`}</Text>}
            {esp === undefined ? null : <Text dimColor wrap="truncate-end">{`  ${ondeEscreve(esp)}`}</Text>}
            {x.alerta === undefined ? null : <Text color="warning" wrap="truncate-end">{`  ${x.alerta}`}</Text>}
          </Box>
        )
      })}
      {dispensados.length ? <Text dimColor wrap="truncate-end">{`Dispensados: ${dispensados.join(', ')}`}</Text> : null}
      {pendentes.length ? titulo('Escritas recusadas esperando o chefe') : null}
      {pendentes.map(b => (
        <Text wrap="truncate-end">
          <Text color="warning">{'▲ '}</Text>
          <Text>{`${b.especialista}  `}</Text>
          <Text dimColor>{`${b.ferramenta} em ${curto(b.alvo, 3)}`}</Text>
        </Text>
      ))}
      {l.avisos.length ? titulo(`O que o modo barrar teria recusado nesta sessão (${l.avisos.length}${novos ? `, ${novos === 1 ? '1 novo' : `${novos} novos`}` : ''})`) : null}
      {l.avisos.slice(-5).map(a => (
        <Text dimColor wrap="truncate-end">{`  ${a.caso}`}</Text>
      ))}
      {temCodex ? titulo('Codex') : null}
      {temCodex ? (
        <Text dimColor wrap="truncate-end">
          {l.codex.fora !== null ? 'Fora do cardápio: a última execução estourou o limite' : l.codex.leitura?.ok ? 'No cardápio: limite lido e liberado' : 'Limite ainda não lido nesta sessão'}
        </Text>
      ) : null}
      {titulo(`Lições esperando a sua aprovação: ${fila.length}`)}
      {fila.slice(-3).map(f => (
        <Text dimColor wrap="truncate-end">{`  ${f.regra}`}</Text>
      ))}
      {fila.length ? <Text dimColor wrap="wrap">{'  Para uma valer, copie-a da fila (alrix-equipe/licoes-fila.json) para o licoes.json da sua prateleira.'}</Text> : null}
    </Box>
  )
}
