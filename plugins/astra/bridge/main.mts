// A ponte de uma sessão do Claude Code com o App Server do Codex. O mod a abre pelo `$.process.spawn` do
// `session.start` (o filho vive a sessão, sobrevive ao Esc e morre com ela), por `start.mjs`, e lê a 1ª linha:
// `READY <canal> <epoch> <segredo>`, onde o canal é o caminho do socket Unix ou `http://127.0.0.1:<porta>`
// (`channel.mts`), e todo pedido traz o segredo.
// Uso: node start.mjs --session <id> [--codex-path <caminho>] [--channel unix|tcp] [--codex '["codex","app-server"]']
// [--state <pasta>] [--hold-ms <ms>] [--compact-wait-ms <ms>]. O `--codex-path` é a opção codexPath do astra; o
// `--codex` (o comando inteiro, sem busca), o `--channel`, o `--state` (a pasta dos bindings, por padrão a do sistema,
// `bindings.mts`), o `--hold-ms` e o `--compact-wait-ms`, só os testes mudam.
import { randomUUID } from 'node:crypto'
import { chmodSync, realpathSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type AppServer, authStamp, type ServerEvents, setupError, startAppServer, VALIDATED_CODEX } from './appserver.mts'
import { createBindings, SESSION_ID, stateRoot } from './bindings.mts'
import { type Channel, channelFor, endpointOf, LOOPBACK, newSecret, refusalOf } from './channel.mts'
import { type CodexCommand, findCodex } from './codex-path.mts'
import { createHttp } from './http.mts'
import { releaseDir } from './rundir.mts'
import { COMPACT_WAIT_MS, createThreads, HOLD_MS } from './threads.mts'

/** Sem pedido e sem turno por este tempo, a ponte sai; o próximo passo GPT a abre de novo. */
const IDLE_MS = 20 * 60_000
/** Quanto o desligamento espera a última resposta sair pelo canal. */
const FLUSH_MS = 300
/** De quanto em quanto tempo a ponte confere se o Claude Code que a abriu ainda vive. */
const PARENT_CHECK_MS = 5_000

type Start = { epoch: string; secret: string; channel: Channel; codex: () => CodexCommand; state: string; holdMs: number; compactWaitMs: number }
type Slot = {
  open: () => Promise<AppServer>
  current: () => AppServer | undefined
  settled: () => Promise<AppServer | undefined>
  renew: (isBusy: () => boolean) => Promise<void>
}

function option(name: string): string | undefined {
  const args = process.argv.slice(2)
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** O comando do App Server: o do `--codex`, ou o achado na máquina na hora de abrir (a falta vira a frase do 503). */
function codexOf(): () => CodexCommand {
  const given = option('--codex')
  if (given !== undefined) {
    const parsed: unknown = JSON.parse(given)
    if (!Array.isArray(parsed) || !parsed.every(part => typeof part === 'string')) throw new Error('--codex precisa ser uma lista JSON de textos')
    return () => ({ argv: parsed, env: {} })
  }
  return () => {
    const found = findCodex({ given: option('--codex-path'), path: process.env.PATH, platform: process.platform, arch: process.arch, execPath: process.execPath, disk: { isFile, realpath: realpathSync } })
    if (typeof found === 'string') throw setupError(found)
    return found
  }
}

/** O erro de partida numa linha só: o mod mostra a última linha do stderr da ponte. */
function fail(error: unknown): never {
  process.stderr.write(`a ponte não subiu: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

function msOption(name: string, fallback: number): number {
  const given = option(name)
  const value = given === undefined ? fallback : Number(given)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} precisa ser um inteiro positivo`)
  return value
}

function prepare(): Start {
  const session = option('--session')
  if (session === undefined || !SESSION_ID.test(session)) throw new Error('uso: start.mjs --session <id da sessão>')
  const epoch = randomUUID().slice(0, 8)
  return { epoch, secret: newSecret(), channel: channelFor(process.platform, option('--channel'), session, epoch), codex: codexOf(), state: stateRoot(option('--state')),
    holdMs: msOption('--hold-ms', HOLD_MS), compactWaitMs: msOption('--compact-wait-ms', COMPACT_WAIT_MS) }
}

/** O App Server da ponte: aberto no 1º pedido e de novo depois de cair; o `signal` mata a partida em curso. */
function appServerSlot(codex: () => CodexCommand, signal: AbortSignal, events: ServerEvents): Slot {
  let starting: Promise<AppServer> | undefined
  let current: AppServer | undefined
  // O `auth.json` de quando o App Server em uso subiu: ele guarda o login em memória e não troca de conta sozinho.
  let stamp = ''
  const onExit = (reason: string): void => {
    starting = undefined
    current = undefined
    events.onExit(reason)
  }
  // O login mudou no disco: com a ponte ociosa, o App Server sai (as threads ficam para a próxima `ensure` retomar), e o
  // seguinte sobe com o login novo. Com turno em curso, espera a próxima `ensure`. A renovação do token por algum Codex
  // também muda o arquivo e custa uma troca, sem perder a thread (a conta é a mesma).
  const renew = async (isBusy: () => boolean): Promise<void> => {
    if (current === undefined || isBusy() || authStamp() === stamp) return
    await current.close()
  }
  const open = (): Promise<AppServer> => {
    if (starting === undefined) stamp = authStamp()
    starting ??= Promise.resolve().then(() => startAppServer(codex(), process.cwd(), { ...events, onExit }, signal)).then(
      server => (current = server),
      (error: unknown) => {
        starting = undefined
        throw error
      },
    )
    return starting
  }
  return { open, current: () => current, settled: async () => current ?? (await starting?.catch(() => undefined)), renew }
}

const drained = (http: Server): Promise<void> =>
  new Promise(resolve => {
    http.close(() => resolve())
    setTimeout(resolve, FLUSH_MS)
  })

/** O Claude Code que abriu a ponte saiu sem fechá-la (no Windows ele não manda sinal nenhum): a ponte sai também. */
function watchParent(shutdown: () => void): void {
  const parent = process.ppid
  setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch {
      shutdown()
    }
  }, PARENT_CHECK_MS).unref()
}

