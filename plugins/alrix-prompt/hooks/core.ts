// ALRIX · prompt, o miolo puro: o que vai para o especialista, as travas que decidem se a reescrita pode seguir e a
// âncora com a mensagem original. Uma fonte só para o mod (os hooks daqui) e para o motor do ALRIX Code
// (engine/src/refine.ts), que carrega este arquivo com o type stripping do Node. Por isso: nada de `$`, nenhum import
// que fique em tempo de execução (só `import type`), nada de sintaxe que o Node não apague (enum, namespace).

export type Expert = 'organizar' | 'engenharia'
export type Harness = 'claude' | 'codex'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** Uma mensagem recente da sessão: do dono (`user`) ou do agente (`assistant`). */
export type Turn = { role: 'user' | 'assistant'; text: string }

/** O que o especialista recebe para trabalhar, além do prompt do modo. */
export type ExpertInput = {
  text: string
  /** Quem vai ler a reescrita: Claude Code ou Codex. */
  harness: Harness
  /** O modelo do agente que vai ler, quando se sabe (`claude-opus-5-5`, `gpt-6-astra`). */
  model?: string
  /** A pasta da sessão. */
  cwd?: string
  /** As últimas mensagens da sessão, as mais antigas primeiro. */
  recent?: readonly Turn[]
}

/** Os dois especialistas são Sonnet 5.5, por decisão do dono (28/10/2026). */
export const EXPERT_MODEL = 'claude-sonnet-5-5'
export const EXPERT_NAME = 'Sonnet 5.5'

export type Plan = {
  /** O prompt do modo, em `prompts/`. */
  file: string
  effort: Effort
  /** No motor, `false` desliga o raciocínio (Organizar é mecânico). O `$.model.complete` do mod só tem `effort`. */
  thinking: boolean
  timeoutMs: number
  /** Teto da resposta no `$.model.complete` do mod: folga para o raciocínio, que divide o teto com o texto. */
  minTokens: number
  /** Tamanho da reescrita em relação à original: abaixo, resumiu ou cortou; acima, respondeu ou inventou. */
  minRatio: number
  maxRatio: number
  /** O quanto uma mensagem curta sempre pode crescer, além da proporção. */
  slackChars: number
  /** Quanto das palavras dele precisa sobreviver (com tolerância a erro de digitação e flexão). */
  minKept: number
  /** Abaixo disto ("sim", "pode") não há o que melhorar: com o modo da sessão, e com o modo só desta mensagem. */
  minChars: { session: number; once: number }
}

export const PLAN: Readonly<Record<Expert, Plan>> = {
  organizar: {
    file: 'organizar.md',
    effort: 'low',
    thinking: false,
    timeoutMs: 45_000,
    minTokens: 4_096,
    minRatio: 0.75,
    maxRatio: 1.5,
    slackChars: 80,
    minKept: 0.8,
    minChars: { session: 40, once: 12 },
  },
  engenharia: {
    file: 'engenharia.md',
    effort: 'medium',
    thinking: true,
    timeoutMs: 120_000,
    minTokens: 16_000,
    minRatio: 0.35,
    maxRatio: 4,
    slackChars: 700,
    minKept: 0.45,
    minChars: { session: 40, once: 12 },
  },
}

export const MODE_LABEL: Readonly<Record<Expert | 'normal', string>> = {
  normal: 'Normal',
  organizar: 'Organizar',
  engenharia: 'Engenharia',
}

/**
 * O que o Engenharia lê da conversa: as últimas mensagens que o dono digitou e, de cada uma, a resposta do agente que
 * veio logo antes (a mais recente quase inteira, as outras só o bastante para situar). O trabalho do agente entre uma
 * mensagem e outra fica de fora. Medido nas sessões deste PC (11/11/2026, 1.069 mensagens): com "as últimas 8
 * mensagens com texto", a mensagem anterior dele não entrava em 38% das vezes e a última resposta do agente (mediana
 * de 1.492 caracteres, p90 de 3.163) chegava cortada em metade delas.
 */
const OWNER_MESSAGES = 3
const OWNER_CHARS = 1_500
const LAST_ANSWER_CHARS = 4_000
const EARLIER_ANSWER_CHARS = 800
const CONVERSATION_CHARS = 12_000
/** Quanto do começo e do fim de um bloco colado o Engenharia lê, para saber o que é. */
const PASTED_PREVIEW_CHARS = 600

