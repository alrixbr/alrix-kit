import type { TurnStepChunk } from 'claude-code'
import { displayText } from './activity'

/**
 * Os eventos de um turno do Codex como a ponte os entrega no long-poll (`bridge/proto.mts`), conferidos aqui, na
 * fronteira, e a conversão deles nos chunks do passo. Cada troca entre texto e pensamento abre um bloco novo; as
 * ferramentas vêm depois, uma por bloco. O pensamento aparece ao vivo e não fica no transcript; o texto fica.
 */
export type ItemView = { type: string; command?: string; status?: string; exitCode?: number; paths?: readonly string[]; server?: string; tool?: string }

export type WireEvent =
  | { seq: number; kind: 'text' | 'thinking'; delta: string }
  | { seq: number; kind: 'item'; phase: 'started' | 'completed'; item: ItemView }
  | { seq: number; kind: 'toolCall'; callId: string; tool: string; args: unknown }
  | { seq: number; kind: 'error'; message: string; willRetry: boolean }
  | { seq: number; kind: 'done'; status: string; error?: string }

export type Batch = { events: readonly WireEvent[]; next: number }

export type ToolCall = { callId: string; tool: string; args: unknown }

export type Relay = {
  /** O bloco aberto, ou o próximo livre quando nenhum abriu. */
  index: number
  open?: 'text' | 'thinking'
  isLineStart: boolean
  answer: string
  /** A última linha de andamento, que o sinal de vida repete. */
  latest?: string
  calls: readonly ToolCall[]
  done?: { status: string; error?: string }
}

export const RELAY_START: Relay = { index: 0, isLineStart: true, answer: '', calls: [] }

type Fields = Readonly<Record<string, unknown>>
const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (fields: Fields, key: string): string | undefined => (typeof fields[key] === 'string' ? fields[key] : undefined)

function itemOf(value: unknown): ItemView | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  const paths = Array.isArray(value.paths) ? value.paths.filter((path): path is string => typeof path === 'string') : undefined
  const exitCode = typeof value.exitCode === 'number' ? value.exitCode : undefined
  return { type: value.type, command: text(value, 'command'), status: text(value, 'status'), exitCode, paths, server: text(value, 'server'), tool: text(value, 'tool') }
}

function eventOf(value: unknown): WireEvent | undefined {
  if (!isRecord(value) || typeof value.seq !== 'number') return undefined
  const { seq, kind } = value
  if ((kind === 'text' || kind === 'thinking') && typeof value.delta === 'string') return { seq, kind, delta: value.delta }
  if (kind === 'item' && (value.phase === 'started' || value.phase === 'completed')) {
    const item = itemOf(value.item)
    return item === undefined ? undefined : { seq, kind, phase: value.phase, item }
  }
  if (kind === 'toolCall' && typeof value.callId === 'string' && typeof value.tool === 'string') return { seq, kind, callId: value.callId, tool: value.tool, args: value.args }
  if (kind === 'error' && typeof value.message === 'string') return { seq, kind, message: value.message, willRetry: value.willRetry === true }
  if (kind === 'done' && typeof value.status === 'string') return { seq, kind, status: value.status, error: text(value, 'error') }
  return undefined
}

/** A resposta do `GET /events`; um evento de tipo que o mod não conhece (o de uso, na F1) fica de fora. */
export function parseBatch(value: unknown): Batch {
  if (!isRecord(value) || typeof value.next !== 'number' || !Array.isArray(value.events)) throw new Error('a ponte respondeu eventos num formato desconhecido')
  return { events: value.events.flatMap(event => eventOf(event) ?? []), next: value.next }
}

/** A linha de andamento de um item, no formato do relatório de hoje; sem linha para o que não diz nada a quem lê. */
export function itemLine(phase: 'started' | 'completed', item: ItemView): string | undefined {
  const status = item.status ?? (phase === 'started' ? 'in_progress' : 'completed')
  if (item.type === 'commandExecution') {
    if (phase === 'started') return displayText(`$ ${item.command ?? ''}`)
    return displayText(`$ ${item.command ?? '(comando sem texto)'} → ${item.exitCode === undefined ? status : `exit ${item.exitCode}`}`)
  }
  if (item.type === 'mcpToolCall') return displayText(`⚙ ${item.server ?? ''}.${item.tool ?? ''} → ${status}`)
  if (item.type === 'collabAgentToolCall') return displayText(`↔ ${item.tool ?? 'collab'} → ${status}`)
  if (phase === 'started') return undefined
  if (item.type === 'fileChange') return displayText(`± ${status}: ${(item.paths ?? []).join(', ')}`)
  if (item.type === 'webSearch') return '⌕ busca na web'
  if (item.type === 'contextCompaction') return 'O Codex compactou o contexto da thread.'
  return undefined
}

/** Um pedaço de texto ou de pensamento: no bloco aberto, se é do mesmo tipo, ou num bloco novo. */
export function piece(relay: Relay, kind: 'text' | 'thinking', chunk: string): { relay: Relay; chunks: TurnStepChunk[] } {
  if (chunk === '') return { relay, chunks: [] }
  const index = relay.open === undefined || relay.open === kind ? relay.index : relay.index + 1
  const answer = kind === 'text' ? relay.answer + chunk : relay.answer
  return { relay: { ...relay, index, open: kind, answer, isLineStart: chunk.endsWith('\n') }, chunks: [{ kind, index, text: chunk }] }
}

/** Uma linha de andamento como pensamento, começando numa linha própria. */
export function noteLine(relay: Relay, shown: string): { relay: Relay; chunks: TurnStepChunk[] } {
  const isFresh = relay.open !== 'thinking' || relay.isLineStart
  return piece({ ...relay, latest: shown }, 'thinking', `${isFresh ? '' : '\n'}${shown}\n`)
}

export function relayEvent(relay: Relay, event: WireEvent): { relay: Relay; chunks: TurnStepChunk[] } {
  switch (event.kind) {
    case 'text':
    case 'thinking':
      return piece(relay, event.kind, event.delta)
    case 'item': {
      const shown = itemLine(event.phase, event.item)
      return shown === undefined ? { relay, chunks: [] } : noteLine(relay, shown)
    }
    case 'toolCall':
      return { relay: { ...relay, calls: [...relay.calls, { callId: event.callId, tool: event.tool, args: event.args }] }, chunks: [] }
    case 'error':
      return noteLine(relay, displayText(`! ${event.message}${event.willRetry ? ' (o Codex tenta de novo)' : ''}`))
    case 'done':
      return { relay: { ...relay, done: { status: event.status, error: event.error } }, chunks: [] }
  }
}

/** O texto que fecha o turno quando ele não terminou bem, ou terminou sem resposta. */
export function closingText(relay: Relay): string {
  const done = relay.done
  if (done?.status === 'interrupted') return '[astra] O turno do Codex foi interrompido.'
  if (done !== undefined && done.status !== 'completed') return `[astra] O turno do Codex falhou: ${displayText(done.error ?? done.status)}`
  return relay.answer.trim() === '' ? '[astra] O Codex terminou o turno sem resposta em texto.' : ''
}

/** O índice do primeiro bloco depois dos que já saíram. */
export const nextIndex = (relay: Relay): number => (relay.open === undefined ? relay.index : relay.index + 1)
