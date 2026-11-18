import type { EngineInterface, HttpResponse } from 'claude-code'
import type { Config } from './config'
import { joinPath } from './paths'

/**
 * A ponte com o App Server do Codex (`bridge/main.mts`), uma por sessão. O filho do `$.process.spawn` só sobrevive ao Esc
 * quando nasce do `$` do `session.start` (medido em 25/10: aberto no passo ou num timer do passo, morre no Esc). Por isso
 * o `session.start` deixa um laço esperando, sem processo nenhum, e o primeiro passo GPT só o acorda.
 *
 * `endpoint`: o caminho do socket Unix (Linux, macOS) ou `http://127.0.0.1:<porta>` (Windows); `secret`: o segredo que
 * todo pedido leva (`bridge/channel.mts`).
 */
export type Bridge = { endpoint: string; epoch: string; secret: string }

const READY_MS = 5_000
const STDERR_TAIL = 600
const SECRET_HEADER = 'x-astra-secret'

export const NO_NODE =
  'Não achei o Node.js nesta máquina, e o astra precisa dele (versão 22.18 ou mais nova) para falar com o Codex. '
  + 'Instale a versão LTS em https://nodejs.org e abra o Claude Code de novo.'

let wake: (() => void) | undefined
let ready: Promise<Bridge> | undefined
let settle: { resolve: (bridge: Bridge) => void; reject: (error: Error) => void } | undefined
/** A ponte que disse READY e ainda não saiu. */
let live: Bridge | undefined

/** A ponte de pé, sem abrir outra: o `/clear` e o `/compact` só falam com uma que já existe. */
export const liveBridge = (): Bridge | undefined => live

/** A ponte é aberta pelo Node do PATH, sem shell; o `start.mjs` confere a versão dele antes de carregar o resto. */
export function bridgeArgv(root: string, sessionId: string, options: Pick<Config, 'codexPath'>): readonly string[] {
  const codexPath = options.codexPath === '' ? [] : ['--codex-path', options.codexPath]
  return ['node', '--no-warnings', joinPath(root, 'bridge', 'start.mjs'), '--session', sessionId, ...codexPath]
}

export const parseReady = (line: string): Bridge | undefined => {
  const [word, endpoint, epoch, secret] = line.trim().split(' ')
  return word === 'READY' && endpoint !== undefined && epoch !== undefined && secret !== undefined && secret !== '' ? { endpoint, epoch, secret } : undefined
}

/** Por que a ponte não está de pé: a última linha que ela escreveu, ou, se nem abriu, a falta do Node. */
function exitReason(stderr: string, isStarted: boolean, failure: string | undefined): string {
  const last = stderr.trim().split('\n').pop()?.trim() ?? ''
  const said = last.replace(/^a ponte não subiu: /, '')
  if (said !== '') return `${said.charAt(0).toUpperCase()}${said.slice(1)}`
  if (!isStarted && failure !== undefined) return `${NO_NODE} (${failure})`
  return 'a ponte do Codex saiu sem dizer o motivo'
}

