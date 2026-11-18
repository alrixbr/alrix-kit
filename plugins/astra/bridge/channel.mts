// O canal entre o mod e a ponte, escolhido por sistema. No Linux e no macOS, um socket Unix numa pasta privada
// (`rundir.mts`). No Windows, TCP em 127.0.0.1 numa porta sorteada: lá o Node só escuta em pipe nomeado, e o
// `$.http.fetch` do Claude Code recusa um `socketPath` em `\\.\pipe\` como local de rede (medido em 17/11/2026,
// `_dev/astra/probe-channel`). Nos dois, todo pedido traz o segredo da sessão: sem ele, outro processo ou outro usuário
// da máquina não manda comando à ponte, mesmo que ache o socket ou a porta.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { socketPathFor } from './rundir.mts'

export const LOOPBACK = '127.0.0.1'
/** O cabeçalho do segredo; o nome tem `secret`, e o Claude Code o esconde no registro de depuração. */
export const SECRET_HEADER = 'x-astra-secret'

export type Channel = { kind: 'unix'; path: string } | { kind: 'tcp'; host: typeof LOOPBACK }

/** `wanted`: o `--channel` dos testes; sem ele, o do sistema. */
export function channelFor(platform: NodeJS.Platform, wanted: string | undefined, session: string, epoch: string): Channel {
  const kind = wanted ?? (platform === 'win32' ? 'tcp' : 'unix')
  if (kind === 'tcp') return { kind: 'tcp', host: LOOPBACK }
  if (kind !== 'unix') throw new Error('--channel precisa ser unix ou tcp')
  if (platform === 'win32') throw new Error('no Windows a ponte não abre socket Unix: o canal é TCP em 127.0.0.1')
  return { kind: 'unix', path: socketPathFor(session, epoch) }
}

/** 32 bytes aleatórios por ponte: o segredo só sai pela 1ª linha do stdout, que só o processo que abriu a ponte lê. */
export const newSecret = (): string => randomBytes(32).toString('base64url')

/** Onde o mod fala com a ponte: o caminho do socket, ou a URL de base no TCP. */
export const endpointOf = (channel: Channel, port: number): string => (channel.kind === 'unix' ? channel.path : `http://${LOOPBACK}:${port}`)

const sameText = (given: string, expected: string): boolean => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Por que o pedido é recusado, ou undefined se ele passa. No TCP também se confere o `Host` (um site aberto no
 * navegador que aponta um nome para 127.0.0.1 manda outro) e se recusa o pedido com `Origin`, que só um navegador põe.
 */
export function refusalOf(request: IncomingMessage, secret: string, tcpHost: string | undefined): string | undefined {
  const given = request.headers[SECRET_HEADER]
  if (typeof given !== 'string' || !sameText(given, secret)) return 'pedido sem o segredo desta ponte'
  if (tcpHost === undefined) return undefined
  if (request.headers.host !== tcpHost) return 'pedido com um Host que não é o desta ponte'
  if (request.headers.origin !== undefined) return 'pedido de navegador'
  return undefined
}
