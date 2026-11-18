import type { SessionMessage } from 'claude-code'

/**
 * A linha `cwd: <caminho absoluto>` no começo do pedido: `/caminho` (Linux, macOS), `C:\caminho` ou `C:/caminho`
 * (Windows). Num teammate o pedido chega dentro do envelope do Claude Code (`<teammate-message teammate_id="...">`,
 * numa linha só), e a linha é a primeira dentro dele.
 */
const CWD_DIRECTIVE = /^(<teammate-message\b[^>\r\n]*>\r?\n)?cwd:[ \t]*((?:\/|[A-Za-z]:[\\/])[^\r\n]*?)[ \t]*(?:\r?\n|$)/
/** O nome do líder numa equipe do Claude Code: é o destino do SendMessage de um teammate para ele. */
const TEAM_LEAD = 'team-lead'
/** A ferramenta por onde o subagente entrega o relatório quando o Claude Code o exige (modo auto). */
export const HANDBACK_TOOL = 'SubagentHandback'
/** A chamada que o próprio Claude Code pede quando exige a entrega por ferramenta: no lembrete do começo e na cobrança. */
const HANDBACK_CALL = /SubagentHandback\(\{\s*message\s*:/
/** A cobrança do motor fora de lembrete: uma linha que começa com a etiqueta dele (`[handback-send-enforce]`). */
const ENGINE_TAG = /^\[[\w-]+\]\s/
const REMINDER_BLOCK = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder\b[^>]*>/g
const HISTORY_INTRO =
  'A conversa anterior do Codex para este agente não está mais disponível. Este é o histórico até aqui; responda ao último pedido.'

/**
 * O que chegou depois do último passo do Astra: é o que uma conversa retomada ainda não viu.
 * O passo conta mesmo sem texto, porque no modo auto a resposta sai por ferramenta (SubagentHandback).
 */
export function latestRequest(rows: readonly SessionMessage[]): string {
  const lastStep = rows.map(row => row.role).lastIndexOf('assistant')
  const texts = rows.slice(lastStep + 1).map(row => row.text.trim())
  return texts.filter(text => text !== '').join('\n\n')
}

/**
 * O que o Astra respondeu num passo: o relatório que saiu por ferramenta, pelo SubagentHandback (o texto ao lado é o
 * andamento) ou, no teammate em painel, pelo SendMessage ao líder; sem ele, o texto do passo.
 */
export function answerOf(row: SessionMessage): string {
  const handback = row.toolUses.find(use => use.tool === HANDBACK_TOOL)?.input.message
  const toLead = row.toolUses.find(use => use.tool === 'SendMessage' && use.input.to === TEAM_LEAD)?.input.message
  const report = typeof handback === 'string' ? handback : toLead
  return typeof report === 'string' ? report.trim() : row.text.trim()
}

/**
 * O marcador que a compactação do mod põe no lugar das mensagens que tira de um loop do Codex: nem pedido nem histórico,
 * ele sai das linhas antes de o passo lê-las.
 */
export const COMPACT_MARK = '[astra] Compactado:'
export const withoutMarks = (rows: readonly SessionMessage[]): readonly SessionMessage[] =>
  rows.filter(row => !(row.role === 'user' && row.text.startsWith(COMPACT_MARK)))

/** Um pedaço de texto do lado do usuário: o de dentro de um lembrete, ou o texto fora deles; `isDemand`, se é o pedido de entrega do motor. */
export type Part = { text: string; isDemand: boolean }

/** Um bloco de contexto (o de dentro de um lembrete, ou o texto inteiro de um hook) que pede a entrega pelo SubagentHandback. */
export const isHandbackDemand = (block: string): boolean => HANDBACK_CALL.test(block)

/**
 * Os pedaços de um texto do usuário, em ordem. O pedido de entrega do motor é o lembrete que cita a chamada, ou a linha
 * dele com etiqueta; o texto da pessoa que só cita a chamada não conta.
 */
export function partsOf(text: string): readonly Part[] {
  const parts: Part[] = []
  const plain = (piece: string): void => {
    const trimmed = piece.trim()
    if (trimmed !== '') parts.push({ text: trimmed, isDemand: ENGINE_TAG.test(trimmed) && HANDBACK_CALL.test(trimmed) })
  }
  let at = 0
  for (const match of text.matchAll(REMINDER_BLOCK)) {
    plain(text.slice(at, match.index))
    const inner = (match[1] ?? '').trim()
    if (inner !== '') parts.push({ text: inner, isDemand: HANDBACK_CALL.test(inner) })
    at = match.index + match[0].length
  }
  plain(text.slice(at))
  return parts
}

/**
 * As linhas sem o pedido de entrega do motor: quem entrega é o mod (`native-handback.ts`), e o Codex não o recebe. A
 * linha que só tinha o pedido sai; a que não tem nenhum fica como veio.
 */
export function withoutDemands(rows: readonly SessionMessage[]): readonly SessionMessage[] {
  return rows.flatMap(row => {
    const parts = row.role === 'user' ? partsOf(row.text) : []
    if (!parts.some(part => part.isDemand)) return [row]
    const text = parts.filter(part => !part.isDemand).map(part => part.text).join('\n\n')
    return text === '' && (row.toolResults ?? []).length === 0 ? [] : [{ ...row, text }]
  })
}

export function history(rows: readonly SessionMessage[]): string {
  const turns = rows.flatMap(row => {
    const text = row.role === 'user' ? row.text.trim() : answerOf(row)
    return text === '' ? [] : [`[${row.role === 'user' ? 'pedido' : 'sua resposta'}]\n${text}`]
  })
  return [HISTORY_INTRO, ...turns].join('\n\n')
}

/**
 * A primeira linha do 1º pedido pode ser `cwd: /caminho`, que diz onde o Codex trabalha; sem ela, `cwd` vem
 * undefined e vale o da sessão. As linhas voltam sem a diretiva.
 */
export function directiveOf(rows: readonly SessionMessage[]): { cwd?: string; rows: readonly SessionMessage[] } {
  const [first, ...rest] = rows
  const directive = first === undefined ? null : CWD_DIRECTIVE.exec(first.text)
  if (first === undefined || directive === null) return { rows }
  return { cwd: directive[2], rows: [{ ...first, text: (directive[1] ?? '') + first.text.slice(directive[0].length) }, ...rest] }
}
