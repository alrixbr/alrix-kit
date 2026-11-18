import type { AgentInfo, EngineInterface } from 'claude-code'

/** O que muda de um mod para o outro: o comando, o nome mostrado e quais tipos de agente são dele. */
export type ViewSpec = { command: string; title: string; types: { has: (type: string) => boolean } }

const ACTIVE: ReadonlySet<AgentInfo['status']> = new Set(['pending', 'running', 'waiting'])

export const labelOf = (agent: AgentInfo): string => agent.name ?? agent.description

/** Os agentes do mod nesta sessão, na ordem em que o Claude Code os lista. */
export async function agentsOf($: EngineInterface, spec: ViewSpec): Promise<AgentInfo[]> {
  return (await $.agent.list()).filter(agent => spec.types.has(agent.type))
}

export function listText(agents: readonly AgentInfo[], spec: ViewSpec): string {
  if (agents.length === 0) return `Nenhum agente ${spec.title} nesta sessão.`
  const lines = agents.map(agent => `\`${labelOf(agent)}\` · ${agent.type} · ${agent.status}${agent.name === undefined ? '' : ` · ${agent.description}`}`)
  const numbered = lines.map((line, position) => `${position + 1}. ${line}`)
  const help = `\`/${spec.command} ver N\` mostra a conversa do agente N (sem N, a do mais recente); \`/${spec.command} voltar\` volta à conversa principal.`
  return [`**${spec.title} nesta sessão**`, ...numbered, '', help].join('\n')
}

/** O agente pedido: pelo número da lista ou pelo nome; sem nada, o mais recente ainda ativo, senão o último. */
export function pick(agents: readonly AgentInfo[], wanted: string): AgentInfo | undefined {
  if (wanted === '') return [...agents].reverse().find(agent => ACTIVE.has(agent.status)) ?? agents[agents.length - 1]
  const position = Number(wanted)
  if (Number.isInteger(position)) return agents[position - 1]
  return agents.find(agent => agent.name === wanted)
}

/**
 * Responde `/<comando> ver [N|nome]` e `/<comando> voltar` pondo a conversa na tela principal, como a lista de
 * tarefas do Claude Code faz; undefined para qualquer outro argumento, que o comando responde do seu jeito.
 */
export async function viewAnswer($: EngineInterface, args: string, spec: ViewSpec): Promise<string | undefined> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(part => part !== '')
  if (verb === 'voltar') return (await $.ui.view({})).deny ?? 'De volta à conversa principal.'
  if (verb !== 'ver') return undefined
  const agents = await agentsOf($, spec)
  const agent = pick(agents, rest.join(' '))
  if (agent === undefined) return `Não achei esse agente.\n\n${listText(agents, spec)}`
  const { deny } = await $.ui.view({ agentId: agent.id })
  if (deny !== undefined) return `Não deu para mostrar \`${labelOf(agent)}\`: ${deny}`
  return `Mostrando a conversa de \`${labelOf(agent)}\` (${agent.type}). Para voltar: \`/${spec.command} voltar\`.`
}
