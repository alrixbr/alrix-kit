// Onde está o Codex desta máquina, do jeito que a pessoa o instalou, sem shell e sem texto de comando montado.
// - O caminho da opção `codexPath` do astra, se a pessoa deu um.
// - O primeiro `codex` do PATH. No Windows, `codex.exe` (winget, binário baixado) roda direto; o `codex.cmd` do npm é
//   um script do cmd, que não se abre sem shell: dele se acha o `codex.exe` que o pacote traz (o mesmo que o
//   `bin/codex.js` do pacote abriria) e, se faltar, o próprio `codex.js` com este Node. No Linux e no macOS, o `codex`
//   do PATH roda direto (o do npm é um link para o `codex.js`, com `#!/usr/bin/env node`).
import { posix, win32 } from 'node:path'

/** O comando do App Server e o que vai no ambiente dele (o que o `codex.js` do npm poria). */
export type CodexCommand = { argv: readonly string[]; env: Readonly<Record<string, string>> }

/** O que a busca pergunta ao disco; os testes respondem sem disco. */
export type Disk = { isFile: (path: string) => boolean; realpath: (path: string) => string }

export type Where = {
  given?: string
  path: string | undefined
  platform: NodeJS.Platform
  arch: string
  /** O Node que roda a ponte: abre o `codex.js` quando o pacote do npm não traz o binário. */
  execPath: string
  disk: Disk
}

export const NOT_FOUND =
  'Não achei o Codex nesta máquina. Instale com `npm install -g @openai/codex`, faça login com `codex login` e peça de novo. '
  + 'Se ele já está instalado num lugar fora do PATH, informe o caminho do programa na opção codexPath do astra (no menu /config).'

const APP_SERVER = ['app-server'] as const
const WINDOWS_NAMES = ['codex.exe', 'codex.cmd', 'codex.ps1', 'codex.bat', 'codex'] as const

/** O alvo do binário que o pacote do npm traz por sistema (`bin/codex.js` do @openai/codex). */
const TRIPLES: Readonly<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
}

/** As pastas do PATH na ordem; no Windows o separador é `;`. */
export function pathDirs(path: string | undefined, platform: NodeJS.Platform): readonly string[] {
  return (path ?? '').split(platform === 'win32' ? ';' : ':').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => dir !== '')
}

/** O `codex.exe` que o pacote do npm traz (em `node_modules` dele ou ao lado), e a pasta do pacote. */
function npmNative(dir: string, where: Where): CodexCommand | undefined {
  const { join } = win32
  const root = join(dir, 'node_modules', '@openai', 'codex')
  const triple = TRIPLES[`${where.platform}-${where.arch}`]
  const platformPackage = `codex-${where.platform}-${where.arch}`
  const binaries = triple === undefined ? [] : [
    join(root, 'node_modules', '@openai', platformPackage, 'vendor', triple, 'bin', 'codex.exe'),
    join(dir, 'node_modules', '@openai', platformPackage, 'vendor', triple, 'bin', 'codex.exe'),
    join(root, 'vendor', triple, 'bin', 'codex.exe'),
  ]
  const binary = binaries.find(candidate => where.disk.isFile(candidate))
  if (binary !== undefined) return { argv: [binary, ...APP_SERVER], env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: where.disk.realpath(root) } }
  const script = join(root, 'bin', 'codex.js')
  return where.disk.isFile(script) ? { argv: [where.execPath, script, ...APP_SERVER], env: {} } : undefined
}

/** Um arquivo achado: o binário roda direto; no Windows, o script do npm vira o binário do pacote dele. */
function fromFile(file: string, where: Where): CodexCommand | string {
  if (where.platform !== 'win32' || /\.exe$/i.test(file)) return { argv: [file, ...APP_SERVER], env: {} }
  return npmNative(win32.dirname(file), where)
    ?? `Achei o Codex em ${file}, mas não o binário que ele abre. Reinstale com \`npm install -g @openai/codex\`, ou informe o caminho do codex.exe na opção codexPath do astra.`
}

/** O comando do App Server, ou a frase que diz à pessoa o que falta. */
export function findCodex(where: Where): CodexCommand | string {
  const given = where.given?.trim().replace(/^"(.*)"$/, '$1')
  if (given !== undefined && given !== '') {
    return where.disk.isFile(given) ? fromFile(given, where) : `O caminho do Codex informado na opção codexPath do astra não existe: ${given}`
  }
  const join = where.platform === 'win32' ? win32.join : posix.join
  const names = where.platform === 'win32' ? WINDOWS_NAMES : (['codex'] as const)
  for (const dir of pathDirs(where.path, where.platform)) {
    const file = names.map(name => join(dir, name)).find(candidate => where.disk.isFile(candidate))
    if (file !== undefined) return fromFile(file, where)
  }
  return NOT_FOUND
}