/** Um ciclo de vida da ponte: lê o READY, segue lendo (o filho trava se ninguém lê) e, quando ele sai, desarma. */
async function runOnce($: EngineInterface, argv: readonly string[]): Promise<void> {
  let stdout = ''
  let stderr = ''
  let isReady = false
  let isStarted = false
  let failure: string | undefined
  try {
    for await (const piece of $.process.spawn({ argv })) {
      isStarted = true
      if (piece.stream === 'stderr') stderr = (stderr + piece.text).slice(-STDERR_TAIL)
      if (piece.stream !== 'stdout' || isReady) continue
      stdout += piece.text
      const bridge = stdout.includes('\n') ? parseReady(stdout.split('\n')[0] ?? '') : undefined
      if (bridge === undefined) continue
      isReady = true
      live = bridge
      settle?.resolve(bridge)
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  live = undefined
  ready = undefined
  // A ponte que nem disse READY: falta algo na máquina (Node, um Node velho) ou ela não subiu, e a frase vai à pessoa.
  settle?.reject(Object.assign(new Error(exitReason(stderr, isStarted, failure)), { isSetup: !isReady }))
  settle = undefined
}

/** Roda no `session.start`, solto: espera cada pedido de ponte e a abre com o `$` da sessão; nada roda antes disso. */
export async function bridgeLife($: EngineInterface, argv: readonly string[]): Promise<void> {
  for (;;) {
    await new Promise<void>(resolve => {
      wake = resolve
    })
    await runOnce($, argv)
  }
}

/** A ponte pronta: a que já está de pé, ou uma nova, acordando o laço do `session.start`. */
export async function bridgeReady($: EngineInterface): Promise<Bridge> {
  if (ready === undefined) {
    const open = wake
    if (open === undefined) throw new Error('a ponte não tem quem a abra: o session.start do mod astra não rodou nesta carga')
    wake = undefined
    ready = new Promise<Bridge>((resolve, reject) => {
      settle = { resolve, reject }
    })
    open()
  }
  const waiting = ready
  return new Promise<Bridge>((resolve, reject) => {
    const timer = $.clock.after(READY_MS, () => reject(Object.assign(new Error(`A ponte com o Codex não ficou pronta em ${READY_MS / 1000} s. Peça de novo; se repetir, abra o Claude Code de novo.`), { isSetup: true })))
    waiting.then(
      bridge => {
        timer.cancel()
        resolve(bridge)
      },
      (error: unknown) => {
        timer.cancel()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

const errorOf = (response: HttpResponse): string => {
  try {
    const body: unknown = JSON.parse(response.text)
    return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : response.text
  } catch {
    return response.text
  }
}

/** A URL e o `socketPath` de um pedido: no TCP a URL já leva host e porta; no socket, o host é só um nome. */
const target = (bridge: Bridge, path: string): { url: string; socketPath?: string } =>
  bridge.endpoint.startsWith('http://') ? { url: `${bridge.endpoint}${path}` } : { url: `http://bridge${path}`, socketPath: bridge.endpoint }

/**
 * Uma chamada à ponte pelo canal da sessão, com o segredo; o corpo da resposta, já lido como JSON. O 503 é a máquina
 * sem o que o Codex precisa (sem Codex, sem login): a frase da ponte vai como está. Outro erro HTTP vira exceção com o
 * motivo e o status.
 */
export async function bridgeCall($: EngineInterface, bridge: Bridge, path: string, body?: object): Promise<unknown> {
  const { url, socketPath } = target(bridge, path)
  const headers: Record<string, string> = body === undefined ? { [SECRET_HEADER]: bridge.secret } : { [SECRET_HEADER]: bridge.secret, 'content-type': 'application/json' }
  const init = { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers, ...(socketPath === undefined ? {} : { socketPath }) }
  const response = await $.http.fetch(url, init)
  if (response.status === 503) throw Object.assign(new Error(errorOf(response)), { status: 503, isSetup: true })
  if (!response.ok) throw Object.assign(new Error(`a ponte respondeu ${response.status}: ${errorOf(response)}`), { status: response.status })
  return JSON.parse(response.text)
}

/** O 409 da ponte: a chamada já não está pendente, ou não há turno em curso para receber a entrada. */
export const isConflict = (error: unknown): boolean => error instanceof Error && 'status' in error && error.status === 409

/** A falta de algo na máquina (o 503 da ponte, a ponte que não abriu): a frase é para a pessoa, sem prefixo técnico. */
export const isSetupError = (error: unknown): boolean => error instanceof Error && 'isSetup' in error && error.isSetup === true

/** A chamada que o 409 só diz que não coube: true se a ponte aceitou, false no 409; o resto do erro segue. */
export const accepted = (call: Promise<unknown>): Promise<boolean> =>
  call.then(
    () => true,
    (error: unknown) => {
      if (isConflict(error)) return false
      throw error
    },
  )
