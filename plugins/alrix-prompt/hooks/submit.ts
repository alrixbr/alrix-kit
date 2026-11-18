// O caminho de uma mensagem do dono: Normal passa direto; Organizar manda o texto arrumado; Engenharia devolve a versão
// reestruturada na caixa para ele revisar, e a original vai junto, invisível, como âncora. Qualquer falha manda a
// mensagem como ele digitou; Esc (ou "cancelar" na faixa) enquanto o especialista trabalha não manda nada.
import type { EngineInterface, PromptSubmitInput, PromptSubmitResult } from 'claude-code'

import type { AlrixPromptExpert, AlrixPromptLast, AlrixPromptPending } from '../types'
import { anchorOf, EXPERT_NAME, keptShare, LONG_MESSAGE_CHARS, ownLength, shouldRefine, wordsOf } from './core'
import { rewrite } from './rewrite'
import {
  disarm,
  holdPending,
  isBusy,
  noteStart,
  readNext,
  readPending,
  readStartedAt,
  recordLast,
  setBusy,
  takePending,
  tickBusy,
} from './state'

type Next = ((e: PromptSubmitInput) => Promise<PromptSubmitResult>) & { readonly signal?: AbortSignal }

/**
 * O prompt que chega até aqui logo depois de a sessão abrir é o do argumento do CLI (`claude "pedido"`), não o dono
 * digitando: passa como veio, para nunca ficar preso na caixa de uma sessão sem ninguém.
 */
const OPENING_MS = 5_000
/** Quanto das palavras do texto mandado precisa vir do que estava na caixa para valer como a revisão dela. */
const REVIEW_SHARE = 0.5
/** Os comandos que, com um texto depois, tratam só aquele texto: `/engenharia arruma o login`. */
const ONE_SHOT: Readonly<Record<string, AlrixPromptExpert>> = { organizar: 'organizar', engenharia: 'engenharia' }

const WAIT_DROP = `alrix-prompt · o ${EXPERT_NAME} ainda trabalha na sua mensagem anterior. Esta voltou para a caixa: aperte Enter de novo quando ele terminar.`
const BOX_DROP: Record<AlrixPromptExpert, string> = {
  organizar: 'alrix-prompt · a versão organizada está na caixa. Confira e aperte Enter.',
  engenharia: 'alrix-prompt · a versão reestruturada está na caixa. Revise e aperte Enter.',
}
const CANCEL_DROP = 'alrix-prompt · cancelado: nada foi enviado, e a sua mensagem voltou para a caixa.'
const BUSY_BOX_TOAST = 'Engenharia: você já escrevia outra mensagem, então a versão reestruturada foi direto, com a sua original junto.'
const MEDIA_TOAST = 'Engenharia: a mensagem tem imagem, então a versão reestruturada foi direto, com a imagem e a sua original junto.'

/** A reescrita em curso, para a faixa poder cancelar. Some numa recarga do mod, como a própria chamada. */
let inflight: AbortController | undefined

/** "cancelar" na faixa: para o especialista; a mensagem volta para a caixa e nada é enviado. */
export function cancelInflight(): boolean {
  if (inflight === undefined || inflight.signal.aborted) return false
  inflight.abort()
  return true
}

/** Só o que o dono digita: no terminal ou pelo Remote Control. Comando, modo bash e mensagem de agente passam direto. */
const isOwnerTyped = (e: PromptSubmitInput): boolean =>
  e.command === undefined &&
  e.isMeta !== true &&
  (e.origin.kind === 'composer' || e.origin.kind === 'bridge') &&
  !e.text.trimStart().startsWith('!')

const withAnchor = (e: PromptSubmitInput, original: string, isReviewed: boolean): PromptSubmitInput => ({
  ...e,
  context: [...(e.context ?? []), anchorOf(original, isReviewed)],
})

/**
 * Se o texto mandado saiu do que o mod deixou na caixa (a reescrita, ou a original escolhida), mesmo cortado ou com
 * frases a mais. A conta é sobre as palavras do texto mandado: um pedido novo, digitado no lugar, não passa.
 */
function reviewOf(text: string, held: AlrixPromptPending): 'revisada' | 'original' | undefined {
  // "ok" ou "1" não têm palavra para comparar: não são a revisão de nada.
  if (wordsOf(text).size === 0) return undefined
  if (held.choice === 'reescrita') return keptShare(text, held.rewritten) >= REVIEW_SHARE ? 'revisada' : undefined
  return keptShare(text, held.original) >= REVIEW_SHARE ? 'original' : undefined
}

