# alrix-base

A base do kit ALRIX para o Claude Code. Este plugin traz três coisas e guarda os roteiros da barra de status:

- **Relógio a cada pedido.** Junto de cada mensagem sua, o agente recebe a data, o dia da semana, a hora e o fuso do relógio do seu computador. Assim ele deixa de adivinhar que dia é.
- **Seus pedidos de volta depois de compactar.** Quando a conversa é compactada, o resumo pode perder algo que você pediu. Logo depois da compactação, este plugin devolve ao agente a lista do que você mandou e das respostas que deu nas caixas de pergunta, lida da própria transcrição da sessão. Se a lista for grande, ele guarda os pedidos mais recentes inteiros e diz quantos ficaram de fora e onde ler.
- **Ajudante `pesquisador`.** Pesquisa na web e na documentação oficial e devolve só a conclusão, com as fontes, para as páginas lidas não encherem a sua conversa. Roda em Sonnet, na conta da sessão, quando o agente principal o chama.
- **Barra de status** (pasta `barra/`). O plugin não consegue ligar a barra sozinho: quem a liga é o instalador do kit, que copia estes roteiros para a sua pasta de configuração e acrescenta três chaves ao seu `settings.json` (`statusLine`, `subagentStatusLine` e `autoCompactWindow`), com cópia de segurança e jeito de desfazer.

O relógio e a lista de pedidos rodam dentro do próprio Claude Code, sem abrir um programa a cada pedido, e não usam a internet. A barra também não usa a internet: ela lê o que o Claude Code manda e roda o `git status` da pasta em que você está. Só o `pesquisador` vai à web, e só quando é chamado.

## Instalar

Com o kit inteiro, pela linha do `README.md` da raiz. Só este plugin, sem a barra de status:

```
claude plugin install alrix-base --marketplace alrixbr/alrix-kit
```

## Desligar

- Por um tempo: `claude plugin disable alrix-base@alrix`, e abra uma sessão nova. Para voltar, `claude plugin enable alrix-base@alrix`.
- De vez: `claude plugin uninstall alrix-base@alrix`.
- A barra de status e a compactação em 400 mil não são do plugin, são do instalador: saem com `node "$HOME\.claude\alrix-kit\instalar.mjs" --desfazer`, que desfaz a instalação inteira do kit.
