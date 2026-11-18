// O estado da sessão em $.state: o time, a liberação, as escritas barradas, os avisos do modo "aviso", as
// medidas de contexto, a leitura do Codex, a memória livre e a fila de lições. Os átomos ficam só aqui; o
// resto do mod lê e escreve pelas funções deste arquivo (declarações de função: o motor só segue o `$`
// para outro arquivo por elas).
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type {
  EquipeAviso,
  EquipeBarrada,
  EquipeCodex,
  EquipeEspecialista,
  EquipeLicaoProposta,
  EquipeMedida,
  EquipeMemoria,
  EquipePulso,
} from '../types'

/** Quantos registros cada lista guarda, para o estado não crescer sem fim. */
const GUARDA = 200

const time = atom({ plugin: 'alrix-equipe', key: 'time' } as const, [] as EquipeEspecialista[], { shape: 'time-1' })
const liberacao = atom({ plugin: 'alrix-equipe', key: 'liberacao' } as const, 'nenhuma')
const barradas = atom({ plugin: 'alrix-equipe', key: 'barradas' } as const, [] as EquipeBarrada[], { shape: 'barradas-1' })
const avisos = atom({ plugin: 'alrix-equipe', key: 'avisos' } as const, [] as EquipeAviso[], { shape: 'avisos-1' })
const medidas = atom({ plugin: 'alrix-equipe', key: 'medidas' } as const, [] as EquipeMedida[], { shape: 'medidas-1' })
const codex = atom({ plugin: 'alrix-equipe', key: 'codex' } as const, { leitura: null, lidoEm: 0, fora: null } as EquipeCodex, { shape: 'codex-1' })
const memoria = atom({ plugin: 'alrix-equipe', key: 'memoria' } as const, { gb: null, lidoEm: 0 } as EquipeMemoria, { shape: 'memoria-1' })
const fila = atom({ plugin: 'alrix-equipe', key: 'fila' } as const, [] as EquipeLicaoProposta[], { shape: 'fila-1' })
const pulso = atom({ plugin: 'alrix-equipe', key: 'pulso' } as const, { agora: 0, inicio: {}, fim: {} } as EquipePulso, { shape: 'pulso-1' })

// ---------------------------------------------------------------------------------------------- time

export async function lerTime($: EngineInterface): Promise<EquipeEspecialista[]> {
  return read($, time)
}

export async function mudarTime($: EngineInterface, fn: (atual: EquipeEspecialista[]) => EquipeEspecialista[]): Promise<void> {
  await update($, time, fn)
  await guardarTime($)
}

/** Troca um especialista pelo nome; nada acontece quando ele não está no time. */
export async function mudarEspecialista($: EngineInterface, nome: string, fn: (atual: EquipeEspecialista) => EquipeEspecialista): Promise<void> {
  await update($, time, lista => lista.map(x => (x.nome === nome ? fn(x) : x)))
  await guardarTime($)
}

// ---------------------------------------------------------------------------- o time que sobrevive

// O $.state vale enquanto a sessão roda e some quando ela fecha. A cada mudança o time vai também para o
// $.store do mod (um arquivo do mod na configuração do Claude Code), sob o id da sessão, e volta quando a
// mesma sessão é retomada. Guarda os times das últimas 10 sessões: o $.store inteiro cabe em 4 MiB, e cada
// especialista leva a ficha (até 24 000 caracteres).
const GUARDA_SESSOES = 10
const chaveTime = (sessao: string): string => `time:${sessao}`

/** A sessão dona do time que está no estado; vazio antes da primeira conferência. */
const sessaoDoTime = atom({ plugin: 'alrix-equipe', key: 'sessaoDoTime' } as const, '')
/** Especialistas de outra sessão deste processo que ainda rodavam quando a sessão trocou. */
const vigiados = atom({ plugin: 'alrix-equipe', key: 'vigiados' } as const, [] as EquipeEspecialista[], { shape: 'time-1' })

