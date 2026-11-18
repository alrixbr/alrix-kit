// Tradução pura dos avisos do App Server em eventos do turno, na ordem em que chegam.
// A fala do Codex tem fase: `commentary` (o que ele narra enquanto trabalha) vira pensamento, que o Claude Code mostra
// ao vivo e não guarda; a resposta (`final_answer`, `partial_answer` ou sem fase) vira texto, que fica no transcript.
import { type Fields, itemView, type NewEvent, recordOf, textOf, usageOf } from './proto.mts'

export type Translation = {
  events: readonly NewEvent[]
  /** A fase de uma fala nova (`item/started` de `agentMessage`), pelo id do item. */
  phase?: readonly [string, string]
  /** O item de fala que mandou pedaços: no fim, não se repete o texto inteiro. */
  streamed?: string
  isTurnOver?: boolean
}

const NONE: Translation = { events: [] }

const speech = (phase: string | undefined): 'text' | 'thinking' => (phase === 'commentary' ? 'thinking' : 'text')

function delta(params: Fields, phases: ReadonlyMap<string, string>): Translation {
  const itemId = textOf(params, 'itemId') ?? ''
  const text = textOf(params, 'delta') ?? ''
  return text === '' ? NONE : { events: [{ kind: speech(phases.get(itemId)), delta: text }], streamed: itemId }
}

function started(params: Fields): Translation {
  const item = recordOf(params, 'item')
  if (textOf(item, 'type') === 'agentMessage') return { events: [], phase: [textOf(item, 'id') ?? '', textOf(item, 'phase') ?? 'final_answer'] }
  const view = itemView(item)
  return view === undefined ? NONE : { events: [{ kind: 'item', phase: 'started', item: view }] }
}

function completed(params: Fields, streamed: ReadonlySet<string>): Translation {
  const item = recordOf(params, 'item')
  if (textOf(item, 'type') === 'agentMessage') {
    const text = textOf(item, 'text') ?? ''
    const isNew = !streamed.has(textOf(item, 'id') ?? '') && text !== ''
    return isNew ? { events: [{ kind: speech(textOf(item, 'phase')), delta: text }] } : NONE
  }
  const view = itemView(item)
  return view === undefined ? NONE : { events: [{ kind: 'item', phase: 'completed', item: view }] }
}

function turnOver(params: Fields): Translation {
  const turn = recordOf(params, 'turn')
  const error = textOf(recordOf(turn, 'error'), 'message')
  const status = textOf(turn, 'status') ?? 'completed'
  return { events: [{ kind: 'done', status, ...(error === undefined ? {} : { error }) }], isTurnOver: true }
}

export function translate(method: string, params: Fields, phases: ReadonlyMap<string, string>, streamed: ReadonlySet<string>): Translation {
  switch (method) {
    case 'item/agentMessage/delta':
      return delta(params, phases)
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const text = textOf(params, 'delta') ?? ''
      return text === '' ? NONE : { events: [{ kind: 'thinking', delta: text }] }
    }
    case 'item/started':
      return started(params)
    case 'item/completed':
      return completed(params, streamed)
    case 'thread/tokenUsage/updated':
      return { events: [{ kind: 'usage', usage: usageOf(recordOf(params, 'tokenUsage')) }] }
    case 'error':
      return { events: [{ kind: 'error', message: textOf(recordOf(params, 'error'), 'message') ?? 'erro sem mensagem', willRetry: params.willRetry === true }] }
    case 'turn/completed':
      return turnOver(params)
    default:
      return NONE
  }
}
