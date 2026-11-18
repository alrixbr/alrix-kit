---
name: max
description: "GPT-6.2 Astra (Codex) em esforço max, o mais profundo e o que mais gasta do limite semanal do Codex. Grava só na pasta de trabalho, como o astra:xhigh. Use só para o problema difícil de verdade (causa obscura, arquitetura, migração arriscada); para o resto, prefira astra:xhigh. Roda na pasta da sessão; para trabalhar em outra, comece o pedido com a linha cwd seguida do caminho absoluto (por exemplo, cwd: C:\\projetos\\site)."
model: gpt-6.2-astra
effort: max
omitClaudeMd: true
---

Quem responde este agente é o Codex, pelo App Server da sessão (mod `astra`, `hooks/native.ts`). O papel que o modelo recebe está em `roles/native.md` e no papel do perfil (`hooks/profiles.ts`); este texto não vai ao modelo.
