import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { AlrixPromptLast } from '../types'
import { LABEL, readLast } from './state'

export const PANE_ID = 'alrix-prompt'
export const PANE_TITLE = 'alrix-prompt · original e reescrita'

type PaneInput = Extract<RenderInput, { component: 'Pane' }>

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

const OUTCOME: Record<AlrixPromptLast['outcome'], string> = {
  enviada: 'enviada',
  'na caixa': 'na caixa, esperando você',
  revisada: 'revisada e enviada',
  original: 'foi a original',
  descartada: 'descartada',
  cancelada: 'cancelada',
}

const sentLabel = (done: AlrixPromptLast): string =>
  done.outcome === 'na caixa' ? 'Está na caixa' : done.outcome === 'revisada' ? 'Foi para o agente, revisada por você' : 'Foi para o agente'

/** O painel de comparação: a mensagem como o dono digitou e como o especialista a deixou, com o custo. */
export async function renderPane($: EngineInterface, e: PaneInput): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const done = await readLast($)
  if (done?.rewritten === undefined) return <Text dimColor>Nenhuma reescrita nesta sessão ainda.</Text>
  const cost = done.tokensOut === 0 ? '' : ` · ${seconds(done.ms)} · ${done.tokensIn} → ${done.tokensOut} tokens`
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text dimColor>
        {LABEL[done.mode]} · {OUTCOME[done.outcome]}
        {cost} · Esc fecha
      </Text>
      <Box flexDirection="column">
        <Text bold>Você digitou</Text>
        <Text dimColor>{done.original}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold color="success">
          {sentLabel(done)}
        </Text>
        <Text>{done.rewritten}</Text>
      </Box>
      {done.gaps === undefined ? null : (
        <Box flexDirection="column">
          <Text bold color="warning">
            Falta dizer (só você vê; não foi para o agente)
          </Text>
          {done.gaps.map(gap => (
            <Text key={`gap-${gap}`}>· {gap}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