/**
 * A partir de quantos caracteres uma mensagem é "longa" para o mod do terminal: com o Engenharia ligado na sessão, só
 * as longas param para a revisão. Nas mensagens do dono neste PC (11/11/2026, 1.152 em 12 dias) a mediana é de 129
 * caracteres, o p75 de 258 e o p90 de 473: 400 pega mais ou menos uma em cada oito.
 */
export const LONG_MESSAGE_CHARS = 400

/** Quantos caracteres ele mesmo digitou, fora o que colou. */
export const ownLength = (text: string): number => splitPasted(text.trim()).text.replace(PASTED_MARKS, '').trim().length

/** Se a mensagem vale a chamada: nem curta demais (fora o que ele colou), nem um comando ou o modo bash. */
export function shouldRefine(expert: Expert, text: string, isOnce: boolean): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return false
  return ownLength(trimmed) >= PLAN[expert].minChars[isOnce ? 'once' : 'session']
}

// ── o que ele colou ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Um bloco colado, como o Claude Code o entrega na mensagem: `<pasted_content id="b6fe">` … `</pasted_content id="b6fe">`. */
const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g
/** O marcador que fica no lugar de um bloco colado enquanto o especialista trabalha: `[[COLADO-1]]`. */
const PASTED_MARKS = /\[\[COLADO-(\d+)\]\]/g
const HAS_PASTED_MARK = /\[\[COLADO-\d+\]\]/
export const pastedMark = (index: number): string => `[[COLADO-${index + 1}]]`

/**
 * Tira da mensagem os blocos colados e deixa um marcador no lugar de cada um. O especialista nunca reescreve o que foi
 * colado: o bloco volta inteiro, com as tags que dizem ao agente que aquilo é texto colado, pelo `restorePasted`.
 * Uma mensagem que já traz um marcador escrito fica como está, sem separar nada.
 */
export function splitPasted(text: string): { text: string; blocks: string[] } {
  if (HAS_PASTED_MARK.test(text)) return { text, blocks: [] }
  const blocks: string[] = []
  const bare = text.replace(PASTED_BLOCK, block => pastedMark(blocks.push(block) - 1))
  return { text: bare, blocks }
}

/** Devolve cada bloco colado ao lugar do seu marcador. */
export function restorePasted(text: string, blocks: readonly string[]): string {
  return text.replace(PASTED_MARKS, (mark, number: string) => blocks[Number(number) - 1] ?? mark)
}

/** Se a reescrita traz cada marcador uma vez só, e nenhum a mais. */
function hasEveryMark(rewritten: string, blocks: readonly string[]): boolean {
  const found = [...rewritten.matchAll(PASTED_MARKS)].map(match => Number(match[1]))
  return found.length === blocks.length && blocks.every((_, index) => found.filter(number => number === index + 1).length === 1)
}

/** O miolo de um bloco colado, sem as tags, para o Engenharia ler o começo e o fim. */
const insideOf = (block: string): string => block.replace(/^<pasted_content\b[^>]*>\s*/, '').replace(/\s*<\/pasted_content\b[^>]*>$/, '')

/** Teto de tokens da resposta para o `$.model.complete` do mod. */
export function maxTokensFor(expert: Expert, text: string): number {
  return Math.min(32_000, Math.max(PLAN[expert].minTokens, text.length * 2))
}

