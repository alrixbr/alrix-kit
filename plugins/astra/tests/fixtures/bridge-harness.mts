// O que os testes da ponte usam para abrir o processo inteiro (`bridge/start.mjs`) contra o App Server falso e falar com
// ele pelo canal da ponte (socket Unix no Linux e no macOS, TCP em 127.0.0.1 no Windows), com o segredo dela.
// `XDG_RUNTIME_DIR` dos sockets: `ASTRA_TEST_RUNTIME` (o caminho de um socket Unix tem teto de ~107 bytes); os
// registros do App Server falso e os bindings: `ASTRA_TEST_LOGS`. Sem elas, pastas novas no tmpdir.
import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { type OutgoingHttpHeaders, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SECRET_HEADER } from '../../bridge/channel.mts'
import type { BridgeEvent } from '../../bridge/proto.mts'

/** A pasta dos testes: serve de `cwd` das threads. */
export const HERE = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RUNTIME = process.env.ASTRA_TEST_RUNTIME ?? join(tmpdir(), 'astra-rt')
export const LOGS = process.env.ASTRA_TEST_LOGS ?? join(tmpdir(), 'astra-logs')
mkdirSync(LOGS, { recursive: true })
export const IS_WINDOWS = process.platform === 'win32'
const STRIP = ['--experimental-strip-types', '--no-warnings']
export const START = join(HERE, '../bridge/start.mjs')
export const MEMORY = { type: 'function', name: 'mcp_notas__buscar', description: 'Busca.', inputSchema: { type: 'object' } }

export type Json = Record<string, unknown>
/** `socket`: o caminho do socket Unix, ou a URL de base no TCP; `secret`: o que todo pedido leva. */
export type Bridge = { child: ChildProcessWithoutNullStreams; socket: string; epoch: string; secret: string; log: string }