async function guardarTime($: EngineInterface): Promise<void> {
  try {
    // A chave é a da sessão dona do time, não a da conversa de agora: depois de um /resume no mesmo processo,
    // o time velho não cai sobre o guardado da sessão retomada.
    const sessao = (await read($, sessaoDoTime)) || (await $.session.id())
    await guardarSob($, sessao, await read($, time))
  } catch {
    /* a cópia que falha não muda o time da sessão */
  }
}

/**
 * Grava um time sob a sessão dele e põe a sessão no fim da ordem. A ordem se refaz com as chaves que o $.store
 * tem: uma sessão que outra gravação ao mesmo tempo tirou da lista volta (como a mais velha) na gravação seguinte,
 * e a poda das mais velhas vale para ela também.
 */
async function guardarSob($: EngineInterface, sessao: string, lista: readonly EquipeEspecialista[]): Promise<void> {
  // Sessão sem time nenhum guardado não ocupa uma das 10 vagas.
  if (lista.length === 0 && (await $.store.get(chaveTime(sessao))) === undefined) return
  await $.store.set(chaveTime(sessao), lista)
  const ordem = await $.store.get('sessoes')
  const naLista = Array.isArray(ordem) ? ordem.filter((s): s is string => typeof s === 'string') : []
  const chaves = (await $.store.keys()).filter(k => k.startsWith('time:')).map(k => k.slice('time:'.length))
  const soltas = chaves.filter(s => s !== sessao && !naLista.includes(s))
  const nova = [...soltas, ...naLista.filter(s => s !== sessao && chaves.includes(s)), sessao]
  const podadas = nova.slice(0, -GUARDA_SESSOES)
  // O time podado vai para o índice antes de sair: o especialista dele, retomado pelo id, volta com o território.
  const daPoda: EntradaDoIndice[] = []
  for (const velha of podadas) {
    const time = await $.store.get(chaveTime(velha))
    if (Array.isArray(time)) for (const esp of time) if (ehEspecialista(esp)) daPoda.push({ sessao: velha, esp })
  }
  await indexar($, [...daPoda, ...lista.map(esp => ({ sessao, esp }))])
  for (const velha of podadas) await $.store.delete(chaveTime(velha))
  await $.store.set('sessoes', nova.slice(-GUARDA_SESSOES))
}

// ------------------------------------------------------------------- o índice de quem já foi do time

// Cada especialista que teve id, de qualquer sessão, com o que os porteiros precisam (território, "não toque", modelo,
// esforço), sem o texto da ficha. Não é podado com o time: um /resume para uma sessão velha, ou um /branch, retoma o
// especialista pelo id, e ele volta com o território. Guarda os 100 mais novos: 10 sessões com o teto de 10 cabem, e
// cada entrada sem o texto fica perto de 1 KB (100 KB dos 4 MiB do $.store).
const GUARDA_INDICE = 100
const CHAVE_INDICE = 'indice'
export type EntradaDoIndice = { sessao: string; esp: EquipeEspecialista }

const ehEspecialista = (x: unknown): x is EquipeEspecialista =>
  typeof x === 'object' && x !== null && typeof (x as EquipeEspecialista).nome === 'string' && Array.isArray((x as EquipeEspecialista).agentIds)

async function lerIndice($: EngineInterface): Promise<EntradaDoIndice[]> {
  const guardado = await $.store.get(CHAVE_INDICE)
  if (!Array.isArray(guardado)) return []
  return guardado.filter((x): x is EntradaDoIndice => typeof x === 'object' && x !== null && typeof (x as EntradaDoIndice).sessao === 'string' && ehEspecialista((x as EntradaDoIndice).esp))
}

