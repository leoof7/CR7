# Favoritar ligas, bandeiras e reorganização da aba Tips

## Contexto

Hoje, `index.html` agrupa os jogos por liga (`país + " - " + competição`) em três lugares: Radar Principal, aba Tips e aba Foguete. No Radar e na Tips, cada liga vira um accordion; só a primeira liga da ordenação regional (Brasil > Top 5 Europa > resto da Europa > resto do mundo) começa aberta, as outras ficam fechadas. Não existe hoje nenhum jeito de fixar uma liga no topo ou mantê-la sempre aberta — isso muda toda vez que a lista de jogos do dia muda. A aba Tips não tem filtro por janela de tempo (Ao Vivo / Próximas horas), só o corte por faixa de probabilidade (Padrões 65-80% / Grandes Chances ≥80%) e busca por texto.

Este documento cobre três mudanças, todas dentro de `index.html` (sem alteração em `motor.ts` — os dados já vêm prontos: país, competição, hora, status):

1. Favoritar liga (não jogo) — persiste entre dias, prioriza a liga no topo da lista e já vem expandida.
2. Bandeira do país ao lado do nome, nos cabeçalhos de liga.
3. Reorganização da aba Tips com filtro de janela de tempo (Ao Vivo / Próximas 3h).

## 1. Favoritar liga

### Modelo de dados

Nova chave no `localStorage`: `cr7_ligas_favoritas`, lista JSON de strings no formato `"{País} - {Competição}"` — a mesma string já usada como chave de agrupamento (`chaveAgrupamento`) em todo o código. Usar essa mesma string (em vez de um id separado) é o que faz o favorito valer para qualquer dia: a chave não depende da data nem do id do jogo, só do par país+competição, então uma liga favoritada hoje continua favoritada amanhã sem nenhum código extra de "sincronizar entre dias".

```js
let ligasFavoritasIds = JSON.parse(localStorage.getItem('cr7_ligas_favoritas') || '[]');

function toggleFavoritoLiga(chave) {
  if (ligasFavoritasIds.includes(chave)) ligasFavoritasIds = ligasFavoritasIds.filter(f => f !== chave);
  else ligasFavoritasIds.push(chave);
  localStorage.setItem('cr7_ligas_favoritas', JSON.stringify(ligasFavoritasIds));
}
```

Este é um mecanismo novo e separado do `favoritosIds` (favorito por jogo, usado na aba "⭐ Fav" do Radar) — não reaproveita nem modifica esse existente.

### Ordenação (compartilhada por Radar e Tips)

`ordenarLigasPorPrioridade(chaves, mapa)` é a única função de ordenação de ligas, chamada tanto pelo Radar quanto pela Tips. Ganha uma checagem de favorito antes do critério regional atual:

```js
function ordenarLigasPorPrioridade(chaves, mapa) {
  return chaves.sort((a, b) => {
    const favA = ligasFavoritasIds.includes(a) ? 0 : 1;
    const favB = ligasFavoritasIds.includes(b) ? 0 : 1;
    if (favA !== favB) return favA - favB;
    const pa = getPrioridadeRegiao(mapa[a]), pb = getPrioridadeRegiao(mapa[b]);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}
```

Favoritas vêm primeiro (entre si, mantendo a prioridade regional); o resto continua na ordem de hoje. Por ser a mesma função para as duas abas, o Radar e a Tips ficam consistentes sem duplicar lógica.

### Estado expandido/fechado

Nos dois lugares que montam o accordion de liga (Radar: `renderizarJogos`; Tips: `renderizarTips`), a condição que hoje é `index === 0 ? '' : 'hidden'` vira `ligasFavoritasIds.includes(chave) ? '' : 'hidden'`. Sem nenhuma liga favoritada, tudo começa fechado — não existe mais "a primeira sempre aberta".

### Estrela no cabeçalho

Ícone clicável (⭐ favoritada / ☆ não favoritada) dentro do cabeçalho de cada liga, nos dois lugares. Usa `event.stopPropagation()` para não disparar também o toggle de abrir/fechar do card (que está no `onclick` do cabeçalho inteiro):

```html
<span onclick="event.stopPropagation(); toggleFavoritoLiga('${esc(chave)}')" class="cursor-pointer">${ligasFavoritasIds.includes(chave) ? '⭐' : '☆'}</span>
```

### Aba Foguete

A aba Foguete (`renderizarAlavancagem`) não tem accordion — é uma lista corrida de jogos com odd ≤ 1.50. Não ganha agrupamento novo nem estrela visual. Só um `.sort()` nos `candidatos` antes de renderizar, colocando jogos de ligas favoritadas primeiro; o resto mantém a ordem atual entre si.

## 2. Bandeira do país

Nova função `flagDoPais(pais)`, usada nos cabeçalhos de liga do Radar e da Tips (mesmo lugar onde a pílula do país já é renderizada), inserindo a bandeira logo depois do nome do país, dentro da pílula.

Implementação via `<img>` apontando para `flagcdn.com` (CDN público de bandeiras, sem chave/autenticação) — confirmado carregando na rede do usuário. Segue o mesmo padrão que o app já usa para escudos de time (imagem de fonte externa, sem asset local).

