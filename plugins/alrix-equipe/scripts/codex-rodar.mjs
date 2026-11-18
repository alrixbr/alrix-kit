// Roda um especialista do Codex como processo à parte, que segue vivo depois que este comando volta.
//
//   node codex-rodar.mjs <pasta do trabalho>            começa: solta um vigia e volta na hora
//   node codex-rodar.mjs --vigiar <pasta do trabalho>   (uso interno) roda o codex e grava o estado
//   node codex-rodar.mjs --parar <pasta do trabalho>    encerra o codex daquela pasta
//
// Na pasta do trabalho: pedido.json (PedidoCodex), ficha.md e, se houver, mensagem.md.
// O vigia grava lá: estado.json (EstadoCodex), eventos.jsonl (saída --json do codex), log.txt (erros)
// e final.md (a última mensagem do Codex). Os formatos estão em hooks/contrato.ts.
//
// Execução nova:  codex exec -m <modelo> -c model_reasoning_effort=<esforço> -s <modo> -C <pasta> … -
// Retomada:       codex exec resume … -c sandbox_mode=<modo> <sessão> -
// O `resume` não tem -s nem -C (codex-cli 0.167.0): o modo vai por -c e a pasta, pelo diretório atual.
// O texto entra pela entrada padrão. Só lê e grava dentro da pasta do trabalho, fora o que o Codex fizer.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { executavel } from './codex-limite.mjs'

const eu = fileURLToPath(import.meta.url)
const [primeiro, segundo] = process.argv.slice(2)
const modo = primeiro === '--vigiar' || primeiro === '--parar' ? primeiro : '--comecar'
const pasta = path.resolve((modo === '--comecar' ? primeiro : segundo) ?? '')

const arquivo = nome => path.join(pasta, nome)
const ler = nome => readFileSync(arquivo(nome), 'utf8')
const agora = () => new Date().toISOString()
const gravarEstado = estado => writeFileSync(arquivo('estado.json'), JSON.stringify(estado, null, 1))
const responder = (resultado, codigo) => { process.stdout.write(JSON.stringify(resultado) + '\n'); process.exit(codigo) }

function lerPedido() {
  const pedido = JSON.parse(ler('pedido.json'))
  if (typeof pedido.modelo !== 'string' || !pedido.modelo) throw new Error('pedido.modelo ausente')
  if (typeof pedido.pasta !== 'string' || !existsSync(pedido.pasta)) throw new Error('pedido.pasta não existe')
  if (!pedido.retomar && !existsSync(arquivo('ficha.md'))) throw new Error('ficha.md ausente')
  if (pedido.retomar && !existsSync(arquivo('mensagem.md'))) throw new Error('mensagem.md ausente na retomada')
  return pedido
}

/**
 * Arquivos que o git vê alterados, pelo caminho absoluto, com a hora de gravação de cada um; null fora de um
 * repositório. Os caminhos do `--porcelain` são relativos à raiz do repositório, que pode ficar acima da pasta do
 * projeto: por isso a raiz vem do próprio git. Com `-z` eles chegam sem aspas nem escapes (acento, espaço).
 */
