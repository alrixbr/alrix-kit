/**
 * Caminhos montados por função, no separador da pasta do plugin: o mod roda sem Node, e `$.plugin.root` é
 * `C:\...\astra` no Windows e `/.../astra` no resto.
 */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(path) || /^\\\\/.test(path)

/** `root` e as partes (cada uma pode ter `/`), no separador de `root`. */
export function joinPath(root: string, ...parts: readonly string[]): string {
  const separator = isWindowsPath(root) ? '\\' : '/'
  const pieces = parts.flatMap(part => part.split(/[\\/]+/)).filter(piece => piece !== '')
  return [root.replace(/[\\/]+$/, ''), ...pieces].join(separator)
}
