// Território de escrita: caminhos normalizados, "dentro de", cruzamento e as listas de "não toque em".
// Puro: nada aqui fala com o motor. Quem resolve links e `..` no disco é o porteiro (fs.stat com resolve);
// estas funções comparam os textos que ele já resolveu.

/** Caminho do Windows: começa por letra de unidade. Nele, maiúsculas e minúsculas são o mesmo arquivo. */
export const ehDoWindows = (caminho: string): boolean => /^[A-Za-z]:/.test(caminho)

/** Absoluto: "/x" ou "C:/x". */
export const ehAbsoluto = (caminho: string): boolean => /^[A-Za-z]:[\\/]/.test(caminho) || /^[\\/]/.test(caminho)

/**
 * Barras normais, `.` e `..` dobrados, sem barra no fim (a raiz fica "/" ou "c:/") e, se o caminho é do
 * Windows, tudo em minúsculas.
 */
export function normalizar(caminho: string): string {
  let texto = caminho.trim().replace(/\\/g, '/')
  const windows = ehDoWindows(texto)
  let raiz = ''
  if (windows) {
    raiz = `${texto.slice(0, 2).toLowerCase()}/`
    texto = texto.slice(2)
  } else if (texto.startsWith('/')) {
    raiz = '/'
  }
  const partes: string[] = []
  for (const parte of texto.split('/')) {
    if (parte === '' || parte === '.') continue
    if (parte === '..') {
      if (partes.length > 0 && partes[partes.length - 1] !== '..') partes.pop()
      else if (raiz === '') partes.push('..')
      continue
    }
    partes.push(parte)
  }
  const junto = raiz + partes.join('/')
  const final = junto === '' ? '.' : junto
  return windows ? final.toLowerCase() : final
}

/** O caminho absoluto de `caminho`, relativo a `base` quando não é absoluto; "~/" é a pasta do usuário. */
export function absoluto(caminho: string, base: string, casa?: string): string {
  const limpo = caminho.trim()
  if (casa !== undefined && (limpo === '~' || limpo.startsWith('~/') || limpo.startsWith('~\\'))) return normalizar(`${casa}/${limpo.slice(1)}`)
  if (ehAbsoluto(limpo)) return normalizar(limpo)
  return normalizar(`${base}/${limpo}`)
}

/** `caminho` é `raiz` ou fica abaixo dela. Os dois já normalizados. */
export function dentro(caminho: string, raiz: string): boolean {
  const a = normalizar(caminho)
  const r = normalizar(raiz)
  if (a === r) return true
  return a.startsWith(r.endsWith('/') ? r : `${r}/`)
}

export const dentroDeAlgum = (caminho: string, raizes: readonly string[]): boolean => raizes.some(raiz => dentro(caminho, raiz))

/** O primeiro par (um de cada lista) em que um caminho contém o outro; undefined quando não se cruzam. */
export function cruzamento(a: readonly string[], b: readonly string[]): [string, string] | undefined {
  for (const x of a) for (const y of b) if (dentro(x, y) || dentro(y, x)) return [x, y]
  return undefined
}

export const cruzam = (a: readonly string[], b: readonly string[]): boolean => cruzamento(a, b) !== undefined

/** Um nome com "*" valendo por qualquer trecho, comparado sem distinguir maiúsculas quando `semCaixa`. */
function casaNome(nome: string, molde: string, semCaixa: boolean): boolean {
  const escapado = molde.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escapado}$`, semCaixa ? 'i' : '').test(nome)
}

// Um padrão de `Casa.naoToque` casa com o caminho (já absoluto e normalizado)? Três formas: absoluto;
// "~/" (pasta do usuário); "**/<nome>", um nome em qualquer pasta, com "*" valendo por qualquer trecho.
// Na terceira forma vale qualquer trecho do caminho, para que uma pasta protegida cubra o que há nela.
export function casaPadrao(caminho: string, padrao: string, casa: string): boolean {
  const alvo = normalizar(caminho)
  const p = padrao.trim().replace(/\\/g, '/')
  if (p.startsWith('**/')) {
    const molde = p.slice(3)
    if (molde === '' || molde.includes('/')) return false
    return alvo.split('/').some(trecho => trecho !== '' && casaNome(trecho, molde, true))
  }
  if (p === '~' || p.startsWith('~/')) return dentro(alvo, normalizar(`${casa}/${p.slice(1)}`))
  if (ehAbsoluto(p)) return dentro(alvo, normalizar(p))
  return false
}

/** O primeiro padrão da casa que casa com o caminho. */
export const padraoQueCasa = (caminho: string, padroes: readonly string[], casa: string): string | undefined =>
  padroes.find(padrao => casaPadrao(caminho, padrao, casa))

export type Decisao = { ok: true } | { ok: false; motivo: string }

/**
 * Formas do Windows que chegam a um arquivo por outro nome e escapariam do "não toque": um trecho com ":"
 * (fluxo alternativo, como ".env::$DATA"), terminado em ponto ou espaço (o Windows os tira: ".env." é
 * ".env") ou com "~" e dígito (nome curto 8.3, como "CLAUDE~1"). Devolve o trecho, ou undefined. Não traduz:
 * quem pede escreve o caminho normal. Só para caminho do Windows.
 */
export function formaSuspeita(caminho: string): string | undefined {
  // Só o começo é aparado: o espaço no fim do nome é justamente uma das formas.
  const texto = caminho.replace(/^\s+/, '').replace(/\\/g, '/')
  if (!ehDoWindows(texto)) return undefined
  for (const trecho of texto.slice(2).split('/')) {
    if (trecho === '' || trecho === '.' || trecho === '..') continue
    if (trecho.includes(':') || /[. ]$/.test(trecho) || /~\d/.test(trecho)) return trecho
  }
  return undefined
}

/**
 * Pode escrever em `caminho`? Primeiro as formas do Windows que mudam o nome do arquivo; depois "não toque
 * em" (da ficha e do projeto, já absolutos; e os padrões da casa), que vence "trabalhe só em".
 */
export function decidirEscrita(a: {
  caminho: string
  territorio: readonly string[]
  naoToque: readonly string[]
  casaNaoToque: readonly string[]
  casa: string
}): Decisao {
  const suspeito = formaSuspeita(a.caminho)
  if (suspeito !== undefined) {
    return { ok: false, motivo: `o trecho "${suspeito}" de ${a.caminho} usa uma forma do Windows que chega ao arquivo por outro nome (fluxo com ":", ponto ou espaço no fim, nome curto com "~" e dígito); escreva o caminho normal do arquivo` }
  }
  const alvo = normalizar(a.caminho)
  const proibido = a.naoToque.find(raiz => dentro(alvo, raiz))
  if (proibido !== undefined) return { ok: false, motivo: `${alvo} está em "não toque em" (${proibido})` }
  const daCasa = padraoQueCasa(alvo, a.casaNaoToque, a.casa)
  if (daCasa !== undefined) return { ok: false, motivo: `${alvo} está na lista da casa que nenhum especialista escreve (${daCasa})` }
  if (!dentroDeAlgum(alvo, a.territorio)) {
    const onde = a.territorio.length === 0 ? 'você não tem território de escrita' : `seu território é ${a.territorio.join(', ')}`
    return { ok: false, motivo: `${alvo} fica fora do seu território (${onde})` }
  }
  return { ok: true }
}

/** A partir de quantos segundos um sleep sozinho conta como espera longa. */
export const ESPERA_LONGA_S = 30

/**
 * O texto que o shell vai rodar como código. O que está entre aspas é dado (o padrão do `grep`, a mensagem do
 * `git commit -m`, o `sed 's/…/'`) e vira `""`, a não ser quando as aspas são o código de outro interpretador
 * (`bash -c '…'`, `powershell -Command "…"`, `cmd /c "…"`, `python -c "…"`, `node -e "…"`): aí o conteúdo
 * entra, sem as aspas.
 */
export function codigoDoComando(comando: string): string {
  let saida = ''
  for (const parte of partesDoComando(semCorpoDeHeredoc(comando))) {
    if (parte.tipo === 'codigo') saida += parte.texto
    // o programa chamado pelo caminho entre aspas ("C:/Program Files/Git/bin/bash.exe") conta pelo nome
    else if (PROGRAMA_ENTRE_ASPAS.test(parte.texto) && /(?:^|[\s;&|(])\s*$/.test(saida)) saida += parte.texto.replace(/^.*[\\/]/, '')
    // o código de outro interpretador (e o que vai pelo ssh) entra numa linha própria: um `while` lá dentro começa um comando
    else saida += INTERPRETE.test(saida) || REMOTO.test(saida) ? `\n${parte.texto}\n` : '""'
  }
  return saida
}

/** Antes das aspas, o comando entrega o texto a outro interpretador: `bash -c`/`-lc`, `pwsh -Command`, `cmd /c`, `iex`, `python -c`, `node -e`. */
const INTERPRETE = /(?:^|[\s;&|(])(?:(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|python3?|py|node|deno|bun|ruby|perl)(?:\.exe)?\b[^;&|]*?\s(?:-[a-z]*c|-command|-e|\/c|\/k)|invoke-expression|iex)\s*$/i
/** Um caminho entre aspas que termina num interpretador: o programa chamado pelo caminho. */
const PROGRAMA_ENTRE_ASPAS = /[\\/](?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|python3?|py|node|ruby|perl)(?:\.exe)?$/i
/** Antes do `<<`, um interpretador: o corpo do heredoc é código, e não texto. */
const INTERPRETE_HEREDOC = /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|pwsh|powershell|python3?|py|node|deno|bun|ruby|perl|ssh)(?:\.exe)?\b[^\n<]*$/i

/**
 * O comando sem o corpo dos heredocs que são texto (`cat > roteiro.sh <<'EOF' … EOF`): o que vai para um arquivo
 * não é o que o shell roda. O corpo entregue a um interpretador (`bash <<EOF`, `python - <<EOF`, `ssh host <<EOF`)
 * fica, porque é código.
 */
export function semCorpoDeHeredoc(comando: string): string {
  return comando.replace(HEREDOC, (todo: string, menos: string, aspa: string, fim: string, resto: string, _corpo: string, onde: number, texto: string) => {
    const antes = texto.slice(texto.lastIndexOf('\n', onde - 1) + 1, onde)
    return INTERPRETE_HEREDOC.test(antes) ? todo : `<<${menos}${aspa}${fim}${aspa}${resto}\n`
  })
}

const HEREDOC = /<<(-?)[ \t]*(["']?)([A-Za-z_][\w-]*)\2([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g
/** Antes do `<<`, um interpretador de linguagem (não de shell): o corpo é um roteiro nessa linguagem. */
const LINGUAGEM_HEREDOC = /(?:^|[\s;&|(])(?:python3?|py|node|deno|bun|ruby|perl)(?:\.exe)?\b[^\n<]*$/i

/**
 * O comando sem os roteiros embutidos (`node - <<'EOF' … EOF`, `python - <<EOF … EOF`), e os roteiros à parte. O
 * roteiro é código de outra linguagem: as palavras dele (`sleep`, `for`, `while`) não são comandos de shell.
 */
export function semRoteiroEmbutido(comando: string): { resto: string; roteiros: string[] } {
  const roteiros: string[] = []
  const resto = comando.replace(HEREDOC, (todo: string, menos: string, aspa: string, fim: string, fimDaLinha: string, corpo: string, onde: number, texto: string) => {
    const antes = texto.slice(texto.lastIndexOf('\n', onde - 1) + 1, onde)
    if (!LINGUAGEM_HEREDOC.test(antes)) return todo
    roteiros.push(corpo)
    return `<<${menos}${aspa}${fim}${aspa}${fimDaLinha}\n`
  })
  return { resto, roteiros }
}
/** `ssh host "…"`: o código roda na outra máquina; conta para a espera (o especialista fica esperando do mesmo jeito). */
const REMOTO = /(?:^|[\s;&|(])ssh(?:\.exe)?(?:\s+[^\s;&|"']+)+\s*$/i

/**
 * O comando em partes: o que está fora das aspas (`codigo`) e o que está dentro (`aspas`, sem as aspas). Uma aspa
 * sem par (`echo it's`) é uma letra, e não apaga o resto do comando. Aspas duplas aceitam `\"` dentro.
 */
