import type { Color, EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { AlrixPromptLast, AlrixPromptMode, AlrixPromptPending } from '../types'
import { EXPERT_NAME } from './core'
import { PANE_ID, PANE_TITLE } from './pane'
import type { BandView } from './state'
import { changePending, DOING, LABEL, MODES, pressMode, readBand } from './state'
import { cancelInflight } from './submit'

type BandInput = Extract<RenderInput, { component: 'AbovePrompt' }>
type Status = { text: string; color?: Color; isDim?: boolean }

/** Cada modo com a sua cor do tema, para o modo ativo saltar aos olhos. */
export const MODE_COLOR: Record<AlrixPromptMode, Color> = { normal: 'text', organizar: 'success', engenharia: 'merged' }
/** Abaixo desta largura a faixa esconde a dica do atalho, para caber numa linha. */
const ROOMY_COLUMNS = 96

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`
export const tokens = (count: number): string =>
  count < 1_000 ? String(count) : `${(count / 1_000).toFixed(1).replace('.', ',')} mil`

const costOf = (done: AlrixPromptLast): string =>
  done.tokensOut === 0 ? '' : ` · ${seconds(done.ms)} · ${tokens(done.tokensIn)} → ${tokens(done.tokensOut)} tokens`

function lastStatus(done: AlrixPromptLast): Status {
  if (done.outcome === 'descartada') return { text: `⚠ reescrita descartada (${done.note ?? 'sem motivo'}) · foi a sua original`, color: 'warning' }
  if (done.outcome === 'cancelada') return { text: '· cancelada: nada foi enviado', isDim: true }
  if (done.outcome === 'revisada') return { text: `✓ revisada e enviada${done.mode === 'engenharia' ? ', com a original junto' : ''}`, isDim: true }
  if (done.outcome === 'original') return { text: '· foi a sua original', isDim: true }
  return { text: `✓ ${done.mode === 'organizar' ? 'organizada' : 'reestruturada'}${costOf(done)}`, isDim: true }
}

/** O que a faixa diz ao lado dos modos: o trabalho em curso, a revisão pendente, o modo armado ou a última mensagem. */
export function statusOf({ session, armed, working, held, done }: BandView): Status | undefined {
  if (working !== null) return { text: `◐ ${DOING[working.mode]} com o ${EXPERT_NAME} · ${working.seconds} s`, color: 'warning' }
  if (held !== null && held.choice === 'original') return { text: '✎ a sua original está na caixa: Enter manda como está', color: 'merged' }
  if (held !== null) return { text: `✎ revise a versão ${held.mode === 'organizar' ? 'organizada' : 'reestruturada'} na caixa e aperte Enter`, color: 'merged' }
  if (armed !== null) {
    const index = MODES.indexOf(armed) + 1
    if (armed === session && armed === 'engenharia') return { text: 'Engenharia na próxima mensagem, mesmo curta', color: MODE_COLOR[armed] }
    return armed === 'normal'
      ? { text: `a próxima vai como você digitar · ${index} de novo deixa Normal na sessão`, color: 'text' }
      : { text: `${LABEL[armed]} só na próxima mensagem · ${index} de novo mantém na sessão`, color: MODE_COLOR[armed] }
  }
  if (done !== null) return lastStatus(done)
  if (session === 'normal') return undefined
  return { text: session === 'engenharia' ? 'Engenharia nesta sessão · só nas mensagens longas' : `${LABEL[session]} nesta sessão`, isDim: true }
}

/**
 * Troca o que vai na caixa durante a revisão: a reescrita ou a original. A reescrita sai da caixa como o dono a deixou,
 * e é essa que volta se ele trocar de novo.
 */
async function swapChoice($: EngineInterface, held: AlrixPromptPending): Promise<void> {
  if (held.choice === 'original') {
    await changePending($, current => ({ ...current, choice: 'reescrita', isSettled: true }))
    await $.prompt.fill({ text: held.rewritten })
    return
  }
  const box = await $.prompt.read()
  const edited = box.text.trim() === '' ? held.rewritten : box.text
  await changePending($, current => ({ ...current, rewritten: edited, choice: 'original', isSettled: true }))
  await $.prompt.fill({ text: held.original })
}

/**
 * O que falta no pedido, para mostrar abaixo da linha dos modos: durante a revisão ("falta dizer", ainda dá para
 * completar na caixa) ou logo depois de uma reescrita que foi direto ("faltou dizer"). Com a original na caixa, some.
 */
export function gapsOf({ working, held, done }: BandView): { label: string; gaps: readonly string[] } | undefined {
  if (working !== null) return undefined
  if (held !== null) return held.choice === 'reescrita' && held.gaps !== undefined ? { label: 'falta dizer', gaps: held.gaps } : undefined
  return done?.outcome === 'enviada' && done.gaps !== undefined ? { label: 'faltou dizer', gaps: done.gaps } : undefined
}

/** O modo que a próxima mensagem usa: o armado, ou o da sessão. É ele que aparece aceso. */
const lit = (view: BandView): AlrixPromptMode => view.armed ?? view.session

/** A linha dos modos acima do prompt; o que outros mods desenham na faixa vem logo abaixo dela. */
export async function renderBand(
  $: EngineInterface,
  e: BandInput,
  next: (e: BandInput) => Promise<RenderElement>,
): Promise<RenderElement> {
  if (e.props.hasSurvey) return next(e)
  const view = await readBand($)
  const status = statusOf(view)
  const below = await next(e)
  const { Box, Button, Text } = $.ui.resolve(e)
  const { held, done, working } = view
  const active = lit(view)
  const canSwap = held !== null && working === null && held.rewritten !== held.original
  const canCompare = working === null && done?.rewritten !== undefined
  const isRoomy = e.props.bodyColumns >= ROOMY_COLUMNS
  const missing = gapsOf(view)
  return (
    <Box flexDirection="column">
      <Box columnGap={2}>
        <Text color="claude" bold>
          ✎ prompt
        </Text>
        {MODES.map((one, index) => (
          <Button key={`alrix-prompt-${one}`} hotkey={String(index + 1)} plain dimColor={one !== active} onPress={() => pressMode($, one)}>
            {one === active ? (
              <Text bold color={MODE_COLOR[one]}>
                {LABEL[one]}
              </Text>
            ) : (
              LABEL[one]
            )}
          </Button>
        ))}
        {status === undefined ? (
          isRoomy ? <Text dimColor>ctrl+x tab e 2 ou 3: só a próxima · de novo: na sessão</Text> : null
        ) : (
          <Text color={status.color} dimColor={status.isDim} wrap="truncate-end">
            {status.text}
          </Text>
        )}
        {working === null ? null : (
          <Button key="alrix-prompt-cancel" hotkey="x" plain onPress={() => void cancelInflight()}>
            cancelar
          </Button>
        )}
        {canSwap ? (
          <Button key="alrix-prompt-swap" hotkey="o" plain onPress={() => swapChoice($, held)}>
            {held.choice === 'reescrita' ? 'usar a original' : 'usar a reescrita'}
          </Button>
        ) : null}
        {canCompare ? (
          <Button key="alrix-prompt-compare" hotkey="v" plain dimColor onPress={() => void $.ui.open({ id: PANE_ID, title: PANE_TITLE, closeOnEscape: true, focus: true })}>
            comparar
          </Button>
        ) : null}
      </Box>
      {missing === undefined
        ? null
        : missing.gaps.map(gap => (
            <Box key={`alrix-prompt-gap-${gap}`} columnGap={1}>
              <Text color="warning">{missing.label}</Text>
              <Text>{gap}</Text>
            </Box>
          ))}
      {below}
    </Box>
  )
}