/** Toda ponte que um teste abre: a que um assert deixou de pé morre no fim, em vez de segurar a suíte. */
const opened = new Set<ChildProcessWithoutNullStreams>()
const tracked = (child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams => {
  opened.add(child)
  child.once('exit', () => opened.delete(child))
  return child
}
after(() => {
  for (const child of opened) child.kill('SIGKILL')
})

/** A pasta de bindings de um teste: nunca a de produção (`~/.local/state/alrix-astra`). */
export const stateDir = (name: string): string => join(LOGS, `state-${process.pid}-${name}`)

/** O `CODEX_HOME` de um teste, onde a ponte olha o `auth.json`: nunca o `~/.codex` de verdade. */
export function codexHome(name: string): string {
  const dir = join(LOGS, `codex-${process.pid}-${name}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** `log` dá o nome do registro do App Server falso (o padrão é o do teste); `extra` vai no fim da linha de comando. */
export function startBridge(name: string, env: Record<string, string> = {}, extra: readonly string[] = [], log = name): Promise<Bridge> {
  mkdirSync(RUNTIME, { recursive: true, mode: 0o700 })
  const logFile = join(LOGS, `fake-${log}-${process.pid}.jsonl`)
  const codex = JSON.stringify([process.execPath, ...STRIP, join(HERE, 'fixtures/fake-appserver.mts')])
  const args = ['--no-warnings', START, '--session', `t${process.pid}-${name}`, '--codex', codex, '--state', stateDir(name), ...extra]
  const base = { ...process.env, XDG_RUNTIME_DIR: RUNTIME, FAKE_LOG: logFile, CODEX_HOME: codexHome(name) }
  const child = tracked(spawn(process.execPath, args, { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }))
  let stderr = ''
  child.stderr.on('data', (part: Buffer) => (stderr += part.toString('utf8')))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('a ponte não disse READY em 5 s')), 5_000)
    child.once('exit', code => reject(new Error(`a ponte saiu com ${String(code)} antes do READY: ${stderr.trim()}`)))
    createInterface({ input: child.stdout }).once('line', line => {
      clearTimeout(timer)
      const [word, socket = '', epoch = '', secret = ''] = line.split(' ')
      if (word === 'READY') resolve({ child, socket, epoch, secret, log: logFile })
      else reject(new Error(`primeira linha inesperada: ${line}`))
    })
  })
}

/** Onde o pedido vai: o socket Unix, ou host e porta do TCP. */
export const targetOf = (endpoint: string): { socketPath: string } | { host: string; port: number } => {
  if (!endpoint.startsWith('http://')) return { socketPath: endpoint }
  const url = new URL(endpoint)
  return { host: url.hostname, port: Number(url.port) }
}

/** Um pedido cru, com os cabeçalhos que o teste der (sem o segredo, se ele não o puser). */
export function raw(bridge: Bridge, method: 'GET' | 'POST', path: string, headers: OutgoingHttpHeaders, body?: object): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const sent = request({ ...targetOf(bridge.socket), path, method, headers: { 'content-type': 'application/json', ...headers } }, response => {
      const parts: Buffer[] = []
      response.on('data', (part: Buffer) => parts.push(part))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as Json }))
    })
    sent.on('error', reject)
    sent.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export function call(bridge: Bridge, method: 'GET' | 'POST', path: string, body?: object): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const sent = request({ ...targetOf(bridge.socket), path, method, headers: { 'content-type': 'application/json', [SECRET_HEADER]: bridge.secret } }, response => {
      const parts: Buffer[] = []
      response.on('data', (part: Buffer) => parts.push(part))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as Json }))
    })
    sent.on('error', reject)
    sent.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export const post = async (bridge: Bridge, path: string, body: object): Promise<Json> => {
  const answer = await call(bridge, 'POST', path, body)
  assert.equal(answer.status, 200, JSON.stringify(answer.body))
  return answer.body
}

/** Lê os eventos de `key` desde `after` até aparecer um do tipo pedido. */
export async function readUntil(bridge: Bridge, key: string, after: number, kind: BridgeEvent['kind']): Promise<{ events: BridgeEvent[]; next: number }> {
  const events: BridgeEvent[] = []
  let cursor = after
  for (let round = 0; round < 20 && !events.some(event => event.kind === kind); round += 1) {
    const { body } = await call(bridge, 'GET', `/events?key=${encodeURIComponent(key)}&after=${cursor}&waitMs=3000`)
    events.push(...(body.events as BridgeEvent[]))
    cursor = body.next as number
  }
  return { events, next: cursor }
}

/** Uma ponte que não deve subir: o código de saída e a última linha do stderr, que é o que o mod mostra. A que sobe
 * mesmo assim é morta em 5 s e volta com `code: null`. */
export function startFailing(name: string, env: Record<string, string>, extra: readonly string[] = []): Promise<{ code: number | null; line: string }> {
  const args = ['--no-warnings', START, '--session', `t${process.pid}-${name}`, ...extra]
  const child = tracked(spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }))
  let stderr = ''
  child.stderr.on('data', (part: Buffer) => (stderr += part.toString('utf8')))
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  return new Promise(resolve =>
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: signal === null ? code : null, line: stderr.trim().split('\n').pop() ?? '' })
    }),
  )
}

/** Uma pasta de teste nova, no lugar do tmpdir da ponte, com caminho curto o bastante para o socket. */
export function scratchTmp(name: string): string {
  const dir = join(RUNTIME, `tmp-${process.pid}-${name}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export const UID = process.getuid?.() ?? -1
export const modeOf = (path: string): number => statSync(path).mode & 0o777

/** O desligamento pedido pela própria ponte (`/shutdown`), igual em todo sistema; devolve o código de saída. */
export async function shutdown(bridge: Bridge): Promise<number | null> {
  const gone = exited(bridge)
  await post(bridge, '/shutdown', {})
  return gone
}

export const texts = (events: readonly BridgeEvent[]): string[] => events.flatMap(event => (event.kind === 'text' ? [event.delta] : []))
export const exited = (bridge: Bridge): Promise<number | null> => new Promise(resolve => bridge.child.once('exit', code => resolve(code)))
export const logged = (bridge: Bridge): Json[] => readFileSync(bridge.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Json)
/** Os parâmetros de cada pedido `method` que a ponte fez ao App Server falso, na ordem. */
export const asked = (bridge: Bridge, method: string): Json[] => logged(bridge).filter(entry => entry.method === method).map(entry => entry.params as Json)
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** O pid do App Server falso, quando ele já escreveu no registro. */
export async function pidOf(bridge: Bridge): Promise<number> {
  for (let round = 0; round < 100; round += 1) {
    const entry = existsSync(bridge.log) ? logged(bridge).find(line => line.method === 'pid') : undefined
    if (entry !== undefined) return (entry.params as Json).pid as number
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('o App Server falso não subiu em 5 s')
}

/** `extra` entra no `/threads/ensure` (a sessão do binding, as instruções). */
export async function turn(bridge: Bridge, key: string, text: string, extra: Json = {}): Promise<number> {
  await post(bridge, '/threads/ensure', { key, cwd: HERE, model: 'gpt-6.1-sol', dynamicTools: [MEMORY], ...extra })
  const { seq } = await post(bridge, '/turns', { key, text, model: 'gpt-6.1-sol', effort: 'low' })
  return seq as number
}
