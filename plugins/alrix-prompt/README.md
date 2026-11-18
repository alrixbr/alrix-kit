# alrix-prompt

Melhora a mensagem que você manda ao agente no Claude Code, sem mudar o que você pediu. Uma linha acima do campo de texto mostra três modos, e toda sessão começa em **Normal** (a mensagem vai como você digitou).

| Modo | O que faz | O que você vê |
| --- | --- | --- |
| Normal | Nada: a mensagem passa como veio. | A linha `✎ prompt` com os três modos. |
| Organizar | O Sonnet 5.5 arruma acento, pontuação e parágrafo, com as suas palavras, e a mensagem segue sozinha. | `◐ organizando…` por alguns segundos e depois `✓ organizada`. |
| Engenharia | O Sonnet 5.5 reescreve a mensagem como um pedido completo e devolve no campo de texto para você revisar. Enter manda. A sua mensagem original vai junto para o agente, sem aparecer na tela. | `✎ revise a versão reestruturada na caixa e aperte Enter`, com `usar a original` e `comparar`. |

## Instalar

```
claude plugin install alrix-prompt --marketplace alrixbr/alrix-kit
```

Dentro de uma sessão, o mesmo comando com a barra na frente: `/plugin install alrix-prompt --marketplace alrixbr/alrix-kit`. Precisa do Claude Code 2.1.275 ou mais novo. Para atualizar: `claude plugin update alrix-prompt@alrix`.

## Como usar

- **Na linha acima do campo:** `ctrl+x tab` leva o foco até ela; `2` ou `3` liga o modo só para a próxima mensagem, a mesma tecla de novo mantém na sessão, e mais uma vez desliga. `ctrl+x ctrl+a` recolhe a linha.
- **Por comando:** `/organizar` e `/engenharia` valem só para a próxima mensagem (com um texto depois, só para aquele texto, que volta para o campo); `/modo 1`, `/modo 2`, `/modo 3` trocam o modo da sessão.
- **Engenharia na sessão só para as mensagens longas:** com o Engenharia mantido na sessão, só a mensagem com 400 caracteres ou mais (fora o que você colou) para para a revisão; as curtas vão como você digitou, sem chamada. Para uma curta passar pela revisão, `/engenharia` antes dela. Com o Engenharia só para a próxima mensagem, qualquer tamanho vale.
- **Enquanto o Sonnet trabalha:** Esc ou `cancelar` (x) para tudo, e a mensagem volta para o campo.
- **Depois:** `comparar` (v) abre um painel com o que você digitou e o que foi para o agente, o tempo e os tokens.

Passam direto, sem chamada: comando (`/…`), modo bash (`!…`), mensagem de outro agente ou de tarefa em segundo plano, mensagem curta (menos de 40 caracteres com o modo da sessão, menos de 12 com o modo só da próxima) e o pedido que abre a sessão.

O limite de 400 vem de uma medição de 1.152 mensagens reais do autor (de 30/10 a 11/11/2026): a mediana é de 129 caracteres e uma em cada oito passa de 400. Está em `LONG_MESSAGE_CHARS`, em `hooks/core.ts`.

## O que nunca muda

Antes de seguir, cada reescrita passa por travas no código (`hooks/core.ts`). Se uma falhar, vai a sua mensagem original e a linha diz o motivo.

- Caminhos, URLs, `/comandos`, `@menções`, nomes de arquivo e de variável, números e o marcador de imagem (`[Image #1]`) voltam iguais, caractere por caractere.
- O que você colou não passa pelo Sonnet: vai um marcador no lugar e o bloco volta inteiro, com as tags que dizem ao agente que aquilo é texto colado.
- Negação continua negação, palavra em MAIÚSCULAS continua em maiúsculas, e nenhuma ganha maiúsculas por conta própria. Quando o deslize é só de maiúsculas (o Sonnet escreveu "NÃO" onde você escreveu "nao", ou "Não" onde você escreveu "NAO"), o código acerta pela sua mensagem em vez de descartar a reescrita inteira.
- O Engenharia não pode inventar caminho, comando ou URL, nem responder no lugar de reescrever.
- Mensagem com imagem, no Engenharia, vai direto (reestruturada, com a imagem e a original junto), sem a parada para revisão.

## O que o Engenharia lê e como ele escreve

