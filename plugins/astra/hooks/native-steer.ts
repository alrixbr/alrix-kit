import type { EngineInterface, PromptSubmitInput, PromptSubmitResult } from 'claude-code'
import { accepted, bridgeCall, liveBridge } from './bridge-client'

/**
 * O recado digitado com o turno do Codex em curso vai a ele na hora, por `turn/steer`, sem esperar a fronteira de uma
 * ferramenta do Claude Code: o Codex que roda um comando no shell dele não passa por nenhuma, e o recado digitado só
 * entrava quando o turno acabava (medido em 25/10). O steer vai amarrado ao turno do Codex que rodava, e o recado aceito
 * fica anotado no loop: quando o Claude Code o entrega depois (na fronteira, ou como turno novo), ele não vai de novo.
 *
 * O recado a um subagente não tem esse caminho: o Claude Code só o passa ao `session.receive` dentro do turno dele, na
 * rodada de ferramentas, junto com a entrega (assim diz o tipo do `session.receive`, e a sonda de 25/10 mediu).
 */

/** O turno do Codex em curso num loop, com o turno do Claude Code que o abriu. */
export type Live = { turnId: string; codexTurnId: string }

/**
 * Um recado que foi ao Codex por steer: o texto como o Claude Code o entrega, a ponte que o recebeu (`epoch`) e se ela o
 * aceitou. Se a ponte reiniciou, o turno que o recebeu morreu com ela, e a anotação não vale mais.
 */
type Steered = { text: string; epoch: string; isTaken: Promise<boolean> }

const MAX_STEERED = 20
/**
 * Quanto se espera a ponte dizer se o Codex aceitou o recado. O recado já está na fila (o `next(e)` o põe lá, medido em
 * 25/10), e a entrega dele na fronteira de uma ferramenta espera essa resposta, segurando a rodada. Passado o prazo, vale
 * como recusa, e o recado segue o caminho normal (se a ponte o aceitar depois, o Codex o recebe duas vezes).
 */
const STEER_WAIT_MS = 5_000
/** As origens do `prompt.submit` que são a pessoa digitando: no terminal ou pelo Remote Control. */
const TYPED = new Set(['composer', 'bridge'])

const lives = new Map<string, Live>()
const steered = new Map<string, readonly Steered[]>()

export const markLive = (key: string, live: Live): void => {
  lives.set(key, live)
}
export const clearLive = (key: string): void => {
  lives.delete(key)
}

/** O turno do Codex não terminou bem (Esc, falha, ponte que caiu): o recado anotado segue o caminho normal. */
export const forgetSteered = (key: string): void => {
  steered.delete(key)
}

/** O `/clear`: o loop principal da sessão que acabou não tem turno nem recado. */
export function forgetLive(key: string): void {
  lives.delete(key)
  steered.delete(key)
}

function store(key: string, notes: readonly Steered[]): void {
  if (notes.length === 0) steered.delete(key)
  else steered.set(key, notes)
}

type Span = { start: number; end: number }

/** Onde `needle` aparece em `haystack` como bloco de linhas inteiras, com os espaços da borda; undefined se não aparece. */
function blockAt(haystack: string, needle: string): Span | undefined {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const start = at - (/[ \t]*$/.exec(haystack.slice(0, at))?.[0].length ?? 0)
    const after = at + needle.length
    const end = after + (/^[ \t]*/.exec(haystack.slice(after))?.[0].length ?? 0)
    if ((start === 0 || haystack[start - 1] === '\n') && (end === haystack.length || haystack[end] === '\n')) return { start, end }
  }
  return undefined
}

/** Tira a anotação do recado que `text` traz (a entrega do Claude Code o cerca com o aviso dele) e devolve-a. */
function takeOne(key: string, text: string): Steered | undefined {
  const epoch = liveBridge()?.epoch
  const notes = (steered.get(key) ?? []).filter(note => note.epoch === epoch)
  const found = notes.find(note => blockAt(text, note.text) !== undefined)
  store(key, notes.filter(note => note !== found))
  return found
}

/** A entrega que traz um recado que o Codex já aceitou por steer: true, e a anotação sai. */
export async function wasSteered(key: string, text: string): Promise<boolean> {
  const found = takeOne(key, text)
  return found !== undefined && (await found.isTaken)
}

/**
 * O pedido de um turno novo sem os recados que o turno anterior do Codex já recebeu por steer: a fila do Claude Code
 * abre o turno com eles quando o anterior acaba sem passar por uma ferramenta.
 */
export async function withoutSteered(key: string, lead: string): Promise<string> {
  let rest = lead
  for (let found = takeOne(key, rest); found !== undefined; found = takeOne(key, rest)) {
    const at = blockAt(rest, found.text)
    if (at !== undefined && (await found.isTaken)) rest = `${rest.slice(0, at.start)}${rest.slice(at.end)}`.replace(/\n{3,}/g, '\n\n').trim()
  }
  return rest
}

/** O aceite do steer, com o prazo de `STEER_WAIT_MS`: a ponte que não responde vale como recusa. */
function steerTaken($: EngineInterface, call: Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = $.clock.after(STEER_WAIT_MS, () => resolve(false))
    void accepted(call)
      .catch(() => false)
      .then(isTaken => {
        timer.cancel()
        resolve(isTaken)
      })
  })
}

/**
 * Manda o recado ao turno do Codex que roda no loop, se é o turno em que ele chegou. A anotação entra antes da resposta:
 * a entrega que o Claude Code fizer enquanto ela corre espera a resposta da ponte para saber se vai ou não. Recusado, sai
 * a anotação deste recado, e não a de outro de mesmo texto que o Codex aceitou.
 */
async function steerNow($: EngineInterface, key: string, text: string, turnId: string): Promise<void> {
  const live = lives.get(key)
  const bridge = liveBridge()
  if (live === undefined || bridge === undefined || live.turnId !== turnId) return
  const framed = `A pessoa mandou um recado enquanto você trabalhava:\n${text}`
  const note: Steered = { text, epoch: bridge.epoch, isTaken: steerTaken($, bridgeCall($, bridge, '/steer', { key, text: framed, turnId: live.codexTurnId })) }
  steered.set(key, [...(steered.get(key) ?? []), note].slice(-MAX_STEERED))
  if (!(await note.isTaken)) store(key, (steered.get(key) ?? []).filter(other => other !== note))
}

/**
 * O recado digitado com o turno em curso: na hora, no turno do Codex do loop principal. O pedido digitado sem turno em
 * curso acha a fila vazia: a anotação que sobrou é de um recado que a pessoa tirou da fila (a seta para cima, medido em
 * 25/10), que o Claude Code não entrega mais, e ela cai antes de engolir um pedido novo de mesmo texto.
 */
export async function onSubmit($: EngineInterface, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>): Promise<PromptSubmitResult> {
  // A chave sai antes do `next`: entre a resposta dele e a anotação não há espera nenhuma.
  const key = `main:${await $.session.id()}`
  if (e.turnId === undefined && TYPED.has(e.origin.kind)) forgetSteered(key)
  const entered = await next(e)
  const isTyped = !e.wait && e.command === undefined && (e.attachments ?? []).length === 0 && TYPED.has(e.origin.kind)
  if (entered.drop !== undefined || e.turnId === undefined || !isTyped || entered.text.trim() === '') return entered
  await steerNow($, key, entered.text.trim(), e.turnId)
  return entered
}
