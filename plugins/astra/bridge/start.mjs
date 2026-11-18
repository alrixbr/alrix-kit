// A porta de entrada da ponte, em JavaScript puro: confere o Node antes de carregar o TypeScript da ponte
// (`node-version.mjs`). Num Node velho a ponte sai com uma linha que diz o que falta, e é essa linha que o mod mostra.
import { isEnoughNode, oldNodeLine } from './node-version.mjs'

if (!isEnoughNode(process.versions.node)) {
  process.stderr.write(`${oldNodeLine(process.versions.node)}\n`)
  process.exit(1)
}

await import('./main.mts')
