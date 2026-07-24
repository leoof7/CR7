import os
import json
import requests
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwiLqkwunkPgrcfpkq-FbJDKF0OrDNKfv5TC0zTTckobKNfexpJoKqaO8G2BOB9I2U1cw/exec"

TOKEN = os.environ.get("SITE_TOKEN", "").strip()
if not TOKEN or TOKEN == "None" or TOKEN == "null":
    TOKEN = "8f88b4c964"

DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha", "depois", "depois2"]

# LISTA NEGRA: O robô vai pular essas ligas imediatamente
BLOCKLIST = [
    "série b do equador", "série b ecuador", "costa rica", "colômbia - primera b", "colombia - primera b", 
    "peru - segunda", "islândia", "iceland", "bélgica - copa", "bielorrússia", "belarus", "bulgária", "bulgaria", 
    "canadá", "canada", "dinamarca - segunda", "hungria", "hungary", "nb i", "nb ii", "kazakhstan", "cazaquistão", 
    "poland - 1. liga", "polônia - 1", "republic of ireland", "irlanda", "romania", "romênia", "slovakia", "eslováquia", 
    "slovenia", "eslovênia", "prvaliga", "south korea", "coreia do sul", "k league 2", "sweden", "suécia", "allsvenskan", 
    "superettan", "tchéquia", "czech", "ukraine", "ucrânia", "pershaya", "usl championship", "china", "russian", 
    "ascenso mx", "esiliiga", "veikkausliiga", "ykkosliiga", "1. liga", "cup", "copa da", "challenge"
]

EXTRACTOR_JS = """
() => {
    let m = "Mandante", v = "Visitante", comp = "Geral", h = "19:00", st = "NS", gc = "-", gf = "-", oc = "", of = "", lc = "", lf = "";
    let hImg = document.querySelector('.card-match-teams-block.home img');
    if (hImg) { lc = hImg.src || ""; if (hImg.alt) m = hImg.alt.trim(); }
    let aImg = document.querySelector('.card-match-teams-block.away img');
    if (aImg) { lf = aImg.src || ""; if (aImg.alt) v = aImg.alt.trim(); }
    let hOdd = document.querySelector('.card-match-teams-block.home .card-match-odds-item');
    if (hOdd) oc = hOdd.innerText.trim();
    let aOdd = document.querySelector('.card-match-teams-block.away .card-match-odds-item');
    if (aOdd) of = aOdd.innerText.trim();
    
    let header = document.querySelector('.card-match-header');
    if (header) {
        let lines = header.innerText.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 1) { comp = lines[lines.length - 1]; } 
        else { comp = lines[0]; }
        if (comp.toLowerCase().includes('partidas') && lines.length > 1) comp = lines[1];
    }
    
    let center = document.querySelector('.card-match-center');
    if (center) {
        let timeText = center.innerText;
        let tMatch = timeText.match(/\\d{2}:\\d{2}/);
        if (tMatch) h = tMatch[0];
        
        let scoreMatch = timeText.match(/(\\d+)\\s*[-xX]\\s*(\\d+)/);
        if (scoreMatch) { 
            gc = scoreMatch[1]; gf = scoreMatch[2]; 
            if (timeText.includes("'") || timeText.toLowerCase().includes("vivo") || timeText.includes("+")) {
                st = "LIVE"; 
                let minMatch = timeText.match(/\\d+'/); 
                if(minMatch) h = minMatch[0];
            } else { st = "FT"; }
        } else if (timeText.toLowerCase().includes("encerrado") || timeText.toLowerCase().includes("ft")) {
            st = "FT";
        }
    }
    return { mandante: m, visitante: v, competicao: comp, hora: h, status: st, gC: gc, gF: gf, oddC: oc, oddF: of, logoC: lc, logoF: lf };
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
        "amanha": (hoje + timedelta(days=1)).strftime("%Y-%m-%d"),
        "depois": (hoje + timedelta(days=2)).strftime("%Y-%m-%d"),
        "depois2": (hoje + timedelta(days=3)).strftime("%Y-%m-%d")
    }

    with sync_playwright() as p:
        # Força o Fuso Horário de São Paulo para evitar "Viagens no tempo"
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080}, timezone_id="America/Sao_Paulo")
        page = context.new_page()

        for dia in DIAS_PARA_RASPAR:
            data_oficial = mapa_datas[dia]
            url_lista = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"\n📍 Lendo lista: {dia.upper()} ({data_oficial})")
            
            try:
                page.goto(url_lista, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(3000)
                
                botoes_expandir = page.locator('.competition-card.collapsed .competition-header')
                for i in range(botoes_expandir.count()):
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
                        page.wait_for_timeout(2500)
                        
                        dados = page.evaluate(EXTRACTOR_JS)
                        if dados["mandante"] == "Mandante" or dados["mandante"] == "": continue
                        
                        comp_lower = dados["competicao"].lower()
                        if any(lixo in comp_lower for lixo in BLOCKLIST):
                            print(f"🚫 Ignorado pela Blocklist: {dados['competicao']}")
                            continue

                        eventos_json = {}
                        try: eventos_json["geral_txt"] = page.evaluate("() => document.querySelector('.tab-content.active')?.innerText || ''")
                        except: pass

                        if not (dia == "ontem" and dados["status"] == "FT"):
                            for aba in ["Desempenho", "Gols", "Odds"]:
                                try:
                                    page.locator(f"text='{aba}'").first.click(timeout=2000)
                                    page.wait_for_timeout(1000)
                                    eventos_json[f"{aba.lower()}_txt"] = page.evaluate("() => document.querySelector('.tab-content.active')?.innerText || ''")
                                except: pass

                        dados["eventosJSON"] = json.dumps(eventos_json)
                        dados["fixtureId"] = link.split("/game/")[1].split("?")[0]
                        dados["dataJogo"] = data_oficial
                        jogos_extraidos.append(dados)
                        print(f"  🎯 SUCESSO: {dados['mandante']} x {dados['visitante']} | Liga: {dados['competicao']}")
                    except: pass
            except: pass

        browser.close()

    if jogos_extraidos:
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta Planilha: {resp.text}")
        except: pass

if __name__ == "__main__":
    run_scraper()
