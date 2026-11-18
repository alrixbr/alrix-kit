// Dublê do codex para testar scripts/codex-rodar.mjs sem gastar cota.
// Imita `codex exec … --json -o <arquivo> -`: lê a entrada padrão, imprime eventos e grava a última mensagem.
// Na ficha, uma linha "ESCREVER: <caminho relativo>" faz o dublê criar esse arquivo na pasta atual;
// uma linha "LIMITE" faz o dublê falhar como o codex falha quando o limite acaba.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argumentos = process.argv.slice(2)
const final = argumentos[argumentos.indexOf('-o') + 1]
let texto = ''
process.stdin.setEncoding('utf8')
for await (const pedaco of process.stdin) texto += pedaco

const diga = evento => process.stdout.write(JSON.stringify(evento) + '\n')
diga({ type: 'thread.started', thread_id: '00000000-0000-7000-8000-000000000001' })
diga({ type: 'turn.started' })

if (/^LIMITE$/m.test(texto)) {
  diga({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } })
  process.exit(1)
}

for (const achado of texto.matchAll(/^ESCREVER: (.+)$/gm)) {
  const alvo = path.resolve(process.cwd(), achado[1].trim())
  mkdirSync(path.dirname(alvo), { recursive: true })
  writeFileSync(alvo, 'escrito pelo dublê\n')
}

writeFileSync(final, `dublê: recebi ${texto.length} caracteres; argumentos: ${argumentos.join(' ')}\n`)
diga({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
