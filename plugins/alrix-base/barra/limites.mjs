// ALRIX · barra de status: desenho dos limites do plano (barras, faixas de cor e a hora em que a janela volta).

/** Cor por faixa de uso: normal na tinta, âmbar a partir de 60 %, vermelho a partir de 85 %. */
export function faixa(cor, pct) {
  if (pct >= 85) return cor.del;
  if (pct >= 60) return cor.amber;
  return cor.ink2;
}

/** Uma barra de `celulas` traços; `pinta` troca a cor da parte cheia. */
export function barra(cor, pct, celulas, pinta) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const cheias = p > 0 ? Math.max(1, Math.round((p * celulas) / 100)) : 0;
  return `${(pinta ?? faixa(cor, p))('━'.repeat(cheias))}${cor.lineSoft('━'.repeat(celulas - cheias))}`;
}

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dois = (n) => String(n).padStart(2, '0');

/** Hoje: "00:51". Outro dia: "ter 10/11 · 05:00" (curto: "ter 05:00"). */
export function quando(ms, agora = Date.now(), curto = false) {
  const data = new Date(ms);
  const hora = `${dois(data.getHours())}:${dois(data.getMinutes())}`;
  if (data.toDateString() === new Date(agora).toDateString()) return hora;
  if (curto) return `${DIAS[data.getDay()]} ${hora}`;
  return `${DIAS[data.getDay()]} ${dois(data.getDate())}/${dois(data.getMonth() + 1)} · ${hora}`;
}
