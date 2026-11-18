// O Node que abre a ponte precisa ler `.mts` sem opção nenhuma: 22.18 ou mais novo na linha 22, 23.6 ou mais novo depois.
export const MIN_NODE = '22.18'

/** @param {string} version a versão sem o `v` (`process.versions.node`) */
export function isEnoughNode(version) {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}

/** @param {string} version */
export const oldNodeLine = version =>
  `a ponte não subiu: o Node.js desta máquina é a versão ${version}, e o astra precisa da ${MIN_NODE} ou mais nova. `
  + 'Instale a versão LTS em https://nodejs.org e abra o Claude Code de novo.'
