# Guia Mestre e Escopo do Projeto - CR7 SIUUU Terminal v7.0[cite: 1]

## 🎯 1. Visão Geral e Filosofia
- **Objetivo do Projeto:** Plataforma All-in-One para traders esportivos. O sistema centraliza um radar de jogos, painel de Tips via A.I., cockpit de configurações, e um diário completo de gestão de banca[cite: 1].
- **Filosofia de Trabalho (O CÉU É O LIMITE):** O desenvolvedor líder atua na visão de negócios. A inteligência artificial (agente) tem TOTAL LIBERDADE para sugerir novas funcionalidades, refatorar código, criar animações e otimizar integrações. A IA não deve se autolimitar, desde que respeite as regras de filtragem de dados abaixo.

## 🏗️ 2. Arquitetura e Infraestrutura[cite: 1]
- **Back-end (`motor.ts`):** Roda Node.js com TypeScript em ambiente Linux/NixOS (originalmente estruturado no Replit)[cite: 1].
- **Banco de Dados:** Firebase Firestore, operando com as coleções principais: `jogos_ao_vivo`, `diario_operacoes` e `configuracoes`[cite: 1].
- **Front-end (`index.html`):** Single Page Application (SPA) em arquivo único, desenhada com TailwindCSS (via CDN) e Firebase SDK Native[cite: 1].
- **Design System:** Apple-like, focado em Glassmorphism e Dark Mode total[cite: 1].

## ⚙️ 3. O Motor de Raspagem e Sincronização (`motor.ts`)
- **Navegação:** Utiliza Playwright para acessar a plataforma fonte. Expande todas as ligas e processa a grade de 5 dias[cite: 1].
- **Sincronização:** Envia os dados limpos ao Firestore utilizando `batch.set` (com merge) e atualiza as métricas de tempo no `motor_status`[cite: 1].
- **Lógica de Horários:** Preserva o horário nativo salvo no Firestore. Em jogos finalizados sem horário de início mapeado, a IA deve definir como `"00:00"`.
- **Navegação H2H:** O motor simula cliques na ordem exata: `[Mandante]` -> `[H2H]` -> `[Visitante]`.

## 🚫 4. Filtro de Dados Rigoroso (Restrição Inviolável)
- O motor já atua extraindo a hierarquia de países e limpando linhas indesejadas do Raio-X[cite: 1].
- **REGRA DE OURO:** Sob nenhuma hipótese o sistema deve renderizar estatísticas de **Cartões**, **Escanteios (Cantos)** ou **Pressão** nas áreas de Tendências, Destaques ou Confronto Direto. Utilize filtros regex rigorosos para varrer esses itens.

## 🖥️ 5. O Dashboard e Módulos (`index.html`)[cite: 1]
- **Radar Principal:** Filtros por data e status (Todos, Favoritos, Live, A Seguir, Finalizados). Agrupamento priorizando ligas do Brasil no topo[cite: 1]. Jogos de "ontem" forçam status FT, jogos futuros mudam de placar para "vs"[cite: 1].
- **Smart Tips:** Filtro IA dividindo "IA Padrões" (Odds >= 1.80) e "Grandes Chances" (Odds < 1.80)[cite: 1]. As cores dos cards alternam dinamicamente no FT[cite: 1].
- **Livro de Gestão:** Integração com `diario_operacoes`, mostrando Win Rate, P/L e Calendário de resultados[cite: 1].
- **Cockpit (Sala de Máquinas):** Painel de controle para API-Football, Sportmonks, ID da planilha fonte e botão de limpeza total do Firestore[cite: 1].

## 📊 6. Estrutura Exata das Abas (Tabelas Internas)
Quando for atuar no modal de Raio-X, siga a distribuição exata de cards:
- **Destaques:** Confronto Direto, Tendências Recentes e Principais Mercados.
- **Desempenho:** Aproveitamento, Desempenho por Tempo, Primeiro Gol, Quando Marcou Primeiro e Quando Sofreu Primeiro.
- **Gols:** Resumo Geral, Total de Gols (Over/Under), Gols por Tempo, Marcados/Sofridos, Relógio de Gols (0-90min) e Finalizações.