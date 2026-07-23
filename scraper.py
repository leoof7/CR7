import json
import requests
import re
from playwright.sync_api import sync_playwright

# ==========================================
# CONFIGURAÇÕES DA INTEGRAÇÃO
# ==========================================
# ⚠️ ATENÇÃO: Cole a URL final do Apps Script que termina em /exec
WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyqpbiSNKRhbJ5qdreOU_eV6qjOAh4-boVFPW6XNIMrS7Zejyql13s2RguE_OmLmexgRw/exec"

TOKEN = "8f88b4c964"
DIAS_PARA_RASPAR = ["ontem", "hoje", "amanha"]

def run_scraper():
    print("🤖 Iniciando Motor Python Playwright (Extração Profunda)...")
    jogos_extraidos = []
    links_visitados = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        for dia in DIAS_PARA_RASPAR:
            url_lista = f"https://clube.theoborges.com/matches?dia={dia}&t={TOKEN}"
            print(f"📍 Acessando lista: {dia.upper()}")
            
            try:
                page.goto(url_lista, wait_until="networkidle", timeout=15000)
                hrefs = page.eval_on_selector_all("a", "elements => elements.map(e => e.href)")
                game_links = [href for href in hrefs if "/game/" in href]
                
                print(f"✅ {len(game_links)} jogos encontrados para {dia}.")
                
                for link in game_links:
                    if link in links_visitados: continue
                    links_visitados.add(link)
                    
                    try:
                        print(f"  ⏳ Lendo dados reais de: {link}")
                        # networkidle é o segredo: ele espera a tela carregar 100%
                        page.goto(link, wait_until="networkidle", timeout=15000)
                        
                        # Captura o texto 100% renderizado da tela
                        texto_tela = page.evaluate("() => document.body.innerText")
                        # Captura os links das imagens (Escudos)
                        escudos = page.evaluate("() => Array.from(document.querySelectorAll('img')).map(i => i.src).filter(s => s.includes('team-image-proxy'))")
                        # Captura o banco de dados interno da página
                        next_data = page.evaluate("() => { let el = document.getElementById('__NEXT_DATA__'); return el ? el.innerText : null; }")
                        
                        fixture_id = link.split("/game/")[1].split("?")[0]
                        m_name, v_name, comp = "Mandante", "Visitante", "Geral"
                        date_str, time_str = "", "19:00"
                        status, gC, gF = "NS", "-", "-"
                        odd_c, odd_f = "", ""
                        
                        # Tentativa 1: Via banco de dados oculto (JSON)
                        if next_data:
                            try:
                                data = json.loads(next_data)
                                match = data.get("props", {}).get("pageProps", {}).get("match", {})
                                m_name = match.get("homeTeam", {}).get("name", m_name)
                                v_name = match.get("awayTeam", {}).get("name", v_name)
                                comp = match.get("league", {}).get("name", comp)
                                if match.get("date"):
                                    date_str = match["date"].split("T")[0]
                                    time_str = match["date"].split("T")[1][:5]
                                s = match.get("status", "")
                                status = "FT" if s == "finished" else ("LIVE" if s == "in_progress" else "NS")
                                if match.get("homeScore") is not None: gC = str(match["homeScore"])
                                if match.get("awayScore") is not None: gF = str(match["awayScore"])
                            except: pass

                        # Tentativa 2: Caçar os nomes direto no texto renderizado se o JSON falhar
                        if m_name == "Mandante":
                            m_match = re.search(r"Partidas\s+(.*?)\s+(.*?)\s+\d{2}:\d{2}", texto_tela, re.IGNORECASE)
                            if m_match:
                                comp = m_match.group(1).strip()
                                m_name = m_match.group(2).strip()

                        # Pega as Odds direto da tela usando Regex
                        odd_match = re.search(r"Resultado\s+([\d\.]+)\s+([\d\.]+)", texto_tela, re.IGNORECASE)
                        if odd_match:
                            odd_c = odd_match.group(1)
                            odd_f = odd_match.group(2)
                            
                        # Limpa o texto da tela para a IA do Google gerar as dicas depois
                        tx_limpo = " ".join(texto_tela.split())[:8000]

                        # Empacota os dados estruturados
                        jogos_extraidos.append({
                            "fixtureId": fixture_id,
                            "mandante": m_name,
                            "visitante": v_name,
                            "competicao": comp,
                            "dataJogo": date_str,
                            "hora": time_str,
                            "status": status,
                            "gC": gC,
                            "gF": gF,
                            "oddC": odd_c,
                            "oddF": odd_f,
                            "logoC": escudos[0] if len(escudos) > 0 else "",
                            "logoF": escudos[1] if len(escudos) > 1 else "",
                            "texto": tx_limpo
                        })
                        print(f"  ✅ SUCESSO: {m_name} x {v_name} | {gC}x{gF}")
                        
                    except Exception as e:
                        print(f"  ❌ Falha no jogo: {e}")

            except Exception as e:
                print(f"⚠️ Erro ao carregar página da lista {dia}: {e}")

        browser.close()

    if jogos_extraidos:
        print(f"🚀 Enviando payload mastigado de {len(jogos_extraidos)} jogos para o Google Apps Script...")
        try:
            resp = requests.post(WEBHOOK_URL, json={"jogos": jogos_extraidos})
            print(f"Resposta do Servidor: {resp.text}")
        except Exception as e:
            print(f"❌ Erro de conexão com a planilha: {e}")
    else:
        print("🤷 Nenhum jogo processado.")

if __name__ == "__main__":
    run_scraper()
