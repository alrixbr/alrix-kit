import type { EngineInterface, SessionMessage } from 'claude-code'
import type { AstraForeignAgent } from '../types/index'
import { type Allowed, type Catalog, catalogFor } from './catalog'
import { config } from './config'
import { foreignAgent } from './foreign'
import { joinPath } from './paths'
import { type Profile, PROFILES } from './profiles'
import { directiveOf, history, latestRequest } from './request'

export type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * O que muda por loop no caminho nativo: onde o Codex trabalha, com que ferramentas do Claude Code, com que instruções
 * e com que sandbox (`sandboxOf`). `history`, quando o loop já tem resposta: o que vai no 1º turno de uma thread nova,
 * que não sabe da conversa.
 */
export type LoopSetup = { cwd: string; text: string; history?: string; catalog: Catalog; sandbox: Sandbox; developerInstructions: string }

/** O que todo loop nativo precisa saber da ponte (as ferramentas longas, o Agent, as entregas). */
const BRIDGE_ROLE = 'roles/bridge.md'
const BASE_ROLE = 'roles/native.md'
const ROLE_FILES: Readonly<Record<Profile['role'], string>> = { builder: 'roles/native-builder.md', codereviewer: 'roles/codereviewer.md' }
/** As ferramentas do Claude Code que gravam: sem nenhuma delas no loop, o Codex dele também só lê. */
const WRITING_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** O teto do histórico de uma thread nova (~50 mil tokens): o começo de uma conversa mais longa fica de fora. */
const MAX_HISTORY_CHARS = 200_000

/**
 * De quem é o passo: um subagente (`agentId`) ou o loop principal, com o agente com que o processo foi lançado
 * (`--agent`, ou o `--agent-type` de um teammate em painel), já resolvido pelo `launchOf` do register.ts.
 */
export type LoopOf = { agentId?: string; mainType?: string }

/** `foreign`: o tipo é de outro plugin (ou do próprio Claude Code); `spec`, o que esse plugin registrou, se registrou. */
type Role = { type?: string; profile?: Profile; foreign?: { spec?: AstraForeignAgent } }

/**
 * A pasta que a linha `cwd:` deu a cada loop, guardada na primeira vez em que ela aparece (na memória e no `$.state`,
 * que sobrevive ao recarregamento do mod). Depois de uma compactação o 1º pedido sai do transcript, e sem isto o passo
 * seguinte abriria outra thread do Codex na pasta da sessão, gravando no lugar errado sem avisar.
 */
const CWDS = { plugin: 'astra', key: 'cwds' } as const
const loopCwds = new Map<string, string>()

async function cwdOf($: EngineInterface, key: string, asked: string | undefined): Promise<string | undefined> {
  if (asked !== undefined) {
    if (loopCwds.get(key) !== asked) {
      loopCwds.set(key, asked)
      // Guardar é só para sobreviver ao recarregamento: se falhar, a memória do módulo ainda vale nesta carga.
      await $.state.get(CWDS).then(({ value }) => $.state.set(CWDS, { ...(value ?? {}), [key]: asked })).catch(() => undefined)
    }
    return asked
  }
  const held = loopCwds.get(key)
  if (held !== undefined) return held
  const saved = await $.state.get(CWDS).then(({ value }) => value?.[key]).catch(() => undefined)
  if (saved !== undefined) loopCwds.set(key, saved)
  return saved
}

/** O loop acabou (`/clear`, ou outra conversa retomada): a pasta dele não vale para a conversa seguinte. */
export async function forgetLoopCwd($: EngineInterface, key: string): Promise<void> {
  loopCwds.delete(key)
  await $.state.get(CWDS).then(({ value }) => {
    if (value === undefined || !(key in value)) return undefined
    const { [key]: _gone, ...rest } = value
    return $.state.set(CWDS, rest)
  }).catch(() => undefined)
}

/**
 * O tipo e o perfil do loop. Sem saber o papel, o passo recusa em vez de abrir o Codex: o subagente que não está na
 * lista da sessão, e o tipo `astra:*` sem perfil em `profiles.ts`.
 */
