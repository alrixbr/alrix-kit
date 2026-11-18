// O que o dono vê sem pedir: o time, uma linha por especialista, na mesma língua de uma barra de estado que leia o time (rótulo, fio,
// trechos), e o relógio que diz há quanto tempo cada um trabalha.
//
// Quem desenha depende de onde a sessão roda. A barra de estado é a única que desenha acima da linha de modo
// do motor ("⏵⏵ auto mode on"); o que um mod põe sob o campo de texto (PromptHint) fica abaixo dela. Por isso,
// onde uma barra de estado (statusline) que conhece o mod está de pé, ele só publica o time num arquivo e a
// barra o desenha, colado nas linhas dela. Sem a barra (outra máquina, outro terminal, o app), o mod desenha o
// time sob o campo de texto. Desenhar só lê o estado; quem escreve é o pulso, fora do desenho (register.tsx).
import type { EngineInterface, RenderElement, RenderInput, Timer } from 'claude-code'

import type { EquipeBarrada, EquipeEspecialista, EquipePulso } from '../types'
import { vivos } from './capacidade.ts'
import { configDe, dadosDe } from './pastas.ts'
import { gravarPulso, gravarVitrine, lerAvisos, lerBarradas, lerMedidas, lerPulso, lerTime, lerVitrine } from './estado.ts'

type DicaInput = Extract<RenderInput, { component: 'PromptHint' }>

/** Quantas linhas de especialista aparecem sob o campo de texto; o resto vira "+ n no time". */
export const LINHAS = 5
/** De quanto em quanto tempo o relógio da tela confere quem roda. */
const PULSO_MS = 5000
// O rótulo tem a largura dos rótulos de uma barra de estado que leia o time, para os fios das três
// linhas caírem na mesma coluna.
const ROTULO = 'Equipe'
const FIO = ' │ '

export type Marca = 'rodando' | 'pronto' | 'terminou' | 'alerta'

/**
 * Uma linha do time como o dono lê: quem, com que modelo e esforço, e o que está fazendo. De quem trabalha
 * vão também o começo da rodada (`desde`) e o que segue o tempo (`sufixo`): a barra de estado refaz o "há N min"
 * com o relógio dela a cada vez que desenha.
 */
export type LinhaEquipe = { marca: Marca; nome: string; motor: string; estado: string; alerta?: string; desde?: number; sufixo?: string }

export const GLIFO: Record<Marca, string> = { rodando: '●', pronto: '○', terminou: '✓', alerta: '▲' }
const COR: Record<Marca, 'claude' | 'success' | 'warning' | undefined> = { rodando: 'claude', pronto: undefined, terminou: 'success', alerta: 'warning' }

const MODELOS: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', haiku: 'Haiku' }
// As mesmas palavras do cartão (ESFORCO_PT, em equipe.ts).
const ESFORCOS: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'muito alto', max: 'máximo', ultra: 'ultra' }

/** O nome curto do modelo, para quem foi montado sem o nome por extenso: "fable" vira "Fable"; "gpt-6-astra", "Astra". */
export function nomeModelo(id: string): string {
  const limpo = id.trim().toLowerCase()
  const conhecido = MODELOS[limpo] ?? MODELOS[/^claude-([a-z]+)/.exec(limpo)?.[1] ?? '']
  if (conhecido !== undefined) return conhecido
  const base = /^gpt-[\d.]+-([a-z]+)/.exec(limpo)?.[1] ?? limpo
  return base === '' ? 'modelo não informado' : base.charAt(0).toUpperCase() + base.slice(1)
}

/** O esforço em português, como o dono fala dele. */
export function nomeEsforco(esforco: string): string {
  return ESFORCOS[esforco] ?? esforco
}

/** Uma duração para ler de relance: "menos de 1 min", "14 min", "1 h 05 min". */
export function duracao(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000)
  if (min < 1) return 'menos de 1 min'
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}

/** Roda agora: um ajudante do Claude em execução, ou uma execução do Codex que não acabou. */
export function rodaAgora(x: EquipeEspecialista): boolean {
  return x.emExecucao.length > 0 || (x.codex?.execucoes.some(c => c.fase === 'iniciando' || c.fase === 'rodando') ?? false)
}

