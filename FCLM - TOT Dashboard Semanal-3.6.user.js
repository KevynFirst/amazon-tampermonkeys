// ==UserScript==
// @name         FCLM - TOT Dashboard Semanal
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  Dashboard semanal Time Off Task + integração Slack — links por gestor abrem abas
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/timeOnTask*
// @match        https://fclm-portal.amazon.com/reports/ppaTimeOnTask*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// ==/UserScript==
// v1.0 — Versão leve: paleta Amazon #232F3E/#FF9900; botão acima do overlay Off-Task
// v1.1 — getDays(): segunda-feira puxa semana anterior; mensagem "Prezados(as)"; emoji 🚨
// v1.2 — Botão footer: ícone SVG Slack + "Enviar Via Slack"; fix className→class
// v1.3 — Editor de Mapa de Áreas: importar CSV, editar textarea, salvar localStorage
// v1.4 — Importar Excel: aceita .xlsx e .csv (EN/BR); parseCSVMap auto-detecta separador
// v1.5 — AREA_MAP atualizado com lista completa; botão "Gerar TOT via Slack"; showWebhookEditor()
// v1.6 — N/A→"Não Mapeado"; buildSlackMgrs() por área; 🏆 badge ofensora; showUnmappedModal()
// v1.7 — showMapEditor(): botão 📥 Exportar adicionado (CSV provisório)
// v1.8 — Exportar: CSV → XLSX via SheetJS (aoa_to_sheet + writeFile)
// v1.9 — Fix Slack links: URL construída por employeeId+warehouseId+bestDay; getNextDay()
// v2.0 — Fetch por janelas operacionais 06:00→06:00 (spanType=Intraday); última janela truncada
//         ao currentHour; URL employee: startTime/endTime ISO (YYYY-MM-DDTHH:mm:ss±TZOFF)
// v2.1 — buildSlackText(): 3 mensagens por dia (Dom/Seg/Ter-Sáb); link SharePoint no rodapé
// v2.2 — Link do gestor no Slack abre ppaTimeOnTask (não timeOnTask); @match ppaTimeOnTask*;
//         fetchWindow() hardcoded para /reports/timeOnTask (dados sempre do PPR)
// v2.9 — getWindows(): segunda-feira adiciona janela parcial Dom 06:00→Seg currentHour;
//         buildSlackText(): mensagem de segunda atualizada para "semana passada até agora"
// v3.0 — showDashboard(): expõe window.__totSlackPayload após buildReport() para automação
//         Python (requests.post direto — sem GM_xmlhttpRequest, sem CORS, confiável)
// v3.1 — Fix sandbox TM: window → unsafeWindow.__totSlackPayload (grants isolam window interno)
// v3.2 — Fix definitivo: unsafeWindow → data-slack-payload no DOM (#tot-dash setAttribute)
//         DOM attributes não sofrem restrições de sandbox — leitura garantida pelo Selenium
// v3.3 — Fix crítico fetchWindow(): parâmetros startHour/endHour → startHourIntraday/endHourIntraday
//         FCLM ignorava as horas → janela Jun4→Jun5 virava 00:00→00:00 (perdia turno noturno)
//         getWindows(): simplificado para 2 janelas fixas (ontem 06:00→hoje 06:00 + hoje 06:00→horaAtual)
// v3.4 — UX/UI refresh (visual): tokens de gradiente na paleta C + CSS global (keyframes)
//         Modais (dashboard/unmapped/webhook/mapa): overlay com blur, painel arredondado 16px + animação pop,
//         headers em gradiente, botão ✕ que gira, foco laranja 3px, botões com elevação, scrollbar custom
//         Banner com slide-down; botão flutuante e cards refinados
//         Fix className→class no botão "abrir abas" por gestor (delegação .tot-mgr-btn não funcionava)
// v3.5 — Fix getWindows(): volta a ser SEMANAL de verdade. Gera 1 janela por dia operacional
//         desde o domingo (início da semana) até agora, atravessando a virada de mês.
//         Antes (v3.3) pegava só ontem+hoje (2 janelas) → no fim do mês cortava no dia 1º
//         (ex.: só 01 e 02/jul). Agora pega a semana inteira (ex.: 28/jun→02/jul = 5 janelas).