/** Corta o meio de um texto longo, mantendo o começo e o fim. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  return `${text.slice(0, head)} […] ${text.slice(text.length - (max - head))}`
}

// ── o que precisa sobreviver byte a byte ─────────────────────────────────────────────────────────────────────────────

const EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|mts|cts|json|jsonl|md|mdx|cs|csproj|sln|xaml|ps1|psm1|bat|cmd|sh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|' +
  'html|css|scss|sql|yml|yaml|toml|ini|cfg|conf|env|lock|txt|log|csv|xml|svg|png|jpg|jpeg|gif|webp|mp3|mp4|wav|mov|pdf|zip|exe|dll|' +
  'uproject|uasset|umap|glb|gltf|fbx|blend|ttf|otf|woff2|ico|plugin|mcpb'

const PROTECTED: readonly RegExp[] = [
  // URLs
  /https?:\/\/[^\s)>\]"'`]+/g,
  // caminhos Unix e /comandos (/root/x, ~/x, ./x, /plugin-authoring, /plugin-dev:agent-development)
  /(?<![\w/.~\\])(?:~|\.{1,2})?\/[\w.@:+-]+(?:\/[\w.@:+-]+)*/g,
  // caminhos do Windows (C:\Users\x, %LOCALAPPDATA%\x, ~\x)
  /(?<![\w])[A-Za-z]:\\[^\s"'<>|*?`]+/g,
  /%[A-Za-z_][\w]*%(?:\\[^\s"'<>|*?`]+)*/g,
  /(?<![\w])~\\[^\s"'<>|*?`]+/g,
  // @menções (@app/Views/Composer.cs, @ana)
  /(?<![\w@])@[\w][\w./:-]*/g,
  // nomes de variável: CONSTANTE_COM_SUBLINHADO, snake_case, camelCase
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g,
  /\b[a-z][a-z0-9]*_[a-z0-9_]*[a-z0-9]\b/g,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
  // erros nomeados (TypeError, ENOENT)
  /\b\w+(?:Error|Exception)\b/g,
]

/** Caminho relativo (app/Views/Composer.cs, engine/src): com extensão, ou com duas barras ou mais. */
const RELATIVE = /(?<![\w/.@~\\:-])[\w.-]+(?:\/[\w.@-]+)+\/?/g
/** Nome de arquivo solto (package.json, MainWindow.xaml.cs). */
const FILE_NAME = new RegExp(`(?<![\\w./\\\\-])[\\w-]+(?:\\.[\\w-]+)*\\.(?:${EXTENSIONS})(?![\\w.-]*\\w)`, 'gi')
const NUMBERS = /\d+(?:[.,]\d+)*/g

/** O marcador de uma imagem anexada (`[Image #1]`): sem ele no texto, o agente não sabe de que imagem a frase fala. */
const IMAGE_MARK = /\[Image #\d+\]/g

const trimEnd = (token: string): string => token.replace(/[.,:;!?)\]]+$/, '')

/** As tags XML que o Engenharia usa para o material colado (`<erro>`, `</texto_colado>`): não são caminho nem nome. */
const XML_TAG = /<\/?[A-Za-z][\w-]*>/g

/** O que a reescrita precisa repetir byte a byte: URLs, trechos entre crases, caminhos, /comandos, @menções e nomes. */
export function protectedTokens(raw: string): string[] {
  const text = raw.replace(XML_TAG, ' ')
  const found: string[] = []
  for (const pattern of PROTECTED) for (const match of text.matchAll(pattern)) found.push(trimEnd(match[0]))
  for (const match of text.matchAll(/`([^`\n]+)`/g)) found.push(match[1] ?? '')
  for (const match of text.matchAll(RELATIVE)) {
    const token = trimEnd(match[0])
    const parts = token.split('/').filter(part => part !== '')
    const isDate = parts.every(part => /^\d+$/.test(part))
    const last = parts[parts.length - 1] ?? ''
    if (!isDate && (parts.length >= 3 || /\.[A-Za-z][\w]{0,7}$/.test(last))) found.push(token)
  }
  for (const match of text.matchAll(FILE_NAME)) found.push(trimEnd(match[0]))
  for (const match of text.matchAll(IMAGE_MARK)) found.push(match[0])
  return [...new Set(found.filter(token => token.length > 1))]
}

/** Os números da mensagem (3, 2.6.5, 07/11 vira 07 e 11): todos voltam na reescrita. */
export const numbersOf = (text: string): string[] => [...new Set(text.match(NUMBERS) ?? [])]

const LOG_LINE =
  /^\s*(?:at\s+\S+\s*\(|\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}|\[?\d{1,2}:\d{2}:\d{2}|(?:\w+(?:Error|Exception)|ERROR|ERR!|WARN(?:ING)?|FATAL|Traceback|npm ERR!|error(?:\[\w+\])?:|warning:|fatal:)|File "|PS [A-Z]:\\|\$ |> )/

/** As linhas coladas (dentro de ``` ou com cara de log): voltam inteiras, como vieram. */
export function pastedLines(text: string): string[] {
  const lines: string[] = []
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) lines.push(...(block[1] ?? '').split('\n'))
  for (const line of text.split('\n')) if (LOG_LINE.test(line)) lines.push(line)
  return [...new Set(lines.map(line => line.trim()).filter(line => line.length >= 12))]
}

// ── palavras, ênfase e negação ───────────────────────────────────────────────────────────────────────────────────────

/** Sem acento e em minúsculas, para "nao" e "não" contarem igual. */
export const folded = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** As palavras em MAIÚSCULAS (3 letras ou mais): a ênfase dele, que volta em maiúsculas, mesmo sem acento. */
export function emphasisOf(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
  const caps = words.filter(word => (word.match(/\p{L}/gu)?.length ?? 0) >= 3 && word === word.toUpperCase() && /\p{Lu}/u.test(word))
  return [...new Set(caps.map(folded))]
}

/** Palavras que, se somem, invertem o pedido ("não apague" vira "apague"). Contadas sem acento. */
const NEGATIONS = /(?<![\p{L}])(?:nao|nunca|nem|jamais|sem|nada|ninguem|nenhum|nenhuma)(?![\p{L}])/gu
export const negationsIn = (text: string): number => folded(text).match(NEGATIONS)?.length ?? 0

/** O "não" de quem se corrige no meio da frase ("copia pra lá, não, pera, só gera"): não é uma proibição. */
const SELF_CORRECTION = /(?<![\p{L}])nao[\s,.!]+(?:pera|perai|espera|calma|melhor)(?![\p{L}])/gu
/** A negação que o Engenharia escreve numa palavra só ("inativo por padrão", "desligado até eu ativar"). */
const NEGATED_WORDS = /(?<![\p{L}])(?:inativ|desativad|desligad|proibid)\p{L}*/gu

/** As proibições de uma mensagem do dono, como o Engenharia as conta: sem as correções que ele fez no caminho. */
export const prohibitionsIn = (text: string): number => negationsIn(text) - (folded(text).match(SELF_CORRECTION)?.length ?? 0)
/** As proibições de uma reescrita do Engenharia, contando as que viraram uma palavra só. */
export const prohibitionsOut = (text: string): number => negationsIn(text) + (folded(text).match(NEGATED_WORDS)?.length ?? 0)

/** As palavras que viram grito quando alguém as põe em maiúsculas: só o dono decide gritar. */
const LOUD = new Set(
  'nao nunca nada nem jamais sem nenhum nenhuma ninguem sempre todos todas tudo apenas muito importante urgente cuidado atencao obrigatorio proibido somente'.split(' '),
)

/** As palavras que a reescrita pôs em MAIÚSCULAS e que ele não gritou: "não commita" virou "NÃO commita". */
export function addedEmphasis(original: string, rewritten: string): string[] {
  const his = new Set(emphasisOf(original))
  return emphasisOf(rewritten).filter(word => LOUD.has(word) && !his.has(word))
}

const WORD = /[\p{L}\p{N}]+/gu
const isShouted = (word: string): boolean => (word.match(/\p{L}/gu)?.length ?? 0) >= 3 && word === word.toUpperCase() && /\p{Lu}/u.test(word)

/** Se a palavra abre uma frase, uma linha ou um item de lista: aí ela perde o grito mas fica com a inicial maiúscula. */
function startsSentence(text: string, offset: number): boolean {
  const before = text.slice(0, offset).replace(/[ \t]+$/, '')
  return before === '' || /[.!?\n]$/.test(before) || /(?:^|\n)[ \t]*[-•*]$/.test(before)
}

/** Se a palavra é um pedaço de caminho, URL, @menção ou nome de arquivo (`/api/contas`, `server.ts`): não se mexe. */
function isInsideToken(text: string, offset: number, length: number): boolean {
  const prev = text[offset - 1] ?? ''
  const next = text[offset + length] ?? ''
  const afterNext = text[offset + length + 1] ?? ''
  const beforePrev = text[offset - 2] ?? ''
  if ('/\\@_-`'.includes(prev) && prev !== '') return true
  if ('/\\_@-`'.includes(next) && next !== '') return true
  if (prev === '.' && /[\p{L}\p{N}]/u.test(beforePrev)) return true
  return next === '.' && /[\p{L}\p{N}]/u.test(afterNext)
}

/**
 * Acerta a ênfase da reescrita pela do dono, onde isso é só questão de maiúsculas, para a reescrita boa não ser
 * descartada por uma palavra: a palavra de grito que o especialista pôs em MAIÚSCULAS volta a minúsculas ("NÃO troque"
 * vira "não troque"), e a palavra que o dono gritou e aparece uma vez só na reescrita, em minúsculas, volta a
 * MAIÚSCULAS ("Não use" vira "NÃO use"). O que não dá para acertar assim (a palavra sumiu, ou aparece duas vezes)
 * fica para as travas.
 */
export function fixEmphasis(original: string, rewritten: string): string {
  const his = new Set(emphasisOf(original))
  const loud = new Set(addedEmphasis(original, rewritten))
  const kept = new Set(emphasisOf(rewritten))
  const lost = new Set([...his].filter(word => !kept.has(word)))
  if (loud.size === 0 && lost.size === 0) return rewritten
  const counts = new Map<string, number>()
  for (const found of rewritten.matchAll(WORD)) {
    if (isInsideToken(rewritten, found.index, found[0].length)) continue
    counts.set(folded(found[0]), (counts.get(folded(found[0])) ?? 0) + 1)
  }
  return rewritten.replace(WORD, (word: string, offset: number) => {
    if (isInsideToken(rewritten, offset, word.length)) return word
    const key = folded(word)
    if (loud.has(key) && isShouted(word)) return startsSentence(rewritten, offset) ? `${word.slice(0, 1)}${word.slice(1).toLowerCase()}` : word.toLowerCase()
    if (lost.has(key) && counts.get(key) === 1) return word.toUpperCase()
    return word
  })
}

/** Abreviações de digitação que se escrevem por extenso: a palavra conta como mantida nas duas formas. */
const SPELLED_OUT: Readonly<Record<string, readonly string[]>> = {
  vc: ['voce'],
  vcs: ['voces'],
  pq: ['porque', 'por'],
  tbm: ['tambem'],
  qdo: ['quando'],
  qnd: ['quando'],
  mto: ['muito'],
  msm: ['mesmo'],
  msg: ['mensagem'],
  pfv: ['favor'],
  pfvr: ['favor'],
  obg: ['obrigado'],
  dps: ['depois'],
  vdd: ['verdade'],
  ngm: ['ninguem'],
  cmg: ['comigo'],
  hj: ['hoje'],
  td: ['tudo'],
  tds: ['todos', 'todas'],
  blz: ['beleza'],
  pra: ['para'],
  pro: ['para'],
}

/** O que não conta para dizer se as palavras dele ficaram: ligação, pronome, verbo de apoio, cortesia. */
const STOPWORDS = new Set(
  (
    'que para pra pro com uma umas uns por favor please isso isto esse essa esses essas este esta estes estas aquele aquela ' +
    'como mais mas tudo todo toda todos todas ele ela eles elas voce voces vamos quero queria preciso precisa pode podem ' +
    'entao tambem aqui agora ainda onde quando depois antes sobre cada muito muita muitos muitas bem mesmo mesma nosso nossa ' +
    'nossos nossas meu minha meus minhas seu sua seus suas dele dela deles delas estao ser ter tem temos fazer faz faca ' +
    'vai vou foi era sao sendo sido assim tipo coisa coisas mano gente deixa deixe deixar ficar fica fique veja ver olha ' +
    'olhe the and for with this that you are can will dos das nos nas num numa pelo pela pelos pelas'
  ).split(' '),
)

export const wordsOf = (text: string): Set<string> => new Set(folded(text).match(/[\p{L}\d]{3,}/gu) ?? [])

/** Distância de edição com troca de vizinhas (OSA), parando assim que passa de `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (before[j - 2] ?? 0) + 1)
      current.push(value)
      best = Math.min(best, value)
    }
    if (best > limit) return limit + 1
    before = previous
    previous = current
  }
  return previous[b.length] ?? limit + 1
}

/** Se a palavra ficou: igual, por extenso, com o erro de digitação corrigido, ou flexionada (quebrando, quebra). */
function survives(word: string, after: Set<string>, afterList: readonly string[]): boolean {
  if (after.has(word)) return true
  if ((SPELLED_OUT[word] ?? []).some(full => after.has(full))) return true
  const limit = word.length >= 6 ? 2 : word.length >= 4 ? 1 : 0
  // A mesma palavra flexionada (mexer, mexa; corrige, corrija; quebrando, quebrou): o radical, sem as duas últimas letras.
  const stem = word.length >= 5 ? word.slice(0, Math.min(5, word.length - 2)) : ''
  return afterList.some(
    other => (limit > 0 && distance(word, other, limit) <= limit) || (stem !== '' && other.length >= 4 && other.startsWith(stem)),
  )
}

/**
 * Quanto das palavras da original ficou na reescrita, de 0 a 1. `content` conta só as palavras de conteúdo (4 letras
 * ou mais, fora as de ligação), que é o que o Engenharia não pode perder quando reorganiza a frase.
 */
export function keptShare(original: string, rewritten: string, content = false): number {
  const before = [...wordsOf(original)].filter(word => !content || (word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)))
  if (before.length === 0) return 1
  const after = wordsOf(rewritten)
  const afterList = [...after]
  return before.filter(word => survives(word, after, afterList)).length / before.length
}