function alteradosAgora(pasta) {
  const git = args => execFileSync('git', args, { cwd: pasta, encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let topo
  let texto
  try {
    topo = git(['rev-parse', '--show-toplevel']).trim()
    texto = git(['status', '--porcelain', '-z', '--untracked-files=all'])
  } catch {
    return null
  }
  if (!topo) return null
  const mapa = new Map()
  const campos = texto.split('\0')
  for (let i = 0; i < campos.length; i += 1) {
    const campo = campos[i]
    if (campo.length < 4) continue
    const xy = campo.slice(0, 2)
    // renomeado ou copiado: o campo seguinte é o nome antigo
    if (xy[0] === 'R' || xy[0] === 'C') i += 1
    const caminho = path.join(topo, campo.slice(3))
    let hora = 0
    try { hora = statSync(caminho).mtimeMs } catch { /* apagado */ }
    mapa.set(caminho.replace(/\\/g, '/'), `${xy}|${hora}`)
  }
  return mapa
}

function parar(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(pid, 'SIGTERM')
  } catch { /* já saiu */ }
}

// ------------------------------------------------------------------ começar
if (modo === '--comecar') {
  try { lerPedido() } catch (erro) { responder({ ok: false, motivo: 'pedido-invalido', detalhe: String(erro?.message ?? erro) }, 1) }
  gravarEstado({ fase: 'iniciando', iniciadoEm: agora() })
  const vigia = spawn(process.execPath, [eu, '--vigiar', pasta], { detached: true, stdio: 'ignore', windowsHide: true })
  vigia.unref()
  responder({ ok: true, vigia: vigia.pid }, 0)
}

// -------------------------------------------------------------------- parar
if (modo === '--parar') {
  let estado
  try { estado = JSON.parse(ler('estado.json')) } catch { responder({ ok: false, motivo: 'sem-estado' }, 1) }
  if (estado.fase !== 'rodando' && estado.fase !== 'iniciando') responder({ ok: true, jaTinhaAcabado: true }, 0)
  parar(estado.pid)
  parar(estado.vigia)
  gravarEstado({ ...estado, fase: 'falhou', terminouEm: agora(), erro: 'encerrado a pedido' })
  responder({ ok: true }, 0)
}

// ------------------------------------------------------------------- vigiar
const iniciadoEm = agora()
let pedido
try {
  pedido = lerPedido()
} catch (erro) {
  gravarEstado({ fase: 'falhou', iniciadoEm, terminouEm: agora(), erro: String(erro?.message ?? erro) })
  process.exit(1)
}

const sandbox = pedido.escreve ? 'workspace-write' : 'read-only'
const lista = valor => (Array.isArray(valor) ? valor.filter(item => typeof item === 'string' && item) : [])
const comuns = [
  '-m', pedido.modelo, '-c', `model_reasoning_effort=${pedido.esforco}`,
  ...lista(pedido.config).flatMap(par => ['-c', par]),
  ...lista(pedido.habilitar).flatMap(nome => ['--enable', nome]),
  ...lista(pedido.desabilitar).flatMap(nome => ['--disable', nome]),
  '--skip-git-repo-check', '--json', '-o', arquivo('final.md'),
]
const argumentos = pedido.retomar
  ? ['exec', 'resume', ...comuns, '-c', `sandbox_mode=${sandbox}`, pedido.retomar, '-']
  : ['exec', ...comuns, '-s', sandbox, '-C', pedido.pasta, ...(pedido.pastasExtras ?? []).flatMap(d => ['--add-dir', d]), '-']
const texto = pedido.retomar
  ? ler('mensagem.md')
  : ler('ficha.md') + (existsSync(arquivo('mensagem.md')) ? `\n\n${ler('mensagem.md')}` : '')

let comando, prefixo = [], shell = false
if (Array.isArray(pedido.executavel) && pedido.executavel.length) [comando, ...prefixo] = pedido.executavel
else ({ comando, prefixo, shell } = executavel())

// Com shell (último recurso no Windows) os argumentos viram uma linha só, e aspas e colchetes se perdem.
const frageis = shell ? [...lista(pedido.config), pedido.pasta, ...(pedido.pastasExtras ?? [])].filter(a => /[\s"'&|<>^%()[\]{}]/.test(a)) : []
if (frageis.length) {
  gravarEstado({
    fase: 'falhou', iniciadoEm, terminouEm: agora(),
    erro: `o executável do Codex não foi achado e, pelo shell, estes argumentos não chegam inteiros: ${frageis.join(' | ')}. Defina CODEX_BIN com o caminho do codex.`,
  })
  process.exit(1)
}

const antes = alteradosAgora(pedido.pasta)
const filho = spawn(comando, [...prefixo, ...argumentos], {
  cwd: pedido.pasta,
  stdio: ['pipe', openSync(arquivo('eventos.jsonl'), 'a'), openSync(arquivo('log.txt'), 'a')],
  shell,
  windowsHide: true,
  env: pedido.codexHome ? { ...process.env, CODEX_HOME: pedido.codexHome } : process.env,
})

let acabou = false
function fechar(codigo, erro) {
  if (acabou) return
  acabou = true
  clearTimeout(prazo)
  let sessao, uso, falha = erro
  try {
    for (const linha of ler('eventos.jsonl').split('\n')) {
      if (!linha.trim()) continue
      let evento
      try { evento = JSON.parse(linha) } catch { continue }
      if (evento.type === 'thread.started' && typeof evento.thread_id === 'string') sessao = evento.thread_id
      else if (evento.type === 'turn.completed' && evento.usage) uso = evento.usage
      else if (evento.type === 'turn.failed' || evento.type === 'error') {
        falha = String(evento.error?.message ?? evento.message ?? evento.type).slice(0, 400)
      }
    }
  } catch { /* sem eventos */ }
  let rabo = ''
  try { rabo = ler('log.txt').slice(-20_000) } catch { /* sem log */ }
  const deuCerto = codigo === 0 && !erro
  const limiteEstourou = !deuCerto && /usage limit|out of credits|usageLimitExceeded|usage_limit|credits_depleted|rate_limit_reached/i.test(`${falha ?? ''}\n${rabo}`)

  let alterados = null
  const depois = antes ? alteradosAgora(pedido.pasta) : null
  if (antes && depois) alterados = [...depois.keys()].filter(caminho => antes.get(caminho) !== depois.get(caminho))

  gravarEstado({
    fase: deuCerto ? 'terminou' : 'falhou',
    pid: filho.pid, vigia: process.pid, iniciadoEm, terminouEm: agora(), codigo,
    sessao: sessao ?? pedido.retomar, limiteEstourou, alterados, uso,
    erro: deuCerto ? undefined : (falha ?? `saiu com o código ${codigo}`),
  })
  process.exit(deuCerto ? 0 : 1)
}

const prazo = setTimeout(() => { parar(filho.pid); fechar(null, `passou de ${pedido.limiteMin ?? 90} min e foi encerrado`) }, (pedido.limiteMin ?? 90) * 60_000)
filho.on('error', erro => fechar(null, `não iniciou: ${String(erro?.message ?? erro)}`))
filho.on('exit', codigo => fechar(codigo))
gravarEstado({ fase: 'rodando', pid: filho.pid, vigia: process.pid, iniciadoEm, sessao: pedido.retomar })
filho.stdin.on('error', () => { /* o codex fechou a entrada antes */ })
filho.stdin.end(texto)
