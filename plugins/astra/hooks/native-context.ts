import type { EngineInterface, SessionAppendInput, SessionAppendResult } from 'claude-code'
import { isGptLoop } from './native-news'
import { isHandbackDemand } from './request'

/**
 * O contexto que o Claude Code dá a um loop chega ao modelo como blocos `<system-reminder>`: o CLAUDE.md, as regras e a
 * memória, as skills, os agentes, as instruções dos MCP, a data. As linhas de `$.session.messages()` não os mostram
 * (medido em 25/10: são linhas da porta `attachment`, e só o formato da API as traz). O Codex recebe o que um modelo
 * Claude receberia no mesmo loop: numa thread nova, os blocos do formato da API; numa que já existe, as linhas novas.
 */

/** Uma mensagem no formato da API, como `$.session.messages({ as: 'api' })` a devolve. */
type ApiMessage = { role: string; content: readonly { type: string; [field: string]: unknown }[] }

const REMINDER = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder\b[^>]*>/g
/**
 * O que não vai: os avisos das ferramentas adiadas do Claude Code (o catálogo do Codex é o `dynamicTools` da thread, com
 * os schemas) e o ambiente do Claude Code (o Codex tem o dele, com o cwd da thread, que num agente pode ser outro).
 */
const LEFT_OUT = [/^The following (deferred )?tools\b/, /^# Environment\b/]
/**
 * O teto do contexto de um turno. A cabeça fica (numa thread nova, o CLAUDE.md, as regras e a memória vêm primeiro), e o
 * resto do teto vai aos mais novos, os avisos da sessão que o Codex ainda não viu.
 */
const MAX_CONTEXT_CHARS = 150_000
const MAX_HEAD_CHARS = 100_000
const MAX_BOX = 50
export const CONTEXT_LABEL =
  '[contexto do Claude Code] O que o Claude Code dá a este loop, como daria a um modelo Claude: as instruções da pessoa e do projeto (CLAUDE.md, regras, memória), as skills, os agentes, os MCP e os avisos da sessão. As ferramentas citadas são as do namespace `claude_code`.'

const boxes = new Map<string, readonly string[]>()

/** Também não vai o pedido de entrega pelo SubagentHandback: quem entrega é o mod (`native-handback.ts`), não o Codex. */
export const isKept = (block: string): boolean => block !== '' && !LEFT_OUT.some(pattern => pattern.test(block)) && !isHandbackDemand(block)

/** Os lembretes de um texto; o texto que não tem nenhum (o de um hook) vale inteiro, se `isWhole`. */
function remindersOf(text: string, isWhole: boolean): readonly string[] {
  const found = [...text.matchAll(REMINDER)].map(match => (match[1] ?? '').trim())
  return found.length > 0 ? found : isWhole ? [text.trim()] : []
}

/** Os blocos de contexto de uma conversa no formato da API, em ordem: os lembretes dos textos do usuário. */
export function reminderBlocks(messages: readonly ApiMessage[]): readonly string[] {
  return messages.flatMap(message =>
    message.role !== 'user' ? [] : message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? remindersOf(block.text, false) : [])),
  ).filter(isKept)
}

/** O hook do `session.append` nas portas `attachment` e `hook-context`: guarda o contexto novo de um loop GPT. */
export async function onContext($: EngineInterface, e: SessionAppendInput, next: (e: SessionAppendInput) => Promise<SessionAppendResult>): Promise<SessionAppendResult> {
  const key = e.agentId ?? `main:${await $.session.id()}`
  const text = e.message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
  const blocks = isGptLoop(key) ? remindersOf(text, true).filter(isKept) : []
  if (blocks.length > 0) boxes.set(key, [...(boxes.get(key) ?? []), ...blocks].slice(-MAX_BOX))
  return next(e)
}

/** O contexto que chegou a `key` desde o último turno do Codex; sai da caixa só com `dropContext`, quando o turno abriu. */
export const peekContext = (key: string): readonly string[] => boxes.get(key) ?? []

/** Tira da caixa os `count` primeiros, os que foram no turno que abriu; o que entrou depois fica. */
export function dropContext(key: string, count: number): void {
  const left = (boxes.get(key) ?? []).slice(count)
  if (left.length === 0) boxes.delete(key)
  else boxes.set(key, left)
}

export const forgetContext = (key: string): void => {
  boxes.delete(key)
}

/** Os blocos que cabem em `room` caracteres, na ordem dada; o que não cabe fica, e o seguinte ainda pode caber. */
function fitting(blocks: readonly string[], room: number): { blocks: readonly string[]; size: number } {
  return blocks.reduce<{ blocks: readonly string[]; size: number }>(
    (acc, block) => (acc.size + block.length > room ? acc : { blocks: [...acc.blocks, block], size: acc.size + block.length }),
    { blocks: [], size: 0 },
  )
}

/**
 * O texto que leva o contexto ao Codex, rotulado; vazio se não há nada. Sai o bloco repetido e o que já vai no turno por
 * outro caminho (`sent`: as entregas da caixa de recados). Passando do teto, ficam a cabeça e os mais novos, em ordem, e
 * o aviso conta os do meio que ficaram de fora.
 */
export function contextText(blocks: readonly string[], sent: readonly string[]): string {
  const unique = [...new Set(blocks)].filter(block => !sent.includes(block))
  const head = fitting(unique, MAX_HEAD_CHARS)
  const rest = unique.filter(block => !head.blocks.includes(block))
  const tail = fitting(rest.toReversed(), MAX_CONTEXT_CHARS - head.size).blocks
  const kept = unique.filter(block => head.blocks.includes(block) || tail.includes(block))
  if (kept.length === 0) return ''
  const cut = unique.length - kept.length
  const note = cut === 0 ? [] : [`[astra] ${cut} bloco(s) de contexto do meio ficaram de fora (teto de ${MAX_CONTEXT_CHARS} caracteres: ficam o começo e os mais novos).`]
  return [CONTEXT_LABEL, ...kept, ...note].join('\n\n')
}