Além da mensagem: o modelo da sessão, a pasta, o começo e o fim do que você colou, e a conversa recente, que são as suas três últimas mensagens e, antes de cada uma, a resposta do agente a que você reagiu (a mais recente quase inteira). O trabalho do agente entre uma mensagem e outra não entra. O Organizar lê só a mensagem.

As instruções dele (`prompts/engenharia.md`) seguem o que a Anthropic ensina sobre escrever para os modelos dela:

- **Claro e direto:** a primeira frase abre com o verbo que diz o tipo de trabalho (implementar, investigar, comparar, planejar) e a tarefa.
- **O que só você sabe:** o agente lê o projeto sozinho; o texto entrega o que ele não acha lá: para que serve, até onde ir, o que você já decidiu e o que conta como pronto. O nível que você pede ("capricha", "top", "AAA") fica junto do objetivo, com as suas palavras.
- **Aprovação com nome:** quando você responde "pode" ou "a segunda", o texto diz o que foi aprovado, com as palavras da pergunta do agente, em vez de um "pode" solto.
- **Dado separado de instrução:** o que você colou vai inteiro, no fim, apresentado por uma frase; os passos viram lista numerada só quando a ordem importa.
- **Tamanho proporcional:** pedido de uma frase continua com poucas linhas; seções com título só no pedido de várias partes.
- **Sem reforço genérico:** nada de "pense passo a passo" ou "é MUITO importante"; a única ênfase é a sua.
- **Exemplos com o porquê:** cinco exemplos de mensagem e saída, cada um dizendo por que a saída é aquela.

## Lacunas: o que falta no pedido

Na mesma chamada, o Engenharia aponta até duas coisas que faltam no pedido e que só você sabe, quando um palpite errado do agente sairia caro: qual de duas coisas você quis dizer, onde agir (teste ou produção), até onde ir numa ordem que apaga, publica ou envia. A maioria das mensagens não tem lacuna, e aí nada aparece.

- **Onde aparecem:** numa linha `falta dizer`, logo abaixo da linha dos modos, enquanto a versão reestruturada espera a sua revisão; e no painel `comparar`. Complete o texto no campo, se quiser, e aperte Enter.
- **Nunca vão para o agente:** nem no texto, nem junto da original. O pedido segue como você escreveu, sem palpite e sem pergunta a mais.
- **Quando a reescrita vai direto** (mensagem com imagem, ou você já escrevia outra): a linha diz `faltou dizer`, para você completar na mensagem seguinte.
- **Esconder:** a variável de ambiente `ALRIX_PROMPT_LACUNAS=0`.

Na rodada de 11/11/2026 (22 casos), cinco tiveram lacuna: os dois em que ela era esperada, dois em que ajudou (o site do cliente, o sintoma do login) e um com lacunas condicionais ("se houver mais de um"), que eram ruído. A regra contra a lacuna escrita com "se" entrou em seguida: na repetição (3 chamadas), esse caso saiu sem lacuna e os dois esperados continuaram apontando as suas.

## Custo

Cada mensagem tratada é uma chamada ao Sonnet 5.5 na conta da sessão. Medido em 11/11/2026: Organizar de 3,0 a 3,9 s e de 51 a 85 tokens de resposta (3 chamadas); Engenharia 3,2 s e 85 tokens de resposta nas medianas, com cerca de 6 mil tokens de entrada (as instruções, que ficam em cache), em 22 chamadas.

## Registro de uso

Cada mensagem tratada deixa uma linha em `~/.claude/alrix-prompt/uso/<sessão>.jsonl`: a hora, o modo, o que aconteceu (enviada, na caixa, revisada, trocada pela original, descartada, cancelada), o tipo do motivo de um descarte, o tempo, os tokens, o tamanho em caracteres e quantas lacunas foram apontadas. **O texto da mensagem não é gravado**, nem o pedaço dela que o aviso na tela mostra. Nada sai do PC.

- Desligar: a variável de ambiente `ALRIX_PROMPT_REGISTRO=0`.

## Desligar

- Só nesta sessão: `/modo 1` (Normal não chama nada).
- De vez: `claude plugin disable alrix-prompt@alrix` e abra uma sessão nova. Para voltar, `claude plugin enable alrix-prompt@alrix`.

## Para quem mexe no mod

- `claude plugin validate .` e `claude plugin test .` (45 testes).
- `hooks/core.ts` é o miolo puro (o que vai ao especialista, as travas, a âncora): sem `$` e sem import de execução.
