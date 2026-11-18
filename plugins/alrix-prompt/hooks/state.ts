// Todo acesso ao `$.state` do mod fica aqui: a engine só aceita `read` e `update` sobre um `atom` do mesmo arquivo.
// Toda sessão começa em Normal: o modo vive no `$.state` da sessão e nada vai para o `$.store`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AlrixPromptBusy, AlrixPromptExpert, AlrixPromptLast, AlrixPromptMode, AlrixPromptPending } from '../types'
import { EXPERT_NAME, LONG_MESSAGE_CHARS, MODE_LABEL } from './core'
import { logUse } from './usage'

export const MODES: readonly AlrixPromptMode[] = ['normal', 'organizar', 'engenharia']
export const LABEL = MODE_LABEL
export const DOING: Record<AlrixPromptExpert, string> = { organizar: 'organizando', engenharia: 'reestruturando' }

/** O que passa a acontecer com as mensagens, para o aviso de quando o modo muda. */
const EXPLAINED: Record<AlrixPromptMode, string> = {
  normal: 'vai como você digita.',
  organizar: `o ${EXPERT_NAME} arruma a escrita antes de enviar, sem mudar o que você pediu.`,
  engenharia: `o ${EXPERT_NAME} reestrutura o pedido e devolve na caixa para você revisar.`,
}
/** Na sessão, o Engenharia só para as mensagens longas: parar toda mensagem curta para revisão cansa e não ajuda. */
const SESSION_EXPLAINED: Record<AlrixPromptMode, string> = {
  ...EXPLAINED,
  engenharia: `o ${EXPERT_NAME} reestrutura as mensagens longas (${LONG_MESSAGE_CHARS} caracteres ou mais) e devolve na caixa para você revisar; as curtas vão como você digita.`,
}

const mode = atom({ plugin: 'alrix-prompt', key: 'mode' } as const, 'normal' as AlrixPromptMode)
const once = atom({ plugin: 'alrix-prompt', key: 'once' } as const, null as AlrixPromptMode | null, { shape: 'v3' })
/** Quando a sessão começou (ou o mod recarregou), para não tocar no prompt que a sessão já recebe ao abrir. */
const startedAt = atom({ plugin: 'alrix-prompt', key: 'startedAt' } as const, 0)
const busy = atom({ plugin: 'alrix-prompt', key: 'busy' } as const, null as AlrixPromptBusy | null, { shape: 'v3' })
const pending = atom({ plugin: 'alrix-prompt', key: 'pending' } as const, null as AlrixPromptPending | null, { shape: 'v3' })
const last = atom({ plugin: 'alrix-prompt', key: 'last' } as const, null as AlrixPromptLast | null, { shape: 'v3' })

export const isMode = (value: unknown): value is AlrixPromptMode => MODES.some(one => one === value)

/** O modo que a próxima mensagem vai usar, e se ele vale só para ela. */
export type NextMode = { mode: AlrixPromptMode; isOnce: boolean }

export async function readNext($: EngineInterface): Promise<NextMode> {
  const armed = await read($, once)
  return armed === null ? { mode: await read($, mode), isOnce: false } : { mode: armed, isOnce: true }
}

/** O modo da sessão: por `/modo`, que também desarma o da próxima mensagem. */
export async function chooseMode($: EngineInterface, value: AlrixPromptMode): Promise<void> {
  await update($, mode, () => value)
  await update($, once, () => null)
  $.ui.toast(value === 'normal' ? 'Modo Normal: a mensagem vai como você digita.' : `Modo ${LABEL[value]} nesta sessão: ${SESSION_EXPLAINED[value]}`)
}

/**
 * Só a próxima mensagem: `/organizar`, `/engenharia`, ou o primeiro toque na faixa. Com a sessão já em Engenharia,
 * `/engenharia` faz a próxima passar pela revisão mesmo sendo curta.
 */
export async function armOnce($: EngineInterface, value: AlrixPromptMode): Promise<void> {
  const session = await read($, mode)
  if (value === session && value === 'engenharia') {
    await update($, once, () => value)
    $.ui.toast('Engenharia na próxima mensagem, mesmo curta; depois volta a valer só nas longas.')
    return
  }
  await update($, once, () => (value === session ? null : value))
  if (value === session) {
    $.ui.toast(`A sessão já está em ${LABEL[value]}.`)
    return
  }
  $.ui.toast(
    value === 'normal'
      ? 'A próxima mensagem vai como você digitar; depois volta o modo da sessão.'
      : `${LABEL[value]} só na próxima mensagem: ${EXPLAINED[value]}`,
  )
}