/** Escuta no canal; o callback recebe a porta (no socket Unix, 0). */
function listen(http: Server, channel: Channel, ready: (port: number) => void): void {
  if (channel.kind === 'tcp') {
    http.listen(0, LOOPBACK, () => ready((http.address() as AddressInfo).port))
    return
  }
  http.listen(channel.path, () => {
    try {
      chmodSync(channel.path, 0o600)
    } catch (error) {
      fail(error)
    }
    ready(0)
  })
}

function run({ epoch, secret, channel, codex, state, holdMs, compactWaitMs }: Start): void {
  const stopping = new AbortController()
  const threads = createThreads(() => slot.open(), { bindings: createBindings(state), holdMs, compactWaitMs })
  const slot = appServerSlot(codex, stopping.signal, {
    onNotification: (method, params) => threads.onNotification(method, params),
    onRequest: (id, method, params) => threads.onRequest(id, method, params),
    onExit: reason => threads.onExit(reason),
  })
  let idle: NodeJS.Timeout | undefined
  let tcpHost: string | undefined
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => (threads.isBusy() ? touch() : void shutdown()), IDLE_MS)
  }
  const health = () => ({ epoch, codex: slot.current()?.version ?? null, validated: VALIDATED_CODEX, threads: threads.count(), isBusy: threads.isBusy() })
  const routes = { threads, touch, health, shutdown: () => void shutdown(), renew: () => slot.renew(() => threads.isBusy()) }
  const http = createHttp(routes, request => (channel.kind === 'tcp' && tcpHost === undefined ? 'a ponte ainda não está pronta' : refusalOf(request, secret, tcpHost)))
  // Sai só depois que o App Server saiu de fato (morto aos 5 s), inclusive o que ainda estava subindo.
  async function shutdown(): Promise<void> {
    if (stopping.signal.aborted) return
    stopping.abort()
    clearTimeout(idle)
    const server = await slot.settled()
    await Promise.all([server?.close(), drained(http)])
    if (channel.kind === 'unix') releaseDir(channel.path)
    process.exit(0)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void shutdown())
  watchParent(() => void shutdown())
  http.on('error', fail)
  listen(http, channel, port => {
    if (channel.kind === 'tcp') tcpHost = `${LOOPBACK}:${port}`
    touch()
    process.stdout.write(`READY ${endpointOf(channel, port)} ${epoch} ${secret}\n`)
  })
}

try {
  run(prepare())
} catch (error) {
  fail(error)
}
