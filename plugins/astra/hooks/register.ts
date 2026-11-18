import type { EngineInterface, Register, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { displayText } from './activity'
import { bridgeArgv, bridgeLife } from './bridge-client'
import { readConfig } from './config'
import { registerForeign } from './foreign'
import { argvOf, parseLaunch, type Launch } from './launch'
import { isGptModel, nativeStep } from './native'
import { registerNative } from './native-session'
import { PROFILES } from './profiles'
import { agentsOf, listText, viewAnswer, type ViewSpec } from './view'

type Step = Pick<TurnStepInput, 'turnId' | 'index'>

const COMMAND = 'astra'
const VIEW: ViewSpec = { command: COMMAND, title: 'Astra', types: PROFILES }

/** O tipo de cada subagente já visto: o perfil Astra dele, ou null para o agente que não é Astra. */
const seen = new Map<string, string | null>()
/** O argv do processo, lido uma vez por carga do módulo: no session.start ou, se um hot reload não o rodou, no primeiro passo. */
let argvLaunch: Launch | undefined
/**
 * O agente do loop principal como o Claude Code o resolveu no último pedido da sessão. Fica no `$.state`, que
 * sobrevive ao recarregamento do mod (as variáveis do módulo recomeçam); antes do primeiro pedido, vale o do argv.
 */
const MAIN_AGENT = { plugin: 'astra', key: 'mainAgent' } as const

/**
 * O argv do processo, de `/proc/self/cmdline` (só no Linux): no Windows e no macOS não há `/proc`, e o agente do loop
 * principal vem só do que o Claude Code resolveu no pedido (`classic.UserPromptSubmit`, mais abaixo).
 */
async function readLaunch($: EngineInterface): Promise<Launch> {
  try {
    return parseLaunch(argvOf(await $.fs.read('/proc/self/cmdline')))
  } catch {
    return {}
  }
}

/**
 * Com que agente e em que equipe o processo roda: a equipe e o nome do argv; o agente, o que o Claude Code resolveu
 * no último pedido desta sessão. O argv só diz o agente pelo nome completo (`--agent astra:sol`, ou o `--agent-type`
 * do painel): o nome curto (`--agent sol`) o mod não resolve, porque o Claude Code pode tê-lo dado a outro plugin.
 * Resíduo: o turno que o Claude Code abre sem UserPromptSubmit (poll-event, despacho vazio de poll, a chamada que junta
 * notificações no `-p`/SDK, permissão órfã) vale o argv até o primeiro pedido de verdade, se a sessão não tem tipo guardado.
 */
async function launchOf($: EngineInterface): Promise<Launch> {
  argvLaunch ??= await readLaunch($)
  const { value: resolved } = await $.state.get(MAIN_AGENT)
  if (resolved === undefined || resolved.sessionId !== (await $.session.id())) return argvLaunch
  return { ...argvLaunch, type: resolved.type ?? undefined }
}

/**
 * O perfil Astra do loop do passo: o tipo do subagente ou, no loop principal, o agente com que a sessão roda;
 * undefined quando o loop não é de um perfil do mod.
 */
async function astraTypeOf($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) {
    const type = (await launchOf($)).type
    return type !== undefined && PROFILES.has(type) ? type : undefined
  }
  if (!seen.has(agentId)) {
    const type = (await $.agent.list()).find(agent => agent.id === agentId)?.type
    if (type === undefined) return undefined
    seen.set(agentId, PROFILES.has(type) ? type : null)
  }
  return seen.get(agentId) ?? undefined
}

function* endTurn(e: Step, answer: string, index: number): Generator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index, text: answer }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
}

/**
 * O passo de um perfil Astra que chegou com um modelo Claude: o agente nasceu antes dos perfis com modelo do Codex
 * (`agents/*.md`), ou a sessão foi aberta com `--model`. O caminho do `codex exec` que atendia esse passo foi arquivado
 * na F7, e o passo de um Astra nunca vai ao modelo Claude no lugar do Codex.
 */