(function () {
    'use strict';


    // ── Paleta Amazon (consistente com demais scripts) ────────────────────
    const C = {
        dark:   '#232F3E',
        darker: '#131921',
        hover:  '#37475A',
        accent: '#FF9900',
        gold:   '#FEBD69',
        blue:   '#4A86C8',
        grey:   '#607D8B',
        red:    '#CC0000',
        amber:  '#E88B00',
        green:  '#27AE60',
        white:  '#FFFFFF',
        light:  '#F7F7F7',
        border: '#E8E8E8',
        // v3.4 — tokens de gradiente p/ visual coeso (navy/laranja Amazon)
        headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
        btnGrad:    'linear-gradient(145deg,#37475A 0%,#232F3E 100%)',
        btnGradH:   'linear-gradient(145deg,#4A5D72 0%,#37475A 100%)',
        bodyBg:     '#EEF1F4',
    };


    // ── CSS global (keyframes + scrollbar) — injetado 1x (v3.4) ───────────
    function injectUICss() {
        if (document.getElementById('tot-ui-css')) return;
        const st = document.createElement('style');
        st.id = 'tot-ui-css';
        st.textContent =
            '@keyframes totFade{from{opacity:0}to{opacity:1}}' +
            '@keyframes totPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}' +
            '@keyframes totSlideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}' +
            '@keyframes totPulse{0%,100%{opacity:1}50%{opacity:.35}}' +
            '#tot-dash ::-webkit-scrollbar,#tot-map-editor ::-webkit-scrollbar,#tot-unmapped-modal ::-webkit-scrollbar{width:10px;height:10px}' +
            '#tot-dash ::-webkit-scrollbar-thumb,#tot-map-editor ::-webkit-scrollbar-thumb,#tot-unmapped-modal ::-webkit-scrollbar-thumb{background:#C5CDD4;border-radius:8px;border:2px solid transparent;background-clip:padding-box}' +
            '#tot-dash ::-webkit-scrollbar-thumb:hover,#tot-map-editor ::-webkit-scrollbar-thumb:hover{background:#9AA6B1;background-clip:padding-box}';
        document.head.appendChild(st);
    }


    // ── SVG do Slack (reutilizado no botão flutuante e footer) ───────────
    const SLACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 122.8 122.8" width="14" height="14" style="vertical-align:middle;margin-right:6px;"><path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E"/></svg>`;


    // ── Dicionário Manager → Área ─────────────────────────────────────────
    const AREA_MAP = [
        { name: "Delazari Mergulhão,Guilherme",        area: "Outbound"         },
        { name: "Demarchi,Janaina",                    area: "Transfer/IXD"     },
        { name: "Moreiraminhos,Ana Carla",             area: "Transfer/IXD"     },
        { name: "dos Santos Barreto,Larissa",          area: "environmental"    },
        { name: "Da Silva,Madalena Priscila",          area: "environmental"    },
        { name: "Santana,Giovanna",                    area: "environmental"    },
        { name: "Meth,Fabiana",                        area: "FLOW"             },
        { name: "Nathan,Thiago",                       area: "FLOW"             },
        { name: "Nascimento,Caroline Soares",          area: "FLOW"             },
        { name: "Silva Do Nascimento,Glaan Kaique",    area: "FLOW"             },
        { name: "Magalhaes Filho,Roberto",             area: "FLOW"             },
        { name: "Oliveira Goncalves,Ruan",             area: "FLOW"             },
        { name: "Da Silva Amorim,Mariana",             area: "FLOW"             },
        { name: "Mendes Meneses,Suanny",               area: "FLOW"             },
        { name: "Silva de Oliveira,Luan",              area: "FLOW"             },
        { name: "Calvoso,Alvaro",                      area: "Transfer/IXD"     },
        { name: "de Almeida,Claudinei Andrade",        area: "Transfer/IXD"     },
        { name: "Da Silva,Vitor Souza",                area: "Transfer/IXD"     },
        { name: "Leite Santos,Gracielle",              area: "Transfer/IXD"     },
        { name: "Costa,Dener Henrique",                area: "Inbound"          },
        { name: "Caldeira,Daiana Felix",               area: "Inbound"          },
        { name: "Cleantino dos Santos,Thayná",         area: "Inbound"          },
        { name: "Nunes de Silva,Graziela",             area: "Inbound"          },
        { name: "Oliveira da Silva,Adriel",            area: "Inbound"          },
        { name: "Damacena,Nagela Ribeiro",             area: "Inbound"          },
        { name: "Lourenco,Amanda Naíara",              area: "Inbound"          },
        { name: "JAQUIM SILVA DOS SANTOS,WILTHON",     area: "Inbound"          },
        { name: "Pereira Do Amaral,Samuel",            area: "Inbound"          },
        { name: "Santos,Filipe Gomes Dos",             area: "Inbound"          },
        { name: "Pontieri,Karina",                     area: "Transfer/IXD"     },
        { name: "Camargo,Jhessica Nayara",             area: "Outbound"         },
        { name: "de Oliveira,Alexandre Cavalcante",    area: "Transfer/IXD"     },
        { name: "Manfredi,Bruno",                      area: "Outbound"         },
        { name: "Oliveira,Daiane",                     area: "Inbound"          },
        { name: "Ribeiro,Charles",                     area: "Inbound"          },
        { name: "Pinheiro de Torres,Henrique",         area: "Inbound"          },
        { name: "Dos Santos Pinto,Osmar",              area: "Inbound"          },
        { name: "Queiroz,Matheus",                     area: "Inbound"          },
        { name: "OLIVEIRA,ANA",                        area: "Inbound"          },
        { name: "AUGUSTO,RENATA",                      area: "Inbound"          },
        { name: "Anjos,Andre",                         area: "Inbound"          },
        { name: "Volpini,Filipe",                      area: "Inbound"          },
        { name: "Novais,Weder Almeida",                area: "Inbound"          },
        { name: "Almeida Da Silva,Jennifer",           area: "Inbound"          },
        { name: "Camargo,Luan Soares",                 area: "Inbound"          },
        { name: "Busato,Pablo",                        area: "Inbound"          },
        { name: "Bernardes,Jerrisson",                 area: "Inbound"          },
        { name: "Boaventura,Raphael",                  area: "Inbound"          },
        { name: "de Souza,Jonas Rodriguez",            area: "Inbound"          },
        { name: "Mendes de Oliveira,Marco Felipe",     area: "Inbound"          },
        { name: "D Silva Cesar Joaquim,Jennifer",      area: "Inbound"          },
        { name: "Sampaio,Jesiel Sampaio De",           area: "Inbound"          },
        { name: "Ferreira,Nikolina Santos",            area: "Inbound"          },
        { name: "Eloi,Pedro Henrique",                 area: "Inbound"          },
        { name: "SANTOS,CARLA",                        area: "Insumos"          },
        { name: "Okamatsu,Fernando",                   area: "Insumos"          },
        { name: "Roque,Thais",                         area: "Insumos"          },
        { name: "Costa Bandeira,Amanda Fernandes",     area: "Learning"         },
        { name: "Moura,Jessé",                         area: "Learning"         },
        { name: "Rita Oliveira de Lima,Maria",         area: "Learning"         },
        { name: "De Oliveira,Erik Matheus",            area: "Learning"         },
        { name: "Beatriz,Ana",                         area: "Learning"         },
        { name: "Mendes de Souza,Wallace",             area: "Learning"         },
        { name: "BEZERRA,BRUNA LETICIA DOS SANTOS",    area: "Learning"         },
        { name: "Stanislau,Kevin Bezerra",             area: "Learning"         },
        { name: "Santos Morais,Aline Vitoria",         area: "Learning"         },
        { name: "Segovia,Felipe",                      area: "LP"               },
        { name: "da Silva,Kezia Rodrigues",            area: "LP"               },
        { name: "AMARAL,MARILIA",                      area: "LP"               },
        { name: "dos Santos Oliveira Pinto,Daniel",    area: "Outbound"         },
        { name: "WELINGTON PEREIRA CLAUDINO,Douglas",  area: "Outbound"         },
        { name: "Neves Guatis,Alzirene Christo",       area: "Outbound"         },
        { name: "Graciano,David",                      area: "Outbound"         },
        { name: "Alves Gomes,Zequias",                 area: "Outbound"         },
        { name: "Da Paixao,Pamela M Principe",         area: "Outbound"         },
        { name: "da Silva de Oliveira,Cesar",          area: "Outbound"         },
        { name: "Fragoso,Macauly",                     area: "Outbound"         },
        { name: "Miranda,Bruna",                       area: "Outbound"         },
        { name: "Souza,Lincon",                        area: "Outbound"         },
        { name: "MENDES,RAFA",                         area: "Transfer/IXD"     },
        { name: "Santos de Almeida,Daiane da Fe",      area: "Transfer/IXD"     },
        { name: "Vieira,Luiz Carlos",                  area: "Transfer/IXD"     },
        { name: "Chages,Shiriel",                      area: "Outbound"         },
        { name: "DA SILVA,LUCAS HENRIQUE",             area: "Outbound"         },
        { name: "de Almeida,Thiago",                   area: "Outbound"         },
        { name: "Cassavara,Hudson Leandro",            area: "Outbound"         },
        { name: "Barbosa da Silva,Cleiton",            area: "Outbound"         },
        { name: "Muniz Pessoa,Higor",                  area: "Outbound"         },
        { name: "Silva,Raul",                          area: "Outbound"         },
        { name: "Barbosa da Silva,Caique",             area: "Outbound"         },
        { name: "Pereira de Melo,Larissa",             area: "Outbound"         },
        { name: "Checchia De Santana,Vitor Hugo",      area: "Outbound"         },
        { name: "De Oliveira Santana,Gesielem",        area: "Outbound"         },
        { name: "Oliveira,Bianca",                     area: "Outbound"         },
        { name: "Rodrigues,Ricardo",                   area: "Outbound"         },
        { name: "De carvalho,Kesia Moreira",           area: "Outbound"         },
        { name: "Barbosa,Maiane da Silva",             area: "Outbound"         },
        { name: "Lima,Claudomir Teixeira",             area: "Outbound"         },
        { name: "Barbosa Da Silva,Leonardo",           area: "Outbound"         },
        { name: "De Stevenson Souza Da Silva",         area: "Outbound"         },
        { name: "Soares,Felipe De Oliveira",           area: "Outbound"         },
        { name: "Rodrigues Pereira,Cristian",          area: "Outbound"         },
        { name: "Tendoro,Daniel",                      area: "PXT"              },
        { name: "Cara,Fabiana de Sousa Castanha",      area: "PXT"              },
        { name: "Rodrigues,Klaus",                     area: "PXT"              },
        { name: "Aparecido Pereira,Eduardo",           area: "RME"              },
        { name: "Massaia,Rogerio Luiz",                area: "RME"              },
        { name: "Frischenbruder,Daniele",              area: "HR"               },
        { name: "Junior,Luiz Claudio",                 area: "WHS"              },
        { name: "DA SILVA,DANIELA",                    area: "WHS"              },
        { name: "Steuerwald,Susana",                   area: "TOM"              },
        { name: "Sales de Oliveira,Ramiro Gomes",      area: "TOM"              },
        { name: "Felix,Gabriel Souza",                 area: "TOM"              },
        { name: "Alves,Anderson Rodrigo",              area: "Outbound"         },
        { name: "Conzle,Rodolfo",                      area: "Outbound"         },
        { name: "Nogueira,Jefferson",                  area: "Outbound"         },
        { name: "Belmonte,Viviane",                    area: "Learning"         },
        { name: "Henrique de Lima Justiniano,Bruno",   area: "Inbound"          },
        { name: "Conde,Thiago",                        area: "Inbound"          },
        { name: "Sousa Dos Santos,Victor Hugo",        area: "Inbound"          },
        { name: "Ohoe,Sandra",                         area: "ICQA"             },
        { name: "Santos Da Silva,Vitor Ruan",          area: "ICQA"             },
        { name: "Montina,João Pedro",                  area: "ICQA"             },
        { name: "Vieira da Silva,Alef",                area: "ICQA"             },
        { name: "Felisberto,Larissa",                  area: "ICQA"             },
        { name: "Moreira é Silva,Giuliana",            area: "ICQA"             },
        { name: "Kneissl,Stefani",                     area: "Outbound"         },
        { name: "santos,Breno",                        area: "Procurement"      },
        { name: "Costa,Diogo Dos Santos",              area: "Procurement"      },
        { name: "Henrique da Silva,Tiago",             area: "Procurement"      },
        { name: "Santana,Douglas",                     area: "Procurement"      },
        { name: "Rezende,Leonardo Augusto",            area: "ICQA"             },
        { name: "Santos Mendes,Yasmin",                area: "ICQA"             },
        { name: "De Andrade,Liliane Coelho",           area: "ICQA"             },
        { name: "Almeida,Maria Pontes De Souta",       area: "PXT"              },
        { name: "Ferreira,Marcos",                     area: "PXT"              },
        { name: "Da Silva Caetano,Everson",            area: "C-Ret"            },
        { name: "Rodrigues,Ramoa Anos Miller",         area: "Outbound"         },
        { name: "Montebelllo,Luiza Doneux",            area: "Outbound"         },
        { name: "Mendes de Oliveira Junior,Gabriel",   area: "ICQA"             },
        { name: "santos,Carol",                        area: "Procurement"      },
        { name: "prazeres,wilma",                      area: "Learning"         },
        { name: "Sabatini,Lais",                       area: "Inbound"          },
        { name: "Gammelione,Julia",                    area: "ICQA"             },
        { name: "dos santos,Bruna",                    area: "Learning"         },
        { name: "Marques da Silva,Ryan Vinicius",      area: "Outbound"         },
        { name: "Rodrigues,Rafael Elias",              area: "PXT"              },
        { name: "Castro,Patrick Castro De",            area: "TOM"              },
        { name: "De Sousa Silva,Jose Denilson",        area: "Outbound"         },
        { name: "Cunha,Wesley",                        area: "Outbound"         },
        { name: "Filho,Everson Souza Da Silva",        area: "Outbound"         },
        { name: "Moreira E Silva,Giuliana",            area: "ICQA"             },
        { name: "Ferreira,Marcelina Santos",           area: "Inbound"          },
        { name: "Conde,Rodolfo",                       area: "Outbound"         },
        { name: "MENEZES,RAFA",                        area: "Transfer/IXD"     },
    ];


    // ── Persistência do Mapa de Áreas (localStorage) ─────────────────────
    // Formato CSV interno: "Nome Parcial;Área" — ponto-e-vírgula como separador
    // (nomes de gestores usam vírgula, ex: "Silva,Mari", então ; evita conflito)
    const MAP_KEY = 'fclm_area_map';


    function loadAreaMap() {
        try {
            const saved = localStorage.getItem(MAP_KEY);
            if (saved) return JSON.parse(saved);
        } catch(e) {}
        return AREA_MAP; // fallback para o mapa hardcoded
    }


    function saveAreaMap(arr) {
        localStorage.setItem(MAP_KEY, JSON.stringify(arr));
    }


    function parseCSVMap(text) {
        return text.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(l => {
                let idx = l.indexOf(';');           // ; primeiro — BR Excel / manual / formato interno
                if (idx < 1) idx = l.lastIndexOf(','); // fallback: última , — EN Excel (áreas nunca têm ,)
                if (idx < 1) return null;
                return { name: l.slice(0, idx).trim(), area: l.slice(idx + 1).trim() };
            })
            .filter(r => r && r.name && r.area);
    }


    function mapToCSV(arr) {
        return arr.map(r => `${r.name};${r.area}`).join('\n');
    }


    function getArea(mgr) {
        if (!mgr) return 'Não Mapeado';
        const u = mgr.toUpperCase();
        for (const m of loadAreaMap()) {
            if (u.includes(m.name.toUpperCase())) return m.area;
        }
        return 'Não Mapeado';
    }


    // ── Helper: formata data+hora → ISO com timezone do browser ─────────
    // Ex: ("2026/05/22", 6) → "2026-05-22T06:00:00-0300"
    function fmtDateTime(dateStr, hour) {
        const off  = -new Date().getTimezoneOffset(); // +180 para UTC-3 → -0300
        const sign = off >= 0 ? '+' : '-';
        const tzH  = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
        const tzM  = String(Math.abs(off) % 60).padStart(2, '0');
        const tz   = `${sign}${tzH}${tzM}`;
        const d    = dateStr.replace(/\//g, '-');
        const h    = String(hour).padStart(2, '0');
        return `${d}T${h}:00:00${tz}`;
    }


    // ── Janelas operacionais (06:00→06:00) ───────────────────────────────
    // v3.6 — Semana operacional Domingo→Sábado, com regra de fechamento no domingo:
    //   • DOMINGO: fecha a semana → puxa a SEMANA INTEIRA que terminou (domingo passado
    //     → sábado), 7 dias operacionais COMPLETOS, MAIS o parcial de hoje (domingo).
    //   • SEGUNDA a SÁBADO: semana corrente → do domingo desta semana até hoje (parcial).
    //     Ex.: segunda mostra só domingo (+ segunda parcial), terça acumula, e assim por diante.
    //   Cada dia completo = d 06:00 → d+1 06:00; o dia atual é parcial (hoje 06:00 → horaAtual).
    //   A aritmética de datas (setDate) atravessa a virada de mês automaticamente
    //   (ex.: 28/jun → 02/jul = 5 janelas), em vez de cortar no dia 1º do mês.
    // v3.6.1 — Domingo passa a incluir também o parcial de hoje (domingo), além dos 7 dias completos.
    function getWindows() {
        const now         = new Date();
        const currentHour = now.getHours();


        function fmt(d) {
            return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
        }


        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dow   = today.getDay(); // 0=Dom · 1=Seg … 6=Sáb
        const isSunday = dow === 0;


        // Início da semana:
        //   • Domingo → domingo PASSADO (today-7): mostra a semana que acabou de fechar.
        //   • Demais dias → domingo DESTA semana (today-dow).
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - (isSunday ? 7 : dow));


        const windows = [];


        // Dias operacionais COMPLETOS: de weekStart até ontem (cada um: d 06:00 → d+1 06:00)
        for (let d = new Date(weekStart); d < today; d.setDate(d.getDate() + 1)) {
            const next = new Date(d);
            next.setDate(d.getDate() + 1);
            windows.push({ startDate: fmt(d), startHour: 6, endDate: fmt(next), endHour: 6 });
        }


        // Dia atual PARCIAL (hoje 06:00 → hora atual truncada).
        // Vale para todos os dias, inclusive domingo: no domingo entra o parcial de hoje
        // ALÉM dos 7 dias completos da semana que fechou.
        // Só inclui se já passou das 06:00 para evitar janela inválida (06:00→03:00).
        if (currentHour >= 6) {
            windows.push({
                startDate: fmt(today), startHour: 6,
                endDate:   fmt(today), endHour:   currentHour,
            });
        }


        return windows;
    }


    // ── Fetch de uma janela operacional (spanType=Intraday) ───────────────
    // v3.3 — Fix crítico: parâmetros corretos são startHourIntraday/endHourIntraday
    // (não startHour/endHour). FCLM ignorava as horas com os nomes errados,
    // fazendo a janela Jun4 06:00→Jun5 06:00 virar Jun4 00:00→Jun5 00:00
    // e perder todo o turno noturno (18:00→06:00) — explicava os 9h vs 42h manuais.
    async function fetchWindow(win) {
        try {
            const p = new URLSearchParams(window.location.search);
            p.set('reportFormat',          'HTML');
            p.set('spanType',              'Intraday');
            p.set('startDateIntraday',     win.startDate);
            p.set('startHourIntraday',     String(win.startHour));
            p.set('startMinuteIntraday',   '0');
            p.set('endDateIntraday',       win.endDate);
            p.set('endHourIntraday',       String(win.endHour));
            p.set('endMinuteIntraday',     '0');
            p.delete('startDateDay');
            const res = await fetch(`/reports/timeOnTask?${p}`);
            if (!res.ok) return [];
            return parseTable(new DOMParser().parseFromString(await res.text(), 'text/html'));
        } catch (e) { return []; }
    }


    function parseTable(doc) {
        const rows = doc.querySelectorAll('table tr');
        let header = null;
        const cols = {};


        for (const tr of rows) {
            const cells = tr.querySelectorAll('th,td');
            let hasId = false;
            cells.forEach((c, i) => {
                const t = c.textContent.toUpperCase();
                if (t.includes('EMPLOYEE ID'))   { cols.id = i; hasId = true; }
                if (t.includes('EMPLOYEE NAME'))   cols.name    = i;
                if (t.includes('MANAGER'))         cols.manager = i;
                if (t.includes('TIME ON TASK') && !t.includes('PERCENT')) cols.tot = i;
                if (t.includes('TOTAL TIME'))      cols.total   = i;
            });
            if (hasId && cols.tot != null) { header = tr; break; }
        }
        if (!header) return [];


        const data = [];
        let past = false;
        header.closest('table').querySelectorAll('tr').forEach(tr => {
            if (tr === header) { past = true; return; }
            if (!past) return;
            const cells = tr.querySelectorAll('td,th');
            if (cells.length < 5) return;
            const id = parseInt(cells[cols.id]?.textContent.trim(), 10);
            if (isNaN(id)) return;
            data.push({
                id,
                name:    cells[cols.name]?.textContent.trim()    || '?',
                manager: cells[cols.manager]?.textContent.trim() || '',
                tot:     parseFloat(cells[cols.tot]?.textContent.replace(',', '.'))   || 0,
                total:   parseFloat(cells[cols.total]?.textContent.replace(',', '.')) || 0,
            });
        });
        return data;
    }


    // ── Aggregação semanal ────────────────────────────────────────────────
    async function buildReport() {
        const agg  = {};
        const wh   = new URLSearchParams(window.location.search).get('warehouseId') || '';
        const wins = getWindows();


        for (const win of wins) {
            for (const row of await fetchWindow(win)) {
                if (!agg[row.id]) {
                    agg[row.id] = { ...row, area: getArea(row.manager), tot: 0, total: 0, bestWindow: win, bestWinOff: 0 };
                }
                agg[row.id].tot   += row.tot;
                agg[row.id].total += row.total;


                // Rastreia a janela com mais off-task — URL apontará para essa janela
                const winOff = row.total - row.tot;
                if (winOff > agg[row.id].bestWinOff) {
                    agg[row.id].bestWinOff = winOff;
                    agg[row.id].bestWindow = win;
                }
            }
        }


        const list = [], areaMap = {}, mgrMap = {}, mgrUrls = {};
        for (const e of Object.values(agg)) {
            e.off = e.total - e.tot;
            if (e.off < 0.01) continue;


            // URL aponta para a janela operacional com mais TOT
            // Formato confirmado: startTime/endTime ISO 8601 com timezone do browser
            const win = e.bestWindow;
            e.url = `https://fclm-portal.amazon.com/employee/timeDetails`
                  + `?employeeId=${e.id}&warehouseId=${wh}`
                  + `&startTime=${encodeURIComponent(fmtDateTime(win.startDate, win.startHour))}`
                  + `&endTime=${encodeURIComponent(fmtDateTime(win.endDate, win.endHour))}`;


            list.push(e);
            areaMap[e.area] = (areaMap[e.area] || 0) + e.off;
            const m = e.manager || 'Sem Gestor';
            mgrMap[m] = (mgrMap[m] || 0) + e.off;
            (mgrUrls[m] = mgrUrls[m] || []).push(e.url);
        }
        list.sort((a, b) => b.off - a.off);


        const areas = Object.entries(areaMap).map(([n, h]) => ({ n, h })).sort((a, b) => b.h - a.h);
        const mgrs  = Object.entries(mgrMap).map(([n, h]) => ({ n, h, urls: mgrUrls[n] || [] })).sort((a, b) => b.h - a.h);


        return {
            list, areas, mgrs, mgrUrls,
            totalOff: list.reduce((s, e) => s + e.off, 0),
            days: wins.length,
        };
    }


    // ── Link Slack por gestor ─────────────────────────────────────────────
    // ppaTimeOnTask suporta apenas 1 dia → range = ontem 06:00 → hoje 06:00
    // Sem Tampermonkey: apenas abre a página. Com Tampermonkey: checkSlackLink() abre as abas.
    function buildManagerLink(name) {
        const now   = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yest  = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);


        function fmt(d) {
            return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
        }


        const p = new URLSearchParams(window.location.search);
        p.set('reportFormat',          'HTML');
        p.set('spanType',              'Intraday');
        p.set('maxIntradayDays',       '30');
        p.set('startDateIntraday',     fmt(yest));   // ex: 2026/05/22 (ontem)
        p.set('startHourIntraday',     '6');
        p.set('startMinuteIntraday',   '0');
        p.set('endDateIntraday',       fmt(today));  // ex: 2026/05/23 (hoje)
        p.set('endHourIntraday',       '6');
        p.set('endMinuteIntraday',     '0');
        p.delete('startDateDay');
        p.set('clockManager', encodeURIComponent(name));
        return `${window.location.origin}/reports/ppaTimeOnTask?${p}`;
    }


    // ── Detecção do link do Slack (?clockManager=) ────────────────────────
    function checkSlackLink() {
        const mgr = new URLSearchParams(window.location.search).get('clockManager');
        if (!mgr) return;
        const dec = decodeURIComponent(mgr);


        const banner = document.createElement('div');
        Object.assign(banner.style, {
            position: 'fixed', top: '0', left: '0', right: '0', zIndex: '99999',
            background: C.headerGrad, color: C.white,
            padding: '14px 20px', fontFamily: "'Amazon Ember',Arial,sans-serif",
            fontWeight: 'bold', fontSize: '14px', textAlign: 'center',
            boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
            borderBottom: `3px solid ${C.accent}`,
            animation: 'totSlideDown .3s ease',
        });
        banner.innerHTML = `⏳ Buscando associados de <strong>${dec}</strong>... Aguarde.`;
        document.body.appendChild(banner);


        buildReport().then(r => {
            let urls = r.mgrUrls[dec] || [];
            if (!urls.length) {
                for (const k in r.mgrUrls) {
                    if (k.toUpperCase().includes(dec.toUpperCase()) ||
                        dec.toUpperCase().includes(k.toUpperCase())) {
                        urls = r.mgrUrls[k]; break;
                    }
                }
            }
            if (!urls.length) {
                banner.style.background = C.red;
                banner.innerHTML = `❌ Nenhum associado com TOT para <strong>${dec}</strong> nesta semana.`;
                setTimeout(() => banner.remove(), 5000);
                return;
            }
            banner.innerHTML = `✅ Abrindo ${urls.length} aba(s) de <strong>${dec}</strong>...`;
            urls.forEach((u, i) => setTimeout(() => GM_openInTab(u, { active: false }), i * 400));
            setTimeout(() => {
                banner.style.background = C.green;
                banner.innerHTML = `✅ ${urls.length} aba(s) abertas para <strong>${dec}</strong>!`;
                setTimeout(() => banner.remove(), 4000);
            }, urls.length * 400 + 500);
        }).catch(() => {
            banner.style.background = C.red;
            banner.innerHTML = '❌ Erro ao buscar dados.';
            setTimeout(() => banner.remove(), 5000);
        });
    }


    // ── Payloads Slack ────────────────────────────────────────────────────
    function buildSlackText(r) {
        const day   = new Date().getDay(); // 0=Dom · 1=Seg · 2=Ter … 6=Sáb
        const horas = `*${r.totalOff.toFixed(2)} horas*`;


        let intro;
        if (day === 1) {
            // ── Segunda-feira: semana passada + acumulado de hoje ──────────
            intro = `Prezados(as),\n\nEstamos com ${horas} acumuladas de Time Off Task da semana passada até agora, considerando a contagem por turno (06:00 às 06:00). Solicito que priorizem os ajustes o quanto antes!`;
        } else if (day === 0) {
            // ── Domingo: último dia de ajuste — alerta NOT COMPLIANCE ──────
            intro = `Prezados(as),\n\nEstamos com ${horas} acumuladas de Time Off Task esta semana, considerando a contagem por turno (06:00 às 06:00).\n\n⚠️ *ATENÇÃO:* Hoje é o último dia para realizar os ajustes! Caso não sejam efetuados, serão registrados como *NOT COMPLIANCE* em sua performance dos Mecanismos.`;
        } else {
            // ── Terça a Sábado: semana corrente ───────────────────────────
            intro = `Prezados(as),\n\nEstamos com ${horas} acumuladas de Time Off Task esta semana, considerando a contagem por turno (06:00 às 06:00). Solicito que priorizem os ajustes o quanto antes!`;
        }


        let t = intro + '\n\n';
        t += `*🚨 Time Off Task por Área:*\n`;
        r.areas.forEach((a, idx) => {
            const badge = idx === 0 ? ' 🏆 Área Ofensora' : '';
            t += `🔹 ${a.n}: *${a.h.toFixed(2)}h*${badge}\n`;
        });
        return t;
    }


    function buildSlackMgrs(r) {
        // Agrupa gestores por área a partir da lista de associados
        const byArea = {};
        r.list.forEach(e => {
            const area = e.area;
            const mgr  = e.manager || 'Sem Gestor';
            if (!byArea[area]) byArea[area] = {};
            if (!byArea[area][mgr]) byArea[area][mgr] = { hours: 0, urls: [] };
            byArea[area][mgr].hours += e.off;
            if (e.url && !byArea[area][mgr].urls.includes(e.url)) byArea[area][mgr].urls.push(e.url);
        });


        let t = '';
        // r.areas já está ordenado por horas desc — índice 0 = maior ofensora
        r.areas.forEach((area, idx) => {
            if (!byArea[area.n]) return;
            const ofensora = idx === 0 ? ' 🏆 _Área Ofensora_' : '';
            t += `\n*👥 Horas de ${area.n}:*${ofensora}\n`;
            Object.entries(byArea[area.n])
                .sort(([, a], [, b]) => b.hours - a.hours)
                .forEach(([name, data]) => {
                    t += `🔸 <${buildManagerLink(name)}|${name}>: *${data.hours.toFixed(2)}h* (${data.urls.length} ajustes)\n`;
                });
        });
        const sp = `<https://amazon-my.sharepoint.com/:x:/p/ladislke/IQD4NHEFRq3CQY0focEOFZKdARp-yfWJkqNJkvVvMaT06PM?e=eR2Ro4|GRU5 TIME OFF TASK>`;
        t += `\n💡 _Clique no nome do gestor para abrir os casos no FCLM (requer Tampermonkey)._`;
        t += `\nPara acessar o histórico de ajustes, acesse o sharepoint ${sp}`;
        return t;
    }


    function sendSlack(r) {
        let wh = localStorage.getItem('fclm_slack_webhook');
        if (!wh) {
            wh = prompt('🔗 Integração Slack:\nCole a URL do Incoming Webhook do seu canal:');
            if (!wh) return;
            localStorage.setItem('fclm_slack_webhook', wh);
        }
        GM_xmlhttpRequest({
            method: 'POST', url: wh,
            data: JSON.stringify({ text: buildSlackText(r) + '\n' + buildSlackMgrs(r) }),
            headers: { 'Content-Type': 'application/json' },
            onload: res => {
                if (res.status >= 200 && res.status < 300) {
                    alert('✅ Relatório enviado para o Slack!\n\n💡 Os nomes dos gestores são links clicáveis.');
                } else if (confirm(`❌ Erro ${res.status}. Deseja resetar o webhook?`)) {
                    localStorage.removeItem('fclm_slack_webhook');
                }
            },
            onerror: () => alert('❌ Falha de conexão ao enviar para o Slack.'),
        });
    }


    // ── Modal: Associados Não Mapeados ────────────────────────────────────
    function showUnmappedModal(unmapped) {
        document.getElementById('tot-unmapped-modal')?.remove();


        const modal = document.createElement('div');
        modal.id = 'tot-unmapped-modal';
        modal.style.cssText = `position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);font-family:'Amazon Ember',Arial,sans-serif;animation:totFade .18s ease;`;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });


        const box = document.createElement('div');
        box.style.cssText = `background:#fff;border-radius:16px;overflow:hidden;width:90%;max-width:640px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.5),0 0 0 1px rgba(232,139,0,0.18);animation:totPop .24s cubic-bezier(.18,.9,.32,1.2);`;


        // Header
        const head = document.createElement('div');
        head.style.cssText = `background:${C.headerGrad};color:${C.white};padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${C.amber};flex-shrink:0;`;
        head.innerHTML = `<div>
            <div style="font-size:15px;font-weight:700;">👁️ Associados Não Mapeados</div>
            <div style="font-size:11px;color:${C.gold};margin-top:3px;">${unmapped.length} associado(s) sem área definida no AREA_MAP</div>
        </div>`;
        const btnX = document.createElement('button');
        btnX.textContent = '✖';
        btnX.style.cssText = `background:rgba(255,255,255,0.08);color:${C.white};border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s ease;`;
        btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
        btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
        btnX.onclick = () => modal.remove();
        head.appendChild(btnX);


        // Body
        const body = document.createElement('div');
        body.style.cssText = `flex:1;overflow-y:auto;padding:18px 20px;background:${C.bodyBg};`;


        let html = `<table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ${C.border};box-shadow:0 2px 10px rgba(35,47,62,0.08);">
            <thead><tr style="background:${C.headerGrad};color:#fff;border-bottom:2px solid ${C.amber};">
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Nome</th>
                <th style="padding:11px 14px;text-align:left;font-weight:600;">Gestor</th>
                <th style="padding:11px 14px;text-align:center;font-weight:600;">Off Task</th>
            </tr></thead><tbody>`;
        unmapped.forEach((e, i) => {
            const bg = i % 2 === 0 ? '#fff' : C.light;
            html += `<tr style="background:${bg};border-bottom:1px solid ${C.border};">
                <td style="padding:9px 14px;font-weight:600;color:${C.dark};">${e.name}</td>
                <td style="padding:9px 14px;font-size:12px;color:${C.grey};">${e.manager || '—'}</td>
                <td style="padding:9px 14px;text-align:center;font-weight:700;color:${C.red};">${e.off.toFixed(2)}h</td>
            </tr>`;
        });
        html += `</tbody></table>`;
        body.innerHTML = html;


        // Footer
        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:13px 20px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;`;


        const hint = document.createElement('span');
        hint.style.cssText = `font-size:11px;color:${C.grey};`;
        hint.textContent = '💡 Adicione esses gestores no ⚙️ Mapa de Áreas para mapeá-los.';


        const btnCopy = document.createElement('button');
        btnCopy.innerHTML = '📋 Copiar Gestores';
        btnCopy.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.amber};padding:9px 20px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 2px 8px rgba(35,47,62,0.25);transition:all .15s ease;`;
        btnCopy.onmouseenter = () => { btnCopy.style.background = C.btnGradH; btnCopy.style.transform = 'translateY(-1px)'; };
        btnCopy.onmouseleave = () => { btnCopy.style.background = C.btnGrad; btnCopy.style.transform = 'none'; };
        btnCopy.onclick = () => {
            const gestores = [...new Set(unmapped.map(e => e.manager).filter(Boolean))].join('\n');
            navigator.clipboard.writeText(gestores).then(() => {
                btnCopy.innerHTML = '✅ Copiado!';
                setTimeout(() => { btnCopy.innerHTML = '📋 Copiar Gestores'; }, 2000);
            });
        };


        foot.appendChild(hint);
        foot.appendChild(btnCopy);
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);


        // v3.2 — DOM attribute: acessível pelo Selenium sem restrições de sandbox TM
        // TM sempre pode escrever no DOM; Selenium sempre pode ler atributos do DOM.
        modal.setAttribute('data-slack-payload', JSON.stringify({
            text: buildSlackText(r) + '\n' + buildSlackMgrs(r)
        }));
    }


    // ── Editor de Webhook do Slack ────────────────────────────────────────
    function showWebhookEditor() {
        document.getElementById('tot-webhook-editor')?.remove();


        const modal = document.createElement('div');
        modal.id = 'tot-webhook-editor';
        modal.style.cssText = `position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);font-family:'Amazon Ember',Arial,sans-serif;animation:totFade .18s ease;`;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });


        const box = document.createElement('div');
        box.style.cssText = `background:#fff;border-radius:16px;overflow:hidden;width:90%;max-width:520px;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.5),0 0 0 1px rgba(255,153,0,0.16);animation:totPop .24s cubic-bezier(.18,.9,.32,1.2);`;


        // Header
        const head = document.createElement('div');
        head.style.cssText = `background:${C.headerGrad};color:${C.white};padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${C.accent};flex-shrink:0;`;
        head.innerHTML = `<div>
            <div style="font-size:15px;font-weight:700;">${SLACK_SVG} Webhook do Slack</div>
            <div style="font-size:11px;color:${C.gold};margin-top:3px;">URL usada para enviar relatórios via "Enviar Via Slack"</div>
        </div>`;
        const btnX = document.createElement('button');
        btnX.textContent = '✖';
        btnX.style.cssText = `background:rgba(255,255,255,0.08);color:${C.white};border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s ease;`;
        btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
        btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
        btnX.onclick = () => modal.remove();
        head.appendChild(btnX);


        // Body
        const body = document.createElement('div');
        body.style.cssText = `padding:20px;background:${C.bodyBg};`;


        const lbl = document.createElement('label');
        lbl.style.cssText = `display:block;font-size:12px;font-weight:700;color:${C.dark};margin-bottom:6px;`;
        lbl.textContent = 'URL do Incoming Webhook:';


        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = localStorage.getItem('fclm_slack_webhook') || '';
        inp.placeholder = 'https://hooks.slack.com/services/...';
        inp.style.cssText = `width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #D5DBE0;border-radius:8px;font-size:12px;font-family:'SFMono-Regular',Consolas,monospace;color:${C.dark};background:#fff;outline:none;transition:all .15s ease;`;
        inp.addEventListener('focus', () => { inp.style.borderColor = C.accent; inp.style.boxShadow = '0 0 0 3px rgba(255,153,0,.18)'; });
        inp.addEventListener('blur',  () => { inp.style.borderColor = '#D5DBE0'; inp.style.boxShadow = 'none'; });


        const status = document.createElement('div');
        status.style.cssText = `font-size:11px;margin-top:8px;`;
        const hasWh = !!localStorage.getItem('fclm_slack_webhook');
        status.style.color = hasWh ? C.green : C.amber;
        status.textContent  = hasWh ? '✅ Webhook configurado' : '⚠️ Nenhum webhook configurado';


        body.appendChild(lbl);
        body.appendChild(inp);
        body.appendChild(status);


        // Footer
        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:12px 20px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;`;


        const btnReset = document.createElement('button');
        btnReset.innerHTML = '🗑️ Resetar';
        btnReset.style.cssText = `background:rgba(204,0,0,0.06);color:${C.red};border:1px solid ${C.red};padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;transition:all .15s ease;`;
        btnReset.onmouseenter = () => { btnReset.style.background = 'rgba(204,0,0,0.14)'; btnReset.style.transform = 'translateY(-1px)'; };
        btnReset.onmouseleave = () => { btnReset.style.background = 'rgba(204,0,0,0.06)'; btnReset.style.transform = 'none'; };
        btnReset.onclick = () => {
            localStorage.removeItem('fclm_slack_webhook');
            inp.value = '';
            status.style.color = C.amber;
            status.textContent = '⚠️ Webhook removido — será solicitado na próxima vez';
        };


        const btnSave = document.createElement('button');
        btnSave.innerHTML = '💾 Salvar';
        btnSave.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};padding:9px 24px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 2px 8px rgba(35,47,62,0.25);transition:all .15s ease;`;
        btnSave.onmouseenter = () => { btnSave.style.background = C.btnGradH; btnSave.style.transform = 'translateY(-1px)'; };
        btnSave.onmouseleave = () => { btnSave.style.background = C.btnGrad; btnSave.style.transform = 'none'; };
        btnSave.onclick = () => {
            const url = inp.value.trim();
            if (!url) { alert('❌ Digite uma URL válida.'); return; }
            if (!url.startsWith('https://hooks.slack.com/') &&
                !confirm('⚠️ URL não parece um webhook Slack padrão.\nSalvar assim mesmo?')) return;
            localStorage.setItem('fclm_slack_webhook', url);
            status.style.color = C.green;
            status.textContent = '✅ Webhook salvo com sucesso!';
            setTimeout(() => modal.remove(), 1000);
        };


        foot.appendChild(btnReset);
        foot.appendChild(btnSave);
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }


    // ── Editor de Mapa de Áreas ───────────────────────────────────────────
    function showMapEditor() {
        document.getElementById('tot-map-editor')?.remove();


        const modal = document.createElement('div');
        modal.id = 'tot-map-editor';
        modal.style.cssText = `
            position:fixed;inset:0;z-index:10002;
            display:flex;align-items:center;justify-content:center;
            background:rgba(13,19,26,0.62);
            backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
            font-family:'Amazon Ember',Arial,sans-serif;
            animation:totFade .18s ease;
        `;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });


        const box = document.createElement('div');
        box.style.cssText = `
            background:#fff;border-radius:16px;overflow:hidden;
            width:90%;max-width:580px;
            display:flex;flex-direction:column;
            box-shadow:0 24px 70px rgba(0,0,0,0.5),0 0 0 1px rgba(255,153,0,0.16);
            animation:totPop .24s cubic-bezier(.18,.9,.32,1.2);
        `;


        // Header
        const head = document.createElement('div');
        head.style.cssText = `
            background:${C.headerGrad};color:${C.white};padding:16px 20px;
            display:flex;justify-content:space-between;align-items:center;
            border-bottom:3px solid ${C.accent};flex-shrink:0;
        `;
        head.innerHTML = `
            <div>
                <div style="font-size:15px;font-weight:700;">⚙️ Editor de Mapa de Áreas</div>
                <div style="font-size:11px;color:${C.gold};margin-top:3px;">
                    col. A = Nome Parcial · col. B = Área — aceita <strong>.xlsx</strong> ou <strong>.csv</strong>
                </div>
            </div>`;
        const btnX = document.createElement('button');
        btnX.textContent = '✖';
        btnX.style.cssText = `background:rgba(255,255,255,0.08);color:${C.white};border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s ease;`;
        btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
        btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
        btnX.onclick = () => modal.remove();
        head.appendChild(btnX);


        // Body
        const body = document.createElement('div');
        body.style.cssText = `padding:18px 20px;background:${C.bodyBg};`;


        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.style.cssText = `display:flex;gap:8px;margin-bottom:10px;align-items:center;`;


        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.csv,.xlsx';
        fileInput.style.cssText = `display:none;`;


        const btnImport = document.createElement('button');
        btnImport.innerHTML = '📂 Importar Excel';
        btnImport.style.cssText = `background:${C.blue};color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;transition:all .15s ease;`;
        btnImport.onmouseenter = () => { btnImport.style.background = '#3A76B8'; btnImport.style.transform = 'translateY(-1px)'; };
        btnImport.onmouseleave = () => { btnImport.style.background = C.blue; btnImport.style.transform = 'none'; };
        btnImport.onclick = () => fileInput.click();


        const btnReset = document.createElement('button');
        btnReset.innerHTML = '🔄 Resetar Padrão';
        btnReset.style.cssText = `background:${C.grey};color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;transition:all .15s ease;`;
        btnReset.onmouseenter = () => { btnReset.style.background = '#4A6572'; btnReset.style.transform = 'translateY(-1px)'; };
        btnReset.onmouseleave = () => { btnReset.style.background = C.grey; btnReset.style.transform = 'none'; };
        btnReset.onclick = () => {
            ta.value = mapToCSV(AREA_MAP);
            info.textContent = `${AREA_MAP.length} entradas (padrão)`;
        };


        const btnExport = document.createElement('button');
        btnExport.innerHTML = '📥 Exportar XLSX';
        btnExport.style.cssText = `background:${C.green};color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;transition:all .15s ease;`;
        btnExport.onmouseenter = () => { btnExport.style.background = '#1e8449'; btnExport.style.transform = 'translateY(-1px)'; };
        btnExport.onmouseleave = () => { btnExport.style.background = C.green; btnExport.style.transform = 'none'; };
        btnExport.onclick = () => {
            const data   = loadAreaMap();
            const wsData = [['Nome', 'Área'], ...data.map(r => [r.name, r.area])];
            const ws     = XLSX.utils.aoa_to_sheet(wsData);
            ws['!cols']  = [{ wch: 42 }, { wch: 22 }];
            const wb     = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Mapa de Áreas');
            XLSX.writeFile(wb, 'area_map.xlsx');
        };


        const info = document.createElement('span');
        info.style.cssText = `font-size:11px;color:${C.grey};margin-left:auto;`;
        const current = loadAreaMap();
        const isCustom = !!localStorage.getItem(MAP_KEY);
        info.textContent = `${current.length} entradas${isCustom ? ' (personalizado)' : ' (padrão)'}`;


        toolbar.appendChild(fileInput);
        toolbar.appendChild(btnImport);
        toolbar.appendChild(btnReset);
        toolbar.appendChild(btnExport);
        toolbar.appendChild(info);


        // Textarea
        const ta = document.createElement('textarea');
        ta.style.cssText = `
            width:100%;box-sizing:border-box;height:320px;
            font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;line-height:1.5;
            border:1px solid #D5DBE0;border-radius:10px;
            padding:12px;resize:vertical;
            background:#fff;color:${C.dark};outline:none;transition:all .15s ease;
        `;
        ta.spellcheck = false;
        ta.placeholder = '# Exemplo:\nSilva,Mari;Inbound\nPinheiro,C;QAPS\nYoshida,Ka;Site leader GRU8';
        ta.value = mapToCSV(current);
        ta.addEventListener('focus', () => { ta.style.borderColor = C.accent; ta.style.boxShadow = '0 0 0 3px rgba(255,153,0,.18)'; });
        ta.addEventListener('blur',  () => { ta.style.borderColor = '#D5DBE0'; ta.style.boxShadow = 'none'; });


        // Lê arquivo CSV ou XLSX
        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
            if (isXlsx) {
                // XLSX — SheetJS: col. A = nome, col. B = área
                const reader = new FileReader();
                reader.onload = e => {
                    const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
                    const ws  = wb.Sheets[wb.SheetNames[0]];
                    const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });
                    const csvText = raw
                        .filter(row => row.length >= 2 && String(row[0]).trim())
                        .map(row => `${String(row[0]).trim()};${String(row[1] || '').trim()}`)
                        .join('\n');
                    ta.value = csvText;
                    info.textContent = `${parseCSVMap(csvText).length} entradas lidas do arquivo`;
                };
                reader.readAsArrayBuffer(file);
            } else {
                // CSV — texto direto (EN: vírgula, BR: ponto-e-vírgula)
                const reader = new FileReader();
                reader.onload = e => {
                    ta.value = e.target.result;
                    info.textContent = `${parseCSVMap(e.target.result).length} entradas lidas do arquivo`;
                };
                reader.readAsText(file, 'UTF-8');
            }
            fileInput.value = '';
        });


        body.appendChild(toolbar);
        body.appendChild(ta);


        // Footer
        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:12px 20px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;`;


        const hint = document.createElement('span');
        hint.style.cssText = `font-size:11px;color:${C.grey};`;
        hint.textContent = '💡 Excel: salvar como .xlsx · col. A = Nome Parcial · col. B = Área';


        const btnSave = document.createElement('button');
        btnSave.innerHTML = '💾 Salvar';
        btnSave.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};padding:9px 24px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 2px 8px rgba(35,47,62,0.25);transition:all .15s ease;`;
        btnSave.onmouseenter = () => { btnSave.style.background = C.btnGradH; btnSave.style.transform = 'translateY(-1px)'; };
        btnSave.onmouseleave = () => { btnSave.style.background = C.btnGrad; btnSave.style.transform = 'none'; };
        btnSave.onclick = () => {
            const parsed = parseCSVMap(ta.value);
            if (!parsed.length) {
                alert('❌ Nenhuma entrada válida encontrada.\nVerifique o formato: Nome;Área');
                return;
            }
            saveAreaMap(parsed);
            alert(`✅ Mapa salvo! ${parsed.length} entradas ativas.`);
            modal.remove();
        };


        foot.appendChild(hint);
        foot.appendChild(btnSave);


        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }


    // ── Dashboard modal ───────────────────────────────────────────────────
    function showDashboard(r) {
        document.getElementById('tot-dash')?.remove();


        const modal = document.createElement('div');
        modal.id = 'tot-dash';
        modal.style.cssText = `
            position:fixed;inset:0;z-index:10001;
            display:flex;align-items:center;justify-content:center;
            background:rgba(13,19,26,0.62);
            backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
            font-family:'Amazon Ember',Arial,sans-serif;
            animation:totFade .18s ease;
        `;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });


        const box = document.createElement('div');
        box.style.cssText = `
            background:#fff;border-radius:16px;overflow:hidden;
            width:94%;max-width:1020px;max-height:90vh;
            display:flex;flex-direction:column;
            box-shadow:0 24px 70px rgba(0,0,0,0.5),0 0 0 1px rgba(255,153,0,0.16);
            animation:totPop .24s cubic-bezier(.18,.9,.32,1.2);
        `;


        // ── Header ──
        const head = document.createElement('div');
        head.style.cssText = `
            background:${C.headerGrad};color:${C.white};
            padding:18px 24px;
            display:flex;justify-content:space-between;align-items:center;
            border-bottom:3px solid ${C.accent};
            flex-shrink:0;
        `;
        head.innerHTML = `
            <div>
                <div style="font-size:17px;font-weight:700;letter-spacing:.01em;">📊 Dashboard Semanal — Time Off Task</div>
                <div style="font-size:11px;color:${C.gold};margin-top:4px;">
                    ${r.days} janela(s) operacional(is) · ${r.list.length} associado(s) com off-task
                </div>
            </div>`;
        const btnX = document.createElement('button');
        btnX.textContent = '✖';
        btnX.style.cssText = `
            background:rgba(255,255,255,0.08);color:${C.white};
            border:none;border-radius:8px;
            width:32px;height:32px;cursor:pointer;font-size:14px;
            display:flex;align-items:center;justify-content:center;
            transition:all 0.15s ease;
        `;
        btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
        btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
        btnX.onclick = () => modal.remove();
        head.appendChild(btnX);


        // ── Body ──
        const body = document.createElement('div');
        body.style.cssText = `flex:1;overflow-y:auto;padding:22px;background:${C.bodyBg};`;


        // Cards
        let html = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px;">`;
        [
            { label: 'Total Off Task',         val: `${r.totalOff.toFixed(2)}h`, bg: `linear-gradient(135deg,#E74C3C,#991010)` },
            { label: 'Associados',             val: r.list.length,               bg: `linear-gradient(135deg,#37475A,#1a2530)` },
            { label: 'Janelas Operacionais',   val: r.days,                      bg: `linear-gradient(135deg,#2ECC71,#1e8449)` },
        ].forEach(c => {
            html += `<div style="background:${c.bg};color:#fff;padding:18px 20px;border-radius:12px;text-align:center;box-shadow:0 4px 14px rgba(35,47,62,0.18);">
                <div style="font-size:10px;text-transform:uppercase;opacity:0.85;letter-spacing:.08em;">${c.label}</div>
                <div style="font-size:34px;font-weight:800;margin-top:6px;text-shadow:0 1px 2px rgba(0,0,0,.2);">${c.val}</div>
            </div>`;
        });
        html += `</div>`;


        // Áreas
        if (r.areas.length) {
            html += `<div style="background:#fff;border-radius:12px;border:1px solid ${C.border};padding:16px;margin-bottom:18px;box-shadow:0 2px 10px rgba(35,47,62,0.06);">
                <div style="font-size:11px;font-weight:700;color:${C.grey};text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">⏳ Impacto por Área</div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">`;
            r.areas.forEach((a, idx) => {
                const isTop = idx === 0;
                const border = isTop ? C.accent : C.blue;
                const badge  = isTop
                    ? `<span style="background:${C.accent};color:#000;font-size:9px;font-weight:800;padding:1px 7px;border-radius:20px;margin-left:7px;vertical-align:middle;">🏆 Ofensora</span>`
                    : '';
                html += `<div style="background:${C.light};border-left:4px solid ${border};border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;color:${C.dark};box-shadow:0 1px 3px rgba(35,47,62,0.06);">
                    ${a.n}: <span style="color:${C.red};">${a.h.toFixed(2)}h</span>${badge}
                </div>`;
            });
            html += `</div></div>`;
        }


        // Gestores
        html += `<div style="background:#fff;border-radius:12px;border:1px solid ${C.border};overflow:hidden;margin-bottom:18px;box-shadow:0 2px 10px rgba(35,47,62,0.06);">
            <div style="background:${C.headerGrad};color:#fff;padding:11px 16px;font-size:11px;font-weight:700;
                        text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid ${C.accent};">
                👥 Gestores
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead><tr style="background:${C.light};border-bottom:1px solid ${C.border};">
                    <th style="padding:10px 16px;text-align:left;font-weight:600;color:${C.dark};">Gestor</th>
                    <th style="padding:10px 16px;text-align:center;font-weight:600;color:${C.dark};">Off Task</th>
                    <th style="padding:10px 16px;text-align:center;font-weight:600;color:${C.dark};">Ajustes</th>
                    <th style="padding:10px 16px;text-align:center;font-weight:600;color:${C.dark};">Ação</th>
                </tr></thead><tbody>`;
        r.mgrs.forEach((m, i) => {
            const bg = i % 2 === 0 ? '#fff' : C.light;
            html += `<tr style="background:${bg};border-bottom:1px solid ${C.border};">
                <td style="padding:9px 16px;font-weight:600;color:${C.dark};">${m.n}</td>
                <td style="padding:9px 16px;text-align:center;font-weight:700;color:${C.red};">${m.h.toFixed(2)}h</td>
                <td style="padding:9px 16px;text-align:center;color:${C.grey};">${m.urls.length}</td>
                <td style="padding:9px 16px;text-align:center;">`;
            if (m.urls.length) {
                html += `<button class="tot-mgr-btn" data-idx="${i}"
                    style="background:${C.btnGrad};color:#fff;border:1px solid ${C.accent};
                           padding:5px 13px;border-radius:7px;cursor:pointer;
                           font-size:12px;font-weight:700;transition:all .15s ease;">
                    📂 ${m.urls.length} aba(s)
                </button>`;
            } else {
                html += `<span style="color:#bbb;font-size:11px;">—</span>`;
            }
            html += `</td></tr>`;
        });
        html += `</tbody></table></div>`;


        // Associados
        html += `<div style="background:#fff;border-radius:12px;border:1px solid ${C.border};overflow:hidden;box-shadow:0 2px 10px rgba(35,47,62,0.06);">
            <div style="background:${C.headerGrad};color:#fff;padding:11px 16px;font-size:11px;font-weight:700;
                        text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid ${C.accent};">
                📋 Associados
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead><tr style="background:${C.light};border-bottom:1px solid ${C.border};">
                    <th style="padding:9px 12px;text-align:left;font-weight:600;color:${C.dark};">Nome</th>
                    <th style="padding:9px 12px;text-align:left;font-weight:600;color:${C.dark};">Área</th>
                    <th style="padding:9px 12px;text-align:left;font-weight:600;color:${C.dark};">Gestor</th>
                    <th style="padding:9px 12px;text-align:center;font-weight:600;color:${C.dark};">Off Task</th>
                </tr></thead><tbody>`;
        r.list.forEach((e, i) => {
            const bg  = i % 2 === 0 ? '#fff' : C.light;
            const col = e.off > 5 ? C.red : e.off > 2 ? C.amber : C.grey;
            html += `<tr style="background:${bg};border-bottom:1px solid ${C.border};">
                <td style="padding:8px 12px;font-weight:600;color:${C.dark};">${e.name}</td>
                <td style="padding:8px 12px;">
                    <span style="background:${e.area === 'Não Mapeado' ? C.grey : C.blue};color:#fff;padding:3px 10px;
                                 border-radius:20px;font-size:10px;font-weight:700;">
                        ${e.area}
                    </span>
                </td>
                <td style="padding:8px 12px;font-size:11px;color:${C.grey};">${e.manager}</td>
                <td style="padding:8px 12px;text-align:center;font-weight:700;color:${col};">${e.off.toFixed(2)}h</td>
            </tr>`;
        });
        html += `</tbody></table></div>`;


        body.innerHTML = html;


        // Event delegation — botões "Abrir abas" por gestor
        body.addEventListener('click', ev => {
            const btn = ev.target.closest('.tot-mgr-btn');
            if (!btn) return;
            const m = r.mgrs[+btn.dataset.idx];
            if (!m?.urls?.length) return;
            m.urls.forEach((u, i) => setTimeout(() => GM_openInTab(u, { active: false }), i * 400));
        });
        body.addEventListener('mouseenter', ev => {
            if (ev.target.classList.contains('tot-mgr-btn')) { ev.target.style.background = C.btnGradH; ev.target.style.transform = 'translateY(-1px)'; }
        }, true);
        body.addEventListener('mouseleave', ev => {
            if (ev.target.classList.contains('tot-mgr-btn')) { ev.target.style.background = C.btnGrad; ev.target.style.transform = 'none'; }
        }, true);


        // ── Footer ──
        const foot = document.createElement('div');
        foot.style.cssText = `
            background:#fff;border-top:1px solid ${C.border};
            padding:14px 20px;display:flex;justify-content:space-between;
            align-items:center;gap:10px;flex-shrink:0;
        `;


        const btnMap = document.createElement('button');
        btnMap.innerHTML = '⚙️ Mapa de Áreas';
        btnMap.style.cssText = `background:#fff;color:${C.dark};border:1px solid #CDD4DA;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;font-family:'Amazon Ember',Arial,sans-serif;transition:all .15s ease;`;
        btnMap.onmouseenter = () => { btnMap.style.background = C.light; btnMap.style.borderColor = C.dark; btnMap.style.transform = 'translateY(-1px)'; };
        btnMap.onmouseleave = () => { btnMap.style.background = '#fff'; btnMap.style.borderColor = '#CDD4DA'; btnMap.style.transform = 'none'; };
        btnMap.onclick = () => showMapEditor();


        const btnWebhook = document.createElement('button');
        btnWebhook.innerHTML = '🔗 Webhook';
        btnWebhook.style.cssText = `background:#fff;color:${C.dark};border:1px solid #CDD4DA;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;font-family:'Amazon Ember',Arial,sans-serif;transition:all .15s ease;`;
        btnWebhook.onmouseenter = () => { btnWebhook.style.background = C.light; btnWebhook.style.borderColor = C.dark; btnWebhook.style.transform = 'translateY(-1px)'; };
        btnWebhook.onmouseleave = () => { btnWebhook.style.background = '#fff'; btnWebhook.style.borderColor = '#CDD4DA'; btnWebhook.style.transform = 'none'; };
        btnWebhook.onclick = () => showWebhookEditor();


        const leftGroup = document.createElement('div');
        leftGroup.style.cssText = `display:flex;gap:8px;`;
        leftGroup.appendChild(btnMap);
        leftGroup.appendChild(btnWebhook);


        // Botão "Não Mapeados" — visível apenas se houver associados sem área
        const unmapped = r.list.filter(e => e.area === 'Não Mapeado');
        if (unmapped.length > 0) {
            const btnUnmapped = document.createElement('button');
            btnUnmapped.innerHTML = `👁️ Não Mapeados (${unmapped.length})`;
            btnUnmapped.style.cssText = `background:rgba(232,139,0,0.08);color:${C.amber};border:1px solid ${C.amber};padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;font-family:'Amazon Ember',Arial,sans-serif;transition:all .15s ease;`;
            btnUnmapped.onmouseenter = () => { btnUnmapped.style.background = 'rgba(232,139,0,0.18)'; btnUnmapped.style.transform = 'translateY(-1px)'; };
            btnUnmapped.onmouseleave = () => { btnUnmapped.style.background = 'rgba(232,139,0,0.08)'; btnUnmapped.style.transform = 'none'; };
            btnUnmapped.onclick = () => showUnmappedModal(unmapped);
            leftGroup.appendChild(btnUnmapped);
        }


        foot.appendChild(leftGroup);


        const btnSlack = document.createElement('button');
        btnSlack.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 122.8 122.8" width="15" height="15" style="vertical-align:middle;margin-right:7px;"><path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E"/></svg>Enviar Via Slack`;
        btnSlack.style.cssText = `
            background:linear-gradient(145deg,#611f63,#4A154B);color:#fff;border:none;
            padding:10px 22px;border-radius:8px;cursor:pointer;
            font-weight:700;font-size:13px;
            font-family:'Amazon Ember',Arial,sans-serif;
            box-shadow:0 3px 10px rgba(74,21,75,0.35);
            transition:all .15s ease;
        `;
        btnSlack.onmouseenter = () => { btnSlack.style.background = 'linear-gradient(145deg,#722775,#3a1040)'; btnSlack.style.transform = 'translateY(-1px)'; btnSlack.style.boxShadow = '0 5px 16px rgba(74,21,75,0.45)'; };
        btnSlack.onmouseleave = () => { btnSlack.style.background = 'linear-gradient(145deg,#611f63,#4A154B)'; btnSlack.style.transform = 'none'; btnSlack.style.boxShadow = '0 3px 10px rgba(74,21,75,0.35)'; };
        btnSlack.onclick = () => sendSlack(r);
        foot.appendChild(btnSlack);


        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }


    // ── Botão flutuante — acima do overlay Off-Task (bottom: 95px) ────────
    function injectButton() {
        // Botão só no PPR Time On Task — não aparece no ppaTimeOnTask
        if (window.location.pathname.includes('ppaTimeOnTask')) return;
        if (document.getElementById('tot-dash-btn')) return;


        const btn = document.createElement('button');
        btn.id = 'tot-dash-btn';
        btn.innerHTML = SLACK_SVG + 'Gerar TOT via Slack';
        btn.style.cssText = `
            position:fixed;bottom:95px;right:20px;z-index:9998;
            background:${C.btnGrad};color:${C.white};
            border:2px solid ${C.accent};border-radius:12px;
            padding:11px 20px;font-size:12px;font-weight:700;
            cursor:pointer;font-family:'Amazon Ember',Arial,sans-serif;
            box-shadow:0 4px 16px rgba(0,0,0,0.35);
            transition:all 0.2s ease;
            white-space:nowrap;
        `;
        btn.onmouseenter = () => {
            btn.style.background = C.btnGradH;
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 8px 22px rgba(0,0,0,0.45)';
            btn.style.borderColor = C.gold;
        };
        btn.onmouseleave = () => {
            btn.style.background = C.btnGrad;
            btn.style.transform = 'none';
            btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
            btn.style.borderColor = C.accent;
        };
        btn.onclick = async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.innerHTML = '⏳ Carregando...';
            btn.style.opacity = '0.7';
            try {
                showDashboard(await buildReport());
            } finally {
                btn.disabled = false;
                btn.innerHTML = SLACK_SVG + 'Gerar TOT via Slack';
                btn.style.opacity = '1';
            }
        };
        document.body.appendChild(btn);
    }


    // ── Init ─────────────────────────────────────────────────────────────
    function init() {
        injectUICss();
        checkSlackLink();
        setTimeout(injectButton, 1500);
    }


    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }


    // Reinjecta o botão se o DOM mudar (ex: FCLM re-renderiza a página)
    new MutationObserver(injectButton).observe(document.body, { childList: true });


})();