function estadoDe(x: EquipeEspecialista, pulso: EquipePulso): Pick<LinhaEquipe, 'marca' | 'estado' | 'desde' | 'sufixo'> {
  // A hora exata vem do especialista (gravada no nascimento e no fim); a do pulso serve a quem foi montado
  // antes de esses campos existirem.
  const inicio = x.iniciouEm ?? pulso.inicio[x.nome]
  const fim = x.terminouEm ?? pulso.fim[x.nome]
  if (rodaAgora(x)) {
    const ha = inicio === undefined ? 'trabalhando' : `há ${duracao(pulso.agora - inicio)}`
    const juntos = x.emExecucao.length > 1 ? ` · ${x.emExecucao.length} em paralelo` : ''
    return { marca: 'rodando', estado: `${ha}${juntos}`, ...(inicio === undefined ? {} : { desde: inicio }), ...(juntos === '' ? {} : { sufixo: juntos }) }
  }
  const ultima = x.codex?.execucoes[x.codex.execucoes.length - 1]
  if (ultima?.fase === 'falhou') return { marca: 'alerta', estado: 'a execução falhou' }
  if (x.estado === 'terminou' || ultima?.fase === 'terminou') {
    return { marca: 'terminou', estado: inicio !== undefined && fim !== undefined ? `terminou em ${duracao(fim - inicio)}` : 'terminou' }
  }
  return { marca: 'pronto', estado: 'esperando ser chamado' }
}

/** O time em linhas, na ordem em que foi montado. Função pura: a mesma leitura dá a mesma tela. */
export function linhasEquipe(time: readonly EquipeEspecialista[], barradas: readonly EquipeBarrada[], pulso: EquipePulso): LinhaEquipe[] {
  return vivos(time).map(x => {
    const pendentes = barradas.filter(b => b.pendente && b.especialista === x.nome).length
    const { marca, estado, ...tempo } = estadoDe(x, pulso)
    const motor = `${x.modeloNome ?? nomeModelo(x.modelo)} · ${nomeEsforco(x.esforco)}`
    if (pendentes === 0) return { marca, nome: x.nome, motor, estado, ...tempo }
    return { marca: 'alerta', nome: x.nome, motor, estado, ...tempo, alerta: pendentes === 1 ? '1 escrita recusada' : `${pendentes} escritas recusadas` }
  })
}

const PESO: Record<Marca, number> = { alerta: 0, rodando: 1, pronto: 2, terminou: 3 }

/** As linhas que cabem: quando o time passa do limite, ficam primeiro as que pedem atenção e as que rodam. */
export function escolher(linhas: readonly LinhaEquipe[], limite: number): { visiveis: LinhaEquipe[]; resto: number } {
  if (linhas.length <= limite) return { visiveis: [...linhas], resto: 0 }
  const escolhidas = new Set(
    linhas
      .map((l, i) => ({ l, i }))
      .sort((a, b) => PESO[a.l.marca] - PESO[b.l.marca] || a.i - b.i)
      .slice(0, limite)
      .map(p => p.i),
  )
  return { visiveis: linhas.filter((_, i) => escolhidas.has(i)), resto: linhas.length - limite }
}

/** O trecho do modo, no fim da primeira linha. No modo aviso, com quantos casos o modo barrar teria recusado. */
export function textoModo(modo: string, casos: number): string {
  if (modo !== 'aviso' || casos === 0) return `modo ${modo}`
  return `modo aviso · ${casos === 1 ? '1 caso anotado' : `${casos} casos anotados`}`
}

/**
 * Sob o campo de texto: uma linha por especialista, na língua da barra de estado, e depois a linha do motor, como
 * ele a desenha. Sem time, só a do motor; e, no terminal em que a barra de estado já desenha o time, também.
 */