function partesDoComando(comando: string): { tipo: 'codigo' | 'aspas'; texto: string; aspa?: string }[] {
  const partes: { tipo: 'codigo' | 'aspas'; texto: string; aspa?: string }[] = []
  let codigo = ''
  let i = 0
  while (i < comando.length) {
    const c = comando[i] ?? ''
    if (c !== '"' && c !== "'") {
      codigo += c
      i += 1
      continue
    }
    let j = i + 1
    while (j < comando.length && comando[j] !== c) j += c === '"' && comando[j] === '\\' ? 2 : 1
    if (j >= comando.length) {
      codigo += c
      i += 1
      continue
    }
    partes.push({ tipo: 'codigo', texto: codigo })
    codigo = ''
    partes.push({ tipo: 'aspas', texto: comando.slice(i + 1, j), aspa: c })
    i = j + 1
  }
  partes.push({ tipo: 'codigo', texto: codigo })
  return partes
}

/** Onde começa um comando no shell: o início, depois de ; & | ( { ou de uma quebra, ou depois de do/then/else. */
const COMECO = String.raw`(?:^|[;&|({\n]\s*|\b(?:do|then|else)\s+)`

/** Laço: while/until/for como palavra de comando, `do {` e `for (`/`foreach (` do PowerShell, `ForEach-Object {` e `% {`, `for /l` do cmd. */
const LACO = new RegExp(String.raw`${COMECO}(?:while|until|for|foreach)\b|\bdo\s*\{|(?:\bforeach-object|(?:^|[\s|])%)\s*\{`, 'i')
/** Laço sem fim: `while true`, `while :`, `while ($true)`, `while (1)`, e `until … do` (gira até algo mudar). */
const SEM_FIM = new RegExp(String.raw`${COMECO}(?:while\s*(?:true\b|:|\(\s*(?:\$true|1)\s*\))|until\b[^\n]{0,200}\bdo\b)`, 'i')
/**
 * Espera que não termina sozinha: `watch`, `tail -f`, `Get-Content -Wait`, os logs que seguem (`pm2 logs` sem
 * `--nostream`, `docker logs -f`, `kubectl logs -f`, `journalctl -f`), `Wait-Process`, `Wait-Job`, `wait-on`,
 * `gh run watch`.
 */