/** Põe (ou troca) no índice os especialistas com id; os mais novos ficam no fim. */
async function indexar($: EngineInterface, entradas: readonly EntradaDoIndice[]): Promise<void> {
  const comId = entradas.filter(x => x.esp.agentIds.length > 0)
  if (comId.length === 0) return
  const chave = (x: EntradaDoIndice): string => `${x.sessao}|${x.esp.nome}|${x.esp.criadoEm}`
  const novas = comId.map(x => {
    const { codex: _codex, ...resto } = x.esp
    return { sessao: x.sessao, esp: { ...resto, texto: '', emExecucao: [] } as EquipeEspecialista }
  })
  const atual = await lerIndice($)
  const depois = [...atual.filter(x => !novas.some(n => chave(n) === chave(x))), ...novas].slice(-GUARDA_INDICE)
  // a mesma lista não é regravada (cada mudança do time passa por aqui)
  if (JSON.stringify(depois) !== JSON.stringify(atual)) await $.store.set(CHAVE_INDICE, depois)
}

/** O especialista (de qualquer sessão guardada no índice) que teve este id; undefined quando ninguém teve. */
export async function procurarNoIndice($: EngineInterface, agentId: string): Promise<EntradaDoIndice | undefined> {
  try {
    return [...(await lerIndice($))].reverse().find(x => x.esp.agentIds.includes(agentId))
  } catch {
    return undefined
  }
}

/** Um especialista de fora do time de agora volta a rodar (retomado pelo id): fica vigiado, com o território dele. */
export async function vigiarRetomado($: EngineInterface, esp: EquipeEspecialista, agentId: string): Promise<void> {
  await update($, vigiados, lista => [
    ...lista.filter(v => !(v.nome === esp.nome && v.criadoEm === esp.criadoEm)),
    { ...esp, emExecucao: [...new Set([...esp.emExecucao, agentId])], agentIds: [...new Set([...esp.agentIds, agentId])] },
  ])
}

/**
 * Confere se a conversa ainda é a da sessão dona do time. Num /resume ou /clear no mesmo processo, o $.state
 * continua, mas a sessão é outra: o time velho vai para a chave da sessão dele, quem dele ainda roda segue
 * vigiado (território, recusas da casa e trava de espera) em `vigiados`, e o estado fica livre para o time da
 * sessão de agora, que restaurarTime traz. A liberação e as palavras do dono são da conversa: zeram.
 * Devolve true quando a sessão trocou.
 */
export async function alinharSessao($: EngineInterface): Promise<boolean> {
  const agora = await $.session.id()
  const dono = await read($, sessaoDoTime)
  if (dono === agora) return false
  if (dono === '') {
    await update($, sessaoDoTime, () => agora)
    return false
  }
  const velho = await read($, time)
  try {
    if (velho.length) await guardarSob($, dono, velho)
  } catch {
    /* sem a cópia, o time velho segue só no que já estava guardado */
  }
  const ainda = velho.filter(x => x.emExecucao.length > 0)
  await update($, vigiados, lista => [...lista.filter(v => !ainda.some(a => a.nome === v.nome && a.criadoEm === v.criadoEm)), ...ainda])
  await update($, time, () => [])
  await update($, liberacao, () => 'nenhuma')
  await update($, pedidosDono, () => [])
  await update($, sessaoDoTime, () => agora)
  return true
}

/** O $.store tem um time guardado para a sessão de agora? undefined quando a leitura falha. */
export async function haTimeGuardado($: EngineInterface): Promise<boolean | undefined> {
  try {
    const guardado = await $.store.get(chaveTime(await $.session.id()))
    return Array.isArray(guardado) && guardado.length > 0
  } catch {
    return undefined
  }
}

export async function lerVigiados($: EngineInterface): Promise<EquipeEspecialista[]> {
  const lista = await read($, vigiados)
  return Array.isArray(lista) ? lista : []
}

/** Um vigiado terminou a vez dele: sai dos que rodam; sem ninguém rodando, deixa de ser vigiado. */
export async function fimDeVigiado($: EngineInterface, agentId: string): Promise<void> {
  await update($, vigiados, lista => lista.map(v => ({ ...v, emExecucao: v.emExecucao.filter(id => id !== agentId) })).filter(v => v.emExecucao.length > 0))
}

// ------------------------------------------------------------------------------ quem roda (o teto)

