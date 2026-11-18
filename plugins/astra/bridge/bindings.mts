// O binding de cada loop: a thread do Codex que guarda a conversa dele, num arquivo por loop, para que a ponte aberta
// depois (saída por ociosidade, queda do App Server, `--resume` da sessão) retome a mesma thread pelo `thread/resume`.
// Fica em `<estado>/<sessão>/<loop>.json`, na pasta de estado do sistema (`stateRoot`): fora de `~/.claude` e fora de
// pasta temporária, que some. Nada aqui se apaga: o binding de uma sessão antiga serve a um `--resume`.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { isRecord, textOf } from './proto.mts'

/** `account`: a conta do Codex que abriu a thread (`accountOf`); o binding de antes da F6 não a traz. */
export type Binding = { threadId: string; cwd: string; model: string; fingerprint: string; updatedAt: string; account?: string }

export type Bindings = {
  read: (session: string, key: string) => Binding | undefined
  /** Grava por cima, de forma atômica (arquivo temporário com nome aleatório e `rename`). */
  write: (session: string, key: string, binding: Binding) => void
}

export const SESSION_ID = /^[\w-]+$/

const filled = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value)

/**
 * A pasta de estado: a do `--state`; senão, a do sistema. Windows: `%LOCALAPPDATA%\alrix-astra\state`. macOS:
 * `~/Library/Application Support/alrix-astra`. Linux e o resto: `$XDG_STATE_HOME/alrix-astra`, ou
 * `~/.local/state/alrix-astra`.
 */
export function stateRoot(given: string | undefined, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (filled(given) !== undefined) return given as string
  if (platform === 'win32') return win32.join(filled(env.LOCALAPPDATA) ?? win32.join(home, 'AppData', 'Local'), 'alrix-astra', 'state')
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'alrix-astra')
  return posix.join(filled(env.XDG_STATE_HOME) ?? posix.join(home, '.local', 'state'), 'alrix-astra')
}

/** O arquivo do loop: `main:<sessão>` vira `main_<sessão>.json`; o id de um subagente fica como está. */
const fileOf = (root: string, session: string, key: string): string => join(root, session, `${key.replace(/[^\w-]/g, '_')}.json`)

/**
 * O que a thread sabe fazer e não volta pelo `thread/resume`: as ferramentas (o rollout guarda as da abertura) e as
 * instruções. Mudou, a thread retomada seria outra coisa: abre-se uma nova.
 */
export function fingerprintOf(dynamicTools: readonly unknown[], developerInstructions: string | undefined): string {
  return createHash('sha256').update(JSON.stringify({ dynamicTools, developerInstructions: developerInstructions ?? null })).digest('hex')
}

function parse(text: string): Binding | undefined {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return undefined
  const [threadId, cwd, model, fingerprint, updatedAt] = ['threadId', 'cwd', 'model', 'fingerprint', 'updatedAt'].map(key => textOf(value, key))
  if (threadId === undefined || cwd === undefined || model === undefined || fingerprint === undefined || updatedAt === undefined) return undefined
  const account = textOf(value, 'account')
  return account === undefined ? { threadId, cwd, model, fingerprint, updatedAt } : { threadId, cwd, model, fingerprint, updatedAt, account }
}

export function createBindings(root: string): Bindings {
  return {
    read: (session, key) => {
      if (!SESSION_ID.test(session)) return undefined
      try {
        return parse(readFileSync(fileOf(root, session, key), 'utf8'))
      } catch {
        return undefined
      }
    },
    write: (session, key, binding) => {
      if (!SESSION_ID.test(session)) return
      const file = fileOf(root, session, key)
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
    },
  }
}