async function roleOf($: EngineInterface, loop: LoopOf): Promise<Role | string> {
  const type = loop.agentId === undefined ? loop.mainType : (await $.agent.list()).find(agent => agent.id === loop.agentId)?.type
  if (loop.agentId !== undefined && type === undefined) return `[astra] O agente ${loop.agentId} não está na lista da sessão; sem saber o papel dele, o passo não abre o Codex.`
  if (type === undefined) return {}
  const profile = PROFILES.get(type)
  if (type.startsWith('astra:') && profile === undefined) return `[astra] O agente ${type} não tem perfil no mod (hooks/profiles.ts); sem o papel e o sandbox dele, o passo não abre o Codex.`
  if (profile !== undefined) return { type, profile }
  return { type, foreign: { spec: await foreignAgent($, type) } }
}

/**
 * O sandbox do loop, decidido aqui e nunca pelo pedido. Revisor: `read-only`. Construtor do astra e loop principal sem
 * agente: `workspace-write`, ou acesso total com a opção `fullAccess`. Tipo de outro plugin: `read-only` quando as
 * ferramentas dele não gravam (nem Edit, nem Write), senão `workspace-write`; nunca acesso total.
 */
export function sandboxOf(role: Role, fullAccess: boolean): Sandbox {
  if (role.profile?.sandbox === 'read-only') return 'read-only'
  if (role.foreign === undefined) return fullAccess ? 'danger-full-access' : 'workspace-write'
  const spec = role.foreign.spec
  const denied = new Set(spec?.disallowedTools ?? [])
  const writes = (name: string): boolean => WRITING_TOOLS.includes(name) && !denied.has(name)
  const canWrite = spec?.tools === undefined ? WRITING_TOOLS.some(writes) : spec.tools.some(writes)
  return canWrite ? 'workspace-write' : 'read-only'
}

/** As instruções da thread: o papel da ponte sempre primeiro; depois o papel do astra, ou o prompt do tipo de fora. */
async function instructionsOf($: EngineInterface, role: Role): Promise<string> {
  const files = role.profile === undefined ? [BRIDGE_ROLE] : [BRIDGE_ROLE, BASE_ROLE, ROLE_FILES[role.profile.role]]
  const texts = await Promise.all(files.map(file => $.fs.read(joinPath($.plugin.root, file))))
  const own = role.foreign?.spec?.prompt ?? ''
  return [...texts, own].map(text => text.trim()).filter(text => text !== '').join('\n\n')
}

/** As ferramentas que o tipo de fora registrou, sem as que ele tirou; undefined quando ele não restringe. */
function foreignTools(role: Role): Allowed | undefined {
  const spec = role.foreign?.spec
  if (spec === undefined || (spec.tools === undefined && spec.disallowedTools === undefined)) return undefined
  const denied = new Set(spec.disallowedTools ?? [])
  const tools = spec.tools === undefined ? undefined : new Set(spec.tools)
  return { has: name => !denied.has(name) && (tools === undefined || tools.has(name)) }
}

function historyOf(task: readonly SessionMessage[]): string | undefined {
  if (!task.some(row => row.role === 'assistant')) return undefined
  const text = history(task)
  return text.length <= MAX_HISTORY_CHARS ? text : `[astra] O começo do histórico ficou de fora; seguem os últimos ${MAX_HISTORY_CHARS} caracteres.\n\n${text.slice(-MAX_HISTORY_CHARS)}`
}

/**
 * O loop de um pedido novo. Num agente (subagente, ou o loop principal lançado com um), a linha `cwd:` do 1º pedido
 * diz onde o Codex trabalha, e vale para todos os passos do loop, também depois que esse pedido sai do transcript;
 * um diretório que não existe vira o texto de recusa, sem abrir turno.
 */
export async function setupOf($: EngineInterface, loop: LoopOf, rows: readonly SessionMessage[]): Promise<LoopSetup | string> {
  const isAgent = loop.agentId !== undefined || loop.mainType !== undefined
  const { cwd: asked, rows: task } = isAgent ? directiveOf(rows) : { cwd: undefined, rows }
  const cwd = isAgent ? await cwdOf($, loop.agentId ?? `main:${await $.session.id()}`, asked) : undefined
  if (cwd !== undefined && !(await $.fs.exists(cwd))) return `[astra] O diretório de trabalho do pedido não existe: ${cwd}`
  const role = await roleOf($, loop)
  if (typeof role === 'string') return role
  const [catalog, developerInstructions, sessionCwd] = await Promise.all([catalogFor($, role.type, foreignTools(role)), instructionsOf($, role), $.session.cwd()])
  return { cwd: cwd ?? sessionCwd, text: latestRequest(task), history: historyOf(task), catalog, developerInstructions, sandbox: sandboxOf(role, config().fullAccess) }
}
