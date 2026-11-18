import type { EngineInterface, SessionMessage } from 'claude-code'
import { isKept } from './native-context'
import { answerOf, HANDBACK_TOOL, partsOf, type Part } from './request'

/**
 * A entrega do relatório por ferramenta. Num subagente em que o Claude Code exige a entrega pelo `SubagentHandback` (no
 * modo auto), o texto final não chega a quem chamou: o motor cobra a chamada e, sem ela, encerra o loop dizendo que não
 * houve relatório (prova de 18/11). Quem monta a chamada é o passo (`native.ts`), com a resposta inteira do Codex em
 * `message`; o Codex não recebe essa ferramenta e não precisa saber dela.
 *
 * O motor (2.1.327) não diz a um mod quais ferramentas um loop recebe: o `turn.step` não as traz, o `$.tool.list()` é o
 * conjunto da sessão e nenhuma mensagem leva a lista de ferramentas. O sinal é o que o próprio motor escreve no loop
 * quando a entrega é por ferramenta: o lembrete do começo e a cobrança, os dois com a chamada `SubagentHandback({message:`
 * (`partsOf`, em `request.ts`). Ele só existe num subagente; a conversa principal responde sempre em texto.
 */

/** Quantas mensagens do fim do loop o passo lê para achar o que chegou depois da última resposta. */
const TAIL = 20

type ApiMessage = { role: string; content: readonly { type: string; [field: string]: unknown }[] }

/** Os subagentes em que a entrega é por ferramenta; e, para os outros, o turno em que isso já foi lido sem achar o sinal. */
const byTool = new Set<string>()
const checkedIn = new Map<string, string>()

const textsOf = (message: ApiMessage): readonly string[] =>
  message.role !== 'user' ? [] : message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))

const partsIn = (messages: readonly ApiMessage[]): readonly Part[] => messages.flatMap(textsOf).flatMap(partsOf)

async function apiOf($: EngineInterface, agentId: string | undefined, last?: number): Promise<readonly ApiMessage[]> {
  const range = last === undefined ? {} : { last }
  const read = agentId === undefined ? await $.session.messages({ as: 'api', ...range }) : await $.session.messages({ as: 'api', agentId, ...range })
  return Array.isArray(read) ? read : []
}

/**
 * Se o passo deste loop entrega a resposta pelo SubagentHandback. Lido uma vez por turno no formato da API, que traz o
 * lembrete do motor (as linhas de `$.session.messages()` não trazem). Um erro na leitura responde em texto, como antes.
 */
export async function deliversByTool($: EngineInterface, e: { agentId?: string; turnId: string }): Promise<boolean> {
  const { agentId } = e
  if (agentId === undefined) return false
  if (byTool.has(agentId)) return true
  if (checkedIn.get(agentId) === e.turnId) return false
  try {
    const isByTool = partsIn(await apiOf($, agentId)).some(part => part.isDemand)
    if (isByTool) byTool.add(agentId)
    else checkedIn.set(agentId, e.turnId)
    return isByTool
  } catch {
    return false
  }
}

/**
 * O que chegou ao loop depois da última resposta, num passo do meio do turno sem turno do Codex à espera: é a
 * continuação que um hook de parada abre (a cobrança da entrega, um hook que devolve o turno), e a mensagem dele está só
 * no formato da API. Voltam os pedaços que vão ao Codex: sem o pedido de entrega (ele marca o loop como de entrega por
 * ferramenta), sem o contexto que não vai (`isKept`) e sem o que já vai no turno por outro caminho (`sent`).
 */
export async function continuationOf($: EngineInterface, e: { agentId?: string }, sent: readonly string[]): Promise<readonly string[]> {
  let messages: readonly ApiMessage[]
  try {
    messages = await apiOf($, e.agentId, TAIL)
  } catch {
    return []
  }
  const parts = partsIn(messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1))
  if (e.agentId !== undefined && parts.some(part => part.isDemand)) byTool.add(e.agentId)
  return parts.filter(part => !part.isDemand && isKept(part.text) && !sent.includes(part.text)).map(part => part.text)
}

/** A última resposta do loop, se ela foi a final (sem ferramenta, ou só com a entrega): é o que vai de novo, sem chamar o Codex. */
export function lastAnswer(rows: readonly SessionMessage[]): string {
  const row = rows.findLast(candidate => candidate.role === 'assistant')
  if (row === undefined || row.toolUses.some(use => use.tool !== HANDBACK_TOOL)) return ''
  return answerOf(row)
}
