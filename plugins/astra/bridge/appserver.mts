// O App Server do Codex como filho da ponte: `codex app-server` por stdio, uma linha JSON por mensagem.
// O login é o do próprio Codex (`account/read`): a ponte nunca lê nem repassa token.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CodexCommand } from './codex-path.mts'
import { type Fields, type Incoming, isRecord, parseIncoming, type RpcId, textOf } from './proto.mts'

/**
 * O protocolo foi conferido nesta versão: cada método e campo que a ponte usa, contra os tipos de
 * `codex app-server generate-ts --experimental` da 0.169.0 (18/11/2026). As chaves de `config` da thread
 * (`ensure.mts`) não estão no protocolo e não entram nessa conferência. Outra versão sobe, com a diferença no `/health`.
 */
export const VALIDATED_CODEX = '0.169.0'
const REQUEST_TIMEOUT_MS = 120_000
const STDERR_TAIL = 2_000
const KILL_GRACE_MS = 5_000

/** Um erro de preparo da máquina (sem Codex, sem login): vai ao mod como 503, e o mod mostra a frase como está. */
export const setupError = (message: string): Error => Object.assign(new Error(message), { status: 503 })

const NO_LOGIN =
  'O Codex desta máquina está sem login com uma conta do ChatGPT. Abra um terminal, rode `codex login`, entre com a sua conta e peça de novo.'

export type ServerEvents = {
  onNotification: (method: string, params: Fields) => void
  onRequest: (id: RpcId, method: string, params: Fields) => void
  onExit: (reason: string) => void
}

type Request = (method: string, params: unknown) => Promise<unknown>

export type AppServer = {
  request: Request
  respond: (id: RpcId, result: unknown) => void
  refuse: (id: RpcId, message: string) => void
  /** SIGTERM, SIGKILL depois de 5 s; resolve quando o filho saiu de fato. */
  close: () => Promise<void>
  /** A versão do Codex, lida do `userAgent` do `initialize`. */
  version: string
  /** A versão é a de `VALIDATED_CODEX`, cujo protocolo foi conferido. */
  isValidated: boolean
  /** A conta do login que este App Server usa (`accountOf`). */
  account: string
}

type Response = Extract<Incoming, { kind: 'response' }>
type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type Pending = { request: Request; settle: (message: Response) => void; rejectAll: (reason: string) => void }
type Channel = { request: Request; write: (message: object) => void; close: () => Promise<void> }

export const versionOf = (userAgent: string): string => /\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? 'desconhecida'

/** Os pedidos à espera de resposta, cada um com prazo; `rejectAll` recusa todos quando o filho sai. */
function pendingRequests(write: (message: object) => void, isClosed: () => boolean): Pending {
  const waiting = new Map<RpcId, Waiting>()
  let nextId = 1
  const settle = (message: Response): void => {
    const entry = waiting.get(message.id)
    if (entry === undefined) return
    waiting.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new Error(message.error))
    else entry.resolve(message.result)
  }
  const rejectAll = (reason: string): void => {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    waiting.clear()
  }
  const request: Request = (method, params) =>
    new Promise((resolve, reject) => {
      if (isClosed()) return reject(new Error('o App Server já terminou'))
      const id = nextId++
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`${method} passou de ${REQUEST_TIMEOUT_MS / 1000} s sem resposta`))
      }, REQUEST_TIMEOUT_MS)
      waiting.set(id, { resolve, reject, timer })
      write({ id, method, params })
    })
  return { request, settle, rejectAll }
}

/**
 * O fim do filho: o stdin fecha (o App Server sai no fim da entrada) e, no Linux e no macOS, vai também o SIGTERM;
 * quem não sair em 5 s é morto (SIGKILL; no Windows, que não tem sinal, o encerramento do processo). A promessa
 * resolve quando ele saiu de fato.
 */
function stopper(child: ChildProcessWithoutNullStreams): () => Promise<void> {
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  return () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return exited
    child.stdin.end()
    if (process.platform !== 'win32') child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'), KILL_GRACE_MS)
    return exited.then(() => clearTimeout(timer))
  }
}