/** O envio da caixa revisada: o Engenharia vai com a âncora; o Organizar e a original vão como estão. */
async function sendReviewed($: EngineInterface, e: PromptSubmitInput, held: AlrixPromptPending, review: 'revisada' | 'original', next: Next) {
  const done = { mode: held.mode, ms: 0, tokensIn: 0, tokensOut: 0, original: held.original }
  if (review === 'original') {
    await recordLast($, { ...done, outcome: 'original' })
    return next(e)
  }
  await recordLast($, { ...done, outcome: 'revisada', rewritten: e.text })
  return next(held.mode === 'engenharia' ? withAnchor(e, held.original, true) : e)
}

/**
 * Chama o especialista com a faixa contando os segundos; a faixa volta ao normal quando ele termina, falha ou para.
 * Só a faixa avisa: uma linha de status a mais dizia a mesma coisa e empurrava a tela a cada mensagem.
 */
async function timedRewrite($: EngineInterface, expert: AlrixPromptExpert, text: string, signal: AbortSignal | undefined) {
  const own = new AbortController()
  inflight = own
  const unlink = (): void => own.abort()
  signal?.addEventListener('abort', unlink, { once: true })
  await setBusy($, { mode: expert, seconds: 0 })
  const ticker = $.clock.every(1_000, () => void tickBusy($))
  try {
    return await rewrite($, expert, text, own.signal)
  } finally {
    ticker.cancel()
    signal?.removeEventListener('abort', unlink)
    if (inflight === own) inflight = undefined
    await setBusy($, null)
  }
}

/**
 * Põe a reescrita na caixa para a revisão, só se a caixa está vazia: um rascunho que o dono começou durante a espera
 * fica intacto. A reescrita fica guardada antes de entrar na caixa, e sai de lá se a caixa não a aceitar.
 */
async function parkInBox($: EngineInterface, held: AlrixPromptPending): Promise<boolean> {
  const box = await $.prompt.read()
  if (box.text.trim() !== '') return false
  await holdPending($, held)
  try {
    const filled = await $.prompt.fill({ text: held.rewritten })
    if (!filled.isFilled) await holdPending($, null)
    return filled.isFilled
  } catch (error) {
    await holdPending($, null)
    throw error
  }
}

type Cost = Pick<AlrixPromptLast, 'mode' | 'ms' | 'tokensIn' | 'tokensOut' | 'original'>

/** A reescrita não serve: vai a mensagem como o dono digitou, com o motivo no aviso e na faixa. */
async function discard($: EngineInterface, e: PromptSubmitInput, cost: Cost, note: string, next: Next) {
  $.ui.toast(`Reescrita descartada (${note}): foi a sua mensagem original.`, { timeoutMs: 8_000 })
  await recordLast($, { ...cost, outcome: 'descartada', note })
  return next(e)
}

const costOf = (expert: AlrixPromptExpert, text: string, result: { ms: number; tokensIn: number; tokensOut: number }): Cost => ({
  mode: expert,
  ms: result.ms,
  tokensIn: result.tokensIn,
  tokensOut: result.tokensOut,
  original: text,
})

/** Uma mensagem digitada: o Organizar manda direto; o Engenharia volta para a caixa, para a revisão. */
async function runRewrite($: EngineInterface, e: PromptSubmitInput, expert: AlrixPromptExpert, next: Next) {
  const result = await timedRewrite($, expert, e.text, next.signal)
  const cost = costOf(expert, e.text, result)
  if (!result.isOk && result.isCancelled) {
    await recordLast($, { ...cost, outcome: 'cancelada' })
    return { drop: CANCEL_DROP }
  }
  if (!result.isOk) return discard($, e, cost, result.note, next)
  // As lacunas ficam com o dono (na faixa e no painel): não entram no texto nem no contexto que vai para o agente.
  const gaps = result.gaps.length > 0 ? { gaps: result.gaps } : {}
  const done = { ...cost, rewritten: result.text, ...gaps }
  if (expert === 'organizar') {
    await recordLast($, { ...done, outcome: 'enviada' })
    return next({ ...e, text: result.text })
  }
  // Uma imagem anexada só segue a mensagem que entra: a caixa guarda texto, e a revisão a deixaria para trás.
  const hasMedia = (e.attachments?.length ?? 0) > 0
  if (hasMedia && e.origin.kind === 'composer') $.ui.toast(MEDIA_TOAST, { timeoutMs: 8_000 })
  if (e.origin.kind === 'composer' && !hasMedia) {
    // Anotada antes da caixa: depois que a reescrita está lá, nada pode falhar e mandar a original junto.
    await recordLast($, { ...done, outcome: 'na caixa' })
    const held: AlrixPromptPending = { mode: expert, original: e.text, rewritten: result.text, choice: 'reescrita', returned: e.text, isSettled: false, ...gaps }
    const isParked = await parkInBox($, held).catch(() => undefined)
    if (isParked === undefined) return discard($, e, cost, 'a caixa não respondeu', next)
    if (isParked) return { drop: BOX_DROP.engenharia }
    $.ui.toast(BUSY_BOX_TOAST, { timeoutMs: 8_000 })
  }
  await recordLast($, { ...done, outcome: 'enviada' })
  return next(withAnchor({ ...e, text: result.text }, e.text, false))
}

