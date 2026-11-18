import type { Register } from 'claude-code'

/** Só para o `sync-tools.mts`: tira toda ferramenta de trás do ToolSearch, para que o pedido traga o schema de cada uma. */
export const register: Register = on => {
  on('tool.describe', async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
}
