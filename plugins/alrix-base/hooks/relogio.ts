// Relógio a cada pedido: entrega ao agente a data e a hora do relógio deste computador no momento do pedido.
// Uma linha curta por pedido. Em qualquer erro não entrega nada (o pedido segue como se o módulo não existisse).

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const dois = (n: number): string => String(n).padStart(2, '0')

/** A linha do relógio para `agora`, na hora local do computador, com o deslocamento em relação ao UTC. */
export function linhaDoRelogio(agora: Date): string {
  const fuso = -agora.getTimezoneOffset()
  const sinal = fuso >= 0 ? '+' : '-'
  const utc = `${sinal}${dois(Math.floor(Math.abs(fuso) / 60))}:${dois(Math.abs(fuso) % 60)}`
  return (
    `Relógio do computador quando este pedido chegou: ${DIAS[agora.getDay()] ?? ''}, ${dois(agora.getDate())}/` +
    `${dois(agora.getMonth() + 1)}/${agora.getFullYear()} ${dois(agora.getHours())}:${dois(agora.getMinutes())} ` +
    `(UTC${utc}).`
  )
}