const SEGUE = new RegExp(
  String.raw`${COMECO}(?:watch\b|tail\b[^;&|\n]*\s-[a-z]*f\b|(?:get-content|gc|cat)\b[^;&|\n]*\s-wait\b|` +
    String.raw`pm2\s+logs\b(?![^;&|\n]*--nostream)|(?:docker(?:\s+compose)?|docker-compose|kubectl|podman)\s+logs\b[^;&|\n]*\s(?:-[a-z]*f\b|--follow\b)|` +
    String.raw`journalctl\b[^;&|\n]*\s(?:-[a-z]*f[a-z]*\b|--follow\b)|` +
    // com prazo (`Wait-Job -Timeout 120`, `wait-on -t 20000`), a espera termina sozinha e não conta
    String.raw`(?:wait-process|wait-job)\b(?![^;&|\n]*\s-timeout\b)|(?:npx\s+)?wait-on\b(?![^;&|\n]*\s(?:-t|--timeout)\b)|gh\s+run\s+watch\b|` +
    String.raw`adb(?:\.exe)?\b[^;&|\n]*\slogcat\b(?![^;&|\n]*\s-d\b))`,
  'i',
)
/** Código que repete sem fim por conta própria: `setInterval(…)` (node -e, deno eval). */
const REPETE_SOZINHO = /\bsetInterval\s*\(/

/**
 * Os segundos de cada pausa do código: `sleep 5`, `sleep 2m`, `sleep infinity`; `Start-Sleep 5`, `-Seconds 5`,
 * `-Milliseconds 500`; `timeout /t 5`; `ping -n 6` ou `ping -c 6` (uma volta por segundo); `[Thread]::Sleep(ms)`;
 * `time.sleep(s)`; `setTimeout(…, ms)`.
 */
function pausas(codigo: string): { s: number; em: number }[] {
  const achadas: { s: number; em: number }[] = []
  // `sleep` só conta onde começa um comando: o `sleep` que é argumento (`grep -l sleep`) não é pausa
  const dorme = new RegExp(String.raw`${COMECO}(?:start-sleep|sleep)\b((?:\s+-[a-z]+)?(?:\s+|(?<=-[a-z]+):)(infinity|inf|\d+(?:\.\d+)?)([smhd]?)\b(?:\s+-[a-z]+)?)?`, 'gi')
  for (const m of codigo.matchAll(dorme)) {
    const em = m.index ?? 0
    if (m[2] === undefined) {
      achadas.push({ s: 0, em })
      continue
    }
    if (/^inf/i.test(m[2])) {
      achadas.push({ s: Number.POSITIVE_INFINITY, em })
      continue
    }
    const n = Number(m[2])
    const unidade = (m[3] ?? '').toLowerCase()
    if (/-m(illi)?s(econds)?\b/i.test(m[1] ?? '')) achadas.push({ s: n / 1000, em })
    else achadas.push({ s: n * ({ m: 60, h: 3600, d: 86_400 }[unidade] ?? 1), em })
  }
  for (const m of codigo.matchAll(/\btimeout(?:\.exe)?\s+\/t\s+(\d+)/gi)) achadas.push({ s: Number(m[1]), em: m.index ?? 0 })
  // o ping na própria máquina é o relógio do cmd (`ping -n 6 127.0.0.1 > nul`); o ping a outra máquina é teste de rede
  for (const m of codigo.matchAll(/\bping(?:\.exe)?\b([^;&|\n]*?)\s-[nc]\s+(\d+)([^;&|\n]*)/gi)) {
    if (/(?:^|\s)(?:127(?:\.\d+){3}|localhost|::1|0\.0\.0\.0)(?=\s|$)/i.test(`${m[1] ?? ''} ${m[3] ?? ''}`)) achadas.push({ s: Math.max(0, Number(m[2]) - 1), em: m.index ?? 0 })
  }
  for (const m of codigo.matchAll(/\bthread\]::sleep\s*\(\s*(\d+)/gi)) achadas.push({ s: Number(m[1]) / 1000, em: m.index ?? 0 })
  achadas.push(...pausasDeLinguagem(codigo))
  return achadas
}

/** As pausas que se escrevem como chamada de linguagem: `time.sleep(s)` e `setTimeout(…, ms)`. */
function pausasDeLinguagem(codigo: string): { s: number; em: number }[] {
  const achadas: { s: number; em: number }[] = []
  for (const m of codigo.matchAll(/\btime\.sleep\s*\(\s*(\d+(?:\.\d+)?)/gi)) achadas.push({ s: Number(m[1]), em: m.index ?? 0 })
  for (const m of codigo.matchAll(/\bsetTimeout\s*\([^\n]*?,\s*(\d+)\s*\)/gi)) achadas.push({ s: Number(m[1]) / 1000, em: m.index ?? 0 })
  return achadas
}

/**
 * Laço de um roteiro em outra linguagem que repete até algo mudar: `while` com qualquer condição (`while True:`,
 * `while (!pronto) {`, `while not pronto():`), `do {` e `for (;;)`. Como no shell, com pausa é sempre espera.
 */
const ATE_MUDAR_DE_ROTEIRO = /\bwhile\b\s*(?:\(|[^\n:;{]{1,200}:)|\bdo\s*\{|\bfor\s*\(\s*;\s*;\s*\)/gi
/** Laço de conta escrita no texto: `for (let i = 0; i < 60; i++)` e `for i in range(60):`. O número é o das voltas. */
const CONTADO_DE_ROTEIRO = /\bfor\s*\(\s*(?:let|var|const)?\s*\w+\s*=\s*0\s*;\s*\w+\s*<=?\s*(\d+)\s*;|\bfor\s+\w+\s+in\s+range\s*\(\s*(\d+)\s*\)/gi
/** Chamada de pausa pelo nome: a pausa embrulhada (`await dorme(5000)`) não traz o tempo, mas é pausa. */
const CHAMA_PAUSA = /\b(?:sleep|dorme|dormir|delay|pausa|esperar?|aguardar?|wait|setTimeout)\s*\(|\bAtomics\.wait\s*\(/gi

/** O roteiro sem os textos e os comentários: o `while` e o `sleep` que ele só cita numa frase não são código dele. */
function soCodigoDoRoteiro(roteiro: string): string {
  return roteiro
    .replace(/("""|''')[\s\S]*?\1/g, '""')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')
    .replace(/(^|\s)#[^\n]*/g, '$1')
}

/**
 * Um roteiro embutido (node, python…) espera só quando ele mesmo dorme: `setInterval`; um laço que repete até algo mudar
 * com uma pausa depois do começo dele; um laço de conta escrita cujas voltas vezes a pausa passam do limite; ou pausas
 * soltas que somam o limite. A pausa de cortesia entre os itens de uma lista (`for u in urls: … time.sleep(1)`) passa.
 * O corpo do laço não é medido: a pausa conta se vem depois do começo dele no texto. Devolve o motivo, ou undefined.
 */
function esperaDoRoteiro(roteiroInteiro: string): { motivo: string } | undefined {
  const roteiro = soCodigoDoRoteiro(roteiroInteiro)
  const laco = { motivo: `este comando é um laço de espera (repete e dorme até algo mudar). ${NO_LUGAR_DA_ESPERA}` }
  if (REPETE_SOZINHO.test(roteiro)) return laco
  const chamadas = [...roteiro.matchAll(CHAMA_PAUSA)].map(m => m.index ?? 0)
  for (const m of roteiro.matchAll(ATE_MUDAR_DE_ROTEIRO)) {
    if (chamadas.some(em => em > (m.index ?? 0))) return laco
  }
  const pausas = pausasDeLinguagem(roteiro)
  for (const m of roteiro.matchAll(CONTADO_DE_ROTEIRO)) {
    const noLaco = pausas.filter(p => p.em > (m.index ?? 0)).reduce((soma, p) => soma + p.s, 0)
    if (Number(m[1] ?? m[2]) * noLaco >= ESPERA_LONGA_S) return laco
  }
  const total = pausas.reduce((soma, p) => soma + p.s, 0)
  if (total >= ESPERA_LONGA_S) return { motivo: `este comando dorme ${Math.round(total)} s, uma espera longa. ${NO_LUGAR_DA_ESPERA}` }
  return undefined
}

/**
 * Onde fica o corpo de cada laço do código, do começo do laço ao fim dele: até o `done` que fecha o `do` (com os
 * laços de dentro contados), até a chave que fecha a `{`, ou até o fim do comando (`for /l … do …` do cmd).
 */
function corposDeLaco(codigo: string): { inicio: number; corpo: number; fim: number }[] {
  const corpos: { inicio: number; corpo: number; fim: number }[] = []
  const laco = new RegExp(LACO.source, 'gi')
  for (const m of codigo.matchAll(laco)) {
    const inicio = m.index ?? 0
    const resto = codigo.slice(inicio)
    const chave = resto.search(/(?<!\$)\{/)
    const fazer = resto.search(/\bdo\b(?!\s*\{)/i)
    if (chave >= 0 && (fazer < 0 || chave < fazer)) {
      let nivel = 0
      let fim = codigo.length
      for (let k = inicio + chave; k < codigo.length; k += 1) {
        // `${x}` é variável, não bloco
        if (codigo[k] === '{' && codigo[k - 1] === '$') k = Math.max(k, codigo.indexOf('}', k))
        else if (codigo[k] === '{') nivel += 1
        else if (codigo[k] === '}' && --nivel === 0) {
          fim = k
          break
        }
      }
      corpos.push({ inicio, corpo: inicio + chave, fim })
    } else if (fazer >= 0) {
      let nivel = 0
      let fim = codigo.length
      for (const p of codigo.slice(inicio + fazer).matchAll(/\b(do|done)\b/gi)) {
        nivel += (p[1] ?? '').toLowerCase() === 'do' ? 1 : -1
        if (nivel === 0) {
          fim = inicio + fazer + (p.index ?? 0)
          break
        }
      }
      corpos.push({ inicio, corpo: inicio + fazer, fim })
    }
  }
  return corpos
}

/** Quantos itens uma lista de laço tem, quando o texto diz: `1 2 3`, `{1..9}`, `$(seq 1 30)`, `1..10`, `(1,1,60)`. */
function contarItens(lista: string): number | undefined {
  const texto = lista.trim()
  const seq = /\$\(\s*seq\s+(\d+)(?:\s+(\d+))?(?:\s+(\d+))?\s*\)/.exec(texto)
  if (seq !== null) {
    const [a, b, c] = [seq[1], seq[2], seq[3]].map(x => (x === undefined ? undefined : Number(x)))
    if (b === undefined) return a
    if (c === undefined) return Math.max(0, (b as number) - (a as number) + 1)
    return Math.max(0, Math.floor(((c as number) - (a as number)) / Math.max(1, b as number)) + 1)
  }
  const faixa = /^\{?(-?\d+)\s*\.\.\s*(-?\d+)\}?$/.exec(texto) ?? /^\(?\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\)?$/.exec(texto)
  if (faixa !== null) return Math.abs(Number(faixa[2]) - Number(faixa[1])) + 1
  // lista escrita por extenso, sem variável, sem curinga e sem `$(…)`
  if (texto === '' || /[$`*?[]/.test(texto)) return undefined
  return texto.split(/\s+/).length
}

/**
 * Um laço de `for`/`foreach`/`ForEach-Object` com pausa só é espera quando repete a mesma coisa: com a conta das voltas
 * escrita no texto, se as voltas vezes a pausa passam do limite; sem a conta, se o corpo não usa o item da volta (a
 * pausa de cortesia entre URLs de uma lista passa; `for f in $lista; do curl x; sleep 3; done` é espera).
 * `while`, `until` e `do { } until` repetem até algo mudar: com pausa no corpo, são sempre espera.
 */
function lacoQueEspera(codigo: string, comando: string, l: { inicio: number; corpo: number }, pausaNoCorpo: number): boolean {
  const cabeca = codigo.slice(l.inicio, l.corpo)
  // `while read -r u; do …; done < lista`: um laço por linha, como o `for`; é espera só se o corpo não usa a linha
  const leitura = /\bwhile\s+(?:IFS=\S*\s+)?read\b(?:\s+-[a-z]+)*\s+([A-Za-z_]\w*)/i.exec(cabeca)
  // `yes | while read x`: a lista não acaba, e o laço é espera
  if (leitura !== null && /(?:^|[;&\n]\s*)yes\b[^;&|\n]*\|\s*while\s/i.test(codigo)) return true
  if (leitura !== null) return (comando.match(new RegExp(String.raw`\$\{?${leitura[1]}\b`, 'g')) ?? []).length === 0
  if (/\b(?:while|until)\b/i.test(cabeca) || /\bdo\s*$/i.test(cabeca.trim()) || /\bdo\s*\{/i.test(codigo.slice(l.inicio, l.corpo + 1))) return true
  let voltas: number | undefined
  let item: RegExp | undefined
  let usos = 1
  const bash = /\bfor\s+(\w+)\s+in\s+([^;\n]*?)\s*(?:;|\n)?\s*$/i.exec(cabeca.replace(/\bdo\s*$/i, ''))
  const estiloC = /\bfor\s*\(\(?\s*([^;]*);([^;]*);/i.exec(cabeca)
  const psForeach = /\bforeach\s*\(\s*\$(\w+)\s+in\s+([^)]*)\)/i.exec(cabeca)
  const cmdFor = /\bfor\s+(?:\/l\s+)?%%?(\w)\s+in\s*\(([^)]*)\)/i.exec(cabeca)
  if (psForeach !== null) {
    item = new RegExp(String.raw`\$\{?${psForeach[1]}\b`, 'gi')
    usos = 2
    voltas = contarItens(psForeach[2] ?? '')
  } else if (cmdFor !== null) {
    item = new RegExp(String.raw`%%?${cmdFor[1]}\b`, 'gi')
    usos = 2
    const partes = (cmdFor[2] ?? '').split(',').map(x => Number(x.trim()))
    voltas = /\/l/i.test(cabeca) && partes.length === 3 && partes.every(Number.isFinite) ? Math.floor(((partes[2] as number) - (partes[0] as number)) / Math.max(1, Math.abs(partes[1] as number))) + 1 : contarItens(cmdFor[2] ?? '')
  } else if (estiloC !== null) {
    const condicao = (estiloC[2] ?? '').trim()
    if (condicao === '') return true
    const limite = /(?:<=?|-l[te])\s*(\d+)/i.exec(condicao)
    voltas = limite === null ? undefined : Number(limite[1])
    item = undefined
  } else if (bash !== null) {
    item = new RegExp(String.raw`\$\{?${bash[1]}\b`, 'g')
    voltas = contarItens(bash[2] ?? '')
  } else if (/(?:foreach-object|%)\s*\{?\s*$/i.test(cabeca)) {
    // `1..5 | % { … }`: a lista vem antes do pipe
    item = /\$(?:_|PSItem)\b/gi
    const antes = /(?:^|[\s;(])(\d+\s*\.\.\s*\d+)\s*\)?\s*\|\s*$/.exec(codigo.slice(0, l.inicio))
    voltas = antes === null ? undefined : contarItens(antes[1] ?? '')
  }
  if (voltas !== undefined) return voltas * pausaNoCorpo >= ESPERA_LONGA_S
  if (item === undefined) return true
  return (comando.match(item) ?? []).length < usos
}

/** O que fazer no lugar de esperar; vai junto de toda recusa de espera. */
export const NO_LUGAR_DA_ESPERA =
  'Rode o comando uma vez e leia o resultado. Para esperar um processo, rode-o até o fim no mesmo comando, ou em segundo plano (run_in_background), que avisa quando ele termina. Se o que você espera depende do chefe, de outro agente ou de uma pessoa, siga com o resto e diga isso na devolução.'

/** O que pode haver entre duas pausas seguidas: os próprios comandos de pausa, os números, as opções e os separadores. */
const SO_PAUSA = /\b(?:start-sleep|sleep|timeout(?:\.exe)?|ping(?:\.exe)?|infinity|inf|localhost|nul)\b|-[a-z]+:?|\/t\b|\b\d+(?:\.\d+)*[smhd]?\b|[;&|\s()>]/gi

/**
 * O comando é uma espera: um laço que dorme entre as voltas (`while … sleep`, `for … Start-Sleep`, `% { Start-Sleep }`),
 * um laço sem fim (`while true`, `until … do`), algo que segue sem fim (`watch`, `tail -f`, `Get-Content -Wait`) ou
 * pausas seguidas que somam 30 s ou mais. Devolve o motivo, ou undefined. Lê só o código (codigoDoComando): o que está entre
 * aspas como dado (`grep "while true"`, `git commit -m "…sleep…"`) não conta; o código de `bash -c '…'` conta.
 */
export function esperaNoComando(comandoInteiro: string): { motivo: string } | undefined {
  // o roteiro embutido (`node - <<'EOF'`) é de outra linguagem: só o que ele mesmo dorme conta (esperaDoRoteiro)
  const { resto: comando, roteiros } = semRoteiroEmbutido(comandoInteiro)
  const doRoteiro = roteiros.map(esperaDoRoteiro).find(e => e !== undefined)
  if (doRoteiro !== undefined) return doRoteiro
  const codigo = codigoDoComando(comando)
  const achadas = pausas(codigo)
  const corpos = corposDeLaco(codigo)
  // a pausa conta para o laço só dentro do corpo dele: `sleep 2 && for …` e `… done; Start-Sleep` não são laço de espera;
  // e o laço que percorre uma lista com pausa curta entre os itens não é espera (lacoQueEspera)
  const lacoDeEspera = corpos.some(l => {
    const dentroDoCorpo = achadas.filter(p => p.em >= l.corpo && p.em <= l.fim)
    return dentroDoCorpo.length > 0 && lacoQueEspera(codigo, comando, l, dentroDoCorpo.reduce((a, p) => a + p.s, 0))
  })
  if (SEM_FIM.test(codigo) || REPETE_SOZINHO.test(codigo) || lacoDeEspera) {
    return { motivo: `este comando é um laço de espera (repete e dorme até algo mudar). ${NO_LUGAR_DA_ESPERA}` }
  }
  if (SEGUE.test(codigo)) return { motivo: `este comando fica esperando sem fim (repete ou segue um arquivo até alguém parar). ${NO_LUGAR_DA_ESPERA}` }
  // pausas soltas somam só quando vêm em seguida, sem outro comando no meio (`sleep 20; sleep 20`); a pausa entre duas
  // rodadas de trabalho (`npm test; Start-Sleep 15; npm test; Start-Sleep 15; npm test`) conta sozinha. Todas as
  // pausas soltas juntas passando de 60 s também são espera: a espera desenrolada (`sleep 25; curl …; sleep 25; …`).
  let soma = 0
  let grupo = 0
  let total = 0
  const ordem = [...achadas].sort((p, q) => p.em - q.em)
  ordem.forEach((p, i) => {
    const antes = ordem[i - 1]
    const soPausa = antes !== undefined && codigo.slice(antes.em, p.em).replace(SO_PAUSA, '') === ''
    grupo = soPausa ? grupo + p.s : p.s
    soma = Math.max(soma, grupo)
    total += p.s
  })
  if (total >= 2 * ESPERA_LONGA_S) soma = Math.max(soma, total)
  if (soma >= ESPERA_LONGA_S) {
    return { motivo: `este comando ${Number.isFinite(soma) ? `dorme ${Math.round(soma)} s` : 'dorme sem fim'}, uma espera longa. ${NO_LUGAR_DA_ESPERA}` }
  }
  return undefined
}

// --------------------------------------------------------------------------- escrita pelo shell

/** Comandos que escrevem, apagam ou movem todos os caminhos que recebem. */
const TODOS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'move-item', 'mi', 'remove-item', 'ri',
  'tee', 'tee-object', 'touch', 'mkdir', 'md', 'truncate', 'set-content', 'add-content', 'ac', 'out-file', 'new-item', 'ni',
  'clear-content', 'clc', 'shred', 'unlink', 'export-csv', 'epcsv', 'export-clixml',
])
/** Renomeiam: o primeiro caminho é o arquivo; o segundo é só o nome novo, na mesma pasta. */
const RENOMEIA = new Set(['ren', 'rename', 'rename-item', 'rni'])
/** Copiam: só o destino é escrito. */
const SO_DESTINO = new Set(['cp', 'copy', 'xcopy', 'copy-item', 'cpi', 'install', 'rsync', 'scp'])
/** Criam um link ou uma junção: o link e o alvo dele contam, porque a escrita pelo link cai no alvo. */
const LIGA = new Set(['ln', 'mklink'])
/** Mudam permissão ou atributo: o primeiro argumento é o modo (chmod, chown) ou o arquivo vem primeiro (icacls). */
const PERMISSAO = new Set(['chmod', 'chown', 'icacls', 'attrib'])
/** PowerShell que baixa, compacta ou extrai: só o destino (-OutFile, -DestinationPath, -Destination) é escrito. */
const SO_DESTINO_PS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'expand-archive', 'start-bitstransfer', 'compress-archive'])
/** Interpretadores de shell: o código que recebem (`-c`, `-Command`, `/c`, ou pela entrada) é lido como comando. */
const SHELLS = /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)$/
/** Comandos que listam caminhos: o que vem pelo pipe depois deles são esses caminhos. */
const LISTAM = new Set(['echo', 'printf', 'write-output', 'write', 'get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'find', 'resolve-path', 'rvpa'])
/** Alvos que não são arquivo. */
const NULO = /^(?:nul|\$null|\/dev\/null|-)$/i
/** Um destino em outra máquina (`servidor:/home/x`, `user@host:x`): não é caminho deste PC. */
const OUTRA_MAQUINA = /^(?:[\w.-]+@)?[\w.-]{2,}:(?![\\/]{2})/

// Os parâmetros do PowerShell: os que dizem o caminho, os que dizem o destino e os que levam um valor que não é caminho
// (`-ItemType Directory`, `-Value "texto"`, `-Encoding utf8`, `-NewName b.txt`). O PowerShell aceita o começo do nome
// (`-Dest`), e `-Nome:valor` junto.
const PS_CAMINHO = ['path', 'literalpath', 'filepath', 'pspath']
const PS_DESTINO = ['destination', 'destinationpath', 'outfile', 'target']
const PS_VALOR = new Set([
  'itemtype', 'type', 'value', 'encoding', 'newname', 'name', 'filter', 'include', 'exclude', 'delimiter', 'stream', 'credential',
  'erroraction', 'ea', 'warningaction', 'wa', 'informationaction', 'infa', 'outvariable', 'ov', 'errorvariable', 'ev', 'warningvariable',
  'wv', 'pipelinevariable', 'pv', 'outbuffer', 'ob', 'scope', 'width', 'inputobject', 'depth', 'attributes', 'compressionlevel', 'header',
  'culture', 'readcount', 'totalcount', 'tail', 'first', 'last', 'skip', 'method', 'body', 'headers', 'contenttype', 'uri', 'useragent',
  'timeoutsec', 'maximumredirection', 'proxy', 'websession', 'sessionvariable', 'form', 'property', 'codepage', 'argumentlist', 'verb',
  'computername', 'cn', 'session', 'executionpolicy', 'ep', 'windowstyle', 'configurationname', 'workingdirectory', 'wd', 'outputformat',
  'inputformat', 'version', 'variable',
])
/** Opções curtas que levam valor, por comando (`mkdir -m 755`, `touch -d data`, `truncate -s 0`); `-t` é o destino. */
const POSIX_VALOR: Record<string, RegExp> = {
  cp: /^-S$/, mv: /^-S$/, ln: /^-S$/, install: /^-[mogS]$/, mkdir: /^-m$/, touch: /^-[dtr]$/, truncate: /^-[sr]$/,
  scp: /^-[cDFiJloPS]$/,
}
const POSIX_DESTINO = new Set(['cp', 'mv', 'ln', 'install'])
const POSIX_LONGO_VALOR = /^(?:mode|date|reference|size|suffix|owner|group|exclude|include|exclude-from|include-from|filter)$/

type Argumentos = { posicionais: string[]; caminhos: string[]; destinos: string[]; valores: Map<string, string[]> }

/** Os argumentos de um comando, separados: posicionais, caminhos e destinos nomeados, e os valores que não são caminho. */
function lerArgumentos(verbo: string, args: readonly string[]): Argumentos {
  const r: Argumentos = { posicionais: [], caminhos: [], destinos: [], valores: new Map() }
  const prefixo = (nome: string, lista: readonly string[]): boolean => nome.length >= 3 && lista.some(l => l.startsWith(nome))
  for (let a = 0; a < args.length; a += 1) {
    const arg = args[a] ?? ''
    let nome: string | undefined
    let valor: string | undefined
    let junto = false
    const ps = /^-([A-Za-z][\w-]*):(.*)$/.exec(arg)
    const longo = /^--([\w-]+)=(.*)$/.exec(arg)
    if (ps !== null && !/^[A-Za-z]$/.test(ps[1] ?? '')) {
      nome = (ps[1] ?? '').toLowerCase()
      valor = ps[2]
      junto = true
    } else if (longo !== null) {
      nome = (longo[1] ?? '').toLowerCase()
      valor = longo[2]
      junto = true
    } else if (/^--?[A-Za-z]/.test(arg)) nome = arg.replace(/^--?/, '').toLowerCase()
    if (nome === undefined) {
      if (arg !== '--' && !/^\/[a-z?]$/i.test(arg)) r.posicionais.push(arg)
      continue
    }
    let tipo: 'caminho' | 'destino' | 'valor' | 'chave' = 'chave'
    if (POSIX_DESTINO.has(verbo) && (arg === '-t' || nome === 'target-directory')) tipo = 'destino'
    else if (POSIX_VALOR[verbo]?.test(arg) || (arg.startsWith('--') && POSIX_LONGO_VALOR.test(nome))) tipo = 'valor'
    else if (!arg.startsWith('--') && (PS_VALOR.has(nome) || (nome.length >= 3 && 'variable'.startsWith(nome)))) tipo = 'valor'
    else if (!arg.startsWith('--') && (PS_CAMINHO.includes(nome) || nome === 'lp' || prefixo(nome, PS_CAMINHO))) tipo = 'caminho'
    else if (!arg.startsWith('--') && (PS_DESTINO.includes(nome) || prefixo(nome, PS_DESTINO))) tipo = 'destino'
    else if (POSIX_LONGO_VALOR.test(nome) && junto) tipo = 'valor'
    if (tipo === 'chave') continue
    if (!junto) {
      valor = args[a + 1]
      a += 1
    }
    if (valor === undefined) continue
    if (tipo === 'caminho') r.caminhos.push(valor)
    else if (tipo === 'destino') r.destinos.push(valor)
    else r.valores.set(nome, [...(r.valores.get(nome) ?? []), valor])
  }
  return r
}

/**
 * O que um comando de shell escreve, apaga ou move, pelo texto: os alvos de `>`/`>>`/`&>`/`>|`, os argumentos de rm,
 * mv, cp (o destino), tee, Set-Content, Out-File, Remove-Item e semelhantes, o arquivo de `sed -i`/`perl -i`, o `of=`
 * do dd, o que `find -delete`, `xargs rm` e `| Remove-Item` apagam; o código de outro shell (`bash -c`, `pwsh -Command`,
 * `cmd /c`, `iex`, com ou sem aspas, também pela entrada); e as pastas em que o git grava ou em que um `cd`/`Set-Location`
 * faz uma escrita seguinte cair. Caminhos como foram escritos (relativos ficam relativos); ninguém resolve variável. É
 * uma rede: o que não tem caminho escrito (variável, roteiro, programa que grava por conta própria) passa sem ser visto.
 */
export type EscritaDoShell = {
  caminho: string
  /** A pasta em que o caminho relativo cai: a do `cd` de antes, a do `git -C`, ou a da sessão. */
  base?: string
  /** `redir`: a saída de um comando (`>`); `verbo`: rm, cp, tee, Set-Content e afins. */
  como: 'redir' | 'verbo'
  /** O comando que grava (`rm`, `set-content`, `git checkout`…), ou `>` para a saída. */
  verbo: string
  /** O caminho tem variável ou `$(…)`: ninguém sabe onde ele cai. */
  incerto?: true
}

/** O caminho começa na raiz, na unidade ou na casa: um `cd` para ele troca a pasta inteira. */
const COMECA_DO_ZERO = /^(?:[A-Za-z]:|[\\/]|~|\$HOME\b|\$\{HOME\}|\$env:(?:USERPROFILE|HOME)\b|%USERPROFILE%)/i
const juntarPasta = (base: string | undefined, destino: string): string => (base === undefined || COMECA_DO_ZERO.test(destino) ? destino : `${base}/${destino}`)
/** Variável que o mod não resolve (as da casa, ele resolve). */
const TEM_VARIAVEL = (p: string): boolean => /`|\$\(|\$[A-Za-z_{]|%[A-Za-z_]+%/.test(p.replace(COMECA_DO_ZERO, ''))

/**
 * Os blocos `{ … }` viram quebras de linha, para o comando de dentro ser lido como comando (`{ cd x; rm y; }`,
 * `% { Remove-Item … }`, `Start-Job { … }`). Ficam como estão `${x}` e `@{…}` (variável e tabela) e o `{}` do `find -exec`.
 */
function abrirBlocos(texto: string): string {
  let saida = ''
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i] ?? ''
    if (c === '{') {
      if (texto[i - 1] === '$' || texto[i - 1] === '@') {
        const fim = texto.indexOf('}', i)
        if (fim >= 0) {
          saida += texto.slice(i, fim + 1)
          i = fim
          continue
        }
      }
      if (texto[i + 1] === '}') {
        saida += '{}'
        i += 1
        continue
      }
      saida += '\n'
    } else if (c === '}') saida += '\n'
    else saida += c
  }
  return saida
}

/** Onde um comando termina: `&&`, `||`, `|` (não o de `>|`), `&` sozinho (não o de `&>` nem o de `2>&1`), `;` e a quebra de linha. */
const SEPARADOR = /(\s*(?:&&|\|\||(?<![>|])\|(?![|&])|(?<![>&<])&(?![>&\d])|[;\n])\s*)/

export function escritasDoShell(comando: string, pastaInicial?: string): { alvos: string[]; pastas: string[]; escritas: EscritaDoShell[]; grava: boolean } {
  const escritas: EscritaDoShell[] = []
  const pastas: string[] = []
  let grava = false
  let pastaAtual = pastaInicial
  // o cd que este comando fez (e não a pasta da sessão): uma escrita sem caminho legível depois dele confere a pasta
  let mudou = false
  const pilha: { pasta: string | undefined; mudou: boolean }[] = []
  // O que está entre aspas vira uma marca: o `>` e o `;` dentro delas não contam, e o caminho entre aspas volta inteiro.
  const guardadas: { texto: string; aspa: string }[] = []
  let marcado = ''
  for (const parte of partesDoComando(semCorpoDeHeredoc(comando))) {
    if (parte.tipo === 'codigo') {
      marcado += parte.texto
      continue
    }
    const n = guardadas.push({ texto: parte.texto, aspa: parte.aspa ?? '"' }) - 1
    marcado += `\u0001${n}\u0002`
  }
  const devolver = (t: string): string => t.replace(/\u0001(\d+)\u0002/g, (_, n: string) => guardadas[Number(n)]?.texto ?? '')
  const comAspas = (t: string): string =>
    t.replace(/\u0001(\d+)\u0002/g, (_, n: string) => {
      const g = guardadas[Number(n)]
      return g === undefined ? '' : `${g.aspa}${g.texto}${g.aspa}`
    })
  const anotar = (caminho: string, como: EscritaDoShell['como'], verbo: string, base: string | undefined = pastaAtual): void => {
    const limpo = caminho.trim()
    if (limpo === '' || NULO.test(limpo) || OUTRA_MAQUINA.test(limpo)) return
    escritas.push({ caminho: limpo, ...(base !== undefined ? { base } : {}), como, verbo, ...(TEM_VARIAVEL(limpo) ? { incerto: true as const } : {}) })
  }
  const lerCodigo = (codigo: string): void => {
    const de = escritasDoShell(codigo, pastaAtual)
    escritas.push(...de.escritas)
    pastas.push(...de.pastas)
    grava ||= de.grava
  }
  /** Os caminhos que o trecho anterior a um `|` lista, e o texto que ele escreve na saída (`echo "código" | pwsh -Command -`). */
  let anterior: { caminhos: string[]; texto?: string } | undefined

  const partes = abrirBlocos(marcado).split(SEPARADOR)
  for (let i = 0; i < partes.length; i += 2) {
    const sep = i > 0 ? (partes[i - 1] ?? '').trim() : ''
    let trecho = (partes[i] ?? '').trim()
    // `( … )`: o cd de dentro não passa para fora
    let abre = 0
    while (trecho.startsWith('(')) {
      trecho = trecho.slice(1).trim()
      abre += 1
    }
    let fecha = 0
    const abertos = (trecho.match(/\(/g) ?? []).length
    while (trecho.endsWith(')') && (trecho.match(/\)/g) ?? []).length > abertos) {
      trecho = trecho.slice(0, -1).trim()
      fecha += 1
    }
    for (let p = 0; p < abre; p += 1) pilha.push({ pasta: pastaAtual, mudou })
    const peloPipe = sep === '|'
    const deAntes = peloPipe ? anterior : undefined
    anterior = undefined
    if (trecho !== '') anterior = lerTrecho(trecho, deAntes)
    for (let p = 0; p < fecha; p += 1) {
      const volta = pilha.pop()
      if (volta !== undefined) {
        pastaAtual = volta.pasta
        mudou = volta.mudou
      }
    }
  }
  return { alvos: [...new Set(escritas.map(e => e.caminho))], pastas: [...new Set(pastas)], escritas, grava }

  /** Um comando sozinho (entre separadores). Devolve o que ele passa adiante por um pipe. */
  function lerTrecho(trecho: string, deAntes: { caminhos: string[]; texto?: string } | undefined): { caminhos: string[]; texto?: string } | undefined {
    // o código de `$( … )` também roda
    for (const m of trecho.matchAll(/\$\(([^()]*)\)/g)) lerCodigo(comAspas(m[1] ?? ''))
    // redirecionamento: `> x`, `>> x`, `2> x`, `*> x`, `&> x`, `>| x` (nul, $null e /dev/null não contam)
    for (const m of trecho.matchAll(/(?:^|[^<>&\d*=-])(?:\d|\*|&)?>{1,2}\|?\s*([^\s;&|<>]+)/g)) {
      const alvo = devolver(m[1] ?? '')
      if (/^&\d$/.test(alvo) || NULO.test(alvo.trim())) continue
      grava = true
      anotar(alvo, 'redir', '>')
    }
    const semRedir = trecho.replace(/\d?>&\d/g, ' ').replace(/(?:\d|\*|&)?>{1,2}\|?\s*[^\s;&|<>]+/g, ' ')
    const tokens = [...semRedir.matchAll(/\S+/g)]
    let k = 0
    while (k < tokens.length && (/^(?:sudo|nohup|time|env|command|exec|&|\.|call|do|then|else|elif|!)$/i.test(devolver(tokens[k]?.[0] ?? '')) || /^[A-Za-z_]\w*=/.test(tokens[k]?.[0] ?? ''))) k += 1
    if (k >= tokens.length) return undefined
    const verbo = nomeDoPrograma(devolver(tokens[k]?.[0] ?? ''))
    // `GIT_WORK_TREE=x git …`: a pasta da frente vale como `--work-tree=x`
    const daFrente = verbo === 'git' ? tokens.slice(0, k).map(t => devolver(t[0])).filter(t => /^GIT_WORK_TREE=/i.test(t)).map(t => `--work-tree=${t.slice(t.indexOf('=') + 1)}`) : []
    const args = [...daFrente, ...tokens.slice(k + 1).map(t => devolver(t[0]))]
    /** O texto depois do token `idx`: o código que um shell recebe. Uma só parte entre aspas vem sem as aspas. */
    const codigoApos = (idx: number): string => {
      const t = tokens[idx]
      const resto = semRedir.slice((t?.index ?? 0) + (t?.[0].length ?? 0)).trim()
      return /^\u0001\d+\u0002$/.test(resto) ? devolver(resto) : comAspas(resto)
    }
    // o que este trecho passa adiante pelo pipe
    const lidos = lerArgumentos(verbo, args)
    const saida: { caminhos: string[]; texto?: string } = {
      caminhos: LISTAM.has(verbo) ? (verbo === 'find' ? lidos.posicionais.filter(p => !/^[-(!]/.test(p)).slice(0, 1) : [...lidos.caminhos, ...lidos.posicionais]) : [],
      ...(/^(?:echo|printf|write-output|write)$/.test(verbo) ? { texto: codigoApos(k) } : tokens.length === 1 && /^\u0001\d+\u0002$/.test(tokens[0]?.[0] ?? '') ? { texto: devolver(tokens[0]?.[0] ?? '') } : {}),
    }
    // o que vem pelo pipe para um comando que apaga sem dizer o caminho: os caminhos listados antes, ou a pasta de agora
    const alimentados = deAntes === undefined ? [] : deAntes.caminhos.length ? deAntes.caminhos : ['.']

    if (SHELLS.test(verbo)) {
      const ehPs = verbo === 'pwsh' || verbo === 'powershell'
      let codigo: string | undefined
      let leEntrada = true
      for (let a = k + 1; a < tokens.length; a += 1) {
        const arg = devolver(tokens[a]?.[0] ?? '').toLowerCase()
        const bandeira =
          verbo === 'cmd' ? /^\/[ckr]$/.test(arg) : ehPs ? /^-(?:c|co|com|comm|comma|comman|command|commandwithargs|cwa)$/.test(arg) : /^-[a-z]*c[a-z]*$/.test(arg)
        if (bandeira) {
          const resto = codigoApos(a)
          if (resto !== '-' && resto !== '') {
            codigo = resto
            leEntrada = false
          }
          break
        }
        if (ehPs && /^-(?:f|file|e|ec|enc|encodedcommand)$/.test(arg)) {
          leEntrada = false
          break
        }
        if (ehPs && /^-(?:executionpolicy|ep|windowstyle|w|version|configurationname|workingdirectory|wd|outputformat|of|inputformat|if|settingsfile)$/.test(arg)) {
          a += 1
          continue
        }
        if (arg.startsWith('-') || (verbo === 'cmd' && arg.startsWith('/'))) continue
        // o primeiro argumento que não é opção: o Windows PowerShell roda o resto como comando; os outros, um roteiro
        if (verbo === 'powershell') codigo = codigoApos(a - 1)
        leEntrada = false
        break
      }
      if (codigo === undefined && leEntrada && deAntes?.texto !== undefined) codigo = deAntes.texto
      if (codigo !== undefined) lerCodigo(codigo)
      return saida
    }
    if (verbo === 'iex' || verbo === 'invoke-expression') {
      const codigo = tokens.length > k + 1 ? codigoApos(k).replace(/^-command\s+/i, '') : deAntes?.texto
      if (codigo !== undefined) lerCodigo(/^\u0001\d+\u0002$/.test(codigo) ? devolver(codigo) : codigo)
      return saida
    }
    if (verbo === 'xargs') {
      let a = 0
      while (a < args.length && (args[a] ?? '').startsWith('-')) a += /^-[nIdLPsEa]$/.test(args[a] ?? '') ? 2 : 1
      const interno = nomeDoPrograma(args[a] ?? '')
      if (interno !== '') lerVerbo(interno, args.slice(a + 1), deAntes === undefined ? ['.'] : alimentados, true)
      return saida
    }
    if (/^(?:cd|chdir|set-location|sl|pushd|push-location)$/.test(verbo)) {
      const destino = lidos.caminhos[0] ?? lidos.posicionais[0]
      pastaAtual = destino === undefined ? '~' : destino === '-' ? undefined : juntarPasta(pastaAtual, destino)
      mudou = true
      return saida
    }
    if (/^(?:popd|pop-location)$/.test(verbo)) {
      pastaAtual = undefined
      mudou = true
      return saida
    }
    lerVerbo(verbo, args, alimentados, false)
    return saida
  }

  /** Um programa e os argumentos dele. `pipe`: os caminhos chegam pela entrada (xargs). */
  function lerVerbo(verbo: string, args: readonly string[], alimentados: readonly string[], pipe: boolean): void {
    const lidos = lerArgumentos(verbo, args)
    const valorDe = (curto: RegExp, longo: string): string[] => {
      const achados: string[] = []
      for (let a = 0; a < args.length; a += 1) {
        const arg = args[a] ?? ''
        if (curto.test(arg) || arg === longo) {
          if (args[a + 1] !== undefined) achados.push(args[a + 1] as string)
          a += 1
        } else if (arg.startsWith(`${longo}=`)) achados.push(arg.slice(longo.length + 1))
      }
      return achados
    }
    const marcar = (alvos: readonly string[], base?: string): void => {
      for (const alvo of alvos) anotar(alvo, 'verbo', verbo, base ?? pastaAtual)
    }
    let escreve = false
    if (TODOS.has(verbo)) {
      let alvos = [...lidos.caminhos, ...lidos.destinos, ...lidos.posicionais]
      // New-Item de link ou junção: o alvo (-Value ou -Target) também conta
      if ((verbo === 'new-item' || verbo === 'ni') && /link|junction/i.test([...(lidos.valores.get('itemtype') ?? []), ...(lidos.valores.get('type') ?? [])].join(' '))) {
        alvos.push(...(lidos.valores.get('value') ?? []))
      }
      // pelo pipe, o tee recebe o texto e não caminhos: `| Tee-Object -Variable x` não grava arquivo
      if (pipe || (alvos.length === 0 && verbo !== 'tee' && verbo !== 'tee-object')) alvos = [...alvos, ...alimentados]
      marcar(alvos)
      escreve = true
    } else if (RENOMEIA.has(verbo)) {
      marcar([...lidos.caminhos, ...lidos.posicionais.slice(0, lidos.caminhos.length ? 0 : 1)])
      if (lidos.caminhos.length === 0 && lidos.posicionais.length === 0) marcar(alimentados)
      escreve = true
    } else if (SO_DESTINO.has(verbo)) {
      const destino = lidos.destinos.at(-1) ?? (lidos.posicionais.length >= 2 || pipe ? lidos.posicionais.at(-1) : undefined) ?? (lidos.posicionais.length === 1 ? '.' : undefined)
      if (destino !== undefined) marcar([destino])
      // o scp para outra máquina não grava neste PC
      escreve = verbo !== 'scp' || (destino !== undefined && !OUTRA_MAQUINA.test(destino))
    } else if (LIGA.has(verbo)) {
      marcar([...lidos.caminhos, ...lidos.destinos, ...lidos.posicionais])
      escreve = true
    } else if (verbo === 'robocopy') {
      if (lidos.posicionais[1] !== undefined) marcar([lidos.posicionais[1]])
      escreve = true
    } else if (PERMISSAO.has(verbo)) {
      const p = lidos.posicionais
      marcar(verbo === 'icacls' ? p.slice(0, 1) : verbo === 'attrib' ? p.filter(x => !/^[+-]/.test(x)) : p.slice(1))
      escreve = true
    } else if (SO_DESTINO_PS.has(verbo)) {
      const alvos = lidos.destinos.length ? lidos.destinos : /^(?:compress-archive|expand-archive)$/.test(verbo) ? [lidos.posicionais[1] ?? (verbo === 'expand-archive' ? '.' : '')] : []
      marcar(alvos.filter(x => x !== ''))
      escreve = alvos.some(x => x !== '')
    } else if ((verbo === 'sed' || verbo === 'perl' || verbo === 'ruby') && args.some(a => /^-[a-z]*i/i.test(a))) {
      const arquivo = lidos.posicionais.at(-1)
      if (arquivo !== undefined) marcar([arquivo])
      escreve = true
    } else if (verbo === 'dd') {
      const saidas = args.filter(a => /^of=/i.test(a)).map(a => a.slice(3))
      marcar(saidas)
      escreve = saidas.length > 0
    } else if (verbo === 'find') {
      const apaga = args.includes('-delete') || args.some((a, i) => /^-(?:exec|execdir|ok|okdir)$/.test(a) && (TODOS.has(nomeDoPrograma(args[i + 1] ?? '')) || SO_DESTINO.has(nomeDoPrograma(args[i + 1] ?? ''))))
      if (apaga) {
        const inicio: string[] = []
        for (const a of args) {
          if (/^[-(!]/.test(a)) break
          inicio.push(a)
        }
        marcar(inicio.length ? inicio : ['.'])
        escreve = true
      }
    } else if (verbo === 'curl') {
      const saidas = [...valorDe(/^-[a-zA-Z]*o$/, '--output'), ...valorDe(/^$/, '--output-dir')]
      marcar(saidas)
      escreve = saidas.length > 0
    } else if (verbo === 'wget') {
      marcar([...valorDe(/^-[a-zA-Z]*O$/, '--output-document'), ...valorDe(/^-P$/, '--directory-prefix')])
      escreve = true
    } else if (verbo === 'tar' && args.some(a => /^-?[a-wyz]*x/.test(a) || a === '--extract' || a === '--get')) {
      marcar(valorDe(/^-C$/, '--directory'))
      escreve = true
    } else if (verbo === 'unzip' || verbo === '7z') {
      marcar(valorDe(/^-d$/, '--dir'))
      for (const arg of args) if (/^-o./.test(arg) && verbo === '7z') marcar([arg.slice(2)])
      escreve = true
    } else if (verbo === 'git') {
      escreve = lerGit(args)
    }
    if (escreve) grava = true
    // escrita sem caminho que se possa ler (uma variável) depois de um cd: ao menos a pasta do cd confere
    if (escreve && mudou && pastaAtual !== undefined && escritas.some(e => e.incerto === true && e.base === pastaAtual)) pastas.push(pastaAtual)
  }

  /**
   * O git: em que pasta ele roda (`-C`, o `cd` de antes, ou a pasta da sessão) e o que o subcomando grava. Os que mexem
   * na cópia de trabalho inteira (`checkout <ramo>`, `reset --hard`, `clean`, `stash`, `pull`, `merge`, `rebase`…) gravam
   * na pasta inteira, que tem de estar no território; com caminhos (`checkout -- docs/a.md`, `restore x`, `rm x`), os
   * caminhos. Os que só gravam no repositório (`add`, `commit`, `tag`, `fetch`, `branch`, um `checkout -b` novo) gravam
   * na pasta, que pode estar acima do território. `config --global` grava no ~/.gitconfig; `init`, `clone` e `worktree
   * add` gravam na pasta que nomeiam.
   */
  function lerGit(args: readonly string[]): boolean {
    let pasta: string | undefined
    let a = 0
    while (a < args.length && (args[a] ?? '').startsWith('-')) {
      if ((args[a] === '-C' || args[a] === '-c' || args[a] === '--git-dir' || args[a] === '--work-tree') && args[a + 1] !== undefined) {
        if (args[a] === '-C' || args[a] === '--work-tree') pasta = args[a + 1]
        a += 2
      } else {
        // `--work-tree=x` junto (e o GIT_WORK_TREE=x da frente, que lerTrecho passa assim)
        if ((args[a] ?? '').startsWith('--work-tree=')) pasta = (args[a] ?? '').slice('--work-tree='.length)
        a += 1
      }
    }
    const sub = (args[a] ?? '').toLowerCase()
    const resto = args.slice(a + 1)
    const onde = pasta === undefined ? pastaAtual : juntarPasta(pastaAtual, pasta)
    const ondeDoGit = onde ?? '.'
    const depoisDoTraco = resto.includes('--') ? resto.slice(resto.indexOf('--') + 1) : undefined
    const comValor = /^(?:--depth|-b|-B|-c|-C|--branch|-o|--origin|--reference|--config|--template|--separate-git-dir|-j|--jobs|-s|--source|-m|--message|-e|--exclude|-f|--file|--orphan)$/
    const posicionais: string[] = []
    for (let b = 0; b < resto.length; b += 1) {
      const arg = resto[b] ?? ''
      if (arg === '--') break
      if (comValor.test(arg)) b += 1
      else if (!arg.startsWith('-')) posicionais.push(arg)
    }
    const naPasta = (): void => {
      if (onde !== undefined) pastas.push(onde)
    }
    const caminhos = (lista: readonly string[]): void => {
      for (const p of lista) anotar(p, 'verbo', `git ${sub}`, ondeDoGit)
    }
    const pastaInteira = (): void => anotar('.', 'verbo', `git ${sub}`, ondeDoGit)
    switch (sub) {
      case 'add':
      case 'commit':
      case 'tag':
      case 'notes':
      case 'fetch':
      case 'branch':
      case 'gc':
      case 'prune':
      case 'remote':
      case 'update-index':
      case 'update-ref':
      case 'symbolic-ref':
        naPasta()
        return true
      case 'clone': {
        const url = posicionais[0]
        const nova = posicionais[1] ?? (url === undefined ? undefined : (url.replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '').replace(/\.git$/, ''))
        if (nova) anotar(nova, 'verbo', 'git clone', ondeDoGit)
        return true
      }
      case 'init':
        if (posicionais[0] !== undefined) caminhos([posicionais[0]])
        else pastaInteira()
        return true
      case 'worktree': {
        const acao = posicionais[0]
        if (acao === 'add' || acao === 'move' || acao === 'remove') caminhos(posicionais.slice(1, acao === 'add' ? 2 : 3))
        else if (acao === 'prune' || acao === 'lock' || acao === 'unlock' || acao === 'repair') naPasta()
        return acao !== 'list'
      }
      case 'config': {
        if (resto.some(x => /^--(?:get|get-all|get-regexp|list|get-urlmatch|show-origin)$/.test(x) || x === '-l')) return false
        const arquivo = resto.indexOf('--file') >= 0 ? resto[resto.indexOf('--file') + 1] : resto.indexOf('-f') >= 0 ? resto[resto.indexOf('-f') + 1] : undefined
        if (resto.includes('--global')) anotar('~/.gitconfig', 'verbo', 'git config --global')
        else if (resto.includes('--system')) anotar('C:/Program Files/Git/etc/gitconfig', 'verbo', 'git config --system')
        else if (arquivo !== undefined) caminhos([arquivo])
        else naPasta()
        return true
      }
      case 'reset':
        if (resto.some(x => /^--(?:hard|merge|keep)$/.test(x))) pastaInteira()
        else naPasta()
        return true
      case 'checkout':
      case 'switch': {
        if (depoisDoTraco !== undefined) caminhos(depoisDoTraco.length ? depoisDoTraco : ['.'])
        // ramo novo (`checkout -b x`, `switch -c x main`, `switch --create x`): o git não sobrescreve mudança local sem
        // -f, e abrir o ramo a partir do principal é o método da casa; com -f, --discard-changes ou --merge, a cópia
        // inteira. `-B` e `-C` (`--force-create`) reposicionam um ramo que pode ser o atual, como um `reset --keep`: a
        // cópia inteira também.
        else if (
          resto.some(x => /^(?:-b|-c|--orphan|--create)$/.test(x)) &&
          !resto.some(x => /^(?:-f|--force|--discard-changes|-m|--merge|-B|-C|--force-create)$/.test(x))
        ) naPasta()
        else pastaInteira()
        return true
      }
      case 'restore':
      case 'rm':
      case 'mv':
        caminhos(depoisDoTraco ?? posicionais)
        if ((depoisDoTraco ?? posicionais).length === 0) pastaInteira()
        return true
      case 'clean':
        if ((depoisDoTraco ?? posicionais).length) caminhos(depoisDoTraco ?? posicionais)
        else pastaInteira()
        return true
      case 'stash': {
        const acao = posicionais[0]
        if (acao === 'list' || acao === 'show') return false
        if (depoisDoTraco !== undefined && depoisDoTraco.length) caminhos(depoisDoTraco)
        else pastaInteira()
        return true
      }
      case 'merge':
      case 'pull':
      case 'rebase':
      case 'cherry-pick':
      case 'revert':
      case 'am':
      case 'apply':
      case 'submodule':
      case 'sparse-checkout':
        pastaInteira()
        return true
      default:
        return false
    }
  }
}

/** O nome do programa, sem a pasta e sem a extensão do Windows: `"C:/Program Files/Git/bin/bash.exe"` é `bash`. */
function nomeDoPrograma(palavra: string): string {
  return palavra.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')
}

/** O programa que o comando roda, para o diagnóstico: só o nome (sem argumentos, sem variáveis nem valores). */
export function programaDoComando(comando: string): string {
  for (const palavra of comando.trim().split(/\s+/)) {
    const limpa = palavra.replace(/^["'&(]+|["')]+$/g, '')
    if (limpa === '' || /^[A-Za-z_]\w*=/.test(limpa) || /^(?:sudo|nohup|time|env|command|exec)$/i.test(limpa)) continue
    return nomeDoPrograma(limpa).replace(/[^\w.-]/g, '').slice(0, 40) || '(sem nome)'
  }
  return '(vazio)'
}

// ----------------------------------------------------------------------------- a cerca do terminal

/**
 * Nomes que nenhum especialista grava, apaga ou move pelo terminal, citados em qualquer ponto do comando: as
 * configurações do Claude Code, os arquivos de login, e as pastas de mods, regras e ganchos.
 */
export const SENSIVEL = /settings(?:\.local)?\.json|\.credentials\.json|(?:^|[\\/\s"'=])auth\.json|\.git-credentials|\.netrc\b|[\\/]\.ssh(?:[\\/]|\b)|\.claude[\\/](?:dev-)?mods\b|\.claude[\\/](?:rules|hooks)\b|alrix-equipe[\\/]prateleira\b|(?:^|[\\/\s"'=])\.mcp\.json\b/i

/**
 * O que é do Claude Code e só o chefe muda, dentro da pasta de configuração: o código que roda sozinho (mods,
 * plugins instalados, ganchos, a barra do kit), o que vira instrução de toda sessão (regras, agentes, skills,
 * comandos, CLAUDE.md), os ajustes, o login e a prateleira da pessoa. Vale para a escrita por ferramenta (Write,
 * Edit) e pelo terminal, e "ampliar" não abre nenhum deles.
 * `config` é a pasta de configuração (CLAUDE_CONFIG_DIR); ausente, a .claude da pasta do usuário.
 */
export const pastasProtegidas = (casa: string, config = `${casa}/.claude`): string[] =>
  [
    'mods', 'dev-mods', 'plugins', 'rules', 'hooks', 'agents', 'skills', 'commands', 'alrix-kit', 'alrix-equipe/prateleira',
    'settings.json', 'settings.local.json', '.credentials.json', 'CLAUDE.md',
  ].map(p => normalizar(`${config}/${p}`))

/**
 * O arquivo de configuração do Claude Code que mora dentro de um projeto e roda código por conta própria: os ajustes
 * (`.claude/settings.json` e `.claude/settings.local.json`, que trazem ganchos), a pasta de ganchos (`.claude/hooks`)
 * e os servidores MCP (`.mcp.json`). Dentro do território ou não, nenhum especialista os escreve: um gancho gravado
 * ali roda na sessão seguinte, fora de qualquer porteiro. Devolve o trecho que casou, ou undefined.
 */
export function configDoClaudeNoProjeto(caminho: string): string | undefined {
  const alvo = normalizar(caminho)
  return /(?:^|\/)\.claude\/(?:settings(?:\.local)?\.json$|hooks(?:\/|$))/i.exec(alvo)?.[0].replace(/^\/|\/$/g, '') ?? (/(?:^|\/)\.mcp\.json$/i.test(alvo) ? '.mcp.json' : undefined)
}

/** O caminho como o shell o escreve, na forma do mod: "/c/x" do Git Bash vira "c:/x"; $HOME e afins viram a casa. */
export function caminhoDoShell(caminho: string, casa: string): string {
  let p = caminho.trim().replace(/[\\/]+$/, '')
  p = p.replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=[\\/]|$)/i, casa)
  if (ehDoWindows(casa)) p = p.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:')
  if (/^[A-Za-z]:$/.test(p)) p = `${p}/`
  return p === '' ? caminho : p
}

/** `real` é o `abs` com a letra da unidade na frente ("/tmp/x" e "c:/tmp/x"): nada mais mudou no caminho. */
const soGanhouUnidade = (abs: string, real: string): boolean => abs.startsWith('/') && /^[a-z]:\//.test(real) && real.slice(2) === abs

/** Os caminhos absolutos que o comando grava (e as pastas do git e do cd), como a cerca os confere. */
export function caminhosDoShell(a: { comando: string; cwd: string; casa: string }): string[] {
  const r = escritasDoShell(a.comando, a.cwd)
  const resolver = resolverDoShell(a.casa, a.cwd)
  return [...new Set([...r.escritas.filter(e => !e.incerto).map(e => resolver(e.caminho, e.base)), ...r.pastas.map(p => resolver(p))])]
}

const resolverDoShell =
  (casa: string, cwd: string) =>
  (p: string, base?: string): string =>
    absoluto(caminhoDoShell(p, casa), base === undefined ? cwd : absoluto(caminhoDoShell(base, casa), cwd, casa), casa)

export type DecisaoDoShell =
  | { ok: true }
  | {
      ok: false
      motivo: string
      /** O caminho (ou o nome sensível) que a cerca achou. */
      alvo: string
      /** O comando que grava ali (rm, set-content, git checkout, >). */
      verbo: string
      /** `pare`: só o chefe libera aquele lugar; `reescreva`: fora do território, talvez por leitura errada do comando. */
      saida: 'pare' | 'reescreva'
    }

/**
 * A cerca do terminal de um especialista. Recusa o comando que grava, apaga ou move:
 * - citando um nome de SENSIVEL, em qualquer ponto do comando;
 * - num caminho de "não toque em" (da ficha ou da casa) ou nas pastas protegidas do Claude Code;
 * - num caminho escrito às claras fora do território (o relativo cai na pasta do `cd` de antes, ou na da sessão).
 *   Passam a pasta temporária, o arquivo do relatório (`livres`) e a saída de um comando (`>`) dentro da pasta do
 *   projeto. Com `reais` (o caminho resolvido no disco, links e junções seguidos), vale onde a escrita cai de fato;
 * - numa pasta em que o git grava no repositório (`git add`, `git commit`) que não cruza o território.
 * Variável, roteiro e programa que grava por conta própria passam sem ser vistos.
 */
export function decidirShell(a: {
  comando: string
  cwd: string
  casa: string
  territorio: readonly string[]
  naoToque: readonly string[]
  casaNaoToque: readonly string[]
  projeto?: string
  livres: readonly string[]
  reais?: ReadonlyMap<string, string>
  /** A pasta de configuração do Claude Code; ausente, a .claude da pasta do usuário. */
  config?: string
}): DecisaoDoShell {
  const r = escritasDoShell(a.comando, a.cwd)
  if (!r.grava) return { ok: true }
  const verboDe = (e?: EscritaDoShell): string => e?.verbo ?? 'gravar'
  // a chave do `scp -i ~/.ssh/chave` (e o `-F` da configuração) é lida, não gravada: não conta como citação
  // (só o `-i` e o `-F` exatos, e só quando o programa do trecho é scp, sftp ou ssh, também o do GIT_SSH_COMMAND="ssh -i …"
  // e o chamado pelo caminho entre aspas, `"C:/Program Files/Git/usr/bin/scp.exe" -i …`)
  const citado = SENSIVEL.exec(
    a.comando.replace(
      /((?:(?:^|[;&|\n(]\s*)(?:&\s*)?["'][^"'\n]*[\\/](?:scp|sftp|ssh)(?:\.exe)?["']|(?:^|[;&|\n(]\s*|["'])(?:\S*[\\/])?(?:scp|sftp|ssh)(?:\.exe)?)(?:\s[^;&|\n"']*?)?)\s-[iF]\s+[^\s"']+/g,
      '$1',
    ),
  )
  if (citado !== null) {
    const nome = citado[0].replace(/^[\\/\s"'=]/, '')
    return { ok: false, motivo: `o comando grava, apaga ou move e cita "${nome}", que nenhum especialista mexe pelo terminal`, alvo: nome, verbo: verboDe(r.escritas[0]), saida: 'pare' }
  }
  const protegidas = pastasProtegidas(a.casa, a.config)
  const livres = a.livres.map(normalizar)
  const resolver = resolverDoShell(a.casa, a.cwd)
  const proibido = (abs: string): string | undefined =>
    a.naoToque.find(t => dentro(abs, t)) ?? padraoQueCasa(abs, a.casaNaoToque, a.casa) ?? protegidas.find(t => dentro(abs, t)) ?? configDoClaudeNoProjeto(abs)
  const territorio = a.territorio.join(', ') || 'nenhum: você só lê'
  for (const e of r.escritas) {
    if (e.incerto) continue
    const abs = resolver(e.caminho, e.base)
    const real = a.reais?.get(abs) ?? abs
    const pelo = proibido(abs) ?? proibido(real)
    if (pelo !== undefined) {
      return { ok: false, motivo: `o comando grava em ${real}, que está em "não toque em", na lista da casa ou nas pastas do Claude Code que só o chefe muda (${pelo})`, alvo: real, verbo: e.verbo, saida: 'pare' }
    }
    if (dentroDeAlgum(real, a.territorio) || dentroDeAlgum(real, livres)) continue
    // "/tmp/x" do Git Bash: o disco o lê como "c:/tmp/x" (só ganhou a letra da unidade, nenhum link no caminho) e a pasta
    // temporária que o próprio caminho escrito nomeia vale. Se o caminho passa por um link, `real` é outro e não entra aqui.
    if (soGanhouUnidade(abs, real) && dentroDeAlgum(abs, livres)) continue
    if (e.como === 'redir' && a.projeto !== undefined && dentro(real, a.projeto)) continue
    const link = real !== abs ? ` (${abs} passa por um link ou junção e cai lá)` : ''
    return { ok: false, motivo: `entendi que o comando (${e.verbo}) grava em ${real}${link}, fora do seu território (${territorio})`, alvo: real, verbo: e.verbo, saida: 'reescreva' }
  }
  for (const pasta of r.pastas) {
    const abs = resolver(pasta)
    const real = a.reais?.get(abs) ?? abs
    const pelo = proibido(abs) ?? proibido(real)
    if (pelo !== undefined) return { ok: false, motivo: `o comando grava na pasta ${real}, que está em "não toque em" ou nas pastas que só o chefe muda (${pelo})`, alvo: real, verbo: 'git', saida: 'pare' }
    // A pasta do projeto acima do território passa (cd na raiz e git commit); uma pasta ao lado, não.
    if (!a.territorio.some(t => dentro(real, t) || dentro(t, real))) {
      return { ok: false, motivo: `entendi que o comando grava na pasta ${real}, fora do seu território (${territorio})`, alvo: real, verbo: 'git', saida: 'reescreva' }
    }
  }
  return { ok: true }
}

/**
 * O texto em que os comandos recusados da casa são procurados: o código do comando, como em `codigoDoComando`. O que
 * está entre aspas como dado, com espaço dentro (o padrão do `grep "claude -p"`, a mensagem do `git commit -m "… codex
 * exec"`), vira `""`; o código de `bash -c '…'`, `cmd /c "…"` e do `ssh host '…'` entra. Uma palavra só entre aspas
 * (`ssh "root@host"`, `"--force"`) entra sem as aspas, e o programa chamado pelo caminho entre aspas
 * (`"C:/Program Files/x/codex.exe" exec`, `& "…\claude.exe" -p`) entra pelo nome.
 */
function codigoParaRecusa(comando: string): string {
  return trechosDoComando(comando)
    .map(t => t.join(' '))
    .join('\n')
}

/** O código de cada `$( … )` (com os parênteses de dentro contados) e de cada crase de uma linha, e o texto sem eles. */
function tirarSubstituicoes(texto: string): { resto: string; dentro: string[] } {
  const dentro: string[] = []
  let resto = ''
  let i = 0
  while (i < texto.length) {
    if (texto.startsWith('$(', i)) {
      let nivel = 1
      let j = i + 2
      while (j < texto.length && nivel > 0) {
        if (texto[j] === '(') nivel += 1
        else if (texto[j] === ')') nivel -= 1
        j += 1
      }
      dentro.push(texto.slice(i + 2, nivel === 0 ? j - 1 : j))
      resto += ' _ '
      i = j
      continue
    }
    if (texto[i] === '`') {
      const fim = texto.indexOf('`', i + 1)
      const linha = texto.indexOf('\n', i + 1)
      if (fim > i + 1 && (linha < 0 || fim < linha) && /^[A-Za-z]/.test(texto[i + 1] ?? '')) {
        dentro.push(texto.slice(i + 1, fim))
        resto += ' _ '
        i = fim + 1
        continue
      }
    }
    resto += texto[i]
    i += 1
  }
  return { resto, dentro }
}

/** Programas que só embrulham outro: o programa de verdade vem depois deles (e das opções deles). */
const EMBRULHOS = new Set(['nohup', 'time', 'command', 'builtin', 'exec', 'stdbuf', 'sudo', 'env', 'xargs', 'nice', 'timeout', 'call', '&', '.', 'start', 'start-process', 'saps', 'measure-command', 'invoke-command', 'icm', 'wsl'])
/** Opções que levam valor, nos embrulhos. */
const VALOR_DO_EMBRULHO: Record<string, RegExp> = {
  sudo: /^-[ugpChrt]$/, env: /^-[uSC]$/, xargs: /^-[nIdLPsEa]$/, nice: /^-n$/, timeout: /^-[sk]$/, stdbuf: /^-[ioe]$/,
  wsl: /^(?:-d|-u|--distribution|--user|--cd)$/,
}
/** Lançadores de pacote: `npx x`, `bunx x`, `pnpm dlx x`, `yarn dlx x`, `npm exec -- x`, `bun x x`. */
const LANCA = new Set(['npx', 'bunx', 'pnpx'])
const LANCA_COM_SUB: Record<string, RegExp> = { npm: /^(?:exec|x)$/, pnpm: /^(?:dlx|exec)$/, yarn: /^(?:dlx|exec)$/, bun: /^x$/ }
const SHELL_DE_RECUSA = /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)$/

/** O nome de um programa para a recusa: sem pasta, sem extensão do Windows, sem a versão do pacote (`@openai/codex@latest`). */
function nomeParaRecusa(palavra: string): string {
  const nome = palavra.replace(/^.*[\\/]/, '').replace(/^@/, '').replace(/@[^@]*$/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '')
  return nome === 'claude-code' ? 'claude' : nome
}

/**
 * Cada trecho do comando que roda um programa, como `[programa, ...argumentos]`, para os comandos recusados da casa e a
 * leitura de chave. Os trechos se separam por `;`, `&&`, `||`, `|`, `&`, quebra de linha, `( )` e pelas chaves de um
 * bloco (`{ … }` com espaço); o código de `$( … )`, de crases, de `bash -c`, `cmd /c`, `pwsh -Command`, `iex` e do
 * `ssh host '…'` é um trecho a mais. Em cada trecho saem as atribuições da frente (`VAR=x`, `$x =`), os embrulhos
 * (`timeout 600`, `nice -n 10`, `env`, `sudo`, `xargs`, `Start-Process -FilePath`) e os lançadores de pacote (`npx`,
 * `yarn dlx`, `npm exec --`), e o programa fica pelo nome (`"C:/…/codex.exe"` é `codex`). O que está entre aspas com
 * espaço é dado e vira `""`; uma palavra só entre aspas fica, sem os sinais que separam trechos.
 */
export function trechosDoComando(comando: string, fundo = 0, cru = false): string[][] {
  if (fundo > 4) return []
  let codigo = ''
  const extras: string[] = []
  for (const parte of partesDoComando(semCorpoDeHeredoc(comando))) {
    if (parte.tipo === 'codigo') {
      codigo += parte.texto
      continue
    }
    if (INTERPRETE.test(codigo) || REMOTO.test(codigo)) {
      codigo += `\n${parte.texto}\n`
      continue
    }
    if (parte.aspa === '"' && /\$\(|`/.test(parte.texto)) extras.push(...tirarSubstituicoes(parte.texto).dentro)
    // `cru` (a leitura de chave): o caminho entre aspas fica inteiro, também o do programa, sem os sinais que separam trechos
    if (/(?:^|[;&|({\n]|\b(?:do|then|else))\s*$/i.test(codigo)) codigo += (cru ? parte.texto.replace(/[|(){};&<>`\n]/g, '_') : parte.texto.replace(/^.*[\\/]/, '')).replace(/\s/g, '_')
    else codigo += /\s/.test(parte.texto) || (cru && parte.texto === '') ? ' "" ' : parte.texto.replace(/[|(){};&<>`\n]/g, '_')
  }
  const { resto, dentro } = tirarSubstituicoes(codigo)
  extras.push(...dentro)
  const blocos = resto.replace(/[()]/g, '\n').replace(/(^|\s|@)[{}]|[{}](?=\s|$)/g, '$1\n')
  const trechos: string[][] = []
  for (const texto of blocos.split(/\s*(?:&&|\|\||\||;|\n|(?<![>&<\d])&(?![>&\d]))\s*/)) {
    const lido = lerTrechoParaRecusa(texto.trim().split(/\s+/).filter(t => t !== ''), fundo, cru)
    trechos.push(...lido)
  }
  for (const x of extras) trechos.push(...trechosDoComando(x, fundo + 1, cru))
  return trechos
}

/** As opções do `ssh` que levam valor: depois delas e do destino, o resto é o comando que roda na outra máquina. */
const VALOR_DO_SSH = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/

function lerTrechoParaRecusa(entrada: string[], fundo: number, cru = false): string[][] {
  let t = [...entrada]
  // a entrada de uma tabela do PowerShell (`codex = $true`) não roda programa nenhum
  if (t.length >= 2 && t[1] === '=' && !(t[0] ?? '').startsWith('$')) return []
  for (let volta = 0; volta < 12 && t.length; volta += 1) {
    const primeiro = t[0] ?? ''
    if (/^(?:!|do|then|else|elif|if|while|until|function)$/i.test(primeiro)) {
      t = t.slice(1)
      continue
    }
    // `$x = programa …` do PowerShell, e `VAR=x programa …` do bash
    if (/^\$[\w:.]+$/.test(primeiro) && /^[+-]?=$/.test(t[1] ?? '')) {
      t = t.slice(2)
      continue
    }
    const ps = /^\$[\w:.]+=(.*)$/.exec(primeiro)
    if (ps !== null) {
      t = ps[1] ? [ps[1], ...t.slice(1)] : t.slice(1)
      continue
    }
    if (/^[A-Za-z_]\w*=/.test(primeiro)) {
      t = t.slice(1)
      continue
    }
    const nome = nomeParaRecusa(primeiro)
    if (nome === 'start-process' || nome === 'saps' || (nome === 'start' && t.some(x => /^-(?:filepath|argumentlist|args)$/i.test(x)))) {
      // Start-Process: o programa (-FilePath ou o primeiro) e os argumentos dele (-ArgumentList, separados por vírgula)
      let programa: string | undefined
      const argumentos: string[] = []
      const posicionais: string[] = []
      for (let i = 1; i < t.length; i += 1) {
        const x = t[i] ?? ''
        if (/^-(?:filepath|file|path)$/i.test(x)) programa = t[(i += 1)]
        else if (/^-(?:argumentlist|args)$/i.test(x)) argumentos.push(...(t[(i += 1)] ?? '').split(',').filter(a => a !== ''))
        else if (/^-(?:workingdirectory|redirectstandard\w+|verb|windowstyle|credential)$/i.test(x)) i += 1
        else if (!x.startsWith('-')) posicionais.push(x)
      }
      programa ??= posicionais.shift()
      if (argumentos.length === 0) argumentos.push(...posicionais.flatMap(p => p.split(',').filter(a => a !== '')))
      if (programa === undefined) return []
      t = [programa, ...argumentos]
      continue
    }
    if (EMBRULHOS.has(nome)) {
      // o `timeout /t 5` do Windows é uma pausa, e não um embrulho; `command -v codex` só procura o programa
      if (nome === 'timeout' && /^\//.test(t[1] ?? '')) break
      if (nome === 'command' && /^-[a-zA-Z]*[vV]/.test(t[1] ?? '')) break
      if (nome === 'start' && !t.slice(1).some(x => !x.startsWith('/'))) break
      let i = 1
      while (i < t.length && ((t[i] ?? '').startsWith('-') || (nome === 'start' && /^(?:\/|""$)/.test(t[i] ?? '')) || (nome === 'env' && /^[A-Za-z_]\w*=/.test(t[i] ?? '')))) {
        i += VALOR_DO_EMBRULHO[nome]?.test(t[i] ?? '') ? 2 : 1
      }
      if (nome === 'timeout' && /^\d/.test(t[i] ?? '')) i += 1
      t = t.slice(i)
      continue
    }
    const sub = LANCA_COM_SUB[nome]
    if (LANCA.has(nome) || (sub !== undefined && sub.test(t[1] ?? ''))) {
      let i = LANCA.has(nome) ? 1 : 2
      while (i < t.length && ((t[i] ?? '').startsWith('-'))) i += /^(?:-p|--package)$/.test(t[i] ?? '') ? 2 : 1
      t = t.slice(i)
      continue
    }
    break
  }
  if (t.length === 0) return []
  const programa = nomeParaRecusa(t[0] ?? '')
  const primeiro = cru ? (t[0] ?? '') : programa
  const args = t.slice(1)
  // o código que um shell recebe sem aspas (`cmd /c codex exec x`, `bash -c codex`) é um trecho a mais
  if (SHELL_DE_RECUSA.test(programa)) {
    const ps = programa === 'pwsh' || programa === 'powershell'
    for (let i = 0; i < args.length; i += 1) {
      const a = (args[i] ?? '').toLowerCase()
      const bandeira = programa === 'cmd' ? /^\/[ck]$/.test(a) : ps ? /^-(?:c|co|com|comm|comma|comman|command)$/.test(a) : /^-[a-z]*c[a-z]*$/.test(a)
      if (bandeira) return [[primeiro, ...args.slice(0, i + 1)], ...lerTrechoParaRecusa(args.slice(i + 1), fundo, cru)]
      if (ps && /^-(?:executionpolicy|ep|windowstyle|w|version|workingdirectory|wd)$/.test(a)) {
        i += 1
        continue
      }
      if (a.startsWith('-') || (programa === 'cmd' && a.startsWith('/'))) continue
      if (programa === 'powershell') return [[primeiro], ...lerTrechoParaRecusa(args.slice(i), fundo, cru)]
      break
    }
  }
  // `ssh servidor nmap x`: o que vem depois do destino roda na outra máquina, e é um trecho a mais
  if (programa === 'ssh') {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] ?? ''
      if (VALOR_DO_SSH.test(a)) {
        i += 1
        continue
      }
      if (a.startsWith('-') || a.startsWith('<') || a.startsWith('>')) continue
      if (i + 1 < args.length) return [[primeiro, ...args.slice(0, i + 1)], ...lerTrechoParaRecusa(args.slice(i + 1), fundo, cru)]
      break
    }
  }
  return [[primeiro, ...args]]
}

/** Na pasta `.ssh`, o que se pode ler: a chave pública, a configuração e as listas de servidores e de chaves aceitas. */
const PODE_LER_NA_SSH = /^(?:config|known_hosts|known_hosts\.old|authorized_keys|[^\\/]*\.pub)$/i

/**
 * Onde o caminho cai na pasta `.ssh`: `pasta` (a própria pasta), `chave` (qualquer arquivo dela fora da lista do que se
 * pode ler, também por curinga, como `~/.ssh/*` e `~/.ssh/id*`) ou undefined (fora dela, ou um arquivo da lista). O `./`
 * e o `..` no meio contam como no disco. `naSsh`: o comando já entrou na pasta (`cd ~/.ssh && …`), e o caminho relativo
 * cai nela.
 */
export function alcanceNaSsh(caminho: string, naSsh = false): 'pasta' | 'chave' | undefined {
  const limpo = caminho.replace(/^["']+|["']+$/g, '')
  if (limpo === '') return undefined
  const relativo = !/^(?:[\\/~$%]|[A-Za-z]:)/.test(limpo)
  const partes: string[] = naSsh && relativo ? ['.ssh'] : []
  for (const p of limpo.split(/[\\/]+/)) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      partes.pop()
      continue
    }
    partes.push(p)
  }
  const i = partes.map(p => p.toLowerCase()).lastIndexOf('.ssh')
  if (i < 0) return undefined
  const resto = partes.slice(i + 1)
  if (resto.length === 0) return 'pasta'
  return resto.length === 1 && PODE_LER_NA_SSH.test(resto[0] ?? '') ? undefined : 'chave'
}

/** Programas que só lidam com o nome, a permissão ou o lugar do arquivo, sem abrir o que está dentro. */
const SO_NOMES = new Set([
  'ls', 'dir', 'gci', 'get-childitem', 'll', 'stat', 'test-path', 'get-item', 'gi', 'get-itemproperty', 'gp', 'get-acl', 'icacls', 'chmod', 'chown',
  'attrib', 'rm', 'del', 'erase', 'remove-item', 'ri', 'rmdir', 'rd', 'mkdir', 'md', 'new-item', 'ni', 'which', 'where', 'du', 'tree', 'touch', 'find',
])
/** Programas que entram numa pasta: depois deles, o caminho relativo cai nela. */
const ENTRAM = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
/** Programas que usam a chave sem mostrá-la (o `ssh-keygen` só com `-l` ou `-y`). */
const USAM_A_CHAVE = new Set(['ssh', 'ssh-add', 'git'])
/** Opções que levam valor e cujo valor é a chave em uso (`-i`), a configuração (`-F`) ou outra coisa que não se lê. */
const VALOR_DE_QUEM_USA: Record<string, RegExp> = { scp: /^-[iFPolcJS]$/, sftp: /^-[iFPolcJSb]$/, rsync: /^-e$/ }
/** Programas que copiam: o último caminho é o destino (gravar lá é com a cerca), e não uma leitura. */
const COPIAM = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'mv', 'move', 'move-item', 'mi', 'scp', 'sftp', 'rsync'])
/** Programas de busca: o primeiro argumento solto é o padrão procurado, e não um arquivo. */
const BUSCAM = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'select-string', 'sls'])

/**
 * O comando lê uma chave privada do SSH? A regra é pelo programa de cada trecho: o que não é `ssh`, `ssh-add`, `git`,
 * `ssh-keygen -l`/`-y` nem um programa que só lida com nomes (`ls`, `Get-ChildItem`, `icacls`, `find` sem `-exec`) e
 * recebe como argumento um caminho de chave, ou a própria pasta `.ssh`, lê a chave (`cat`, `sed`, `awk`, `openssl`,
 * `grep -r`, `Copy-Item`, `[IO.File]::ReadAllText(…)`). O `scp` e o `sftp` usam a chave do `-i`, mas copiam a que vem
 * solta. A chave mandada pela entrada (`< chave`) é lida por qualquer programa, o `ssh` também. É chave todo arquivo da
 * pasta `.ssh` fora da lista do que se pode ler (`*.pub`, `config`, `known_hosts`, `known_hosts.old`,
 * `authorized_keys`), também pelo curinga (`~/.ssh/*`) e depois de um `cd ~/.ssh`. Devolve o programa e o caminho.
 */
export function leituraDeChave(comando: string): { programa: string; caminho: string } | undefined {
  let naSsh = false
  for (const trecho of trechosDoComando(comando, 0, true)) {
    const tokens = trecho.flatMap(x => x.split(',')).filter(x => x !== '')
    // a chave pela entrada: `cat < chave`, `ssh servidor 'cat > k' < chave`
    for (let i = 0; i < tokens.length; i += 1) {
      const x = tokens[i] ?? ''
      const entrada = x === '<' ? tokens[i + 1] : x.startsWith('<') && !x.startsWith('<<') ? x.slice(1) : undefined
      if (entrada !== undefined && alcanceNaSsh(entrada, naSsh) !== undefined) return { programa: 'entrada (<)', caminho: entrada }
    }
    const cru = tokens[0] ?? ''
    const programa = nomeParaRecusa(cru)
    const args = tokens.slice(1)
    if (ENTRAM.has(programa)) {
      const alvo = args.find(a => !a.startsWith('-'))
      naSsh = alvo !== undefined && alcanceNaSsh(alvo, naSsh) !== undefined
      continue
    }
    // o próprio caminho no lugar do programa: `[IO.File]::ReadAllText("$HOME/.ssh/id_x")`, a chave chamada como programa
    if (/[\\/]/.test(cru) && alcanceNaSsh(cru, naSsh) === 'chave') return { programa: 'caminho', caminho: cru }
    if (USAM_A_CHAVE.has(programa)) continue
    if (programa === 'ssh-keygen' && args.some(a => /^-[a-zA-Z]*[ly]/.test(a))) continue
    if (programa === 'find' ? !args.some(a => /^-(?:exec|execdir|ok|okdir)$/.test(a)) : SO_NOMES.has(programa)) continue
    const copia = COPIAM.has(programa)
    const busca = BUSCAM.has(programa)
    const padraoDado = busca && args.some(a => /^(?:-e|--regexp|-f|--file|-pattern)$/i.test(a) || /^--regexp=/.test(a))
    let padraoVisto = !busca || padraoDado
    const soltos: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] ?? ''
      // a saída para um arquivo grava (é com a cerca), e não lê
      if (/^(?:\d*|&|\*)>>?$/.test(a)) {
        i += 1
        continue
      }
      if (/^(?:\d*|&|\*)>/.test(a) || a.startsWith('<')) continue
      if (VALOR_DE_QUEM_USA[programa]?.test(a) || (busca && /^(?:-e|--regexp|-pattern)$/i.test(a)) || /^-(?:destination|t|-target-directory)$/i.test(a)) {
        i += 1
        continue
      }
      if (a.startsWith('-') || (programa === 'findstr' && a.startsWith('/'))) {
        // a opção com o valor colado: `-Path:~/.ssh/x`, `--file=~/.ssh/x`
        const colado = /^-{1,2}[\w-]+[:=](.+)$/.exec(a)?.[1]
        if (colado !== undefined && alcanceNaSsh(colado, naSsh) !== undefined) return { programa, caminho: colado }
        continue
      }
      if (!padraoVisto) {
        padraoVisto = true
        continue
      }
      soltos.push(a.replace(/^[A-Za-z_]\w*=(?=.)/, ''))
    }
    // no `cp a b`, o último é o destino
    if (copia && soltos.length >= 2) soltos.pop()
    for (const s of soltos) if (alcanceNaSsh(s, naSsh) !== undefined) return { programa, caminho: s }
  }
  return undefined
}

/**
 * As ferramentas de leitura (Read, Grep, Glob) apontadas para a chave privada do SSH: o arquivo, a pasta `.ssh` sem um
 * filtro que fique na lista do que se pode ler, ou um padrão que a alcance (`~/.ssh/*`, `**\/.ssh/id*`). Só olha caminho
 * dentro de `.ssh`: nenhuma outra leitura muda. Devolve a ferramenta e o caminho, ou undefined.
 */
export function leituraDeChaveNaFerramenta(ferramenta: string, campos: Record<string, unknown>): { programa: string; caminho: string } | undefined {
  const texto = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  if (ferramenta === 'Read') {
    const p = texto(campos.file_path)
    return p !== undefined && alcanceNaSsh(p) === 'chave' ? { programa: ferramenta, caminho: p } : undefined
  }
  if (ferramenta !== 'Grep' && ferramenta !== 'Glob') return undefined
  const pasta = texto(campos.path) ?? '.'
  const filtro = texto(ferramenta === 'Grep' ? campos.glob : campos.pattern)
  if (filtro === undefined) return ferramenta === 'Grep' && alcanceNaSsh(pasta) !== undefined ? { programa: ferramenta, caminho: pasta } : undefined
  // cada alternativa entre chaves (`*.{pub,key}`) e cada filtro separado por vírgula ou espaço contam
  const chaves = /\{([^{}]*)\}/.exec(filtro)
  const filtros = (chaves === null ? [filtro] : (chaves[1] ?? '').split(',').map(x => filtro.replace(chaves[0], x))).flatMap(f => f.split(/[\s,]+/)).filter(f => f !== '')
  for (const f of filtros) {
    const c = /^(?:[A-Za-z]:|[\\/~$%])/.test(f) ? f : `${pasta.replace(/[\\/]+$/, '')}/${f}`
    const alcance = alcanceNaSsh(c)
    if (alcance === 'chave' || (alcance === 'pasta' && ferramenta === 'Grep')) return { programa: ferramenta, caminho: c }
  }
  return undefined
}

/** A linha que continua na seguinte (`\` no fim, no bash; crase no fim, no PowerShell) é um comando só. */
const juntarContinuacoes = (texto: string): string => texto.replace(/[ \t]*(?:\\|`)\r?\n[ \t]*/g, ' ')

/**
 * O primeiro comando recusado da casa que casa com o código do comando (expressão regular, sem distinguir
 * maiúsculas). Procura em `codigoParaRecusa`: a busca e a mensagem que só citam um comando recusado passam.
 */
export function comandoRecusado(
  texto: string,
  lista: readonly { padrao: string; motivo: string }[],
): { padrao: string; motivo: string } | undefined {
  // Cada trecho (um programa e os argumentos dele) é uma linha, e o padrão é lido numa linha de cada vez: um `\s+` de
  // padrão não pode passar da quebra para os argumentos do comando seguinte (`claude plugin test mod; tsc -p x`).
  // O comando escrito em duas linhas (`git push \` e `--force` na de baixo; a crase no PowerShell) é um só: as duas
  // leituras contam, a do texto como veio e a das linhas continuadas já unidas.
  const linhas = [...codigoParaRecusa(texto).split('\n'), ...codigoParaRecusa(juntarContinuacoes(texto)).split('\n')]
  for (const item of lista) {
    let regra: RegExp
    try {
      regra = new RegExp(item.padrao, 'i')
    } catch {
      continue
    }
    if (linhas.some(linha => regra.test(linha))) return item
  }
  return undefined
}
