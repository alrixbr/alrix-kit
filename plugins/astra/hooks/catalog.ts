import type { EngineInterface } from 'claude-code'
import { placeOf } from './catalog-policy'
import { joinPath } from './paths'

/**
 * As ferramentas do Claude Code que o Codex recebe como `dynamicTools` num loop: as da política (`catalog-policy.ts`)
 * que a sessão tem agora, com o schema capturado do próprio motor (`scripts/sync-tools.mts`) e a descrição de hoje
 * (`$.tool.list()`: a do `Agent` lista os tipos de agente desta sessão). Um agente com `tools:` vê só as dele; o
 * motor barra de qualquer jeito a chamada fora dessa lista.
 */
const SCHEMAS_FILE = 'schemas/claude-tools.json'
const NAMESPACE = 'claude_code'
const NAMESPACE_TEXT = 'Tools of the Claude Code session that runs you, loaded on demand.'
/** O nome que o App Server aceita numa ferramenta dinâmica (o mesmo limite que o OpenClaw confere). */
const VALID_NAME = /^[a-zA-Z0-9_-]{1,128}$/
const AGENT_NAME = /^astra:([a-z0-9-]+)$/

type Schema = Readonly<Record<string, unknown>>
/** Quais ferramentas o loop pode ter: o `tools:` de um agente, ou o que um tipo de fora registrou. */
export type Allowed = { has: (name: string) => boolean }
type Listed = { name: string; description: string }
type Spec = { type: 'function'; name: string; description: string; inputSchema: Schema; deferLoading?: true }

/** `dynamicTools` vai ao `thread/start`; `names` leva o nome que o Codex chama de volta ao do Claude Code. */
export type Catalog = { dynamicTools: readonly object[]; names: ReadonlyMap<string, string> }

/**
 * O nome que o Codex vê: o App Server (medido na 0.163.0) recusa ferramenta dinâmica com o prefixo `mcp__`, que é dele ("dynamic tool
 * name is reserved", medido em 25/10); os outros nomes do Claude Code ele aceita como estão (`Read`, `Bash`, `Agent`).
 */
export const codexName = (name: string): string => (name.startsWith('mcp__') ? `mcp_${name.slice('mcp__'.length)}` : name)

const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Os schemas do arquivo, sem o `$schema` (só metadado) e só os de objeto, que é o que uma função aceita. */
export function parseSchemas(text: string): ReadonlyMap<string, Schema> {
  const parsed: unknown = JSON.parse(text)
  const tools = isSchema(parsed) && Array.isArray(parsed.tools) ? parsed.tools : []
  return new Map(
    tools.flatMap((tool: unknown) => {
      if (!isSchema(tool) || typeof tool.name !== 'string' || !isSchema(tool.inputSchema) || tool.inputSchema.type !== 'object') return []
      const { $schema: _meta, ...schema } = tool.inputSchema
      return [[tool.name, schema] as const]
    }),
  )
}

/** O `tools:` do frontmatter de um agente (`tools: A, B` ou `tools: ["A", "B"]`); sem a linha, o agente não restringe. */
export function toolsLine(text: string): ReadonlySet<string> | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const line = front?.split(/\r?\n/).find(row => row.startsWith('tools:'))
  if (line === undefined) return undefined
  return new Set(line.slice('tools:'.length).replace(/[[\]"']/g, '').split(',').map(name => name.trim()).filter(name => name !== ''))
}

/**
 * O catálogo de um loop. A troca do `mcp__` não junta dois nomes: na política, só as de MCP começam com `mcp`, e todas
 * com `mcp__`, onde tirar um `_` é injetor.
 */
export function buildCatalog(listed: readonly Listed[], schemas: ReadonlyMap<string, Schema>, allowed?: Allowed): Catalog {
  const picked = listed.flatMap(tool => {
    const place = placeOf(tool.name)
    const inputSchema = schemas.get(tool.name)
    const name = codexName(tool.name)
    if (place === undefined || inputSchema === undefined || !VALID_NAME.test(name) || (allowed !== undefined && !allowed.has(tool.name))) return []
    return [{ place, original: tool.name, spec: { type: 'function' as const, name, description: tool.description, inputSchema } }]
  })
  const direct: readonly Spec[] = picked.filter(tool => tool.place === 'direct').map(tool => tool.spec)
  const deferred: readonly Spec[] = picked.filter(tool => tool.place === 'deferred').map(tool => ({ ...tool.spec, deferLoading: true as const }))
  const namespace = deferred.length === 0 ? [] : [{ type: 'namespace', name: NAMESPACE, description: NAMESPACE_TEXT, tools: deferred }]
  return { dynamicTools: [...direct, ...namespace], names: new Map(picked.map(tool => [tool.spec.name, tool.original])) }
}

let schemas: Promise<ReadonlyMap<string, Schema>> | undefined

function schemasOf($: EngineInterface): Promise<ReadonlyMap<string, Schema>> {
  schemas ??= $.fs.read(joinPath($.plugin.root, SCHEMAS_FILE)).then(parseSchemas, (error: unknown) => {
    schemas = undefined
    throw error
  })
  return schemas
}

/** As ferramentas que o arquivo de um agente `astra:*` declara; outro tipo de agente, ou nenhum, não restringe aqui. */
async function allowedFor($: EngineInterface, agentType: string | undefined): Promise<ReadonlySet<string> | undefined> {
  const name = agentType === undefined ? undefined : AGENT_NAME.exec(agentType)?.[1]
  return name === undefined ? undefined : toolsLine(await $.fs.read(joinPath($.plugin.root, 'agents', `${name}.md`)))
}

/** `foreign`: as ferramentas que um tipo de outro plugin registrou (`native-agent.ts`), quando ele restringe. */
export async function catalogFor($: EngineInterface, agentType: string | undefined, foreign?: Allowed): Promise<Catalog> {
  const [listed, known, allowed] = await Promise.all([$.tool.list(), schemasOf($), allowedFor($, agentType)])
  return buildCatalog(listed, known, allowed ?? foreign)
}
