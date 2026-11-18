// A pasta privada da ponte e o caminho do socket. Quem troca a pasta ou o socket manda nas chamadas de ferramenta que o
// Claude Code executa, por isso cada nível é conferido com `lstat`: diretório de verdade, deste usuário, sem acesso de outros.
import { chmodSync, lstatSync, mkdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** O teto do `socketPath` do `$.http.fetch` ("near 100 B at most", na API dos mods do Claude Code 2.1.310). */
export const MAX_SOCKET_PATH = 100

const uid = (): number => process.getuid?.() ?? -1

const isExisting = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EEXIST'

/** Cria a pasta com 0700 ou aceita a que existe, só se ela for deste usuário; modo largo numa pasta própria volta a 0700. */
function ownDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (!isExisting(error)) throw error
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.uid !== uid()) throw new Error(`${path} não é uma pasta deste usuário, e a ponte não abre o socket nela`)
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700)
}

/**
 * `<XDG_RUNTIME_DIR>/alrix-astra/<sessão>/b-<epoch>.sock`. Sem `XDG_RUNTIME_DIR` (sessão aberta pelo pm2 ou por shell sem
 * login), a pasta vai para o tmpdir com o uid no nome, para outro usuário não ocupar o nome antes.
 */
export function socketPathFor(session: string, epoch: string): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  const parent = xdg === undefined || xdg === '' ? join(tmpdir(), `alrix-astra-${uid()}`) : join(xdg, 'alrix-astra')
  const dir = join(parent, session.slice(0, 8))
  const socket = join(dir, `b-${epoch}.sock`)
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new Error(`o caminho do socket passa de ${MAX_SOCKET_PATH} bytes (${socket})`)
  ownDir(parent)
  ownDir(dir)
  return socket
}

/**
 * Tira a pasta da sessão ao fechar, se o socket já saiu e ela ficou vazia; com outra ponte da mesma sessão ainda nela
 * (o `--resume` em outro processo), ela fica. A pasta-mãe nunca sai.
 */
export function releaseDir(socket: string): void {
  try {
    rmdirSync(dirname(socket))
  } catch {
    // Não vazia, ou já fora: nada a fazer.
  }
}
