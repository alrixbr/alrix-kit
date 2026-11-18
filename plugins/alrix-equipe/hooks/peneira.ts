// A peneira de segredo: acha chave, token e senha num texto e devolve só uma amostra já mascarada, nunca o valor.
// Puro e sem ligação com o resto do mod; quem a liga no porteiro de mensagens é o chefe. O foco é não dar falso
// alarme no que os agentes escrevem
// todo dia (impressão digital SHA-256, id de commit, id de sessão, caminho de arquivo, nome de variável sem valor).

export type Achado = { tipo: string; amostra: string }

type Trecho = { tipo: string; ini: number; fim: number; amostra: string }

/** Chave com prefixo conhecido: o que se mostra no lugar é só o prefixo. Cada regra tem um mínimo de caracteres depois dele. */
const PREFIXOS: { tipo: string; re: RegExp; mostra: (m: RegExpExecArray) => string; exigeDigito?: boolean }[] = [
  { tipo: 'chave da Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, mostra: () => 'sk-ant-***' },
  // "sk-" também abre palavras comuns; só vale com 20 caracteres ou mais e ao menos um número.
  { tipo: 'chave de API (sk-)', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g, mostra: () => 'sk-***', exigeDigito: true },
  { tipo: 'token do GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, mostra: m => `${m[0].slice(0, 4)}***` },
  { tipo: 'token do GitHub', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, mostra: () => 'github_pat_***' },
  { tipo: 'token do GitLab', re: /\bglpat-[A-Za-z0-9_-]{16,}/g, mostra: () => 'glpat-***' },
  { tipo: 'token do Slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, mostra: m => `${m[0].slice(0, 5)}***` },
  { tipo: 'chave da AWS', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, mostra: m => `${m[0].slice(0, 4)}***` },
  { tipo: 'chave do Google', re: /\bAIza[0-9A-Za-z_-]{30,}/g, mostra: () => 'AIza***' },
  { tipo: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, mostra: () => 'eyJ***' },
]

const BLOCO_CHAVE_PRIVADA = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g

// "Bearer" seguido de um valor longo (20 ou mais caracteres) com algum número; "Bearer tokens" ou "Bearer authentication" não contam.
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/gi

// Nome que diz segredo, separador (= ou :) e valor. O nome pode ter prefixo e sufixo (ANTHROPIC_API_KEY, db_password).
const NOME_VALOR =
  /\b([A-Za-z0-9_.-]*?(?:token|senha|password|passwd|secret|segredo|api[_-]?key|access[_-]?key|private[_-]?key))(["']?\s*[=:]\s*)(["']?)([^\s"'&;|,}<>()[\]]+)/gi

/** Valor curto demais para ser segredo de verdade. */
const VALOR_MINIMO = 12

const temDigito = (s: string): boolean => /\d/.test(s)

/** O valor é um caminho de arquivo, uma variável (por exemplo $TOKEN) ou um marcador de lugar: não é segredo. */
function naoEhValor(v: string): boolean {
  if (/^[$~./\\*]/.test(v)) return true // $VARIAVEL, ~/pasta, ./arquivo, /home/x, \\rede, ***
  if (/^[A-Za-z]:[\\/]/.test(v)) return true // C:\pasta, C:/pasta
  if (/^(?:x{6,}|\.{3,}|-{3,}|_{3,})$/i.test(v)) return true // xxxxxxxx, ..., ---
  return false
}

function sobrepoe(a: Trecho, lista: readonly Trecho[]): boolean {
  return lista.some(b => a.ini < b.fim && b.ini < a.fim)
}

function trechosEm(texto: string): Trecho[] {
  const aceitos: Trecho[] = []
  const aceitar = (t: Trecho): void => {
    if (!sobrepoe(t, aceitos)) aceitos.push(t)
  }

  for (const m of texto.matchAll(BLOCO_CHAVE_PRIVADA)) {
    aceitar({ tipo: 'chave privada', ini: m.index, fim: m.index + m[0].length, amostra: '[chave privada]' })
  }
  for (const p of PREFIXOS) {
    for (const m of texto.matchAll(p.re)) {
      if (p.exigeDigito && !temDigito(m[0])) continue
      aceitar({ tipo: p.tipo, ini: m.index, fim: m.index + m[0].length, amostra: p.mostra(m as RegExpExecArray) })
    }
  }
  for (const m of texto.matchAll(BEARER)) {
    const valor = m[1] ?? ''
    if (!temDigito(valor)) continue
    const ini = m.index + m[0].length - valor.length
    aceitar({ tipo: 'Bearer', ini, fim: ini + valor.length, amostra: 'Bearer ***' })
  }
  for (const m of texto.matchAll(NOME_VALOR)) {
    const [, nome = '', separador = '', aspas = '', valor = ''] = m
    if (valor.length < VALOR_MINIMO || !temDigito(valor) || naoEhValor(valor)) continue
    const ini = m.index + nome.length + separador.length + aspas.length
    aceitar({ tipo: 'nome e valor', ini, fim: ini + valor.length, amostra: `${nome.slice(-40)}=***` })
  }
  return aceitos.sort((a, b) => a.ini - b.ini)
}

/** O que a peneira achou no texto, na ordem em que aparece. A amostra já vem mascarada: o valor nunca sai daqui. */
export function segredosEm(texto: string): Achado[] {
  return trechosEm(texto).map(({ tipo, amostra }) => ({ tipo, amostra }))
}

/** O mesmo texto com cada segredo trocado por uma marca (a chave privada inteira vira "[chave privada]"). */
export function mascarar(texto: string): string {
  let saida = ''
  let de = 0
  for (const t of trechosEm(texto)) {
    saida += texto.slice(de, t.ini)
    // Nome e valor: só o valor some, o nome fica para o leitor saber o que foi escondido. Bearer: idem.
    saida += t.tipo === 'nome e valor' || t.tipo === 'Bearer' ? '***' : t.amostra
    de = t.fim
  }
  return saida + texto.slice(de)
}
