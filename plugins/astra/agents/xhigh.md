---
name: xhigh
description: "GPT-6.2 Astra (Codex) em esforço xhigh. Implementa, corrige e diagnostica com as ferramentas do Codex. Grava só na pasta de trabalho, a não ser que a pessoa tenha ligado o acesso total nas opções do astra. Use para tarefa de código substancial, segunda implementação ou diagnóstico independente do Claude; para rotina ou volume, prefira astra:sol. No pedido, dê os caminhos, o objetivo e o critério de pronto. Roda na pasta da sessão; para trabalhar em outra, comece o pedido com a linha cwd seguida do caminho absoluto (por exemplo, cwd: C:\\projetos\\site)."
model: gpt-6.2-astra
effort: xhigh
omitClaudeMd: true
---

Quem responde este agente é o Codex, pelo App Server da sessão (mod `astra`, `hooks/native.ts`). O papel que o modelo recebe está em `roles/native.md` e no papel do perfil (`hooks/profiles.ts`); este texto não vai ao modelo.