export async function desenharDica($: EngineInterface, e: DicaInput, next: (e: DicaInput) => Promise<RenderElement>, modo: string): Promise<RenderElement> {
  const time = vivos(await lerTime($))
  if (time.length === 0) return next(e)
  if (e.surface === 'terminal' && (await lerVitrine($)) === 'barra') return next(e)
  const { visiveis, resto } = escolher(linhasEquipe(time, await lerBarradas($), await lerPulso($)), LINHAS)
  const casos = (await lerAvisos($)).length
  const { Box, Text } = $.ui.resolve(e)
  const doMotor = await next(e)
  const larguraNome = Math.max(...visiveis.map(l => l.nome.length)) + 2
  const larguraMotor = Math.max(...visiveis.map(l => l.motor.length)) + 2
  const semRotulo = ' '.repeat(ROTULO.length)
  return (
    <Box flexDirection="column">
      {visiveis.map((l, i) => {
        const cor = COR[l.marca]
        return (
          <Text wrap="truncate-end">
            <Text bold>{i === 0 ? ROTULO : semRotulo}</Text>
            <Text dimColor>{FIO}</Text>
            {cor === undefined ? <Text dimColor>{`${GLIFO[l.marca]} `}</Text> : <Text color={cor}>{`${GLIFO[l.marca]} `}</Text>}
            {l.marca === 'rodando' ? <Text bold>{l.nome.padEnd(larguraNome)}</Text> : <Text>{l.nome.padEnd(larguraNome)}</Text>}
            <Text dimColor>{l.motor.padEnd(larguraMotor)}</Text>
            {l.marca === 'rodando' ? <Text>{l.estado}</Text> : <Text dimColor>{l.estado}</Text>}
            {l.alerta === undefined ? null : <Text color="warning">{` · ${l.alerta}`}</Text>}
            {i === 0 ? <Text dimColor>{`${FIO}${textoModo(modo, casos)}`}</Text> : null}
          </Text>
        )
      })}
      {resto > 0 ? <Text dimColor wrap="truncate-end">{`${semRotulo}${FIO}+ ${resto} no time · /equipe mostra todos`}</Text> : null}
      {doMotor}
    </Box>
  )
}

// ---------------------------------------------------------------------------------- a barra de estado

/** Por quanto tempo vale o sinal de que a barra de estado está de pé neste PC (ela o renova a cada minuto). */
const BARRA_VALE_MS = 3 * 60_000

/** O que a barra lê: se é ela quem desenha, as linhas já escolhidas, o trecho do modo e quantos não couberam. */
export type TelaPublicada = { v: 1; naBarra: boolean; modo: string; linhas: LinhaEquipe[]; resto: number }

// O modo vem das opções do mod, que só register.tsx lê; ele o entrega aqui a cada carga.
let modoDaTela = 'aviso'

export function configurarTela(modo: string): void {
  modoDaTela = modo
}

// O último texto gravado nesta carga do módulo: a mesma tela não é gravada duas vezes.
let publicado: string | undefined

/**
 * Publica o time para a barra de estado em sessoes/<sessão>/tela.json e decide quem desenha. A barra deixa o sinal
 * barra.json na pasta do mod a cada vez que roda; sinal fresco quer dizer que ela está de pé e desenha o time.
 * Sessão que nunca teve time não cria arquivo.
 */
async function publicar($: EngineInterface, agora: number): Promise<void> {
  const todos = await lerTime($)
  const dados = dadosDe(await configDe($))
  const caminho = `${dados}/sessoes/${await $.session.id()}/tela.json`
  if (todos.length === 0) {
    // Uma vez por carga: a tela que ficou de uma sessão retomada sem o time é esvaziada.
    if (publicado !== undefined) return
    publicado = ''
    const vazia: TelaPublicada = { v: 1, naBarra: false, modo: '', linhas: [], resto: 0 }
    if (await $.fs.exists(caminho).catch(() => false)) await $.fs.write(caminho, JSON.stringify(vazia))
    return
  }
  let naBarra = false
  try {
    const sinal = JSON.parse(String(await $.fs.read(`${dados}/barra.json`))) as { em?: unknown }
    naBarra = typeof sinal.em === 'number' && agora - sinal.em < BARRA_VALE_MS
  } catch {
    naBarra = false
  }
  await gravarVitrine($, naBarra ? 'barra' : 'campo')
  const { visiveis, resto } = escolher(linhasEquipe(todos, await lerBarradas($), await lerPulso($)), LINHAS)
  const tela: TelaPublicada = { v: 1, naBarra, modo: textoModo(modoDaTela, (await lerAvisos($)).length), linhas: visiveis, resto }
  const texto = JSON.stringify(tela)
  if (texto === publicado) return
  await $.fs.write(caminho, texto)
  publicado = texto
}

