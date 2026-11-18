// Lê o limite de uso do Codex e o catálogo de modelos, sem rodar modelo nenhum.
//
// Limite: abre `codex app-server` (JSON-RPC por stdio, sem o campo "jsonrpc"), faz `initialize` e
// chama `account/rateLimits/read`. Só lê: nunca chama `account/rateLimitResetCredit/consume` nem
// `account/sendAddCreditsNudgeEmail`, que gastam ou pedem crédito.
// Catálogo: `codex debug models`.
//
// A entrada padrão do servidor precisa ficar aberta até a resposta chegar: fechada antes, ele sai
// sem responder (visto no codex-cli 0.167.0 em 10/11/2026). Por isso este arquivo existe: o mod não
// consegue manter a entrada de um processo aberta.
//
// Uso: node codex-limite.mjs [caminho do executável do codex]
// Saída: uma linha JSON no formato LeituraCodex de hooks/contrato.ts. O id da conta não sai daqui.
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ESPERA_MS = 20_000

/**
 * Como chamar o codex: o comando, os argumentos que vêm antes dos nossos e se precisa de shell.
 * Sem shell os argumentos chegam inteiros (aspas e colchetes de um `-c` incluídos); com shell, não.
 */
export function executavel(dito) {
  const escolhido = dito || process.env.CODEX_BIN
  if (escolhido) return { comando: escolhido, prefixo: [], shell: false }
  if (process.platform === 'win32' && process.env.APPDATA) {
    const pacote = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex')
    const nativo = path.join(pacote, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    if (existsSync(nativo)) return { comando: nativo, prefixo: [], shell: false }
    // Sem o binário no lugar de sempre, o lançador do npm roda pelo Node, ainda sem shell.
    const lancador = path.join(pacote, 'bin', 'codex.js')
    if (existsSync(lancador)) return { comando: process.execPath, prefixo: [lancador], shell: false }
    return { comando: 'codex', prefixo: [], shell: true }
  }
  return { comando: 'codex', prefixo: [], shell: false }
}

function janela(w) {
  if (!w) return null
  return { usadoPct: w.usedPercent, minutos: w.windowDurationMins ?? null, voltaEm: w.resetsAt ?? null }
}

function balde(id, s) {
  return {
    id,
    nome: s.limitName ?? null,
    modelo: s.normalModelSlug ?? null,
    limiteAtingido: s.rateLimitReachedType ?? null,
    gastoBarrado: s.spendControlReached ?? null,
    janelaA: janela(s.primary),
    janelaB: janela(s.secondary),
    temCredito: s.credits?.hasCredits ?? null,
    plano: s.planType ?? null,
  }
}

/** Modelos que o Codex mostra em sua lista; null se o catálogo não pôde ser lido. */
function catalogo(comando, prefixo, shell) {
  return new Promise(resolve => {
    execFile(comando, [...prefixo, 'debug', 'models'], { shell, windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 * 1024 }, (erro, stdout) => {
      if (erro) return resolve(null)
      try {
        const j = JSON.parse(stdout)
        const lista = Array.isArray(j) ? j : j.models
        resolve(lista.filter(m => m.visibility === 'list').map(m => ({
          id: m.slug,
          nome: m.display_name,
          esforcos: (m.supported_reasoning_levels ?? []).map(n => (typeof n === 'string' ? n : n.effort)),
        })))
      } catch {
        resolve(null)
      }
    })
  })
}

function limite(comando, prefixo, shell) {
  return new Promise(resolve => {
    let filho
    let feito = false
    const fim = resultado => {
      if (feito) return
      feito = true
      clearTimeout(relogio)
      if (filho) {
        try { filho.stdin.end() } catch { /* já fechada */ }
        try { filho.kill() } catch { /* já saiu */ }
      }
      resolve(resultado)
    }
    const relogio = setTimeout(() => fim({ ok: false, motivo: 'sem-resposta', detalhe: `${ESPERA_MS} ms` }), ESPERA_MS)
    try {
      filho = spawn(comando, [...prefixo, 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'], shell, windowsHide: true })
    } catch (erro) {
      return fim({ ok: false, motivo: 'nao-iniciou', detalhe: String(erro?.message ?? erro) })
    }
    filho.on('error', erro => fim({ ok: false, motivo: 'nao-iniciou', detalhe: String(erro?.message ?? erro) }))
    filho.on('exit', codigo => fim({ ok: false, motivo: 'saiu-antes', detalhe: `codigo ${codigo}` }))
    const enviar = mensagem => filho.stdin.write(JSON.stringify(mensagem) + '\n')

    let resto = ''
    filho.stdout.setEncoding('utf8')
    filho.stdout.on('data', pedaco => {
      resto += pedaco
      let corte
      while ((corte = resto.indexOf('\n')) >= 0) {
        const linha = resto.slice(0, corte).trim()
        resto = resto.slice(corte + 1)
        if (!linha) continue
        let m
        try { m = JSON.parse(linha) } catch { continue }
        if (m.id === 1) {
          if (m.error) return fim({ ok: false, motivo: 'initialize-recusado', detalhe: String(m.error.message ?? '') })
          enviar({ method: 'initialized' })
          enviar({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
        } else if (m.id === 2) {
          if (m.error) return fim({ ok: false, motivo: 'leitura-recusada', detalhe: String(m.error.message ?? '') })
          const r = m.result ?? {}
          const porId = r.rateLimitsByLimitId ?? {}
          return fim({
            ok: true,
            lidoEm: Math.floor(Date.now() / 1000),
            // O servidor avisa: null quer dizer "não sei"; não deduzir por percentual nem por hora de volta.
            usoComumLiberado: r.ordinaryUsageAllowed ?? null,
            geral: balde(r.rateLimits?.limitId ?? 'geral', r.rateLimits ?? {}),
            baldes: Object.keys(porId).map(id => balde(id, porId[id] ?? {})),
          })
        }
      }
    })
    enviar({ id: 1, method: 'initialize', params: { clientInfo: { name: 'equipe', title: 'equipe', version: '0.1.0' } } })
  })
}

const souOPrincipal = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (souOPrincipal) {
  const { comando, prefixo, shell } = executavel(process.argv[2])
  const [leitura, modelos] = await Promise.all([limite(comando, prefixo, shell), catalogo(comando, prefixo, shell)])
  const saida = leitura.ok ? { ...leitura, modelos } : leitura
  process.stdout.write(JSON.stringify(saida) + '\n')
  process.exit(leitura.ok ? 0 : 1)
}