/**
 * `/organizar texto` e `/engenharia texto`: só aquele texto passa pelo especialista, e o resultado volta para a caixa
 * nos dois modos. Uma linha de comando não vira mensagem: daqui nada é enviado, tudo vai para a caixa. Se a reescrita
 * não serve, é o texto dele que volta para a caixa, sem o comando, pronto para ir como está.
 */
async function onOneShot($: EngineInterface, e: PromptSubmitInput, expert: AlrixPromptExpert, next: Next): Promise<PromptSubmitResult> {
  const text = e.command?.args.trim() ?? ''
  if (await isBusy($)) return { drop: WAIT_DROP }
  const result = await timedRewrite($, expert, text, next.signal)
  const cost = costOf(expert, text, result)
  if (!result.isOk && result.isCancelled) {
    await recordLast($, { ...cost, outcome: 'cancelada' })
    return { drop: CANCEL_DROP }
  }
  const isOk = result.isOk
  const rewritten = result.isOk ? result.text : text
  const gaps = result.isOk && result.gaps.length > 0 ? { gaps: result.gaps } : {}
  await recordLast($, isOk ? { ...cost, outcome: 'na caixa', rewritten, ...gaps } : { ...cost, outcome: 'descartada', note: result.note })
  const held: AlrixPromptPending = { mode: expert, original: text, rewritten, choice: isOk ? 'reescrita' : 'original', returned: e.text, isSettled: false, ...gaps }
  const isParked = await parkInBox($, held).catch(() => false)
  if (!isOk) return { drop: `alrix-prompt · reescrita descartada (${result.note}): a sua mensagem voltou para a caixa, sem o comando.` }
  if (isParked) return { drop: BOX_DROP[expert] }
  return { drop: 'alrix-prompt · você já escrevia outra mensagem: a versão nova não entrou na caixa. Ela está em "comparar" (v), na faixa.' }
}

export async function onSubmit($: EngineInterface, e: PromptSubmitInput, next: Next): Promise<PromptSubmitResult> {
  const oneShot = e.command === undefined ? undefined : ONE_SHOT[e.command.name]
  if (oneShot !== undefined && e.origin.kind === 'composer' && shouldRefine(oneShot, e.command?.args ?? '', true)) {
    return onOneShot($, e, oneShot, next)
  }
  if (!isOwnerTyped(e)) return next(e)
  const now = await $.clock.now()
  const started = await readStartedAt($)
  // Sem hora de início, o prompt chegou antes do `session.start` (o do argumento do CLI) ou o mod entrou com a sessão
  // aberta: passa como veio, e a hora fica anotada para as próximas.
  if (started === 0) await noteStart($, now)
  if (started === 0 || now - started < OPENING_MS) return next(e)
  // Uma mensagem nova durante a espera chegaria antes da anterior: volta para a caixa.
  if (await isBusy($)) return { drop: WAIT_DROP }
  const held = await takePending($)
  const review = held === null ? undefined : reviewOf(e.text, held)
  if (held !== null && review !== undefined) return sendReviewed($, e, held, review, next)
  const { mode, isOnce } = await readNext($)
  if (mode === 'normal') {
    if (isOnce) await disarm($)
    return next(e)
  }
  if (!shouldRefine(mode, e.text, isOnce)) return next(e)
  // Engenharia na sessão: só a mensagem longa para para a revisão; a curta vai como ele digitou.
  if (mode === 'engenharia' && !isOnce && ownLength(e.text) < LONG_MESSAGE_CHARS) return next(e)
  if (isOnce) await disarm($)
  return runRewrite($, e, mode, next)
}

/**
 * A engine devolve à caixa o texto de um envio descartado, depois da reescrita que o mod pôs ali: a caixa ficava com as
 * duas, a devolvida no fim. Quando a devolução chega, ela sai da caixa e fica o resto, uma vez por reescrita.
 */
export async function settleBox($: EngineInterface, boxText: string): Promise<void> {
  const held = await readPending($)
  if (held === null || held.isSettled) return
  const returned = held.returned.trim()
  const at = boxText.lastIndexOf(returned)
  if (returned === '' || at === -1) return
  await holdPending($, { ...held, isSettled: true })
  const rest = `${boxText.slice(0, at)}${boxText.slice(at + returned.length)}`.trim()
  await $.prompt.fill({ text: rest === '' ? held.rewritten : rest })
}