// ------------------------------------------------------------------------------------------- o pulso

/** Um tique: anota o começo e o fim da rodada de cada um, avisa o fim e devolve quantos rodam. */
async function umPulso($: EngineInterface): Promise<number> {
  const time = await lerTime($)
  const antes = await lerPulso($)
  const medidas = await lerMedidas($)
  const agora = await $.clock.now()
  const inicio: Record<string, number> = {}
  const fim: Record<string, number> = {}
  let mudou = false
  let rodam = 0
  for (const x of time) {
    const i = antes.inicio[x.nome]
    const f = antes.fim[x.nome]
    if (rodaAgora(x)) {
      rodam += 1
      if (i === undefined || f !== undefined || (x.iniciouEm !== undefined && x.iniciouEm !== i)) {
        // rodada nova: vale a hora que o nascimento gravou. Sem ela (especialista montado antes de o campo
        // existir, ou uma recarga do mod no meio), a da primeira resposta de quem roda, que a medição guardou.
        const nascidos = f === undefined ? medidas.filter(m => x.emExecucao.includes(m.agentId)).map(m => m.em) : []
        inicio[x.nome] = x.iniciouEm ?? (nascidos.length ? Math.min(...nascidos) : agora)
        mudou = true
      } else {
        inicio[x.nome] = i
        // o minuto que o dono lê virou: a tela é desenhada de novo
        if (Math.floor((agora - i) / 60000) !== Math.floor((antes.agora - i) / 60000)) mudou = true
      }
    } else if (i !== undefined) {
      inicio[x.nome] = i
      if (f === undefined) {
        fim[x.nome] = agora
        mudou = true
        // o Codex por roteiro avisa o próprio fim (codex.ts); aqui, os ajudantes do Claude e o Codex nativo
        if (x.motor === 'claude' || x.nativo === true) $.ui.toast(`Equipe: ${x.nome} terminou em ${duracao(agora - i)}`)
      } else {
        fim[x.nome] = f
      }
    }
  }
  if (mudou || Object.keys(inicio).length !== Object.keys(antes.inicio).length) await gravarPulso($, { agora, inicio, fim })
  // a barra de estado lê o que o pulso acabou de anotar; a publicação que falha não muda o pulso
  await publicar($, agora).catch(() => undefined)
  return rodam
}

// Um pulso de cada vez: o tique e o fim de um turno podem chegar juntos, e o fim se avisa uma vez só.
let fila: Promise<unknown> = Promise.resolve()

export function pulsar($: EngineInterface): Promise<number> {
  const vez = fila.then(() => umPulso($))
  fila = vez.catch(() => undefined)
  return vez
}

// O relógio é um só por carga do módulo; uma recarga o cancela, e session.start o liga de novo.
let relogio: Timer | undefined
let tiques = 0

/**
 * Confere agora e liga o relógio da tela, se ainda não está ligado. Ele se desliga quando ninguém roda, depois
 * de pelo menos dois tiques: o segundo já encontra o sinal que a barra de estado deixa ao abrir a sessão.
 */
export function ligarPulso($: EngineInterface): void {
  void pulsar($).catch(() => undefined)
  if (relogio !== undefined) return
  tiques = 0
  relogio = $.clock.every(PULSO_MS, () => {
    tiques += 1
    void pulsar($)
      .then(rodam => {
        if (rodam === 0 && tiques >= 2 && relogio !== undefined) {
          relogio.cancel()
          relogio = undefined
        }
      })
      .catch(() => undefined)
  })
}
