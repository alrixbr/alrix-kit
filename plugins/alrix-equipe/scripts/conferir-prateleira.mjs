// Confere as duas prateleiras, a do plugin (prateleira/) e a da pessoa (<pasta do Claude Code>/alrix-equipe/prateleira),
// juntas como o mod as lê, com o mesmo código (montarPrateleira, em hooks/prateleira.ts), e mais as conferências que só
// dá para fazer fora do mod: o arquivo de cada skill aprovada existe, a impressão digital e o tamanho batem, a pasta de
// cada projeto existe neste computador.
//
// Uso: node scripts/conferir-prateleira.mjs [pasta do plugin] [--sem-pessoa]
// A pasta do Claude Code é a de CLAUDE_CONFIG_DIR, quando a variável existe, senão ~/.claude. Com --sem-pessoa, só a
// do plugin. Sai com 0 quando não há problema e com 1 quando há. Pede Node 22.18 ou mais novo (lê .ts direto).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const semPessoa = args.includes('--sem-pessoa')
const raiz = resolve(args.find(a => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const pasta = join(raiz, 'prateleira')
const config = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
const pastaPessoa = join(config, 'alrix-equipe', 'prateleira')
const barras = c => c.replace(/\\/g, '/')

/** Texto de cada arquivo, pela chave que o mod usa: "prateleira/kits.json", "pessoa/projetos/x.json". */
const arquivos = {}
const ler = (dir0, prefixo) => {
  for (const sub of ['', 'projetos', 'tipos']) {
    const dir = sub === '' ? dir0 : join(dir0, sub)
    if (!existsSync(dir)) continue
    for (const nome of readdirSync(dir).sort()) {
      const inteiro = join(dir, nome)
      if (!statSync(inteiro).isFile() || !/\.(json|md)$/.test(nome)) continue
      arquivos[`${prefixo}${sub === '' ? '' : `${sub}/`}${nome}`] = readFileSync(inteiro, 'utf8')
    }
  }
}
ler(pasta, 'prateleira/')
const temPessoa = !semPessoa && existsSync(pastaPessoa)
if (temPessoa) ler(pastaPessoa, 'pessoa/')

const { montarPrateleira } = await import(pathToFileURL(join(raiz, 'hooks', 'prateleira.ts')).href)
const { prateleira: p, problemas: brutos } = montarPrateleira(arquivos)
// os problemas da prateleira da pessoa citam a pasta de verdade, para ela achar o arquivo
const problemas = brutos.map(x => (x.startsWith('pessoa/') ? `${barras(pastaPessoa)}/${x.slice('pessoa/'.length)}` : x))
const extras = []
const avisos = []

// Modelos: um só padrão, ids sem repetição.
const modelos = p.motores.flatMap(m => m.modelos.map(d => ({ motor: m.id, ...d })))
const padroes = modelos.filter(m => m.padrao === true)
if (padroes.length !== 1) extras.push(`motores.json: ${padroes.length} modelos padrão; tem de haver exatamente um`)
const vistos = new Set()
for (const m of modelos) {
  if (vistos.has(m.id)) extras.push(`motores.json: modelo "${m.id}" repetido`)
  vistos.add(m.id)
}

// Política de modelos e cartão, que o código do mod aplica (hooks/ficha.ts): avisos, não problemas, porque o mod já
// recusa ou pergunta por conta própria; servem para a prateleira não prometer ao chefe o que o mod não deixa.
const { usoDoModelo } = await import(pathToFileURL(join(raiz, 'hooks', 'ficha.ts')).href)
for (const m of modelos) {
  if (m.motor === 'claude' && usoDoModelo(m.id) === 'fora') avisos.push(`motores.json: ${m.id} está na prateleira, mas especialista do Claude só usa Sonnet ou Opus (Fable com pedido da pessoa); o mod recusa ficha com ele e o tira do cardápio`)
  // Quando o cartão aparece é regra do código (cartaoSempreDe); estes campos antigos não são lidos.
  for (const campo of ['cartao', 'esforcosComCartao']) {
    if (m[campo] !== undefined) avisos.push(`motores.json: ${m.id} ainda tem o campo "${campo}", que o mod não lê (a regra do cartão é do código); pode sair`)
  }
}

// Lista livre: o que está nela nasce sem ficha. Os ajudantes do Claude Code que escrevem arquivos (general-purpose,
// claude, statusline-setup) nasceriam sem território; Explore e Plan não editam, mas têm o terminal.
const QUE_ESCREVEM = ['general-purpose', 'claude', 'statusline-setup']
for (const t of p.casa.listaLivre) {
  if (QUE_ESCREVEM.includes(t)) avisos.push(`casa.json: a lista livre tem "${t}", ajudante do Claude Code que escreve arquivos e nasceria sem ficha e sem território`)
  if (t === '*') avisos.push('casa.json: a lista livre tem "*", e todo ajudante que não vem no Claude Code nasce sem ficha')
}

// Kits: as marcas "escreve" e "shell" batem com as ferramentas; o equipamento do Codex tem a forma certa.
const ESCREVE = ['Edit', 'Write', 'NotebookEdit']
const SHELL = ['Bash', 'PowerShell']
const listaDeTextos = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '')
for (const k of p.kits) {
  if (k.ferramentas.length === 0) extras.push(`kits.json: ${k.id} não tem ferramenta`)
  const escreve = k.ferramentas.some(f => ESCREVE.includes(f))
  const shell = k.ferramentas.some(f => SHELL.includes(f))
  if (escreve !== k.escreve) extras.push(`kits.json: ${k.id} diz escreve=${k.escreve}, e as ferramentas dizem ${escreve}`)
  if (shell !== k.shell) extras.push(`kits.json: ${k.id} diz shell=${k.shell}, e as ferramentas dizem ${shell}`)
  if (k.codex !== undefined) {
    for (const campo of ['config', 'habilitar', 'desabilitar']) {
      if (k.codex[campo] !== undefined && !listaDeTextos(k.codex[campo])) extras.push(`kits.json: ${k.id}.codex.${campo} é uma lista de textos`)
    }
    for (const c of Array.isArray(k.codex.config) ? k.codex.config : []) {
      if (typeof c === 'string' && !/^[A-Za-z0-9_.@-]+=.+$/.test(c)) extras.push(`kits.json: ${k.id}.codex.config "${c}" não é chave=valor`)
    }
  }
}

// Lições: cada "vale" é "todos", "esta-pasta" ou o id de um tipo, projeto ou kit que existe.
const alvos = new Set(['todos', 'esta-pasta', ...p.tipos.map(t => t.id), ...p.projetos.map(x => x.id), ...p.kits.map(k => k.id)])
for (const l of p.licoes) {
  for (const v of l.vale) if (!alvos.has(v)) extras.push(`licoes.json: ${l.id} vale em "${v}", que não é tipo, projeto nem kit`)
}

// Skills aprovadas: o arquivo existe, a impressão digital e o tamanho são os de agora.
const caminhoReal = c => (c.startsWith('~/') ? join(homedir(), c.slice(2)) : c)
let conferidas = 0
for (const a of p.aprovados) {
  if (!/[\\/]/.test(a.origem)) {
    avisos.push(`aprovados.json: ${a.id} vem de "${a.origem}" (não é caminho); arquivo não conferido`)
    continue
  }
  const arquivo = caminhoReal(a.origem)
  if (!existsSync(arquivo)) {
    extras.push(`aprovados.json: ${a.id}: o arquivo ${a.origem} não existe`)
    continue
  }
  const bytes = readFileSync(arquivo)
  const caracteres = bytes.toString('utf8').length
  if (caracteres !== a.peso) extras.push(`aprovados.json: ${a.id}: peso ${a.peso}, e o arquivo tem ${caracteres} caracteres`)
  if (a.versao.startsWith('sha256:')) {
    const agora = createHash('sha256').update(bytes).digest('hex')
    if (agora !== a.versao.slice('sha256:'.length).toLowerCase()) extras.push(`aprovados.json: ${a.id}: o arquivo mudou desde a aprovação (a impressão digital não bate); aprove de novo com a ferramenta skills`)
  } else avisos.push(`aprovados.json: ${a.id}: versão "${a.versao}" não é impressão digital; conteúdo não conferido`)
  conferidas += 1
}

// Projetos: a pasta deste computador existe, e os arquivos de onde as versões são lidas também.
for (const x of p.projetos) {
  if (x.pc?.pasta === undefined) continue
  const base = caminhoReal(x.pc.pasta)
  if (!existsSync(base)) {
    extras.push(`projetos/${x.id}.json: a pasta ${x.pc.pasta} não existe neste computador`)
    continue
  }
  for (const f of x.arquivosDeVersao ?? []) {
    if (!existsSync(join(base, f))) extras.push(`projetos/${x.id}.json: arquivosDeVersao cita ${f}, que não existe em ${x.pc.pasta}`)
  }
}

const linha = (titulo, itens) => (itens.length ? [`${titulo} (${itens.length}):`, ...itens.map(i => `  - ${i}`)] : [])
const daPessoa = Object.keys(arquivos).filter(k => k.startsWith('pessoa/')).length
const saida = [
  `Prateleira do plugin em ${barras(pasta)}`,
  semPessoa
    ? 'Prateleira da pessoa: não conferida (--sem-pessoa).'
    : temPessoa
      ? `Prateleira da pessoa em ${barras(pastaPessoa)} (${daPessoa} arquivos)`
      : `Prateleira da pessoa: ainda não existe (${barras(pastaPessoa)}); ela nasce quando você grava um projeto ou aprova uma skill.`,
  `${Object.keys(arquivos).length} arquivos lidos · ${p.projetos.length} projetos · ${p.tipos.length} tipos · ${p.kits.length} kits · ` +
    `${p.aprovados.length} skills (${conferidas} com o arquivo conferido) · ${p.licoes.length} lições · ${modelos.length} modelos`,
  ...linha('Problemas que o mod aponta', problemas),
  ...linha('Problemas das conferências de fora', extras),
  ...linha('Avisos', avisos),
  problemas.length + extras.length === 0 ? 'Nenhum problema.' : `${problemas.length + extras.length} problema(s).`,
]
console.log(saida.join('\n'))
process.exit(problemas.length + extras.length === 0 ? 0 : 1)
