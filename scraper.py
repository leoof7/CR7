import os
import json
import requests
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbw5drrqteZfG8oPVz1yv0xXDfs1LgRRr9zWabW-3xsRq7vr8wLS-OYh-e1RUn4nO1wA4Q/exec"

# Recebe o Token dinâmico do GitHub Actions (ou usa um padrão caso não encontre)
TOKEN = os.environ.get("SITE_TOKEN", "8f88b4c964")
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

EXTRACTOR_BASIC_JS = """
() => {
    let m = "Mandante", v = "Visitante", comp = "Geral", h = "19:00", st = "NS", gc = "-", gf = "-", oc = "", of = "", lc = "", lf = "";
    try {
        let hImg = document.querySelector('.card-match-teams-block.home img');
        if (hImg) { lc = hImg.src || ""; if (hImg.alt) m = hImg.alt.trim(); }
        let aImg = document.querySelector('.card-match-teams-block.away img');
        if (aImg) { lf = aImg.src || ""; if (aImg.alt) v = aImg.alt.trim(); }

        let hOdd = document.querySelector('.card-match-teams-block.home .card-match-odds-item');
        if (hOdd) oc = hOdd.innerText.trim();
        let aOdd = document.querySelector('.card-match-teams-block.away .card-match-odds-item');
        if (aOdd) of = aOdd.innerText.trim();

        let header = document.querySelector('.card-match-header');
        if (header) comp = header.innerText.split('\\n')[0].trim() || "Geral";
        
        let center = document.querySelector('.card-match-center');
        if (center) {
            // Pega a hora ou os minutos do jogo
            let timeText = center.innerText;
            let tMatch = timeText.match(/\\d{2}:\\d{2}/);
            if (tMatch) h = tMatch[0];
            
            // Verifica placar
            let scoreMatch = timeText.match(/(\\d+)\\s*-\\s*(\\d+)/);
            if (scoreMatch) { 
                gc = scoreMatch[1]; gf = scoreMatch[2]; 
                // Se tiver ' (apóstrofo de minutos) ou a palavra Vivo, é LIVE, senão é FT
                if (timeText.includes("'") || timeText.toLowerCase().includes("vivo")) {
                    st = "LIVE";
                    let minMatch = timeText.match(/\\d+'/);
                    if(minMatch) h = minMatch[0]; // Salva o minuto no lugar da hora
                } else {
                    st = "FT";
                }
            }
        }
    } catch(e) {}
    return { mandante: m, visitante: v, competicao: comp, hora: h, status: st, gC: gc, gF: gf, oddC: oc, oddF: of, logoC: lc, logoF: lf, texto_geral: document.body.innerText.substring(0, 5000) };
}
"""

def run_scraper():
    print(f"🤖 Motor Python Ligado | Usando Token: {TOKEN}")
    jogos_extraidos = []
    links_visitados = set()
    hoje = datetime.now()
    mapa_datas = {
        "ontem": (hoje - timedelta(days=1)).strftime("%Y-%m-%d"),
        "hoje": hoje.strftime("%Y-%m-%d"),
        "amanha": (hoje + timedelta(days=1)).strftime("%Y-%m-%d")
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = context.new_page()

        for dia in DIAS_PARA_RASPAR:
            data_oficial = mapa_datas[dia]
            url_lista = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"\n📍 Lendo lista: {dia.upper()} ({data_oficial})")
            
            try:
                page.goto(url_lista, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)
                
                # Expandindo as sanfonas
                botoes_expandir = page.locator('.competition-card.collapsed .competition-header')
                count = botoes_expandir.count()
                for i in range(count):
                    try: botoes_expandir.nth(i).click(timeout=1000)
                    except: pass
                page.wait_for_timeout(2000)
                
                hrefs = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                game_links = list(set([href for href in hrefs if "/game/" in href]))
                
                for link in game_links:
                    if link in links_visitados: continue
                    links_visitados.add(link)
                    
                    try:
                        page.goto(link, wait_until="domcontentloaded", timeout=30000)
                        page.wait_for_timeout(4000)
                        
                        dados = page.evaluate(EXTRACTOR_BASIC_JS)
                        
                        if dados["mandante"] == "Mandante" or dados["mandante"] == "":
                            continue

                        bloco_desempenho = ""
                        bloco_gols = ""

                        # OTIMIZAÇÃO: Se for jogo de "ontem" e já está FT, não perde tempo lendo as abas de desempenho
                        if not (dia == "ontem" and dados["status"] == "FT"):
                            try:
                                page.locator("text='Desempenho'").first.click(timeout=3000)
                                page.wait_for_timeout(1500)
                                bloco_desempenho = page.evaluate("() => { let el = document.querySelector('.tab-content.active'); return el ? el.innerText : ''; }")
                            except: pass
                            
                            try:
                                page.locator("text='Gols'").first.click(timeout=3000)
                                page.wait_for_timeout(1500)
                                bloco_gols = page.evaluate("() => { let el = document.querySelector('.tab-content.active'); return el ? el.innerText : ''; }")
                            except: pass

                        dados["eventosJSON"] = json.dumps({
                            "geral": dados.pop("texto_geral"),
                            "desempenho": bloco_desempenho,
                            "gols": bloco_gols
                        })

                        dados["fixtureId"] = link.split("/game/")[1].split("?")[0]
                        dados["dataJogo"] = data_oficial
                        jogos_extraidos.append(dados)
                        print(f"  🎯 SUCESSO: {dados['mandante']} x {dados['visitante']} ({dados['status']})")
                        
                    except Exception as e:
                        pass
            except Exception as e:
                pass

        browser.close()

    if jogos_extraidos:
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta da Planilha: {resp.text}")
        except Exception as e:
            pass

if __name__ == "__main__":
    run_scraper()