```js
const PAIS_ISO2 = {
  'ALEMANHA':'de','ARGENTINA':'ar','ARABIA SAUDITA':'sa','AUSTRIA':'at','BELGICA':'be','BOLIVIA':'bo',
  'BRASIL':'br','CANADA':'ca','CHILE':'cl','CHINA':'cn','COLOMBIA':'co','COREIA DO SUL':'kr',
  'COSTA RICA':'cr','CROACIA':'hr','DINAMARCA':'dk','EQUADOR':'ec','ESLOVAQUIA':'sk','ESLOVENIA':'si',
  'ESPANHA':'es','ESTADOS UNIDOS':'us','ESTONIA':'ee','FINLANDIA':'fi','FRANCA':'fr','GRECIA':'gr',
  'HOLANDA':'nl','HUNGRIA':'hu','IRLANDA':'ie','ISLANDIA':'is','ITALIA':'it','JAPAO':'jp','MEXICO':'mx',
  'NORUEGA':'no','PARAGUAI':'py','POLONIA':'pl','PORTUGAL':'pt','ROMENIA':'ro','RUSSIA':'ru',
  'AFRICA DO SUL':'za','SUECIA':'se','SUICA':'ch','SERVIA':'rs','TURQUIA':'tr','URUGUAI':'uy',
  'VENEZUELA':'ve'
};
// Bandeira própria, não a do Reino Unido - flagcdn suporta essas subdivisões.
const PAIS_FLAG_ESPECIAL = { 'INGLATERRA': 'gb-eng', 'PAIS DE GALES': 'gb-wls', 'ESCOCIA': 'gb-sct' };

function flagDoPais(pais) {
  const p = semAcento(pais);
  const codigo = PAIS_FLAG_ESPECIAL[p] || PAIS_ISO2[p];
  if (!codigo) return '';
  return `<img src="https://flagcdn.com/24x18/${codigo}.png" alt="" class="inline-block w-4 h-3 rounded-sm align-middle" style="box-shadow:0 0 0 1px rgba(255,255,255,.15)">`;
}
```

País fora da tabela (raro, dado o filtro de ligas já restringir bastante o universo de países) fica sem bandeira — só o nome, sem erro nem espaço quebrado.

Escopo: só os cabeçalhos de liga do Radar e da Tips. Não entra na aba Foguete (lista corrida sem pílula de país) nem em outros lugares que hoje só mostram o texto da competição (ex.: rodapé do card do Foguete).

## 3. Reorganização da aba Tips

### Novo filtro de janela de tempo

Chips abaixo do toggle Padrões/Grandes Chances: **Todos** / **🔴 Ao Vivo** / **⏱ Próximas 3h**. Filtra dentro do dia já selecionado no seletor de data (Qui/Hoje/Sáb...) — trocar de dia muda o que os filtros mostram.

```js
let tipsFiltroTempo = 'todos'; // 'todos' | 'live' | 'proximas3h'

function setTipsFiltroTempo(v) {
  tipsFiltroTempo = v;
  renderizarTips();
}
```

Dentro de `renderizarTips()`, depois do filtro de data + liga bloqueada + oportunidades (já existente), aplica um filtro adicional usando `getMatchTimerAndStatus(j, now)`:

- `'live'`: mantém só `info.isLive`.
- `'proximas3h'`: mantém só jogos que ainda não começaram e cujo pontapé inicial cai nos próximos 180 minutos (`info.isNS && info.diffMinutes < 0 && info.diffMinutes >= -180`). Não inclui jogos já ao vivo — esse é o filtro "Ao Vivo" separado.
- `'todos'`: sem filtro adicional (comportamento de hoje).

### Reorganização visual

Ordem final da aba, de cima para baixo:

1. Título "Smart Tips (A.I)" + toggle Padrões/Grandes Chances (sem mudança).
2. **Novo:** linha de chips Todos / Ao Vivo / Próximas 3h.
3. Busca por time/campeonato (sobe pra cá — hoje vem depois do placar e do botão de sync).
4. Placar do dia (Greens/Reds/Win Rate) com o botão de sincronizar dobrado pra dentro do mesmo card, como ação secundária (link pequeno), em vez do banner full-width que existe hoje.
5. Lista de ligas (accordion com favoritos, bandeira, exatamente como no Radar).

## Fora de escopo

- Nenhuma mudança em `motor.ts` ou no schema do Firestore.
- Não altera o favorito por jogo (`favoritosIds` / aba "⭐ Fav") já existente.
- Não adiciona uma tela separada para gerenciar/listar todas as ligas favoritadas fora do accordion — a estrela no cabeçalho de cada liga é a única forma de favoritar/desfavoritar.
- Não adiciona bandeira em nenhum outro lugar do app além dos cabeçalhos de liga do Radar e da Tips.

## Verificação

Sem suíte de testes automatizados para `index.html` (é um SPA de arquivo único, sem framework de testes no projeto). Verificação por:

1. `npm run typecheck` continua batendo (não deve ser afetado — mudanças são só em `index.html`).
2. Teste manual via `http://localhost:8080/app` (não como `file://`, que não conecta ao Firestore): favoritar/desfavoritar liga no Radar, confirmar que ela sobe pro topo e abre sozinha; trocar de dia e confirmar que continua favoritada; conferir o mesmo na Tips; conferir ordenação na Foguete; testar os chips Ao Vivo/Próximas 3h com jogos reais do dia; conferir bandeira carregando nos cabeçalhos.
