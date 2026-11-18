// ALRIX · barra de status: o que a linha de status e a linha dos subagentes dividem.
// Cores em paleta.json. Nada aqui usa rede e nada aqui lê coisa que só existe em um computador: a pasta de
// configuração do Claude Code vem de CLAUDE_CONFIG_DIR, ou de ~/.claude quando a variável não existe.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

/** A pasta de configuração do Claude Code em uso: CLAUDE_CONFIG_DIR, ou ~/.claude. */
export function pastaDeConfiguracao() {
  const definida = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  return definida ? resolve(definida) : join(homedir(), '.claude');
}

/** O settings.json da pasta de configuração em uso. */
export const ajustesDaPessoa = () => join(pastaDeConfiguracao(), 'settings.json');

export const RST = '\x1b[0m';
export const NEGRITO = '\x1b[1m';

export function lerJson(caminho) {
  try {
    return JSON.parse(readFileSync(caminho, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * Tema em uso: "papel" (fundo claro) ou "tinta" (fundo escuro). ALRIX_TEMA força um dos dois; sem ele, vale o
 * tema do Claude Code no settings.json: o tema ALRIX Papel e os temas claros do Claude Code usam a paleta de papel.
 */
export function temaAtual(ajustes) {
  const pedido = (process.env.ALRIX_TEMA || '').toLowerCase();
  if (pedido === 'papel' || pedido === 'tinta') return pedido;
  const tema = String(ajustes?.theme || '').toLowerCase();
  return tema.includes('papel') || tema.startsWith('light') ? 'papel' : 'tinta';
}

/** NO_COLOR no ambiente: nada sai com cor. */
export const SEM_COR = 'NO_COLOR' in process.env && process.env.NO_COLOR !== '';
/** O traço da parte vazia de uma barra: com cor, o mesmo da parte cheia (a cor as separa); sem cor, um traço fino. */
export const TRACO_VAZIO = SEM_COR ? '─' : '━';

/** Devolve um pintor por nome de cor: cor.accent('texto'). Com NO_COLOR no ambiente, o texto sai sem cor. */
export function pintores(tema) {
  const semCor = SEM_COR;
  const paleta = lerJson(join(AQUI, 'paleta.json'))?.[tema] ?? {};
  const pintor = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m || semCor) return (texto) => String(texto);
    const codigo = `\x1b[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m`;
    return (texto) => `${codigo}${texto}${RST}`;
  };
  return new Proxy({}, { get: (_, nome) => pintor(paleta[nome]) });
}

/** A marca em texto: ΛLRIX, com o I no acento. */
export function marca(cor) {
  return `${NEGRITO}${cor.ink('ΛLR')}${NEGRITO}${cor.accent('I')}${NEGRITO}${cor.ink('X')}`;
}

/** Quantas colunas o texto ocupa, sem as sequências de cor. */
export function largura(texto) {
  return [...texto.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

/** 184300 → "184k"; 1250000 → "1,3M". */
export function milhares(tokens) {
  if (tokens >= 999500) return `${(tokens / 1e6).toFixed(1).replace('.', ',')}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/** 95 s → "1 min 35 s"; 4000 s → "1 h 06 min". */
export function duracao(segundos) {
  const s = Math.max(0, Math.floor(segundos));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
}

/** Lê o JSON que o Claude Code manda na entrada. Sem entrada (rodando à mão num terminal) ou com erro: {}. */
export async function lerEntrada() {
  if (process.stdin.isTTY) return {};
  let texto = '';
  try {
    for await (const pedaco of process.stdin) texto += pedaco;
  } catch {
    return {};
  }
  try {
    const dados = JSON.parse(texto.replace(/^﻿/, ''));
    return dados && typeof dados === 'object' ? dados : {};
  } catch {
    return {};
  }
}
