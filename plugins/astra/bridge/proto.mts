// Os formatos que a ponte troca com o App Server do Codex (JSON-RPC por linha, protocolo gerado do 0.169.0 por
// `codex app-server generate-ts --experimental`) e com o mod (HTTP no canal da sessão). Só os campos usados, conferidos à mão.

export type RpcId = number | string
export type Fields = Readonly<Record<string, unknown>>

/** Uma linha do App Server: a resposta a um pedido da ponte, um pedido dele à ponte, ou um aviso. */
export type Incoming =
  | { kind: 'response'; id: RpcId; result: unknown; error?: string }
  | { kind: 'request'; id: RpcId; method: string; params: Fields }
  | { kind: 'notification'; method: string; params: Fields }

export const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Uma resposta do App Server como campos; o que não é objeto vira vazio. */
export const fieldsOf = (value: unknown): Fields => (isRecord(value) ? value : {})

export const textOf = (fields: Fields, key: string): string | undefined => {
  const value = fields[key]
  return typeof value === 'string' ? value : undefined
}

export const recordOf = (fields: Fields, key: string): Fields => {
  const value = fields[key]
  return isRecord(value) ? value : {}
}

const isRpcId = (value: unknown): value is RpcId => typeof value === 'number' || typeof value === 'string'

export function parseIncoming(line: string): Incoming | undefined {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(message)) return undefined
  const method = textOf(message, 'method')
  const params = recordOf(message, 'params')
  if (method !== undefined) return isRpcId(message.id) ? { kind: 'request', id: message.id, method, params } : { kind: 'notification', method, params }
  if (!isRpcId(message.id)) return undefined
  const error = isRecord(message.error) ? (textOf(message.error, 'message') ?? 'erro sem mensagem') : undefined
  return { kind: 'response', id: message.id, result: message.result, error }
}

/** O que o mod vê de um item do Codex: só o necessário para a linha de andamento, nunca a saída nem os argumentos. */
export type ItemView = {
  type: string
  command?: string
  status?: string
  exitCode?: number
  paths?: readonly string[]
  server?: string
  tool?: string
}

export type Usage = { input: number; cached: number; output: number; total: number; window: number | null }

/** Um evento de um turno, como o mod o lê no long-poll; `seq` cresce por thread e serve de cursor. */
export type BridgeEvent =
  | { seq: number; kind: 'text'; delta: string }
  | { seq: number; kind: 'thinking'; delta: string }
  | { seq: number; kind: 'item'; phase: 'started' | 'completed'; item: ItemView }
  | { seq: number; kind: 'toolCall'; callId: string; tool: string; args: unknown }
  | { seq: number; kind: 'usage'; usage: Usage }
  | { seq: number; kind: 'error'; message: string; willRetry: boolean }
  | { seq: number; kind: 'done'; status: string; error?: string }

type Unsequenced<T> = T extends { seq: number } ? Omit<T, 'seq'> : never
export type NewEvent = Unsequenced<BridgeEvent>

const numberOf = (fields: Fields, key: string): number => {
  const value = fields[key]
  return typeof value === 'number' ? value : 0
}

/** `thread/tokenUsage/updated`: os tokens da última chamada (`last`), que é o que ocupa a janela agora. */
export function usageOf(tokenUsage: Fields): Usage {
  const last = recordOf(tokenUsage, 'last')
  const window = tokenUsage.modelContextWindow
  return {
    input: numberOf(last, 'inputTokens'),
    cached: numberOf(last, 'cachedInputTokens'),
    output: numberOf(last, 'outputTokens'),
    total: numberOf(last, 'totalTokens'),
    window: typeof window === 'number' ? window : null,
  }
}

function pathsOf(changes: unknown): readonly string[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap(change => (isRecord(change) && typeof change.path === 'string' ? [change.path] : []))
}

/** O que a linha de andamento mostra de cada tipo de item; o resto não aparece. */
export function itemView(item: Fields): ItemView | undefined {
  const type = textOf(item, 'type')
  const status = textOf(item, 'status')
  if (type === 'commandExecution') {
    const exitCode = item.exitCode
    return { type, command: textOf(item, 'command'), status, exitCode: typeof exitCode === 'number' ? exitCode : undefined }
  }
  if (type === 'fileChange') return { type, status, paths: pathsOf(item.changes) }
  if (type === 'mcpToolCall') return { type, status, server: textOf(item, 'server'), tool: textOf(item, 'tool') }
  if (type === 'collabAgentToolCall') return { type, status, tool: textOf(item, 'tool') }
  if (type === 'webSearch' || type === 'contextCompaction' || type === 'plan') return { type, status }
  return undefined
}