/** O JSON-RPC sobre o stdio do filho: pedidos com prazo, respostas pelo id, e tudo recusado quando o filho sai. */
function channel(child: ChildProcessWithoutNullStreams, events: ServerEvents): Channel {
  let stderr = ''
  let isClosed = false
  const write = (message: object): void => {
    if (!isClosed) child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const pending = pendingRequests(write, () => isClosed)
  const end = (reason: string): void => {
    if (isClosed) return
    isClosed = true
    pending.rejectAll(reason)
    events.onExit(reason)
  }
  // Escrever num filho que morreu dá EPIPE; quem fecha o canal e recusa o que esperava é o `exit`.
  child.stdin.on('error', () => undefined)
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL)
  })
  createInterface({ input: child.stdout }).on('line', line => {
    const message = parseIncoming(line)
    if (message?.kind === 'response') pending.settle(message)
    else if (message?.kind === 'request') events.onRequest(message.id, message.method, message.params)
    else if (message?.kind === 'notification') events.onNotification(message.method, message.params)
  })
  child.on('exit', (code, signal) => end(`o App Server terminou com ${signal ?? `exit ${code}`}${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').pop()}`}`))
  child.on('error', error => end(`o Codex não abriu (${child.spawnfile}): ${error.message}`))
  return { request: pending.request, write, close: stopper(child) }
}

/**
 * A conta como o `account/read` a descreve (e-mail e plano), num hash curto: o binding a guarda sem dado pessoal. O
 * `workspaceRouting` fica de fora: o App Server o descobre depois de subir, e a mesma conta daria dois valores.
 */
export const accountOf = (account: Fields): string =>
  createHash('sha256').update(JSON.stringify([textOf(account, 'email') ?? null, textOf(account, 'planType') ?? null])).digest('hex').slice(0, 16)

/**
 * O `stat` do `auth.json` do `CODEX_HOME`, sem ler o conteúdo: muda quando o login muda (o "Tornar ativa" do CENTER, um
 * `codex login`) e quando um Codex renova o token. Com o login no keyring do sistema, o arquivo não existe e o valor
 * não muda.
 */
export function authStamp(): string {
  const home = process.env.CODEX_HOME
  const file = join(home === undefined || home === '' ? join(homedir(), '.codex') : home, 'auth.json')
  try {
    const stat = statSync(file)
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'sem auth.json'
  }
}

async function requireSubscription(request: Request): Promise<string> {
  const answer = await request('account/read', { refreshToken: false })
  const account = isRecord(answer) && isRecord(answer.account) ? answer.account : undefined
  if (account?.type !== 'chatgpt') throw setupError(NO_LOGIN)
  return accountOf(account)
}

/** O que a ponte guarda do aperto de mão: a versão do Codex e se o protocolo dela foi conferido. */
export const handshakeOf = (userAgent: string): { version: string; isValidated: boolean } => {
  const version = versionOf(userAgent)
  return { version, isValidated: version === VALIDATED_CODEX }
}

/**
 * Sobe o App Server, faz o `initialize` (o `clientInfo.name` vira o originator dos rollouts) e confere o login. O `signal`
 * da ponte que fecha mata o filho ainda no meio da partida.
 */
export async function startAppServer(codex: CodexCommand, cwd: string, events: ServerEvents, signal?: AbortSignal): Promise<AppServer> {
  const [command, ...args] = codex.argv
  if (command === undefined) throw new Error('comando do App Server vazio')
  if (signal?.aborted === true) throw new Error('a ponte está fechando')
  const child = spawn(command, args, { cwd, env: { ...process.env, ...codex.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
  const rpc = channel(child, events)
  const stop = (): void => void rpc.close()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const hello = await rpc.request('initialize', {
      clientInfo: { name: 'alrix_cc_bridge', title: 'ALRIX · Claude Code', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    rpc.write({ method: 'initialized' })
    const account = await requireSubscription(rpc.request)
    return {
      request: rpc.request,
      respond: (id, result) => rpc.write({ id, result }),
      refuse: (id, message) => rpc.write({ id, error: { code: -32601, message } }),
      close: rpc.close,
      ...handshakeOf(isRecord(hello) ? (textOf(hello, 'userAgent') ?? '') : ''),
      account,
    }
  } catch (error) {
    await rpc.close()
    // O programa que nem abriu (apagado, sem permissão) é preparo da máquina, como o Codex que falta.
    if (child.pid === undefined && error instanceof Error) throw setupError(`${error.message}. Confira a instalação do Codex (\`codex --version\` num terminal) e peça de novo.`)
    throw error
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}
