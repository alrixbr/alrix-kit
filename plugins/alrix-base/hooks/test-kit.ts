// O que os testes dividem: arquivos de mentira por baixo do módulo, em bytes, como o `$.fs` os entrega.
// Não é arquivo de teste (sem `.test.`): o `claude plugin test` o importa e não o roda.
import type { On } from 'claude-code'

const codifica = new TextEncoder()

/** O motor escreve o caminho do jeito do sistema (no Windows, C:\pasta\arquivo): a árvore é lida sem letra de unidade e com barra comum. */
const limpo = (caminho: string): string => caminho.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')

/** Arquivos de teste: caminho -> texto. */
export type Arvore = Readonly<Record<string, string>>

function base64De(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** O sistema de arquivos que o módulo lê: o que não está na árvore dá ENOENT; a leitura em bytes respeita offset e length. */
export function arquivos(on: On, arvore: Arvore): { leituras: () => number } {
  const bytes = new Map(Object.entries(arvore).map(([caminho, texto]) => [limpo(caminho), codifica.encode(texto)] as const))
  let leituras = 0
  on('fs.stat', (_, e) => {
    const conteudo = bytes.get(limpo(e.path))
    if (!conteudo) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file', size: conteudo.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const conteudo = bytes.get(limpo(e.path))
    if (!conteudo) return { deny: `ENOENT: ${e.path}` }
    leituras += 1
    const inicio = e.offset ?? 0
    const fim = e.length === undefined ? conteudo.length : Math.min(conteudo.length, inicio + e.length)
    if (e.length === undefined && conteudo.length > 4 * 1024 * 1024) return { deny: 'maior que 4 MiB' }
    const parte = conteudo.subarray(inicio, fim)
    return { value: e.as === 'bytes' ? { base64: base64De(parte) } : new TextDecoder().decode(parte) }
  })
  return { leituras: () => leituras }
}

/** Uma linha de transcrição: pedido da pessoa. */
export const pedido = (texto: string, ts: string, extra: object = {}): string =>
  JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: ts, message: { role: 'user', content: texto }, ...extra })

/** Uma linha de transcrição: o agente abre uma caixa de pergunta. */
export const pergunta = (id: string, ts: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: {} }] } })

/** Uma linha de transcrição: a pessoa responde à caixa de pergunta. */
export const resposta = (id: string, ts: string, answers: Record<string, string>): string =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { answers } })