const rodandoIds = atom({ plugin: 'alrix-equipe', key: 'rodandoIds' } as const, [] as string[])

/** Os ids de todo ajudante que começou e ainda não terminou a vez nesta sessão (do time, do chefe, de workflow). */
export async function lerRodandoIds($: EngineInterface): Promise<string[]> {
  const lista = await read($, rodandoIds)
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string') : []
}

export async function marcarRodando($: EngineInterface, agentId: string, rodandoAgora: boolean): Promise<void> {
  await update($, rodandoIds, lista => {
    const sem = (Array.isArray(lista) ? lista : []).filter(id => id !== agentId)
    return rodandoAgora ? [...sem, agentId] : sem
  })
}

/** Troca a lista inteira (a conferência com $.agent.list tira quem o motor já não roda). */
export async function gravarRodandoIds($: EngineInterface, ids: readonly string[]): Promise<void> {
  await update($, rodandoIds, () => [...ids])
}

/**
 * Sessão retomada: o $.state começa vazio, e o time guardado desta sessão volta. Quem rodava quando a sessão
 * fechou já não roda (o ajudante morre com o processo): volta como "terminou", com os ids, para que o chefe
 * o retome por mensagem e o mod o reconheça. Devolve os especialistas que voltaram; nenhum quando o $.state
 * já tem time (recarga do código) ou não há time guardado.
 */
export async function restaurarTime($: EngineInterface): Promise<EquipeEspecialista[]> {
  if ((await read($, time)).length > 0) return []
  let guardado: unknown
  let sessao: string
  try {
    sessao = await $.session.id()
    guardado = await $.store.get(chaveTime(sessao))
  } catch {
    return []
  }
  if (!Array.isArray(guardado)) return []
  const lista = guardado
    .filter((x): x is EquipeEspecialista => typeof x === 'object' && x !== null && typeof (x as EquipeEspecialista).nome === 'string' && Array.isArray((x as EquipeEspecialista).agentIds))
    .map(x => {
      if (!Array.isArray(x.emExecucao) || x.emExecucao.length === 0) return x
      const { terminouEm: _fim, ...resto } = x
      return { ...resto, emExecucao: [], estado: x.estado === 'dispensado' ? ('dispensado' as const) : ('terminou' as const) }
    })
  if (lista.length === 0) return []
  await update($, time, () => lista)
  await update($, sessaoDoTime, () => sessao)
  // A liberação é desta abertura, não volta com o time (num /resume dentro do processo, ela ainda estaria aqui).
  await update($, liberacao, () => 'nenhuma')
  return lista
}

// ------------------------------------------------------------------------------ palavras do dono

const pedidosDono = atom({ plugin: 'alrix-equipe', key: 'pedidosDono' } as const, [] as string[])

/** As últimas 30 mensagens que o dono escreveu nesta sessão, cada uma até 4000 caracteres. */
export async function lerPedidosDono($: EngineInterface): Promise<string[]> {
  const lista = await read($, pedidosDono)
  return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === 'string') : []
}

export async function guardarPedidoDono($: EngineInterface, texto: string): Promise<void> {
  await update($, pedidosDono, lista => [...(Array.isArray(lista) ? lista : []), texto.slice(0, 4000)].slice(-30))
}

// ------------------------------------------------------------------------------------------- acordar

const acordar = atom({ plugin: 'alrix-equipe', key: 'acordar' } as const, [] as string[])

/** `montar` registrou estes tipos: no fim do turno do chefe o mod manda o aviso que abre o turno seguinte. */
export async function pedirAcordar($: EngineInterface, tipos: readonly string[]): Promise<void> {
  await update($, acordar, lista => [...new Set([...(Array.isArray(lista) ? lista : []), ...tipos])])
}

/** Os tipos que esperam o aviso; a lista fica vazia depois de lida. */
export async function tomarAcordar($: EngineInterface): Promise<string[]> {
  const lista = await read($, acordar)
  if (!Array.isArray(lista) || lista.length === 0) return []
  await update($, acordar, () => [])
  return lista.filter((x): x is string => typeof x === 'string')
}

