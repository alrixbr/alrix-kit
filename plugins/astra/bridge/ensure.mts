// A thread de um loop: a que a ponte já tem aberta, a retomada pelo binding (`thread/resume`), ou uma nova. A thread
// retomada guarda a conversa inteira do Codex, e o mod só manda o histórico do Claude Code quando ela é nova.
import { fingerprintOf } from './bindings.mts'
import { type Fields, fieldsOf, recordOf, textOf } from './proto.mts'
import type { Context, Ensured, Thread, ThreadSpec } from './threads.mts'

/**
 * O teto de contexto do astra: no máximo 400 mil tokens antes de compactar. A janela de 445.000 vale para os dois
 * modelos: no Astra (272.000 de catálogo) é o que deixa o limite chegar a 400.000; no Sol (500.000) dá o mesmo limite,
 * e a troca de modelo no meio da thread não muda o teto.
 */
export const COMPACTION: Fields = { model_auto_compact_token_limit: 400_000, model_context_window: 445_000 }

/**
 * A config de toda thread (medida no Codex 0.163; as chaves de `config` não estão nos tipos do protocolo, e na 0.169 seguem sem medida): o projeto sem AGENTS.md vale pelo CLAUDE.md (`project_doc_fallback_filenames`,
 * `codex-rs/config`), e o Codex não abre agente próprio, que não teria as ferramentas do Claude Code nem apareceria no
 * time (medido na F2): agente só pelo `Agent` do Claude Code. A versão do multi-agente sai do
 * `multi_agent_version_override` (`codex-rs/core/src/config/mod.rs`): `features.multi_agent_v2` força a V2, senão
 * `agents.enabled = false` desliga, senão vale o que o modelo anuncia, e o gpt-6.1-sol anuncia a V2. O
 * `features.multi_agent` (a V1) só conta quando o modelo não diz nada: no teste real de 25/10 ele não tirou o
 * `spawn_agent`.
 */
export const THREAD_CONFIG: Fields = { project_doc_fallback_filenames: ['CLAUDE.md'], 'agents.enabled': false, 'features.multi_agent_v2': false }

/**
 * A thread a retomar: a desta ponte cujo App Server caiu, ou a do binding, se o cwd, o fingerprint e a conta batem. A
 * thread de outra conta não volta: abre-se uma nova, que recebe a conversa do Claude Code (se o `thread/resume` entre
 * contas funciona não foi medido). O binding de antes da F6, sem conta, vale como da conta atual.
 */
function candidateOf(ctx: Context, spec: ThreadSpec, fingerprint: string, known: Thread | undefined, account: string): string | undefined {
  if (known !== undefined && known.cwd === spec.cwd && known.fingerprint === fingerprint && known.account === account) return known.threadId
  const saved = spec.session === undefined ? undefined : ctx.bindings?.read(spec.session, spec.key)
  const isSame = saved !== undefined && saved.cwd === spec.cwd && saved.fingerprint === fingerprint && (saved.account ?? account) === account
  return isSame ? saved.threadId : undefined
}

const threadParams = (spec: ThreadSpec): Fields => ({
  model: spec.model,
  cwd: spec.cwd,
  approvalPolicy: 'never',
  sandbox: spec.sandbox ?? 'workspace-write',
  developerInstructions: spec.developerInstructions ?? null,
  config: { ...COMPACTION, ...THREAD_CONFIG, ...spec.config },
})

/** `thread/resume` da candidata; se o App Server recusar (rollout que sumiu, thread de outra conta), abre-se uma nova. */
async function resumeThread(ctx: Context, spec: ThreadSpec, threadId: string | undefined): Promise<string | undefined> {
  if (threadId === undefined) return undefined
  try {
    const answer = await (await ctx.appServer()).request('thread/resume', { ...threadParams(spec), threadId, excludeTurns: true })
    return textOf(recordOf(fieldsOf(answer), 'thread'), 'id') ?? threadId
  } catch {
    return undefined
  }
}

async function startThread(ctx: Context, spec: ThreadSpec): Promise<string> {
  const answer = await (await ctx.appServer()).request('thread/start', { ...threadParams(spec), dynamicTools: spec.dynamicTools, ephemeral: false })
  const threadId = textOf(recordOf(fieldsOf(answer), 'thread'), 'id')
  if (threadId === undefined) throw new Error('thread/start respondeu sem id')
  return threadId
}

/** O binding é o que salva a conversa de uma ponte que reabre; se a gravação falhar, o turno segue sem ele. */
function saveBinding(ctx: Context, spec: ThreadSpec, thread: { threadId: string; fingerprint: string; account: string }): void {
  if (spec.session === undefined) return
  try {
    ctx.bindings?.write(spec.session, spec.key, { ...thread, cwd: spec.cwd, model: spec.model, updatedAt: new Date().toISOString() })
  } catch {
    // Disco cheio ou pasta sem permissão: a thread vale nesta ponte, e uma ponte nova abre outra.
  }
}

export async function ensureThread(ctx: Context, spec: ThreadSpec): Promise<Ensured> {
  const known = ctx.byKey.get(spec.key)
  if (known !== undefined && !known.isStale && known.cwd === spec.cwd) return { threadId: known.threadId, isNew: false }
  const fingerprint = fingerprintOf(spec.dynamicTools, spec.developerInstructions)
  const { account } = await ctx.appServer()
  const resumed = await resumeThread(ctx, spec, candidateOf(ctx, spec, fingerprint, known, account))
  const threadId = resumed ?? (await startThread(ctx, spec))
  // A thread que o loop deixa (outro cwd) não fala mais por ele: um aviso atrasado dela fecharia o turno da nova.
  if (known !== undefined && known.threadId !== threadId) ctx.keyOf.delete(known.threadId)
  ctx.keyOf.set(threadId, spec.key)
  ctx.byKey.set(spec.key, {
    threadId, cwd: spec.cwd, session: spec.session, fingerprint, account, isStale: false, isRunning: false, isHandedOff: false, isCompacting: false,
    seq: known?.seq ?? 0, events: known?.events ?? [], calls: new Map(), phases: new Map(), streamed: new Set(), batchUntil: 0,
  })
  saveBinding(ctx, spec, { threadId, fingerprint, account })
  return { threadId, isNew: resumed === undefined }
}