// ── as travas ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** O começo de uma resposta, não de um pedido: o especialista respondeu a mensagem em vez de reescrevê-la. */
const ANSWERED = /^(?:claro|certo|entendi|perfeito|ótimo|otimo|beleza|com certeza|aqui está|aqui esta|segue|vou |posso |sim[,.!]|ok[,.!])/i
/**
 * O dono respondendo ao agente ("pode sim!", "okay! então…", "top! consegue…"): aí a reescrita também pode abrir por
 * "Sim," ou "Ok,", porque é ele quem aprova, não o especialista quem responde.
 */
const APPROVES = /^(?:pode|sim|ok|okay|isso|fechado|manda|bora|top|show|boa|combinado)(?![\p{L}])/iu

/**
 * O que a reescrita traz de técnico que não estava na mensagem nem na conversa: caminho, URL, comando entre crases ou
 * @menção inventados. Os números ficam de fora: a lista numerada cria os seus.
 */
export function inventedTokens(original: string, rewritten: string, context = ''): string[] {
  const known = `${original}\n${context}`
  return protectedTokens(rewritten).filter(token => !known.includes(token))
}

/** O motivo para descartar a reescrita, ou `undefined` quando ela pode seguir. `context` é a conversa e a pasta. */
export function rejectReason(expert: Expert, original: string, rewritten: string, context = ''): string | undefined {
  const plan = PLAN[expert]
  if (rewritten.trim() === '') return 'veio vazia'
  if (rewritten.length < original.length * plan.minRatio) return 'encurtou demais'
  if (rewritten.length > Math.max(original.length * plan.maxRatio, original.length + plan.slackChars)) return 'cresceu demais'
  const lost = [...protectedTokens(original), ...numbersOf(original)].find(token => !rewritten.includes(token))
  if (lost !== undefined) return `perdeu ${clip(lost, 40)}`
  if (pastedLines(original).some(line => !rewritten.includes(line))) return 'mexeu num trecho colado'
  const caps = new Set(emphasisOf(rewritten))
  const flat = emphasisOf(original).find(word => !caps.has(word))
  if (flat !== undefined) return `perdeu a ênfase de ${flat.toUpperCase()}`
  const loud = addedEmphasis(original, rewritten)[0]
  if (loud !== undefined) return `pôs ênfase em ${loud.toUpperCase()}`
  const isLost = expert === 'organizar' ? negationsIn(rewritten) < negationsIn(original) : prohibitionsOut(rewritten) < prohibitionsIn(original)
  if (isLost) return 'perdeu uma negação'
  if (keptShare(original, rewritten, expert === 'engenharia') < plan.minKept) return expert === 'organizar' ? 'trocou palavras' : 'se afastou do pedido'
  if (expert === 'organizar') return undefined
  const invented = inventedTokens(original, rewritten, context)[0]
  if (invented !== undefined) return `inventou ${clip(invented, 40)}`
  const typed = original.trim()
  if (ANSWERED.test(rewritten.trim()) && !ANSWERED.test(typed) && !APPROVES.test(typed)) return 'respondeu em vez de reescrever'
  return undefined
}

