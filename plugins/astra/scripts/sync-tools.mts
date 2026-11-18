// Gera schemas/claude-tools.json: o schema de entrada de cada ferramenta do catálogo do Codex, como o próprio Claude
// Code o manda ao modelo. Um `claude` interativo com o ANTHROPIC_BASE_URL num servidor local entrega o pedido aqui, e o
// servidor responde erro: nada chega à API. Só o campo `tools` do corpo é lido; os cabeçalhos (o login da sessão), nunca.
// Interativo, porque o `claude -p` não oferece as ferramentas que esperam a pessoa (`AskUserQuestion`, medido em 25/10):
// rodado num terminal, o `claude` usa o próprio terminal (Windows, Linux, macOS); sem terminal (Linux e macOS), ele
// roda dentro do `script`, que lhe dá um. O mod `capture/` tira as ferramentas de trás do ToolSearch, para que o pedido
// traga o schema de todas. Sai só o que a política (`hooks/catalog-policy.ts`) põe no catálogo: as ferramentas do
// próprio Claude Code, sem as de MCP, que são de cada máquina.
// Uso, num terminal, de uma pasta que o Claude Code já confia (a sessão abre nela, e a tela de confiança a prenderia):
//   node --no-warnings <plugin>/scripts/sync-tools.mts [arquivo de saída]
// O `claude` vem do PATH; instalado pelo npm no Windows (`claude.cmd`) ou fora do PATH, dê o caminho do programa na
// variável ASTRA_CLAUDE (por exemplo, o `claude.exe` do instalador oficial).
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { rename, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { placeOf } from '../hooks/catalog-policy.ts'

const here = dirname(fileURLToPath(import.meta.url))
const output = process.argv[2] ?? join(here, '..', 'schemas', 'claude-tools.json')
const RUN_MS = 180_000
/** Depois do 1º pedido com ferramentas, o tempo para chegar um maior (o do loop principal) antes de fechar a sessão. */
const SETTLE_MS = 3_000
const MAX_BODY = 64 * 1024 * 1024
const REFUSAL = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captura do sync-tools do astra: nada vai à API' } })

type Tool = { name: string; inputSchema: unknown }

async function bodyOf(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    size += chunk.length
    if (size > MAX_BODY) throw new Error('o pedido passou do tamanho esperado')
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** As ferramentas do corpo de um pedido `/v1/messages`, ou nada se ele não traz a lista. */
function toolsOf(text: string): readonly Tool[] {
  const parsed: unknown = JSON.parse(text)
  const tools = typeof parsed === 'object' && parsed !== null && 'tools' in parsed && Array.isArray(parsed.tools) ? parsed.tools : []
  return tools.flatMap((tool: unknown) =>
    typeof tool === 'object' && tool !== null && 'name' in tool && typeof tool.name === 'string' && 'input_schema' in tool
      ? [{ name: tool.name, inputSchema: tool.input_schema }]
      : [],
  )
}

const CLAUDE = process.env.ASTRA_CLAUDE ?? 'claude'
const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

/** O `claude` no terminal de quem roda; sem terminal, no do `script` (só Linux e macOS). Nunca por um shell do Windows. */
function launch(argv: readonly string[], env: Record<string, string | undefined>): ReturnType<typeof spawn> {
  if (process.stdin.isTTY) return spawn(CLAUDE, argv, { env, stdio: 'inherit', timeout: RUN_MS })
  if (process.platform === 'win32') throw new Error('rode o sync-tools num terminal (PowerShell ou Terminal do Windows): o Claude Code interativo precisa de um')
  // O `script` do macOS (BSD) recebe o comando como argumentos; o do Linux (util-linux), como uma linha só.
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', CLAUDE, ...argv] : ['-q', '-e', '-c', [CLAUDE, ...argv].map(quoted).join(' '), '/dev/null']
  return spawn('script', args, { env, stdio: ['pipe', 'ignore', 'ignore'], timeout: RUN_MS })
}

/** Um `claude` interativo com o pedido inicial `ok`; ele não sai sozinho e fecha depois de `found`. */
async function runInteractive(port: number, found: Promise<void>): Promise<void> {
  const child = launch(['--model', 'haiku', '--plugin-dir', join(here, 'capture'), 'ok'], { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` })
  const exited = once(child, 'exit')
  await Promise.race([found.then(() => sleep(SETTLE_MS)), exited])
  child.kill()
  await exited
}

/** O pedido com a maior lista de ferramentas que o motor fez nesta rodada (o do loop principal). */
async function capture(): Promise<readonly Tool[]> {
  let best: readonly Tool[] = []
  let markFound: () => void = () => undefined
  const found = new Promise<void>(resolve => {
    markFound = resolve
  })
  const server = createServer((request, response) => {
    bodyOf(request)
      .then(text => {
        if (request.method === 'POST' && (request.url ?? '').includes('/v1/messages')) {
          const tools = toolsOf(text)
          if (tools.length > best.length) best = tools
          if (tools.length > 0) markFound()
        }
      })
      .catch(() => undefined)
      .finally(() => response.writeHead(400, { 'content-type': 'application/json' }).end(REFUSAL))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await runInteractive(port, found)
  server.close()
  return best
}

const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()
const captured = await capture()
const tools = captured.filter(tool => placeOf(tool.name) !== undefined)
if (tools.length === 0) throw new Error(`nenhuma ferramenta do catálogo no pedido capturado (${captured.length} no total)`)
const source = `${version}: o pedido do próprio motor, capturado em ${new Date().toISOString().slice(0, 10)} (scripts/sync-tools.mts)`
const temporary = `${output}.tmp`
await writeFile(temporary, `${JSON.stringify({ source, tools }, null, 2)}\n`)
await rename(temporary, output)
process.stdout.write(`${tools.length} de ${captured.length} ferramentas: ${tools.map(tool => tool.name).join(', ')}\n`)
