# alrix-base

A base do kit ALRIX para o Claude Code. Este plugin traz três coisas e guarda os roteiros da barra de status:

- **Relógio a cada pedido.** Junto de cada mensagem sua, o agente recebe a data, o dia da semana, a hora e o fuso do relógio do seu computador. Assim ele deixa de adivinhar que dia é.
- **Seus pedidos de volta depois de compactar.** Quando a conversa é compactada, o resumo pode perder algo que você pediu. Logo depois da compactação, este plugin devolve ao agente a lista do que você mandou e das respostas que deu nas caixas de pergunta, lida da própria transcrição da sessão. Se a lista for grande, ele guarda os pedidos mais recentes inteiros e diz quantos ficaram de fora e onde ler.
- **Ajudante `pesquisador`.** Pesquisa na web e na documentação oficial e devolve só a conclusão, com as fontes, para as páginas lidas não encherem a sua conversa.
- **Barra de status** (pasta `barra/`). O plugin não consegue ligar a barra sozinho: quem a liga é o `instalar.mjs` da raiz do kit, que copia estes roteiros para a sua pasta de configuração e acrescenta duas linhas ao seu `settings.json`, com cópia de segurança e jeito de desfazer.

Nada aqui usa a internet e nada sai do seu computador. Os dois primeiros itens rodam dentro do próprio Claude Code, sem abrir um programa a cada pedido.

Para instalar o kit inteiro, veja o `README.md` na raiz.