/**
 * Um toque na faixa num modo: o primeiro vale só para a próxima mensagem, o segundo mantém o modo na sessão, o
 * terceiro volta ao Normal. Tocar no modo da sessão com um outro armado só desarma o outro.
 */
export async function pressMode($: EngineInterface, value: AlrixPromptMode): Promise<void> {
  const session = await read($, mode)
  const armed = await read($, once)
  if (armed === value) return chooseMode($, value)
  if (armed === null && session === value) return value === 'normal' ? undefined : chooseMode($, 'normal')
  if (armed !== null && session === value) {
    await update($, once, () => null)
    return
  }
  return armOnce($, value)
}

/** A mensagem que usava o modo da próxima já foi tratada: ele se desarma. */
export async function disarm($: EngineInterface): Promise<void> {
  await update($, once, () => null)
}

/** Recomeço da conversa (/clear): volta tudo ao Normal, como numa sessão nova. */
export async function resetSession($: EngineInterface): Promise<void> {
  await update($, mode, () => 'normal' as AlrixPromptMode)
  await update($, once, () => null)
  await update($, pending, () => null)
  await update($, last, () => null)
}

/**
 * Começo de sessão, ou recarga do mod: anota a hora. A espera de uma reescrita que a recarga interrompeu não fica
 * marcada, para não segurar as próximas mensagens.
 */
export async function startSession($: EngineInterface): Promise<void> {
  await update($, busy, () => null)
  await noteStart($, await $.clock.now())
}

export async function noteStart($: EngineInterface, now: number): Promise<void> {
  await update($, startedAt, () => now)
}

export async function readStartedAt($: EngineInterface): Promise<number> {
  return read($, startedAt)
}

export async function setBusy($: EngineInterface, value: AlrixPromptBusy | null): Promise<void> {
  await update($, busy, () => value)
}

export async function isBusy($: EngineInterface): Promise<boolean> {
  return (await read($, busy)) !== null
}

/** Mais um segundo de espera na faixa, se o especialista ainda está trabalhando. */
export async function tickBusy($: EngineInterface): Promise<void> {
  await update($, busy, current => (current === null ? null : { ...current, seconds: current.seconds + 1 }))
}

export async function holdPending($: EngineInterface, value: AlrixPromptPending | null): Promise<void> {
  await update($, pending, () => value)
}

export async function readPending($: EngineInterface): Promise<AlrixPromptPending | null> {
  return read($, pending)
}

/** Muda a reescrita que espera na caixa, se ainda há uma. */
export async function changePending($: EngineInterface, change: (held: AlrixPromptPending) => AlrixPromptPending): Promise<void> {
  await update($, pending, held => (held === null ? null : change(held)))
}

/** Devolve a reescrita que esperava na caixa e a tira de lá: ela vale só para a próxima mensagem. */
export async function takePending($: EngineInterface): Promise<AlrixPromptPending | null> {
  const held = await read($, pending)
  if (held !== null) await update($, pending, () => null)
  return held
}

/** O que aconteceu com a mensagem: para a faixa e o painel, e uma linha no registro de uso (sem o texto). */
export async function recordLast($: EngineInterface, value: AlrixPromptLast): Promise<void> {
  await update($, last, () => value)
  await logUse($, value)
}

export async function readLast($: EngineInterface): Promise<AlrixPromptLast | null> {
  return read($, last)
}

export type BandView = {
  session: AlrixPromptMode
  armed: AlrixPromptMode | null
  working: AlrixPromptBusy | null
  held: AlrixPromptPending | null
  done: AlrixPromptLast | null
}

/** O que a faixa desenha; lido durante o desenho, redesenha a faixa quando muda. */
export async function readBand($: EngineInterface): Promise<BandView> {
  return {
    session: await read($, mode),
    armed: await read($, once),
    working: await read($, busy),
    held: await read($, pending),
    done: await read($, last),
  }
}