function* claudeModelAstra(e: Step, type: string, model: string): Generator<TurnStepChunk, TurnStepResult> {
  const answer = `[astra] O agente ${type} chegou com o modelo ${displayText(model)}, que não é do Codex, e o passo não vai ao modelo Claude no lugar dele. `
    + 'Abra o agente de novo com um modelo do Codex (os agentes do astra usam gpt-6.2-astra e gpt-6.2-sol); se a sessão foi aberta antes de atualizar o astra, rode /reload-plugins antes.'
  return yield* endTurn(e, answer, 0)
}

/** O passo de um modelo do Codex que falhou: o motivo vira a resposta, e o passo nunca segue para a API da Anthropic. */
function* failedNative(e: Step, reason: string): Generator<TurnStepChunk, TurnStepResult> {
  return yield* endTurn(e, `[astra] O Codex não conseguiu responder a este passo: ${displayText(reason)}`, 0)
}

export const register: Register = (on, options) => {
  // As opções do /config (acesso total, caminho do Codex); mudar uma recarrega o mod e roda isto de novo.
  const config = readConfig(options)

  // Os tipos de agente que outro plugin registra: o prompt e as ferramentas de cada um, para o passo GPT dele.
  registerForeign(on)

  // O passo de um modelo do Codex vai ao App Server pela ponte da sessão; o resto segue para o modelo, menos o de um
  // perfil Astra que chegou com modelo Claude, que fecha com o aviso.
  on('turn.step', async function* ($, e, next) {
    if (isGptModel(e.model)) return yield* nativeStep($, e, next.signal, e.agentId === undefined ? (await launchOf($)).type : undefined)
    const type = await astraTypeOf($, e.agentId)
    if (type === undefined) return yield* next(e)
    return yield* claudeModelAstra(e, type, e.model)
  }).catch(async function* ($, e, next) {
    const reason = next.error.kind === 'timeout' ? 'passou do tempo do hook' : (next.error.message ?? 'erro sem mensagem')
    if (!next.called && isGptModel(e.model)) return yield* failedNative(e, reason)
    // O passo de outro agente segue como veio; o de um Astra (perfil já visto) nunca cai no modelo do agente.
    const isAstra = e.agentId === undefined ? PROFILES.has(argvLaunch?.type ?? '') : typeof seen.get(e.agentId) === 'string'
    if (next.called || !isAstra) return yield* next(e)
    return yield* failedNative(e, reason)
  })

  // As entregas no meio do turno, a compactação e o `/clear` dos loops do Codex.
  registerNative(on)

  // A cada pedido, o agente do loop principal como o Claude Code o resolveu (chega antes do primeiro passo do turno):
  // o nome curto (`--agent sol`) já resolvido e o agente que ele restaura no `--resume`/`--continue`, que o argv não diz.
  // Só observa: se falhar, o pedido segue.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.agent_id === undefined) await $.state.set(MAIN_AGENT, { sessionId: await $.session.id(), type: e.agent_type ?? null })
    return next(e)
  }).catch((_$, e, next) => next(e))

  // `/astra` lista os agentes Astra da sessão; `/astra ver [N]` põe a conversa de um deles na tela principal.
  // Depois, o laço da ponte do Codex fica esperando o primeiro passo GPT, sem processo nenhum até lá.
  on('session.start', async ($, e, next) => {
    argvLaunch = await readLaunch($)
    const description = 'Agentes Astra (Codex) desta sessão; /astra ver mostra a conversa de um deles'
    await $.command.register({ name: COMMAND, description, argumentHint: '[ver N | voltar]', immediate: true })
    const started = await next(e)
    void bridgeLife($, bridgeArgv($.plugin.root, await $.session.id(), config))
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: (await viewAnswer($, e.args, VIEW)) ?? listText(await agentsOf($, VIEW), VIEW) }))
}