// ----------------------------------------------------------------------------------------- liberação

export async function lerLiberacao($: EngineInterface): Promise<'nenhuma' | 'sessao'> {
  return (await read($, liberacao)) === 'sessao' ? 'sessao' : 'nenhuma'
}

export async function liberarSessao($: EngineInterface): Promise<void> {
  await update($, liberacao, () => 'sessao')
}

// ------------------------------------------------------------------------------------------ barradas

export async function lerBarradas($: EngineInterface): Promise<EquipeBarrada[]> {
  return read($, barradas)
}

export async function registrarBarrada($: EngineInterface, b: EquipeBarrada): Promise<void> {
  await update($, barradas, lista => [...lista, b].slice(-GUARDA))
}

/** O chefe decidiu (ampliou ou dispensou): as barradas desse especialista deixam de estar pendentes. */
export async function resolverBarradas($: EngineInterface, especialista: string): Promise<void> {
  await update($, barradas, lista => lista.map(b => (b.especialista === especialista && b.pendente ? { ...b, pendente: false } : b)))
}

// -------------------------------------------------------------------------------------------- avisos

export async function lerAvisos($: EngineInterface): Promise<EquipeAviso[]> {
  return read($, avisos)
}

export async function registrarAviso($: EngineInterface, caso: string, em: number): Promise<void> {
  await update($, avisos, lista => [...lista, { em, caso, visto: false }].slice(-GUARDA))
}

export async function marcarAvisosVistos($: EngineInterface): Promise<void> {
  await update($, avisos, lista => lista.map(a => (a.visto ? a : { ...a, visto: true })))
}

// ------------------------------------------------------------------------------------------- medidas

export async function lerMedidas($: EngineInterface): Promise<EquipeMedida[]> {
  return read($, medidas)
}

export async function registrarMedida($: EngineInterface, m: EquipeMedida): Promise<void> {
  await update($, medidas, lista => [...lista, m].slice(-GUARDA))
}

// --------------------------------------------------------------------------------------------- codex

export async function lerCodex($: EngineInterface): Promise<EquipeCodex> {
  return read($, codex)
}

export async function gravarCodex($: EngineInterface, fn: (atual: EquipeCodex) => EquipeCodex): Promise<void> {
  await update($, codex, fn)
}

// ------------------------------------------------------------------------------------------- memória

export async function lerMemoria($: EngineInterface): Promise<EquipeMemoria> {
  return read($, memoria)
}

export async function gravarMemoria($: EngineInterface, valor: EquipeMemoria): Promise<void> {
  await update($, memoria, () => valor)
}

// ---------------------------------------------------------------------------------------------- fila

export async function lerFila($: EngineInterface): Promise<EquipeLicaoProposta[]> {
  return read($, fila)
}

export async function gravarFila($: EngineInterface, valor: EquipeLicaoProposta[]): Promise<void> {
  await update($, fila, () => valor)
}

// --------------------------------------------------------------------------------------------- pulso

export async function lerPulso($: EngineInterface): Promise<EquipePulso> {
  return read($, pulso)
}

export async function gravarPulso($: EngineInterface, valor: EquipePulso): Promise<void> {
  await update($, pulso, () => valor)
}

// ------------------------------------------------------------------------------------------- vitrine

const vitrine = atom({ plugin: 'alrix-equipe', key: 'vitrine' } as const, 'campo')

/** Quem desenha o time agora: uma barra de estado que leia o time ("barra") ou o próprio mod, sob o campo de texto ("campo"). */
export async function lerVitrine($: EngineInterface): Promise<'barra' | 'campo'> {
  return (await read($, vitrine)) === 'barra' ? 'barra' : 'campo'
}

/** Só escreve quando muda: cada escrita redesenha quem lê. */
export async function gravarVitrine($: EngineInterface, valor: 'barra' | 'campo'): Promise<void> {
  if ((await lerVitrine($)) !== valor) await update($, vitrine, () => valor)
}
