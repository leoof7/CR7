// @ts-nocheck
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import { chromium } from "playwright";
import { execSync } from "child_process";
import * as http from "http";

// =========================================================================
// SERVIDOR WEB
// =========================================================================
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("CR7 SIUUU Terminal Engine Online! 🚀");
  })
  .listen(8080, () => {
    console.log("=========================================================");
    console.log("🌐 SERVIDOR WEB ATIVO NA PORTA 8080");
    console.log("⚙️ O Motor está ligado (TRAVADO APENAS EM 'HOJE' PARA TESTES)");
    console.log("=========================================================\n");
  });

const firebaseConfig = {
  apiKey: "AIzaSyCWiM3pBtP_WwoVS7XHWz6K-DX7GveCQGo",
  authDomain: "crterminalsiu.firebaseapp.com",
  projectId: "crterminalsiu",
  storageBucket: "crterminalsiu.firebasestorage.app",
  messagingSenderId: "964211577075",
  appId: "1:964211577075:web:f0519ee06e81a65c36a786"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
db.settings({ experimentalForceLongPolling: true, useFetchStreams: false });

async function atualizarStatusMotor(dados: object) {
  try {
    await db.collection("configuracoes").doc("motor_status").set(
      { ...dados, atualizadoEm: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {}
}

function normalizarNome(str: string) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\W/g, '').toLowerCase();
}

async function sincronizarAoVivoBackend() {
  try {
    const configDoc = await db.collection("configuracoes").doc("motor").get();
    const config = configDoc.data() || {};
    const smToken = config.sportmonks_token || "RaCnlPpnktbtlbuzsNd51VDXKnCcyZ4QRgtYlOFG4Av91CcQMNrTf4egKM9D";
    const asKey = config.apifutebol_key || "e131aa61be7308e97441e475374f47f1";

    const snapshotJogos = await db.collection("jogos_ao_vivo").get();
    if (snapshotJogos.empty) return;

    let jogosAtuais = [];
    snapshotJogos.forEach(doc => jogosAtuais.push(doc.data()));

    let sucessoSM = false;

    // PLANO A: Sportmonks
    if (smToken) {
      try {
        const resSM = await fetch(`https://api.sportmonks.com/v3/football/livescores/inplay?api_token=${smToken}&include=scores,state,events`);
        if (resSM.ok) {
          const jsonSM = await resSM.json();
          console.log(`🟢 [API LIVE] Sportmonks OK! Retornou ${jsonSM.data?.length || 0} jogos ativos.`);
          
          if (jsonSM.data && Array.isArray(jsonSM.data)) {
            sucessoSM = true;
            for (const item of jsonSM.data) {
              const homeName = normalizarNome(item.participants?.find(p => p.meta?.location === 'home')?.name);
              const awayName = normalizarNome(item.participants?.find(p => p.meta?.location === 'away')?.name);
              const hScore = item.scores?.find(s => s.description === 'CURRENT')?.score?.goals || 0;
              const aScore = item.scores?.find(s => s.description === 'CURRENT')?.score?.goals || 0;
              const min = item.state?.minute || "LIVE";
              
              let lastGoalScorer = "";
              if (item.events) {
                  const goals = item.events.filter(e => e.type_id === 14); 
                  if(goals.length > 0) lastGoalScorer = goals[goals.length - 1].player_name || "";
              }

              const match = jogosAtuais.find(j => {
                const m = normalizarNome(j.mandante);
                const v = normalizarNome(j.visitante);
                return (m.includes(homeName) || homeName.includes(m)) && (v.includes(awayName) || awayName.includes(v));
              });

              if (match) {
                await db.collection('jogos_ao_vivo').doc(String(match.id)).set({
                  golsCasa: hScore, golsFora: aScore, status: 'LIVE', minutoAoVivo: `${min}'`, ultimoGol: lastGoalScorer
                }, { merge: true });
              }
            }
            await atualizarStatusMotor({ statusApiLive: `🟢 Sportmonks OK (Última: ${new Date().toLocaleTimeString()})` });
          }
        } else {
          console.log(`🔴 [API LIVE] Erro na Sportmonks. Status: ${resSM.status}`);
        }
      } catch (e) {
        console.log(`🔴 [API LIVE] Falha na rede Sportmonks: ${e.message}`);
      }
    }

    // PLANO B: API-Sports (Se a Sportmonks falhar)
    if (!sucessoSM && asKey) {
      try {
        const resAS = await fetch(`https://v3.football.api-sports.io/fixtures?live=all`, { 
            headers: { 'x-apisports-key': asKey }
        });
        
        if (resAS.ok) {
          const jsonAS = await resAS.json();
          console.log(`🟢 [API LIVE] API-Sports OK! Retornou ${jsonAS.response?.length || 0} jogos ativos.`);
          
          if (jsonAS.response && Array.isArray(jsonAS.response)) {
            for (const item of jsonAS.response) {
              const hName = normalizarNome(item.teams?.home?.name);
              const aName = normalizarNome(item.teams?.away?.name);
              const hScore = item.goals?.home || 0;
              const aScore = item.goals?.away || 0;
              const min = item.fixture?.status?.elapsed || "LIVE";
              
              let lastGoalScorer = "";
              if (item.events) {
                  const goals = item.events.filter(e => e.type === 'Goal');
                  if(goals.length > 0) lastGoalScorer = goals[goals.length - 1].player?.name || "";
              }

              const match = jogosAtuais.find(j => {
                const m = normalizarNome(j.mandante);
                const v = normalizarNome(j.visitante);
                return (m.includes(hName) || hName.includes(m)) && (v.includes(aName) || aName.includes(v));
              });

              if (match) {
                await db.collection('jogos_ao_vivo').doc(String(match.id)).set({
                  golsCasa: hScore, golsFora: aScore, status: 'LIVE', minutoAoVivo: `${min}'`, ultimoGol: lastGoalScorer
                }, { merge: true });
              }
            }
            await atualizarStatusMotor({ statusApiLive: `🟢 API-Sports OK (Última: ${new Date().toLocaleTimeString()})` });
          }
        } else {
          console.log(`🔴 [API LIVE] Erro na API-Sports. Status: ${resAS.status}`);
        }
      } catch (e) {
        console.log(`🔴 [API LIVE] Falha na rede API-Sports: ${e.message}`);
      }
    }
  } catch (err) {
    console.log("Erro no sync live", err);
  }
}

// Otimizado para rodar a cada 5 minutos (300.000 ms)
setInterval(sincronizarAoVivoBackend, 300000);

async function rodarMotorCompleto(theoTokenManual: string | null = null) {
  const inicioMs = Date.now();

  let tokenTheo = theoTokenManual;
  if (!tokenTheo) {
    try {
      const configDoc = await db.collection("configuracoes").doc("motor").get();
      if (configDoc.exists) {
        tokenTheo = configDoc.data()?.theo_token || "afba4f6a53";
      }
    } catch (e) {
      tokenTheo = "afba4f6a53";
    }
  }

  console.log("\n==================================================");
  console.log(`🚀 [CR7 MOTOR] INICIANDO VARREDURA (MODO TESTE RÁPIDO)...`);
  console.log("==================================================");

  await atualizarStatusMotor({
    status: "EXECUTANDO",
    inicioTimestamp: inicioMs,
    mensagem: "Iniciando navegador para ciclo de testes...",
    jogosProcessados: 0,
    jogosTotais: 0,
  });

  let browser;
  try {
    let execPath = undefined;
    if (process.platform !== "win32") {
      try {
        execPath = execSync("which chromium").toString().trim();
      } catch (e) {}
    }

    const launchOptions = {
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    };
    if (execPath) launchOptions.executablePath = execPath;

    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    const diasParaRaspar = ['hoje'];
    let totalJogosNaRodada = 0;

    for (const diaAlvo of diasParaRaspar) {
        console.log(`\n==================================================`);
        console.log(`📅 PREPARANDO RASPAGEM DO DIA: ${diaAlvo.toUpperCase()}`);
        console.log(`==================================================`);

        const refDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        if (diaAlvo === 'amanha') refDate.setDate(refDate.getDate() + 1);
        if (diaAlvo === 'ontem') refDate.setDate(refDate.getDate() - 1);
        const dataSalvarDB = `${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, '0')}-${String(refDate.getDate()).padStart(2, '0')}`;

        const urlAlvo = `https://clube.theoborges.com/matches?dia=${diaAlvo}&t=${tokenTheo}`;
        console.log(`🔍 [NAVEGAÇÃO] Acessando URL: ${urlAlvo}`);
        await page.goto(urlAlvo, { waitUntil: "domcontentloaded", timeout: 90000 });

        console.log("⏳ [AGUARDANDO SPA] Esperando grade de ligas carregar (15s)...");
        await page.waitForTimeout(15000);

        console.log("🔓 [AÇÃO] Expandindo todas as ligas (Sanfonas) fechadas...");
        await page.evaluate(async () => {
          const headers = Array.from(document.querySelectorAll("div, span, p")).filter((el) => {
            if (el.closest('aside, .right-column, [class*="sidebar"]')) return false;
            if (el.closest('a')) return false; 
            const txt = (el.innerText || "").trim();
            return txt.includes(" - ") && txt.length < 80 && !txt.includes(":");
          });

          for (const header of headers) {
            let parent = header.parentElement;
            let limit = 5;
            while (parent && limit > 0) {
              if (parent.tagName === "DIV" && (parent.className.includes("flex") || parent.className.includes("header") || parent.className.includes("card"))) {
                if (parent.querySelector('a[href*="/game/"], a[href*="/match/"]')) break;
                try { parent.click(); } catch (e) {}
                break;
              }
              parent = parent.parentElement;
              limit--;
            }
          }
        });

        console.log("✅ Ligas expandidas! Executando auto-scroll...");
        await page.waitForTimeout(3000);

        await page.evaluate(async () => {
          await new Promise<void>((resolve) => {
            let totalHeight = 0;
            const distance = 400;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= scrollHeight) {
                clearInterval(timer);
                resolve();
              }
            }, 200); 
          });
        });
        
        console.log("⏳ [AGUARDANDO] Esperando rendering do final da página (5s)...");
        await page.waitForTimeout(5000);

        const resultadoGrade = await page.evaluate((dbDate) => {
          const jogosExtraidos = [];
          const matchMap = new Set();
          
          const destaquesSet = new Set();
          document.querySelectorAll('.right-column a[href*="/game/"], [class*="sidebar"] a[href*="/game/"], aside a[href*="/game/"]').forEach(a => {
              const href = typeof a.href === 'string' ? a.href : a.getAttribute('href') || '';
              const mId = href.split("/").pop().split("?")[0];
              if (mId) destaquesSet.add(mId);
          });

          const allMatchLinks = Array.from(document.querySelectorAll('a[href*="/game/"], a[href*="/match/"]'));

          allMatchLinks.forEach((linkEl) => {
            if (linkEl.closest('aside, .right-column, [class*="sidebar"]')) return;

            const href = typeof linkEl.href === "string" ? linkEl.href : linkEl.getAttribute("href") || "";
            if (!href) return;

            const matchId = href.split("/").pop().split("?")[0];
            if (!matchId || matchMap.has(matchId)) return;

            let pais = "Internacional", competicao = "Geral", achouLiga = false;
            let containerDoJogo = linkEl.parentElement;

            while (containerDoJogo && containerDoJogo.tagName !== "BODY") {
              let irmaoAnterior = containerDoJogo.previousElementSibling;
              while (irmaoAnterior) {
                const txt = irmaoAnterior.innerText || "";
                if (txt.includes(" - ") && txt.length < 80) {
                  const primeiraLinha = txt.split("\n")[0].replace(/\s+\d+$/, "").trim();
                  const partes = primeiraLinha.split(" - ");
                  if (partes.length >= 2) {
                    pais = partes[0].trim();
                    competicao = partes.slice(1).join(" - ").trim();
                    achouLiga = true;
                    break;
                  }
                }
                irmaoAnterior = irmaoAnterior.previousElementSibling;
              }
              if (achouLiga) break;
              containerDoJogo = containerDoJogo.parentElement;
            }

            const compStrSegura = String(competicao || "Geral").toUpperCase();
            if (compStrSegura.includes("FAVORITOS") || compStrSegura.includes("CLÁSSICOS") || compStrSegura.includes("ADICIONAR")) return;

            const paisStrSegura = String(pais || "").toUpperCase();
            if (compStrSegura.includes("SEGUNDA DIVIS") || compStrSegura.includes("SÉRIE B") || compStrSegura.includes("SERIE B")) {
              if (!paisStrSegura.includes("BRASIL")) return;
            }

            let mandante = "", visitante = "";
            const teamEls = linkEl.querySelectorAll('[class*="team-name"], [class*="name"]');
            if (teamEls.length >= 2) {
              mandante = teamEls[0].innerText.trim();
              visitante = teamEls[teamEls.length - 1].innerText.trim();
            }

            if (!mandante || !visitante) {
              const txts = (linkEl.innerText || "").split("\n").map((s) => s.trim()).filter((t) => t.length > 2 && !/^[\d.,]+$/.test(t));
              if (txts.length >= 2) {
                mandante = txts[0];
                visitante = txts[txts.length - 1];
              }
            }

            let logoCasa = "", logoFora = "";
            const imgs = linkEl.querySelectorAll("img");
            if (imgs.length >= 2) {
              logoCasa = imgs[0].src || imgs[0].getAttribute("data-src") || "";
              logoFora = imgs[1].src || imgs[1].getAttribute("data-src") || "";
            }

            const oddElements = Array.from(linkEl.querySelectorAll('[class*="odd"], .market-cell, button'));
            const oddValues = oddElements.map((el) => (el.innerText || "").trim()).filter((val) => /^[0-9.]+$/.test(val));
            let oddCasa = "0.00", oddEmpate = "0.00", oddFora = "0.00";

            if (oddValues.length >= 3) {
              oddCasa = oddValues[0]; oddEmpate = oddValues[1]; oddFora = oddValues[2];
            } else if (oddValues.length === 2) {
              oddCasa = oddValues[0]; oddFora = oddValues[1];
            }

            const rawText = (linkEl.innerText || "").toUpperCase();
            let status = "NS";
            if (rawText.includes("FINALIZ") || rawText.includes("FT") || rawText.includes("ENCERR")) {
              status = "FT";
            } else if (rawText.includes("AO VIVO") || rawText.includes("LIVE") || rawText.includes("'")) {
              status = "LIVE";
            } else if (rawText.includes("HT") || rawText.includes("INTERVALO")) {
              status = "HT";
            }

            const timeEl = linkEl.querySelector('.match-time, [class*="time"]');
            let hora = timeEl ? (timeEl.innerText || "").trim() : "";
            if (!hora || !/^\d{1,2}:\d{2}$/.test(hora)) {
              hora = "00:00";
            }

            let golsCasa = 0, golsFora = 0;
            const scoreEl = linkEl.querySelector('.match-score, [class*="score"]');
            if (scoreEl && (scoreEl.innerText || "").includes("-")) {
              const parts = scoreEl.innerText.split("-");
              golsCasa = parseInt(parts[0].trim()) || 0;
              golsFora = parseInt(parts[1].trim()) || 0;
            }

            const isDestaque = destaquesSet.has(matchId);

            if (mandante && visitante) {
              matchMap.add(matchId);
              jogosExtraidos.push({ id: matchId, pais, competicao, mandante, visitante, logoCasa, logoFora, oddCasa, oddEmpate, oddFora, status, hora, golsCasa, golsFora, dataJogo: dbDate, link: href, isDestaque });
            } 
          });

          return { jogos: jogosExtraidos };
        }, dataSalvarDB);

        const listaEstruturada = resultadoGrade.jogos;
        totalJogosNaRodada += listaEstruturada.length;
        console.log(`📌 [MAPA DO DIA ${diaAlvo.toUpperCase()}]: Encontradas ${listaEstruturada.length} partidas`);

        let count = 0;
        for (const item of listaEstruturada) {
          count++;
          try {
            let linkAutenticado = String(item.link || "");
            if (!linkAutenticado) continue;

            if (!linkAutenticado.includes("t=")) {
              const conector = linkAutenticado.includes("?") ? "&" : "?";
              linkAutenticado = `${linkAutenticado}${conector}t=${tokenTheo}`;
            }

            console.log(`\n[${diaAlvo.toUpperCase()} | ${count}/${listaEstruturada.length}] ⚽ Raspando Detalhes: ${item.mandante} x ${item.visitante}`);

            await page.goto(linkAutenticado, { waitUntil: "domcontentloaded", timeout: 90000 });
            await page.waitForTimeout(4000); 

            const headerInfo = await page.evaluate(() => {
              let topAreaText = (document.body.innerText || "").substring(0, 400);
              const upperTop = topAreaText.toUpperCase();
              const isFT = upperTop.includes("FINALIZADA") || upperTop.includes("ENCERRADO") || upperTop.includes("FT");
              const isLIVE = upperTop.includes("AO VIVO") || upperTop.includes("EM ANDAMENTO") || upperTop.includes("HT");
              const isNS = upperTop.includes("AGENDADA") || upperTop.includes("AGENDADO");

              const scoreMatch = topAreaText.match(/(\d+)\s*-\s*(\d+)/);
              let gc = null, gf = null;
              if (scoreMatch && (isFT || isLIVE)) {
                gc = parseInt(scoreMatch[1], 10);
                gf = parseInt(scoreMatch[2], 10);
              }

              // Placar do intervalo (HT) - nunca inventar: só grava se achar um padrão explícito.
              let htCasa = null, htFora = null;
              const parenMatch = topAreaText.match(/\d+\s*-\s*\d+\s*\((\d+)\s*-\s*(\d+)\)/);
              const intervaloMatch = topAreaText.match(/INTERVALO[:\s]*(\d+)\s*-\s*(\d+)/i);
              const htLabelMatch = topAreaText.match(/\bHT[:\s]*(\d+)\s*-\s*(\d+)/i);
              const htMatch = parenMatch || intervaloMatch || htLabelMatch;
              if (htMatch) {
                htCasa = parseInt(htMatch[1], 10);
                htFora = parseInt(htMatch[2], 10);
              }

              return { isFT, isLIVE, isNS, gc, gf, htCasa, htFora };
            });

            if (headerInfo.isFT) item.status = "FT";
            else if (headerInfo.isLIVE) item.status = "LIVE";
            else if (headerInfo.isNS) item.status = "NS";

            if (headerInfo.gc !== null && !isNaN(headerInfo.gc)) item.golsCasa = headerInfo.gc;
            else if (item.status === "NS") item.golsCasa = 0;

            if (headerInfo.gf !== null && !isNaN(headerInfo.gf)) item.golsFora = headerInfo.gf;
            else if (item.status === "NS") item.golsFora = 0;

            item.golsHTCasa = (headerInfo.htCasa !== null && !isNaN(headerInfo.htCasa)) ? headerInfo.htCasa : null;
            item.golsHTFora = (headerInfo.htFora !== null && !isNaN(headerInfo.htFora)) ? headerInfo.htFora : null;

            // Extração de Destaques (Confronto Direto, Tendências, Mercados) com Filtro Global contra Cantos e Cartões
            const jsonGeral = await page.evaluate((teams) => {
              let dados = { confronto: [], tendencias: [], mercados: [] };
              try {
                const n = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\W/g, '').toLowerCase();
                const nm = n(teams.mandante);
                const nv = n(teams.visitante);

                const ehCantoOuCartao = (texto) => {
                  const lower = (texto || "").toLowerCase();
                  return ["canto", "cantos", "escanteio", "escanteios", "cartao", "cartão", "cartoes", "cartões"].some(k => lower.includes(k));
                };

                document.querySelectorAll('.card-match-content, [class*="card"], .bg-white').forEach((card) => {
                  const cardText = card.innerText || "";
                  const rows = cardText.split("\n").map((r) => r.trim()).filter(Boolean);

                  if (cardText.includes("Confronto Direto")) {
                    let ctx = "Ambos";
                    for (let i = 0; i < rows.length; i++) {
                      const nr = n(rows[i]);
                      if (nr === nm || nr.includes(nm) || nm.includes(nr)) ctx = teams.mandante;
                      else if (nr === nv || nr.includes(nv) || nv.includes(nr)) ctx = teams.visitante;
                      else if (["Vitórias", "Sem derrota", "Ambas Marcam", "Menos de", "Mais de", "Sem vitória"].some(k => rows[i].includes(k))) {
                        if (!ehCantoOuCartao(rows[i]) && rows[i + 1] && /^[0-9\/]+$/.test(rows[i + 1])) {
                          dados.confronto.push({ metrica: ctx !== "Ambos" ? `${ctx} - ${rows[i]}` : rows[i], valor: rows[i + 1] });
                        }
                      }
                    }
                  }

                  if (cardText.includes("Tendências") || cardText.includes("RECORTE RECENTE") || cardText.includes("Recorte Recente")) {
                    let ctx = "Ambos";
                    for (let i = 0; i < rows.length; i++) {
                      const nr = n(rows[i]);
                      if (nr === nm || nr.includes(nm) || nm.includes(nr)) ctx = teams.mandante;
                      else if (nr === nv || nr.includes(nv) || nv.includes(nr)) ctx = teams.visitante;
                      else if (["Vitórias", "Sem derrota", "Ambas marcam", "Menos", "Mais", "Sem vitória"].some(k => rows[i].includes(k))) {
                        if (!ehCantoOuCartao(rows[i]) && rows[i + 1] && /^[0-9\/]+$/.test(rows[i + 1])) {
                          dados.tendencias.push({ regra: ctx !== "Ambos" ? `${ctx} - ${rows[i]}` : rows[i], rate: rows[i + 1] });
                        }
                      }
                    }
                  }
                });
                
                document.querySelectorAll('.odds-market-row, [class*="odds-market-row"]').forEach((row) => {
                  const labelEl = row.querySelector('.odds-market-label, [class*="market-label"]');
                  const oddCells = Array.from(row.querySelectorAll('[class*="odds-market-cell"], [class*="cell"]'));
                  if (labelEl && oddCells.length >= 2) {
                    const nomeStr = (labelEl.innerText || "").trim();
                    const oddsNumeric = oddCells.map((c) => (c.innerText || "").trim()).filter((t) => /^[0-9.]+$/.test(t));
                    if (oddsNumeric.length >= 2) {
                      if (nomeStr === 'Resultado' || nomeStr.includes('0.5 Gols HT') || nomeStr.includes('Over 2.5 Gols')) {
                          dados.mercados.push({ nome: nomeStr, man: oddsNumeric[0], vis: oddsNumeric[oddsNumeric.length - 1] });
                      }
                    }
                  }
                });
              } catch (e) {}
              return dados;
            }, { mandante: item.mandante, visitante: item.visitante });

            // --- INÍCIO DO EXTRATOR SNIPER DEFINITIVO ---

            const clicarAba = async (nomeAba: string) => {
              try {
                console.log(`    👉 Clicando na aba: ${nomeAba}`);
                const clicou = await page.evaluate((nome) => {
                    const tabs = Array.from(document.querySelectorAll('.game-tab, button, [role="tab"]'));
                    const target = tabs.find(t => (t.textContent || '').trim().toUpperCase() === nome.toUpperCase());
                    if (target) { (target as HTMLElement).click(); return true; }
                    return false;
                }, nomeAba);

                if (!clicou) {
                    await page.getByText(nomeAba, { exact: true }).first().click({ force: true, timeout: 3000 }).catch(()=>{});
                }
                await page.waitForTimeout(2000);
              } catch (e) {}
            };

            // Extração do H2H ajustada para passar pelas 3 posições exatas [Mandante, H2H, Visitante]
            const extrairH2H = async (modo: 'home' | 'away' | 'h2h', teamName: string) => {
                  await page.evaluate(({ modo, nome }) => {
                      const btns = Array.from(document.querySelectorAll('.pg-cardtab-3-nav .pg-cardtab, .pg-cardtab'));
                      if (modo === 'home' && btns.length >= 1) {
                          (btns[0] as HTMLElement).click();
                      } else if (modo === 'h2h' && btns.length >= 2) {
                          const target = btns.find(b => (b.textContent || '').trim() === 'H2H') || btns[1];
                          (target as HTMLElement).click();
                      } else if (modo === 'away' && btns.length >= 3) {
                          (btns[2] as HTMLElement).click();
                      } else {
                          const target = btns.find(b => (b.textContent || '').includes(nome) || b.innerHTML.includes(nome));
                          if (target) (target as HTMLElement).click();
                      }
                  }, { modo, nome: teamName });
                  
                  await page.waitForTimeout(1500); 

                  return await page.evaluate(() => {
                      const data = [];
                      const seen = new Set();
                      
                      const activePane = document.querySelector('.dsmp-row-ind.active') || document;
                      const rows = activePane.querySelectorAll('a.dsmp-row');

                      rows.forEach(row => {
                          const dt = (row.querySelector('.dsmp-match-local-date')?.textContent || '').trim();
                          
                          const teamEls = row.querySelectorAll('.match-name.match-name-desktop');
                          const mandante = teamEls[0] ? (teamEls[0].textContent || '').trim() : '';
                          const visitante = teamEls[1] ? (teamEls[1].textContent || '').trim() : '';
                          
                          const oddEls = row.querySelectorAll('.dsmp-odd');
                          const odd = oddEls.length > 0 ? (oddEls[oddEls.length - 1].textContent || '').trim() : '-';
                          
                          const placar = (row.querySelector('.dsmp-score-badge')?.textContent || '').trim();

                          const icons = Array.from(row.querySelectorAll('.dsmp-first-goal i, .dsmp-1hf i, .dsmp-2hf i, .dsmp-cs i')).map(iEl => {
                              const cls = iEl.className || '';
                              if (cls.includes('win') || cls.includes('check')) return 'G';
                              if (cls.includes('loss') || cls.includes('close')) return 'R';
                              return 'N';
                          });

                          let [m1, t1, t2, ns] = ['N', 'N', 'N', 'N'];
                          if (icons.length >= 4) { m1 = icons[0]; t1 = icons[1]; t2 = icons[2]; ns = icons[3]; }

                          const key = dt + placar + mandante + visitante;
                          if (dt && placar && !seen.has(key)) {
                              seen.add(key);
                              data.push({ data: dt, mandante, visitante, odd, placar, m1, t1, t2, ns });
                          }
                      });
                      return data;
                  });
            };

            // Extrai as linhas de uma aba (Desempenho/Gols). Quando a aba tem o toggle
            // "Primeiro"/"Segundo", tenta clicar em "Segundo" e capturar de novo, marcando
            // como 'periodo: 2T' SÓ as linhas cujo valor realmente mudou em relação ao
            // "Primeiro" - evita duplicar estatísticas globais (ex.: Aproveitamento da
            // temporada) que usam a mesma classe CSS mas não são por tempo de jogo.
            const extrairLinhasDaTela = async (periodoTag?: string) => {
              return await page.evaluate((periodo) => {
                  const resultados = [];
                  const seen = new Set();

                  document.querySelectorAll('.pg-tstable-row').forEach(row => {
                      const label = (row.querySelector('.pg-tstable-label')?.textContent || '').trim();
                      if (!label) return;

                      const vals = Array.from(row.querySelectorAll('.pgcv')).map(el => (el.textContent || '').trim().replace(/\s+/g, ' '));

                      if (vals.length >= 2) {
                          const key = label + vals[0] + vals[1];
                          if (!seen.has(key)) {
                              seen.add(key);
                              const linha: any = {
                                  metrica: label,
                                  casa: vals[0],
                                  fora: vals[1],
                                  media: vals[2] || ""
                              };
                              if (periodo) linha.periodo = periodo;
                              resultados.push(linha);
                          }
                      }
                  });

                  document.querySelectorAll('.pg-goalmomentum-row').forEach(row => {
                      const tempo = (row.querySelector('.pg-gm-time')?.textContent || '').trim();
                      if (!tempo) return;

                      const marcado = (row.querySelector('.pg-gm-marcado')?.textContent || '').trim();
                      const sofrido = (row.querySelector('.pg-gm-sofrido')?.textContent || '').trim();
                      const percM = (row.querySelector('.pg-gm-perc-mercado, [class*="perc-mercado"]')?.textContent || '').trim();
                      const percS = (row.querySelector('.pg-gm-perc-sofrido, [class*="perc-sofrido"]')?.textContent || '').trim();

                      const key = 'relogio' + tempo + marcado + sofrido;
                      if (!seen.has(key)) {
                          seen.add(key);
                          resultados.push({
                              tipo: 'relogio',
                              tempo: tempo,
                              m: percM,
                              s: percS,
                              marcado: marcado,
                              sofrido: sofrido
                          });
                      }
                  });

                  return resultados;
              }, periodoTag || null);
            };

            const clicarToggleTempo = async (rotulo: 'PRIMEIRO' | 'SEGUNDO') => {
              return await page.evaluate((rot) => {
                  const alvo = Array.from(document.querySelectorAll('button, [role="tab"], span, div')).find(el => {
                      const txt = (el.textContent || '').trim().toUpperCase();
                      return txt === rot && el.closest('button, [role="tab"]');
                  });
                  const clicavel: any = alvo ? (alvo.closest('button, [role="tab"]') || alvo) : null;
                  if (clicavel) { clicavel.click(); return true; }
                  return false;
              }, rotulo);
            };

            const extrairTabelaGenerica = async (nomeAba: string) => {
              await clicarAba(nomeAba);
              const linhas1T = await extrairLinhasDaTela();

              let linhas2T = [];
              try {
                const achouSegundo = await clicarToggleTempo('SEGUNDO');
                if (achouSegundo) {
                  await page.waitForTimeout(1200);
                  const brutas2T = await extrairLinhasDaTela('2T');
                  const mapa1T = new Map(linhas1T.filter((l: any) => l.tipo !== 'relogio').map((l: any) => [l.metrica, l]));
                  linhas2T = brutas2T.filter((l: any) => {
                    if (l.tipo === 'relogio') return false; // relógio de gols já cobre o jogo inteiro
                    const par: any = mapa1T.get(l.metrica);
                    return !par || par.casa !== l.casa || par.fora !== l.fora;
                  });

                  await clicarToggleTempo('PRIMEIRO'); // deixa o toggle limpo pra próxima leitura
                  await page.waitForTimeout(500);
                }
              } catch (e) {}

              return [...linhas1T, ...linhas2T];
            };

            let jsonH2H_casa = [];
            let jsonH2H_fora = [];
            let jsonH2H_ambos = [];
            
            try {
              await clicarAba("H2H");
              jsonH2H_casa = await extrairH2H('home', item.mandante);
              jsonH2H_ambos = await extrairH2H('h2h', 'H2H');
              jsonH2H_fora = await extrairH2H('away', item.visitante);
            } catch (e) {}

            const jsonDesempenho = await extrairTabelaGenerica("Desempenho").catch(() => []);
            const jsonGols = await extrairTabelaGenerica("Gols").catch(() => []);

            // --- FIM DO EXTRATOR SNIPER DEFINITIVO ---

            // Regra de Preservação do Horário
            let horaPreservada = item.hora && item.hora !== "" ? item.hora : "00:00";
            try {
              const docExistente = await db.collection("jogos_ao_vivo").doc(String(item.id)).get();
              if (docExistente.exists) {
                const dadosAntigos = docExistente.data();
                if (dadosAntigos && dadosAntigos.hora && dadosAntigos.hora !== "00:00" && dadosAntigos.hora !== "") {
                  horaPreservada = dadosAntigos.hora;
                }
              }
            } catch (e) {}

            const docJogo = {
              id: item.id,
              pais: item.pais,
              competicao: item.competicao,
              mandante: item.mandante,
              visitante: item.visitante,
              logoCasa: item.logoCasa,
              logoFora: item.logoFora,
              oddCasa: item.oddCasa,
              oddEmpate: item.oddEmpate,
              oddFora: item.oddFora,
              status: item.status,
              hora: horaPreservada,
              dataJogo: item.dataJogo,
              golsCasa: item.golsCasa,
              golsFora: item.golsFora,
              golsHTCasa: item.golsHTCasa ?? null,
              golsHTFora: item.golsHTFora ?? null,
              isDestaque: item.isDestaque || false,
              eventosJSON: JSON.stringify({
                principais_json: jsonGeral,
                raiox_json: {
                  aproveitamento: [], 
                  h2h: jsonH2H_ambos,
                  h2h_casa: jsonH2H_casa, 
                  h2h_fora: jsonH2H_fora,
                  desempenho: jsonDesempenho,
                  gols: jsonGols
                }
              }),
              atualizadoEm: new Date().toISOString(),
            };

            await db.collection("jogos_ao_vivo").doc(String(item.id)).set(docJogo, { merge: true });
            console.log(`    └─ Dados sincronizados no Firestore com sucesso!`);
          } catch (error) {
            console.error(`❌ Erro no jogo ${item.mandante} x ${item.visitante}:`, error.message);
          }
        }
    }

    const fimMs = Date.now();
    await atualizarStatusMotor({
      status: "CONCLUÍDO",
      ultimoLog: `Processados ${totalJogosNaRodada} jogos. (MODO TESTE HOJE)`,
      mensagem: "Varredura concluída com sucesso.",
      duracaoMinutos: Math.floor((fimMs - inicioMs) / 60000),
    });
    console.log(`\n✅ Varredura finalizada. Total de jogos HOJE: ${totalJogosNaRodada}.`);
  } catch (globalErr) {
    console.error("❌ ERRO FATAL NO MOTOR:", (globalErr as Error).message);
    await atualizarStatusMotor({ status: "ERRO", mensagem: `Falha: ${(globalErr as Error).message}` });
  } finally {
    if (browser) await browser.close();
  }
}

let lastTriggerTime: number | null = null;
setInterval(async () => {
  try {
    const doc = await db.collection("configuracoes").doc("motor").get();
    if (doc.exists) {
      const data = doc.data();
      if (lastTriggerTime === null) {
        lastTriggerTime = data?.forcar_leitura || 0;
        return;
      }
      if (data?.forcar_leitura && data.forcar_leitura !== lastTriggerTime) {
        lastTriggerTime = data.forcar_leitura;
        console.log("🔧 Disparo manual recebido pelo Cockpit!");
        await rodarMotorCompleto(data.theo_token);
      }
    }
  } catch (e) {}
}, 3000);

rodarMotorCompleto();