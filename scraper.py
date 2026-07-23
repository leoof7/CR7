import json
import requests
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

# ==========================================
# CONFIGURAÇÕES DA INTEGRAÇÃO
# ==========================================
# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyqpbiSNKRhbJ5qdreOU_eV6qjOAh4-boVFPW6XNIMrS7Zejyql13s2RguE_OmLmexgRw/exec"

TOKEN = "8f88b4c964"
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

EXTRACTOR_JS = """
() => {
    let m_name = "Mandante", v_name = "Visitante";
    let logoC = "", logoF = "";
    let oddC = "", oddF = "";
    let status = "NS", gC = "-", gF = "-";
    let time_str = "19:00", comp = "Geral";

    let homeImg = document.querySelector('.card-match-teams-block.home img');
    if(homeImg) { m_name = homeImg.alt || "Mandante"; logoC = homeImg.src || ""; }
    let homeOdd = document.querySelector('.card-match-teams-block.home .card-match-odds-item');
    if(homeOdd) oddC = homeOdd.innerText.trim();

    let awayImg = document.querySelector('.card-match-teams-block.away img');
    if(awayImg) { v_name = awayImg.alt || "Visitante"; logoF = awayImg.src || ""; }
    let awayOdd = document.querySelector('.card-match-teams-block.away .card-match-odds-item');
    if(awayOdd) oddF = awayOdd.innerText.trim();

    let centerDiv = document.querySelector('.card-match-center');
    if(centerDiv) {
        let text = centerDiv.innerText;
        let scoreMatch = text.match(/(\d+)\s*-\s*(\d+)/);
        if(scoreMatch) { gC = scoreMatch[1]; gF = scoreMatch[2]; status = "FT"; }
        let timeMatch = text.match(/\d{2}:\d{2}/);
        if(timeMatch) time_str = timeMatch[0];
    }
    
    let headerDiv = document.querySelector('.card-match-header');
    if(headerDiv) { comp = headerDiv.innerText.replace(/\n/g, ' ').trim() || "Geral"; }

    let fullText = document.body.innerText;

    return {
        mandante: m_name, visitante: v_name, oddC: oddC, oddF: oddF,
        logoC: logoC, logoF: logoF, gC: gC, gF: gF, status: status,
        hora: time_str, competicao: comp, texto: fullText.substring(0, 8000)
    };
}
"""

def run_scraper():
    print("🤖 Iniciando Motor Python Playwright (Modo Camuflado + Logs Profundos)...")
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
        
        # O DISFARCE: Enganando o servidor para achar que somos um humano no Windows
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
                page.wait_for_timeout(3000) # Pausa dramática para o site carregar
                
                hrefs = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                game_links = [href for href in hrefs if "/game/" in href]
                print(f"✅ {len(game_links)} jogos listados.")
                
                for link in game_links:
                    if link in links_visitados: continue
                    links_visitados.add(link)
                    
                    try:
                        print(f"  ⏳ Acessando: {link}")
                        page.goto(link, wait_until="domcontentloaded", timeout=20000)
                        
                        # Espera a caixa do jogo aparecer
                        page.wait_for_selector('.card-match', timeout=15000)
                        
                        dados = page.evaluate(EXTRACTOR_JS)
                        
                        if dados["mandante"] == "Mandante":
                            print(f"  ⚠️ Falha de captura (Nomes Vazios): {link}")
                            continue

                        dados["fixtureId"] = link.split("/game/")[1].split("?")[0]
                        dados["dataJogo"] = data_oficial
                        
                        jogos_extraidos.append(dados)
                        print(f"  🎯 SUCESSO: {dados['mandante']} x {dados['visitante']}")
                        
                    except Exception as e:
                        # A CÂMERA: Printando na tela do log o que deu errado!
                        print(f"  ❌ ERRO AO LER O JOGO: {link}")
                        print(f"  🔍 CÓDIGO DO ERRO: {str(e)[:200]}")
                        try:
                            # Puxa os primeiros 500 caracteres do texto que está na tela do robô
                            html_visto = page.evaluate("() => document.body.innerText")
                            print(f"  👀 O QUE O ROBÔ ESTÁ VENDO NA TELA AGORA: \n{html_visto[:500]}...")
                        except:
                            print("  👀 TELA EM BRANCO OU INACESSÍVEL.")

            except Exception as e:
                print(f"⚠️ Erro ao carregar a lista de {dia}.")

        browser.close()

    if jogos_extraidos:
        print(f"\n🚀 Enviando {len(jogos_extraidos)} jogos para o Google Sheets...")
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta: {resp.text}")
        except Exception as e:
            print(f"❌ Erro HTTP: {e}")
    else:
        print("\n🤷 Nenhum jogo processado com sucesso.")

if __name__ == "__main__":
    run_scraper()
