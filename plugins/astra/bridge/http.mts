// O contrato mod ↔ ponte: HTTP/1.1 com JSON no canal da sessão (`channel.mts`), cada pedido com o segredo dela. Os
// eventos saem por long-poll, porque o `$.http.fetch` do mod lê a resposta inteira, e a espera dele não conta no
// orçamento do hook.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type Fields, isRecord, textOf } from './proto.mts'
import type { Threads } from './threads.mts'

const MAX_BODY = 8 * 1024 * 1024
/** Os sandboxes que o mod pode pedir; sem nenhum, a thread abre em `workspace-write` (`ensure.mts`). */
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const
const MAX_WAIT_MS = 60_000

export type Health = { epoch: string; codex: string | null; validated: string; threads: number; isBusy: boolean }

/** `renew`: troca o App Server cujo login mudou no disco, se a ponte está ociosa (antes de cada `ensure`). */
type Routes = { threads: Threads; health: () => Health; shutdown: () => void; touch: () => void; renew: () => Promise<void> }

/** Um erro com o status HTTP que o mod recebe; o resto sai como 500. */
const refusal = (status: number, message: string): Error => Object.assign(new Error(message), { status })
const statusOf = (error: unknown): number => (error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 500)

function readBody(request: IncomingMessage): Promise<Fields> {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => {
      size += part.length
      if (size > MAX_BODY) reject(refusal(413, 'corpo grande demais'))
      else parts.push(part)
    })
    request.on('end', () => {
      try {
        const body: unknown = parts.length === 0 ? {} : JSON.parse(Buffer.concat(parts).toString('utf8'))
        if (isRecord(body)) resolve(body)
        else reject(refusal(400, 'o corpo precisa ser um objeto JSON'))
      } catch {
        reject(refusal(400, 'corpo não é JSON'))
      }
    })
    request.on('error', reject)
  })
}

const required = (body: Fields, key: string): string => {
  const value = textOf(body, key)
  if (value === undefined || value === '') throw refusal(400, `falta o campo ${key}`)
  return value
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** O long-poll: a resposta espera eventos até `waitMs` e desiste antes se o mod fechar a conexão. */
async function events(routes: Routes, url: URL, response: ServerResponse): Promise<unknown> {
  const key = url.searchParams.get('key') ?? ''
  const after = Number(url.searchParams.get('after') ?? '0')
  const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(url.searchParams.get('waitMs') ?? '0')))
  const gone = new AbortController()
  response.on('close', () => gone.abort())
  const batch = await routes.threads.events(key, Number.isFinite(after) ? after : 0, Number.isFinite(waitMs) ? waitMs : 0, gone.signal)
  if (batch === undefined) throw refusal(404, `thread desconhecida: ${key}`)
  return batch
}

async function post(routes: Routes, path: string, body: Fields): Promise<unknown> {
  const { threads } = routes
  if (path === '/threads/ensure') {
    const dynamicTools = Array.isArray(body.dynamicTools) ? body.dynamicTools : []
    const config = isRecord(body.config) ? body.config : undefined
    const developerInstructions = textOf(body, 'developerInstructions')
    const sandbox = SANDBOXES.find(mode => mode === body.sandbox)
    const session = textOf(body, 'session')
    await routes.renew()
    return threads.ensure({ key: required(body, 'key'), cwd: required(body, 'cwd'), model: required(body, 'model'), session, sandbox, developerInstructions, dynamicTools, config })
  }
  if (path === '/turns') return threads.startTurn(required(body, 'key'), required(body, 'text'), required(body, 'model'), textOf(body, 'effort'), textOf(body, 'owner'))
  if (path === '/tool-result') {
    const isAnswered = threads.answer(required(body, 'key'), required(body, 'callId'), textOf(body, 'text') ?? '', body.isError === true)
    if (!isAnswered) throw refusal(409, 'a chamada não está pendente nesta ponte')
    return { isAnswered }
  }
  if (path === '/handoff') {
    if (!threads.handOff(required(body, 'key'), required(body, 'callId'))) throw refusal(409, 'a chamada não está pendente nesta ponte')
    return { isHandedOff: true }
  }
  if (path === '/steer') {
    if (!(await threads.steer(required(body, 'key'), required(body, 'text'), textOf(body, 'turnId')))) throw refusal(409, 'não há turno do Codex em curso para receber a entrada')
    return { isSteered: true }
  }
  if (path === '/forget') return { forgotten: threads.forget(required(body, 'session')) }
  if (path === '/compact') return { isCompacting: await threads.compact(required(body, 'key')) }
  // Responde na hora: o fim do turno do Claude Code não espera o Codex fechar. O turno seguinte espera esta interrupção.
  if (path === '/interrupt') {
    void threads.interrupt(required(body, 'key'), textOf(body, 'owner')).catch(() => undefined)
    return { isInterrupting: true }
  }
  if (path === '/shutdown') {
    setImmediate(routes.shutdown)
    return { isClosing: true }
  }
  throw refusal(404, `rota desconhecida: POST ${path}`)
}

async function route(routes: Routes, request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  const url = new URL(request.url ?? '/', 'http://bridge')
  if (request.method === 'GET' && url.pathname === '/health') return routes.health()
  if (request.method === 'GET' && url.pathname === '/events') return events(routes, url, response)
  if (request.method === 'POST') return post(routes, url.pathname, await readBody(request))
  throw refusal(404, `rota desconhecida: ${request.method ?? '?'} ${url.pathname}`)
}

/**
 * `refusal`: por que o pedido não entra (sem o segredo, de outro Host); o recusado não conta como uso da ponte e não
 * diz nada além do 401.
 */
export function createHttp(routes: Routes, refusalOf: (request: IncomingMessage) => string | undefined): Server {
  return createServer((request, response) => {
    const refused = refusalOf(request)
    if (refused !== undefined) {
      request.resume()
      return send(response, 401, { error: refused })
    }
    routes.touch()
    route(routes, request, response).then(
      body => send(response, 200, body),
      (error: unknown) => send(response, statusOf(error), { error: error instanceof Error ? error.message : String(error) }),
    )
  })
}