/** Tira o que o modelo às vezes põe em volta da resposta: cerca de código, aspas ou a tag de entrada. */
export function cleanReply(reply: string): string {
  const trimmed = reply.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(trimmed)
  const inner = (fenced?.[1] ?? trimmed).trim()
  const out = inner
    .replace(/^<(mensagem|saida|prompt|resultado)>\s*([\s\S]*?)\s*<\/\1>$/, '$2')
    .replace(/^<(?:mensagem|saida|prompt|resultado)>\s*/, '')
    .replace(/\s*<\/(?:mensagem|saida|prompt|resultado)>$/, '')
    .trim()
  // Uma tag que fecha no fim sem ter aberto (`</...>`): sobra da resposta, não do pedido. A de um log colado fica.
  const tail = /<\/([^<>\s]*)>$/.exec(out)
  return tail !== null && !out.includes(`<${tail[1]}>`) ? out.slice(0, tail.index).trimEnd() : out
}

// ── o que vai para o especialista ────────────────────────────────────────────────────────────────────────────────────

/** O que o motor põe dentro de uma mensagem "user" e o dono não digitou: lembrete, aviso de tarefa, eco de comando. */
const MACHINE_BLOCK =
  /<(system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?<\/\1>/g
/** Uma mensagem "user" inteira que não é dele: começa numa tag do motor (menos a do texto colado) ou num aviso fixo. */
const MACHINE_START =
  /^(?:<(?!pasted_content\b)[a-z][\w-]*[\s>]|Caveat:|\[Request interrupted|This session is being continued|Stop hook feedback|Base directory for this skill)/

/**
 * O que o dono digitou numa mensagem "user" da transcrição, ou `''` quando ela não é dele. A âncora que o próprio mod
 * manda junto e os blocos do motor saem; um bloco colado vira uma linha dizendo o tamanho.
 */
export function ownerText(text: string): string {
  const anchorAt = text.indexOf(ANCHOR_OPEN)
  const own = (anchorAt === -1 ? text : text.slice(0, anchorAt)).replace(MACHINE_BLOCK, '').trim()
  if (own === '' || MACHINE_START.test(own)) return ''
  return own.replace(PASTED_BLOCK, block => `(bloco colado, ${insideOf(block).length} caracteres)`)
}

/**
 * A conversa como o Engenharia lê, a mais antiga primeiro: as últimas mensagens do dono (`[dono]`) e, antes de cada
 * uma, a resposta do agente a que ele reagiu (`[agente]`); a resposta mais recente vem quase inteira.
 */
export function conversationOf(recent: readonly Turn[] = []): string {
  const turns = recent
    .map(turn => ({ role: turn.role, text: turn.role === 'user' ? ownerText(turn.text) : turn.text.trim() }))
    .filter(turn => turn.text !== '')
  const lines: string[] = []
  let owners = 0
  let isAwaitingAnswer = true
  let hasAnswer = false
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (turn === undefined) continue
    if (turn.role === 'assistant') {
      if (!isAwaitingAnswer) continue
      lines.unshift(`[agente] ${clip(turn.text, hasAnswer ? EARLIER_ANSWER_CHARS : LAST_ANSWER_CHARS)}`)
      isAwaitingAnswer = false
      hasAnswer = true
      if (owners === OWNER_MESSAGES) break
      continue
    }
    if (owners === OWNER_MESSAGES) break
    lines.unshift(`[dono] ${clip(turn.text, OWNER_CHARS)}`)
    owners++
    isAwaitingAnswer = true
  }
  const joined = lines.join('\n\n')
  return joined.length <= CONVERSATION_CHARS ? joined : joined.slice(joined.length - CONVERSATION_CHARS)
}

/** Quem vai ler a reescrita, numa linha: o harness e o modelo, quando se sabe. */
export function targetOf(harness: Harness, model?: string): string {
  const name = harness === 'codex' ? 'Codex (modelo GPT)' : 'Claude Code (modelo Claude)'
  return model !== undefined && model !== '' ? `${name}, ${model}` : name
}

/** O começo e o fim de cada bloco colado, para o Engenharia saber o que é sem ter de copiá-lo. */
function pastedPreview(blocks: readonly string[]): string {
  const previews = blocks.map((block, index) => {
    const inside = insideOf(block)
    return `${pastedMark(index)} (${inside.length} caracteres)\n${clip(inside, PASTED_PREVIEW_CHARS)}`
  })
  return `<colados>\n${previews.join('\n\n')}\n</colados>`
}

/**
 * O texto que o especialista recebe como mensagem: só a mensagem no Organizar; alvo, pasta, conversa e o começo do
 * que foi colado no Engenharia. Nos dois, cada bloco colado vai como um marcador (`[[COLADO-1]]`).
 */
export function inputFor(expert: Expert, input: ExpertInput): string {
  const { text, blocks } = splitPasted(input.text)
  const message = `<mensagem>\n${text}\n</mensagem>`
  if (expert === 'organizar') return message
  const conversation = conversationOf(input.recent) || '(sessão nova: nenhuma mensagem antes desta)'
  return [
    `<alvo>${targetOf(input.harness, input.model)}</alvo>`,
    `<projeto>${input.cwd ?? ''}</projeto>`,
    `<conversa_recente>\n${conversation}\n</conversa_recente>`,
    ...(blocks.length === 0 ? [] : [pastedPreview(blocks)]),
    message,
  ].join('\n\n')
}

/**
 * O que as travas do Engenharia aceitam como já conhecido: a pasta, a conversa e o que ele colou (de onde o
 * especialista pode tirar um caminho ou um nome).
 */
export function contextOf(input: ExpertInput): string {
  return `${input.cwd ?? ''}\n${conversationOf(input.recent)}\n${splitPasted(input.text).blocks.join('\n')}`
}

// ── as lacunas ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Quantas lacunas o Engenharia pode apontar, e o tamanho de cada uma na faixa. */
export const MAX_GAPS = 2
const GAP_CHARS = 90
/** O bloco no fim da resposta, com ou sem uma cerca de código em volta dele. */
const GAPS_BLOCK = /\s*(?:```[\w-]*\s*)?<lacunas>([\s\S]*?)<\/lacunas>\s*(?:```)?\s*$/
const NO_GAP = /^(?:nenhuma|nenhum|nada|não há|nao ha)\b/i

/**
 * Separa da resposta do Engenharia o bloco `<lacunas>` do fim: o que falta no pedido e só o dono sabe. As lacunas são
 * para ele ver na revisão; nunca entram no texto que vai para o agente.
 */
export function splitGaps(reply: string): { text: string; gaps: string[] } {
  const trimmed = reply.trim()
  const found = GAPS_BLOCK.exec(trimmed)
  if (found === null) return { text: trimmed, gaps: [] }
  const gaps = (found[1] ?? '')
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(line => line !== '' && !NO_GAP.test(line))
    .slice(0, MAX_GAPS)
    .map(line => (line.length <= GAP_CHARS ? line : `${line.slice(0, GAP_CHARS - 1).trimEnd()}…`))
  return { text: trimmed.slice(0, found.index).trimEnd(), gaps }
}

/** A resposta do especialista em duas partes: a reescrita, limpa, e as lacunas (só o Engenharia as aponta). */
export function replyParts(expert: Expert, reply: string): { text: string; gaps: string[] } {
  const cleaned = cleanReply(reply)
  if (expert === 'organizar') return { text: cleaned, gaps: [] }
  // O bloco pode vir depois da tag de saída ou dentro dela: limpa, separa e limpa o que sobrou.
  const { text, gaps } = splitGaps(cleaned)
  return { text: cleanReply(text), gaps }
}

/**
 * Tira a reescrita da resposta do modelo e diz se ela pode seguir. As travas olham a mensagem e a reescrita com os
 * marcadores no lugar dos blocos colados; a que passa volta com cada bloco inteiro no lugar do seu marcador, e com as
 * lacunas à parte.
 */
export function judge(expert: Expert, input: ExpertInput, reply: string): { text: string; gaps: string[] } | { reason: string } {
  const { text: original, blocks } = splitPasted(input.text)
  const parts = replyParts(expert, reply)
  const { gaps } = parts
  const text = fixEmphasis(original, parts.text)
  if (blocks.length > 0 && text.trim() !== '' && !hasEveryMark(text, blocks)) return { reason: 'mexeu num trecho colado' }
  const reason = rejectReason(expert, original, text, contextOf(input))
  return reason === undefined ? { text: restorePasted(text, blocks), gaps } : { reason }
}

// ── a âncora ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ANCHOR_OPEN = '<mensagem_original_do_dono>'
export const ANCHOR_CLOSE = '</mensagem_original_do_dono>'

/**
 * O que vai junto com a reescrita do Engenharia, para o agente: a mensagem como o dono digitou. Se o dono revisou a
 * reescrita, vale o que ele mandou e a original mostra a intenção; se ela foi sem revisão, vale a original onde as
 * duas divergirem.
 */
export function anchorOf(original: string, isReviewed: boolean): string {
  return (
    `${ANCHOR_OPEN}\n${original}\n${ANCHOR_CLOSE}\n` +
    `A mensagem do dono desta vez foi reestruturada pelo modo Engenharia (${EXPERT_NAME}) a partir do texto acima, ` +
    (isReviewed
      ? 'e o dono revisou a versão reestruturada antes de mandar: vale o que ele mandou, e o texto acima serve para entender a intenção dele.'
      : 'sem revisão do dono. Se as duas divergirem em algum ponto, vale o texto original.')
  )
}
