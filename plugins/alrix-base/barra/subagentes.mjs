// ALRIX · uma linha por subagente no painel de agentes do Claude Code.
// Entra { columns, tasks: [...] }; sai uma linha JSON por tarefa, {"id", "content"}.
// Tarefa sem linha fica com o desenho padrão.
//
//   ▶ Revisar o diff da fase 3   ▁▂▅▇▃  104k · 1 min 32 s · sonnet 5.5
//
// O modelo aparece em cada linha de propósito: dá para ver de relance com qual modelo cada ajudante roda.
import { ajustesDaPessoa, duracao, lerEntrada, lerJson, milhares, pintores, temaAtual } from './comum.mjs';

const BARRAS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const ENCERRADOS = new Set(['completed', 'failed', 'error', 'cancelled', 'killed']);

/** Ritmo de tokens: a diferença entre as últimas leituras, uma barra por intervalo. */
function ritmo(amostras) {
  const ultimas = (amostras || []).slice(-13);
  if (ultimas.length < 2) return '';
  const saltos = ultimas.slice(1).map((valor, i) => valor - ultimas[i]);
  const maior = Math.max(1, ...saltos);
  return saltos.map((salto) => BARRAS[salto <= 0 ? 0 : Math.floor((salto * 7) / maior)]).join('');
}

/** "claude-sonnet-5-5" → "sonnet 5.5". */
function modeloCurto(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id || '');
  if (!m) return String(id || '');
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

const dados = await lerEntrada();
const cor = pintores(temaAtual(lerJson(ajustesDaPessoa())));
const colunas = Number(dados.columns) || 80;
const agora = Date.now();

for (const tarefa of Array.isArray(dados.tasks) ? dados.tasks : []) {
  try {
    const encerrada = ENCERRADOS.has(tarefa.status);
    const sinal = tarefa.status === 'completed' ? cor.sage('●')
      : encerrada ? cor.del('×')
      : cor.ink2('▶');

    const fatos = [];
    if (tarefa.tokenCount > 0) fatos.push(milhares(tarefa.tokenCount));
    if (!encerrada && tarefa.startTime > 0) fatos.push(duracao((agora - tarefa.startTime) / 1000));
    if (tarefa.model) fatos.push(modeloCurto(tarefa.model));
    const ondas = encerrada ? '' : ritmo(tarefa.tokenSamples);
    const fim = fatos.join(' · ');

    const reservado = 2 + (ondas ? ondas.length + 2 : 0) + (fim ? fim.length + 2 : 0);
    const cabe = Math.max(12, colunas - reservado);
    let rotulo = String(tarefa.label || tarefa.description || tarefa.name || 'agente').replace(/[\x00-\x1f\x7f]/g, ' ');
    if ([...rotulo].length > cabe) rotulo = `${[...rotulo].slice(0, cabe - 1).join('')}…`;

    let linha = `${sinal} ${(encerrada ? cor.muted : cor.ink)(rotulo)}`;
    if (ondas) linha += `  ${cor.muted(ondas)}`;
    if (fim) linha += `  ${cor.muted(fim)}`;
    console.log(JSON.stringify({ id: tarefa.id, content: linha }));
  } catch { /* esta linha fica com o desenho padrão */ }
}
