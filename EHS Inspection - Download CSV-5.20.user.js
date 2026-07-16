// ==UserScript==
// @name         EHS Inspection - Download CSV
// @namespace    http://tampermonkey.net/
// @version      5.20
// @description  Exporta inspeções (painel único navy/laranja) + Dashboard com filtros (data/status/meta), matriz Owner × dia (Dom-Sáb) com desconsiderações sinalizadas, filtro Todos/Não bateram/Bateram, meta geral (% da meta), meta individual FIXA de 2 FSI por semana, Area Org com janela QUINZENAL (2 semanas somadas) e meta de 1 por quinzena, cobrança via Slack (webhook, por turno, logins linkados ao FCLM) e Email report em HTML (copia formatado + abre email novo já endereçado). Webhook do Slack e email de destino editáveis na config (⚙️). Botão único de extração CSV a partir da data filtrada. Coleta em cache: mapeia 1x por carregamento, reabre sem remapear.
// @author       ladislke
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='12' fill='%232e7d32'/%3E%3Cellipse cx='50' cy='72' rx='38' ry='9' fill='%231b5e20'/%3E%3Cpath d='M14 72 Q12 42 50 32 Q88 42 86 72Z' fill='%23a5d6a7'/%3E%3Crect x='44' y='16' width='12' height='20' rx='3' fill='%23a5d6a7'/%3E%3Cellipse cx='50' cy='72' rx='38' ry='9' fill='%23388e3c' opacity='0.6'/%3E%3C/svg%3E
// @match        https://na.ehs-amazon.com/compliance-execution/inspection/list*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @grant        GM_xmlhttpRequest
// @connect      hooks.slack.com
// @run-at       document-idle
// ==/UserScript==
// v5.20 — Seletor de semana/quinzena passa a CRIAR todas as semanas da data filtrada até a
//         semana atual (mesmo as sem registros ainda), via buildWeekList. Default cai na semana
//         mais recente COM dados. Assim aparecem todas as weeks/quinzenas a partir do corte.
// v5.19 — Dashboard: coleta passa a trazer TUDO a partir da data filtrada (removido o teto
//         de 2 semanas), então o seletor mostra todas as semanas/quinzenas do corte em diante
//         (ex.: W28, W29, quinzena W29–W30). No Area Organization, clicar no TOTAL desconsidera/
//         reconsidera por Atestado (zera a meta da quinzena), salvando na config do gestor.
// v5.18 — Config "Gestores & Turnos" (⚙️) ganhou filtros no topo: por gestor (busca) e por
//         turno (dropdown), para achar rápido quem desconsiderar. Só oculta linhas; o índice
//         original é preservado (edição/remoção/desconsideração continuam corretos).
// v5.17 — Extração aplica o filtro de TEXTO por categoria sozinha e pagina para cada termo:
//         FSI+DOCK digita "floor" (pagina) e depois "dock" (pagina); Area Org digita
//         "area organization". Assim não depende da lista estar pré-filtrada.
// v5.16 — Modal de extração agora tem 2 botões (por data filtrada): "Extrair FSI+DOCK" e
//         "Extrair Area Org". Baixa XLSX com ABAS: FSI+DOCK 1 aba por SEMANA (Dom→Sáb);
//         Area Org 1 aba por QUINZENA (semana ímpar+par, com coluna "Semana"). Filtra pela
//         categoria do botão a partir da data filtrada.
// v5.15 — Matriz do Area Organization deixa de ser dia-a-dia e passa a mostrar 2 colunas:
//         semana ÍMPAR e semana PAR do par quinzenal (com contagem de cada uma), além de
//         Total e ✔ (meta). FSI+DOCK continua dia-a-dia (Dom→Sáb).
// v5.14 — Dashboard: clicar numa célula de DIA (aba FSI+DOCK) desconsidera/reconsidera aquele
//         dia da semana do gestor; clicar no TOTAL desconsidera/reconsidera a semana toda.
//         A ação é salva na desconsideração do gestor (mesmo dado do ⚙️ Gestores & Turnos).
// v5.13 — Config "Gestores & Turnos" (⚙️) ganhou botão "Exportar (Login e Turno)": baixa a
//         lista atual em XLSX (fallback CSV), reimportável pelo próprio "Importar CSV/XLSX".
// v5.12 — Painel começa como um BOTÃO CIRCULAR (FAB) no canto inferior esquerdo. Ao clicar,
//         o círculo "explode" no overlay com animação (scale a partir do canto). Botão "–"
//         minimiza de volta ao círculo.
// v5.11 — Meta conta como REALIZADA tanto Completed quanto Submitted (submetida = feita).
//         Contador ✔ e compliance usam isDoneStatus; rótulos "Concluídas" → "Realizadas".
// v5.10 — Datas: o filtro "Date on or after" da página CONTINUA no padrão americano
//         (mm/dd/aaaa), tanto na escrita quanto na leitura. Já os CARDS coletados são
//         interpretados como PT-BR (dd/mm/aaaa) via detecção de locale (idioma, labels e
//         heurística: 1º número > 12 = dd/mm). A extração usa a data escolhida no modal
//         como corte (não ambígua). Corrige contagem por dia/semana quando o EHS está em PT.
//         Datas relativas (Ontem/Hoje/Amanhã e Yesterday/Today/Tomorrow) viram ISO aaaa-mm-dd
//         internamente (não-ambíguo) e o parser entende ISO + palavras relativas — assim esses
//         cards passam a ser contados corretamente.
//         Também move o botão "Extrair CSV" para o modal "Confirmar filtros antes de coletar".
// v5.9 — Suporte bilíngue (EN/PT) aos status de ciclo de vida: contagem de "Concluídas"
//        casa Completed/Concluído; filtro Lifecycle tenta Completed/Concluído e
//        Submitted/Enviado; datas relativas entendem ontem/hoje/amanhã além de
//        yesterday/today/tomorrow.
// v5.8 — Painel flutuante mostra a WEEK ATUAL (Dom→Sáb) no topo e um botão "?" com a
//        recomendação de qual week filtrar: semana ímpar → só a atual; par → anterior +
//        atual; retroativo → 2 semanas subsequentes (quinzena). Inclui a data "a partir de".
// v5.7 — Config (⚙️) agora tem seção "Integrações": campos editáveis do Webhook do Slack e
//        do Email de destino — mude/limpe sem tocar no código (campo vazio = remove o valor).
// v5.6 — Email report abre já ENDEREÇADO: destinatário(s) configurável(is) (pergunta 1x e
//        memoriza em ehs_email_to; vários separados por vírgula) e vão no mailto:.
// v5.5 — "Enviar email report" implementado: monta o mesmo conteúdo da cobrança em HTML
//        (tabela por turno + logins linkados ao FCLM), COPIA o corpo formatado pro clipboard
//        e abre um email novo (mailto) — é só colar (Ctrl+V) no corpo. Não envia automático.
//        Fallback: se a cópia falhar, abre uma janela com o HTML pra copiar manualmente.
// v5.4 — No Slack, cada login vira um LINK clicável (formato <url|@login>) que abre o FCLM
//        Time Details do funcionário: .../employee/timeDetails?...&employeeId=<login>&warehouseId=GRU5.
//        Warehouse configurável em FCLM_WAREHOUSE. Substitui o "@login" em texto puro.
// v5.3 — Cobrança do Slack agrupada por TURNO (Red Day/Night, Blue Day/Night, ADM, MID e
//        "Sem turno"), cada turno com seu subtítulo e contagem. Mantém o "@" nos logins.
// v5.2 — Na cobrança do Slack, cada login vai prefixado com "@" (ex.: @jdoe) para o Slack
//        reconhecer como menção/login.
// v5.1 — Painel simplificado: um ÚNICO botão "Extrair CSV (a partir da data)" no lugar dos
//        dois antigos (WEEK/DAY). Ele pagina a lista atual e exporta só os registros com
//        Scheduled start date >= à data filtrada na página (collectFromFilteredDate). Sem
//        data filtrada, exporta tudo. (collectAll/collectYesterday ficaram sem uso.)
// v5.0 — Base = v4.7 estável (as v4.8/v4.9 de coleta por evento foram descartadas por bug).


(function () {
    'use strict';


    // ─────────────────────────────────────────────────────────────────
    // CONFIGURAÇÕES
    // ─────────────────────────────────────────────────────────────────
    const CONFIG = {
        // XPath do botão ">" de próxima página (SVG path)
        NEXT_BTN_XPATH: '/html/body/div[1]/div/div/div/div/main/div[2]/div/div[2]/div/div/div[3]/div/div[2]/div/div[3]/button[2]',
        PAGE_LOAD_WAIT: 2000,   // ms aguardar após clicar "próxima página"
        SEARCH_WAIT:    2800,   // ms aguardar após aplicar filtro de pesquisa (lista recarregar)
        MAX_PAGES:      200,    // limite de segurança contra loop infinito
        BTN_ID:         'ehs-csv-download-btn',
    };


    // ─────────────────────────────────────────────────────────────────
    // ESTADO GLOBAL
    // ─────────────────────────────────────────────────────────────────
    let selectedType = '';   // 'floor' | 'area_org' | '' (fallback: 'inspections')


    // ─────────────────────────────────────────────────────────────────
    // UTILITÁRIOS
    // ─────────────────────────────────────────────────────────────────
    const sleep = ms => new Promise(r => setTimeout(r, ms));


    function getNodeByXPath(xpath) {
        return document.evaluate(
            xpath, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
    }


    function setButtonState(btn, state, count) {
        const idleText = btn._idleText || 'Extrair csv';
        const map = {
            idle:    { text: idleText,                              disabled: false, bg: '#3a4654' },
            loading: { text: `⏳ Coletando... (pág ${count})`,      disabled: true,  bg: '#e6a817' },
            done:    { text: `✅ CSV (${count})`,                   disabled: false, bg: '#2e7d32' },
            error:   { text: '❌ Erro — tente de novo',             disabled: false, bg: '#c62828' },
        };
        const s = map[state] || map.idle;
        const label = btn.querySelector('.ehs-csv-label') || btn;
        label.textContent      = s.text;
        label.style.background = s.bg;
        btn.disabled           = s.disabled;
        btn.style.cursor       = s.disabled ? 'not-allowed' : 'pointer';
    }

    // Atualiza só o rótulo (pílula) do botão CSV durante o progresso
    function setBtnProgress(btn, text, bg) {
        const label = btn.querySelector('.ehs-csv-label') || btn;
        label.textContent = text;
        if (bg) label.style.background = bg;
    }


    // ─────────────────────────────────────────────────────────────────
    // EXTRAÇÃO DE DADOS — lê os cards/linhas visíveis na página atual
    // ─────────────────────────────────────────────────────────────────


    /**
     * Encontra o container de cada registro de inspeção.
     * Estratégia em cascata: table rows → cards com labels → busca por texto.
     */
    function findInspectionRows() {
        // Estratégia 0 — cards reais do EHS (data-testid = UUID do card)
        const ehsCards = Array.from(document.querySelectorAll('div[data-testid^="ComplianceExecutionCard-"]'))
            .filter(el => /^ComplianceExecutionCard-[0-9a-fA-F-]{30,}$/.test(el.getAttribute('data-testid') || ''));
        if (ehsCards.length > 0) return ehsCards;

        // Estratégia 1 — tabela HTML padrão
        const trs = document.querySelectorAll('tbody tr');
        if (trs.length > 0) return Array.from(trs);


        // Estratégia 2 — cards/divs com exatamente um label "Assigned to"
        const candidates = document.querySelectorAll(
            'div[class*="row"], div[class*="card"], div[class*="item"], li'
        );
        const cards = [];
        for (const el of candidates) {
            const labels = [...el.querySelectorAll('*')].filter(
                n => n.children.length === 0 &&
                     /^assigned to:?$/i.test(n.textContent.trim())
            );
            if (labels.length === 1) cards.push(el);
        }
        if (cards.length > 0) return cards;


        // Estratégia 3 — TreeWalker: sobe a partir do nó de texto "Assigned to"
        return findRowsByWalker();
    }


    function findRowsByWalker() {
        const rows = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!/^assigned to:?$/i.test(node.textContent.trim())) continue;


            let container = node.parentElement;
            for (let i = 0; i < 6; i++) {
                if (!container || !container.parentElement) break;
                container = container.parentElement;
                const inner = container.querySelectorAll('*');
                let hasStart = false, hasEnd = false;
                for (const el of inner) {
                    const t = el.textContent.trim();
                    if (/scheduled start date:?/i.test(t)) hasStart = true;
                    if (/due date:?/i.test(t))              hasEnd   = true;
                }
                if (hasStart && hasEnd) { rows.push(container); break; }
            }
        }
        return rows;
    }


    /**
     * Extrai o valor de um campo dentro de um container,
     * buscando pelo texto do label e pegando o sibling/vizinho.
     */
    function extractField(container, labelPattern) {
        // Tenta via DOM: pega o elemento com o label e busca o sibling
        for (const el of container.querySelectorAll('*')) {
            if (el.children.length > 0) continue;
            if (!labelPattern.test(el.textContent.trim())) continue;


            // Sibling de texto direto
            let sib = el.nextSibling;
            while (sib) {
                const t = sib.textContent ? sib.textContent.trim() : '';
                if (t && !labelPattern.test(t)) return t;
                sib = sib.nextSibling;
            }
            // Próximo elemento sibling
            const nextEl = el.nextElementSibling;
            if (nextEl) return nextEl.textContent.trim();


            // Sobe um nível e pega o próximo sibling do pai
            const parentSib = el.parentElement && el.parentElement.nextElementSibling;
            if (parentSib) return parentSib.textContent.trim();
        }


        // Fallback — Regex no texto completo do container
        const raw = container.textContent;
        const src = labelPattern.source.replace(':?', '').replace(':', '');
        const re  = new RegExp(src + ':?\\s*([^\\n\\r]+)', 'i');
        const m   = raw.match(re);
        return m ? m[1].trim() : '';
    }


    function extractRecord(row) {
        // Card real do EHS (estrutura por data-testid) → extração rica
        if (row.querySelector && row.querySelector('[data-testid="ComplianceExecutionCard-assignedTo"]')) {
            return extractCardRecord(row);
        }

        // ── Fallback: extração antiga por label de texto ──
        const assignedTo = extractField(row, /^assigned to:?$/i);
        const startDate  = extractField(row, /^scheduled start date:?$/i);
        const dueDate    = extractField(row, /^due date:?$/i);

        if (!assignedTo && !startDate && !dueDate) return null;

        const rawStart = startDate.replace(/\s+/g, ' ').trim();

        return {
            login:       assignedTo.replace(/@\S+/, '').trim(),
            title:       '',
            status:      '',
            startDate:   normalizeDate(rawStart),
            dueDate:     normalizeDate(dueDate.replace(/\s+/g, ' ').trim()),
            doneDate:    '',
            isYesterday: /^(yesterday|ontem)\b/i.test(rawStart),
            category:    '',
        };
    }

    // Categoriza pela título da inspeção (independe do filtro de busca)
    function categorizeTitle(title) {
        const t = (title || '').toLowerCase();
        if (t.indexOf('area organization') !== -1) return 'area_org';
        if (t.indexOf('dock') !== -1)              return 'dock';
        if (t.indexOf('floor') !== -1 || t.indexOf('fsi') !== -1) return 'floor';
        return '';
    }

    // Status que contam como REALIZADA (feita) — EN/PT.
    // Inclui Completed/Concluído E Submitted/Enviado (submetida = inspeção feita,
    // ainda que pendente de findings). É esse o conjunto usado na meta.
    function isDoneStatus(s) {
        return /complet|conclu|submit|enviad/i.test(s || '');
    }

    // Extração estruturada do card EHS (data-testid)
    function extractCardRecord(card) {
        // Login: nome do usuário ou alt do avatar
        let login = '';
        const nameEl = card.querySelector('.core-15tgaqh-name');
        if (nameEl) login = nameEl.textContent.trim();
        if (!login) {
            const img = card.querySelector('[data-testid="UserDisplay-user"] img');
            if (img) login = (img.getAttribute('alt') || '').trim();
        }
        login = login.replace(/@\S+/, '').trim();

        // Título da inspeção
        const titleEl = card.querySelector('[data-testid="ComplianceExecutionCard-view-detail-link"]');
        const title = titleEl ? titleEl.textContent.trim() : '';

        // Status (Completed / Submitted / ...)
        const stEl = card.querySelector('[class*="statusMessage"]');
        const status = stEl ? stEl.textContent.trim() : '';

        // Datas por label (testid) → valor no elemento irmão
        const valOf = function (testid) {
            const lbl = card.querySelector('[data-testid="' + testid + '"]');
            if (!lbl) return '';
            const sib = lbl.nextElementSibling;
            return sib ? sib.textContent.replace(/\s+/g, ' ').trim() : '';
        };
        const startDate = valOf('ComplianceExecutionCard-scheduledStartDate');
        const dueDate   = valOf('ComplianceExecutionCard-dueDate');

        // Data de conclusão real: "Completed on 6/10/2026 9:52 PM GMT-3" / "Completed Yesterday ..." / "Submitted on ..."
        const actEl   = card.querySelector('[data-testid="ComplianceExecutionCard-updatedAt-container"]');
        const actText = actEl ? actEl.textContent.replace(/\s+/g, ' ').trim() : '';
        let doneStr = '';
        const m = actText.match(/(?:\b(?:on|em)\s+)?((?:\d{1,2}\/\d{1,2}\/\d{4})|yesterday|today|ontem|hoje)\b(.*)$/i);
        if (m) doneStr = (m[1] + (m[2] || '')).trim();
        const doneDate = normalizeDate(doneStr);

        if (!login && !startDate && !dueDate && !title) return null;

        return {
            login:       login || '?',
            title:       title,
            status:      status,
            startDate:   normalizeDate(startDate),
            dueDate:     normalizeDate(dueDate),
            doneDate:    doneDate,
            isYesterday: /yesterday|ontem/i.test(actText),   // concluída ontem
            category:    categorizeTitle(title),
        };
    }


    function extractPageData() {
        const rows = findInspectionRows();
        return rows.map(extractRecord).filter(Boolean);
    }


    // ─────────────────────────────────────────────────────────────────
    // CSV
    // ─────────────────────────────────────────────────────────────────


    // ─────────────────────────────────────────────────────────────────
    // LOCALE DE DATA — EN usa mm/dd/aaaa; PT-BR usa dd/mm/aaaa.
    // Detecta se a página está em português (labels/idioma) e, se sim, trata
    // as datas como dd/mm. Uma vez detectado PT, mantém (latch).
    // ─────────────────────────────────────────────────────────────────
    let _localeDMY = null;
    function localeDMY() {
        if (_localeDMY === true) return true;
        // 1) Idioma do documento/navegador
        const lang = ((document.documentElement && document.documentElement.getAttribute('lang')) || navigator.language || '').toLowerCase();
        let dmy = lang.indexOf('pt') === 0;
        // 2) Labels em português na página
        if (!dmy && document.body) {
            dmy = /Data de in[íi]cio programada|Detalhes da conclus[ãa]o|Atribu[íi]do a|Conclu[íi]do em/i.test(document.body.textContent || '');
        }
        // 3) Heurística pelos próprios cards: se alguma data tem o 1º número > 12,
        //    ela só pode ser dd/mm (BR) — o mês nunca passa de 12.
        if (!dmy) {
            const cards = document.querySelectorAll('[data-testid^="ComplianceExecutionCard-"]');
            for (const c of cards) {
                const mm = (c.textContent || '').match(/\b(\d{1,2})\/(\d{1,2})\/\d{4}\b/);
                if (mm && +mm[1] > 12) { dmy = true; break; }
            }
        }
        if (dmy) _localeDMY = true;
        return dmy;
    }

    // Parser único de data do EHS, ciente do locale.
    // Aceita "09/07/2026 17:33 GMT-3" (BR) e "6/10/2026 9:52 PM GMT-3" (US).
    function parseFlexibleDate(s) {
        if (!s) return null;
        const str = String(s).replace(/GMT[^\s]*/i, '').trim();

        // Hora opcional (reaproveitada nos formatos abaixo)
        const readTime = () => {
            let hh = 0, mi = 0;
            const tm = str.match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
            if (tm) {
                hh = +tm[1]; mi = +tm[2];
                const ap = (tm[3] || '').toLowerCase();
                if (ap === 'pm' && hh < 12) hh += 12;
                if (ap === 'am' && hh === 12) hh = 0;
            }
            return { hh, mi };
        };

        // 1) ISO aaaa-mm-dd (não ambíguo) — usado para datas relativas normalizadas
        const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            const { hh, mi } = readTime();
            const d = new Date(+iso[1], +iso[2] - 1, +iso[3], hh, mi);
            return isNaN(d.getTime()) ? null : d;
        }

        // 2) Palavras relativas direto (rede de segurança, EN/PT)
        const rel = { yesterday: -1, today: 0, tomorrow: 1, ontem: -1, hoje: 0, 'amanhã': 1, amanha: 1 };
        const low = str.toLowerCase();
        for (const w in rel) {
            if (low.indexOf(w) === 0) {
                const { hh, mi } = readTime();
                const t = new Date();
                t.setDate(t.getDate() + rel[w]);
                t.setHours(hh, mi, 0, 0);
                return t;
            }
        }

        // 3) Data com barras — ciente do locale (mm/dd US ou dd/mm BR)
        const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!m) { const d = new Date(str); return isNaN(d.getTime()) ? null : d; }

        let a = +m[1], b = +m[2]; const y = +m[3];
        let day, mon;
        if (localeDMY()) { day = a; mon = b; }   // BR: dd/mm
        else             { mon = a; day = b; }   // US: mm/dd
        // Autocorreção: se o "mês" for > 12 e o "dia" <= 12, inverte.
        if (mon > 12 && day <= 12) { const t = mon; mon = day; day = t; }

        const { hh, mi } = readTime();
        const d = new Date(y, mon - 1, day, hh, mi);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * Converte datas relativas para formato absoluto (ISO, não-ambíguo).
     * "Yesterday 10:56 PM GMT-3" → "4/27/2026 10:56 PM GMT-3" (US)
     * "Ontem 17:33 GMT-3"        → "27/04/2026 17:33 GMT-3"   (BR)
     */
    function normalizeDate(dateStr) {
        if (!dateStr) return dateStr;
        const s = dateStr.trim();
        // EN + PT: yesterday/ontem, today/hoje, tomorrow/amanhã
        const relMap = {
            yesterday: -1, today: 0, tomorrow: 1,
            ontem: -1, hoje: 0, 'amanhã': 1, 'amanha': 1,
        };


        for (const [word, offset] of Object.entries(relMap)) {
            if (s.toLowerCase().startsWith(word)) {
                const target = new Date();
                target.setDate(target.getDate() + offset);
                // ISO aaaa-mm-dd: não-ambíguo (evita confusão dd/mm × mm/dd).
                const y  = target.getFullYear();
                const mo = String(target.getMonth() + 1).padStart(2, '0');
                const da = String(target.getDate()).padStart(2, '0');
                const rest = s.slice(word.length).trim();   // "10:56 PM GMT-3"
                return `${y}-${mo}-${da}${rest ? ' ' + rest : ''}`;
            }
        }
        return s;   // já é data absoluta
    }


    /**
     * Retorna semana Dom→Sáb e data formatada de ONTEM.
     * Exemplo (hoje = Ter 28/04/2026):
     *   ontem = 27/04 → W18_2026, date = 04-27-2026
     */
    function getYesterdayLabel() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);


        // Número da semana Dom→Sáb de ontem
        const weekNum = getWeekNumberSunSat(yesterday);
        const week    = `W${String(weekNum).padStart(2, '0')}_${yesterday.getFullYear()}`;


        // Data no formato MM-DD-YYYY (sem barras — compatível com nome de arquivo)
        const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
        const dd = String(yesterday.getDate()).padStart(2, '0');
        const date = `${mm}-${dd}-${yesterday.getFullYear()}`;


        return { week, date };
    }


    /**
     * Calcula o número da semana usando o sistema Dom→Sáb.
     * Semana 1 começa no primeiro domingo do ano (ou antes, se jan/1 for Dom).
     * Fórmula: usa o dia da semana de jan/1 como âncora.
     *
     * Verificação para 2026 (jan/1 = Quinta, getDay()=4):
     *   26/04 Dom → floor((115+4)/7)+1 = 18 ✅  (início W18)
     *   25/04 Sáb → floor((114+4)/7)+1 = 17 ✅  (fim W17)
     *   19/04 Dom → floor((108+4)/7)+1 = 17 ✅  (início W17)
     *   27/04 Seg → floor((116+4)/7)+1 = 18 ✅
     */
    function getWeekNumberSunSat(d) {
        const jan1    = new Date(d.getFullYear(), 0, 1);
        const dayOfYr = Math.floor((d - jan1) / 86400000);   // 0-indexed
        return Math.floor((dayOfYr + jan1.getDay()) / 7) + 1;
    }


    /**
     * Retorna a SEMANA PASSADA completa (Dom→Sáb) no formato "W17_2026".
     * Independente do dia de execução, sempre aponta para a semana anterior.
     *
     * Exemplo (hoje = Ter 28/04, W18):
     *   Domingo atual  = 26/04 → Domingo passado = 19/04 → W17 ✅
     */
    function getLastWeekLabel() {
        const today = new Date();


        // Domingo da semana atual: today.getDay() = 0 (Dom) … 6 (Sáb)
        const sundayCurr = new Date(today);
        sundayCurr.setDate(today.getDate() - today.getDay());


        // Domingo da semana PASSADA
        const sundayLast = new Date(sundayCurr);
        sundayLast.setDate(sundayCurr.getDate() - 7);


        const weekNum = getWeekNumberSunSat(sundayLast);
        return `W${String(weekNum).padStart(2, '0')}_${sundayLast.getFullYear()}`;
    }


    // ─────────────────────────────────────────────────────────────────
    // SEMANA ATUAL + RECOMENDAÇÃO DE WEEK PARA FILTRAR (Dom→Sáb)
    // Regra: semana atual ÍMPAR → filtrar só a atual; semana atual PAR →
    // filtrar a anterior + a atual; retroativo → escolher 2 semanas
    // subsequentes (quinzena completa: da semana ímpar até a par seguinte).
    // ─────────────────────────────────────────────────────────────────
    function weekRangeSunSat(d) {
        const sunday = new Date(d);
        sunday.setDate(d.getDate() - d.getDay());
        sunday.setHours(0, 0, 0, 0);
        const saturday = new Date(sunday);
        saturday.setDate(sunday.getDate() + 6);
        return { weekNum: getWeekNumberSunSat(sunday), year: sunday.getFullYear(), sunday, saturday };
    }

    const fmtDM  = d => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
    const fmtDMY = d => fmtDM(d) + '/' + d.getFullYear();
    const wLabel = w => 'W' + String(w.weekNum).padStart(2, '0');

    function getWeekRecommendation() {
        const today = new Date();
        const cur = weekRangeSunSat(today);

        const prevSun = new Date(cur.sunday); prevSun.setDate(cur.sunday.getDate() - 7);
        const prev = weekRangeSunSat(prevSun);

        const nextSun = new Date(cur.sunday); nextSun.setDate(cur.sunday.getDate() + 7);
        const next = weekRangeSunSat(nextSun);

        const isOdd = (cur.weekNum % 2) === 1;
        // Quinzena que contém a semana atual (começa sempre na semana ímpar).
        const pairStart = isOdd ? cur : prev;   // 1ª semana (ímpar)
        const pairEnd   = isOdd ? next : cur;   // 2ª semana (par)

        return { today, cur, prev, next, isOdd, pairStart, pairEnd };
    }


    function buildCSV(records) {
        const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
        const header = ['Login', 'Data Abertura', 'Data Fechamento'].join(',');
        const body   = records.map(r =>
            [esc(r.login), esc(r.startDate), esc(r.dueDate)].join(',')
        );
        return [header, ...body].join('\n');
    }


    function downloadCSV(csv, filename) {
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url      = URL.createObjectURL(blob);
        const a        = Object.assign(document.createElement('a'), {
            href: url, download: filename
        });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }


    // ─────────────────────────────────────────────────────────────────
    // COLETA COM PAGINAÇÃO AUTOMÁTICA
    // ─────────────────────────────────────────────────────────────────

    /**
     * Núcleo de paginação: extrai a página atual, avança até a última e
     * retorna TODOS os registros. Reutilizado por collectAll e pelo dashboard.
     */
    async function paginateCollect(onProgress) {
        const all = [];
        let page  = 1;

        while (page <= CONFIG.MAX_PAGES) {
            if (onProgress) onProgress(page, all.length);

            const records = extractPageData();
            if (records.length > 0) all.push(...records);

            const pathNode = getNodeByXPath(CONFIG.NEXT_BTN_XPATH);
            const nextBtn  = pathNode ? pathNode.closest('button') || pathNode.parentElement : null;

            const isDisabled = !nextBtn ||
                nextBtn.disabled ||
                nextBtn.hasAttribute('disabled') ||
                nextBtn.classList.contains('Mui-disabled') ||
                nextBtn.getAttribute('aria-disabled') === 'true';

            if (isDisabled) break;   // última página

            nextBtn.click();
            await sleep(CONFIG.PAGE_LOAD_WAIT);
            page++;
        }
        return all;
    }

    async function collectAll(btn) {
        try {
            const all = await paginateCollect((page, count) => {
                setBtnProgress(btn, `⏳ pág. ${page} (${count})`, '#e6a817');
            });

            if (all.length === 0) {
                alert(
                    '⚠️ Nenhum dado encontrado.\n\n' +
                    'Certifique-se de que:\n' +
                    '1. Os filtros foram aplicados\n' +
                    '2. A tabela de resultados está visível na tela'
                );
                setButtonState(btn, 'error');
                return;
            }

            downloadCSV(buildCSV(all), `${selectedType || 'inspections'}_${getLastWeekLabel()}.csv`);
            setButtonState(btn, 'done', all.length);

            // Alimenta o dashboard com os dados coletados e abre automaticamente
            storeDashData(selectedType || 'inspections', all, 'week');
            openDashboard();

        } catch (err) {
            console.error('[EHS CSV]', err);
            setButtonState(btn, 'error');
        }
    }


    // ─────────────────────────────────────────────────────────────────
    // COLETA A PARTIR DA DATA FILTRADA (botão único de extração)
    // Pagina a lista atual e exporta em CSV só os registros cujo Scheduled start date
    // é >= à data filtrada na página ("Date on or after"). Sem data filtrada → exporta tudo.
    // ─────────────────────────────────────────────────────────────────
    async function collectFromFilteredDate(btn, explicitDate) {
        try {
            // Corte: usa a data escolhida no modal (não ambígua). Só cai no
            // readFilterDate (formato americano da página) se nada for passado.
            const filterDate = explicitDate || readFilterDate();

            const all = await paginateCollect((page, count) => {
                setBtnProgress(btn, `⏳ pág. ${page} (${count})`, '#e6a817');
            });

            let records = all;
            if (filterDate) {
                const minMs = new Date(filterDate.getFullYear(), filterDate.getMonth(), filterDate.getDate()).getTime();
                records = all.filter(r => {
                    const sd = parseEhsDate(r.startDate);
                    if (!sd) return false;
                    return new Date(sd.getFullYear(), sd.getMonth(), sd.getDate()).getTime() >= minMs;
                });
            }

            if (records.length === 0) {
                alert('⚠️ Nenhum dado encontrado a partir da data filtrada.\n\n' +
                      'Verifique se:\n1. O filtro de data foi aplicado na página\n' +
                      '2. Uma categoria foi selecionada (dock/floor/Area)\n3. A lista está visível');
                setButtonState(btn, 'error');
                return;
            }

            const type = selectedType || 'inspections';
            const dLbl = filterDate
                ? (String(filterDate.getMonth() + 1).padStart(2, '0') + '-'
                   + String(filterDate.getDate()).padStart(2, '0') + '-' + filterDate.getFullYear())
                : 'todos';
            downloadCSV(buildCSV(records), `${type}_apartir_${dLbl}.csv`);
            setButtonState(btn, 'done', records.length);

        } catch (err) {
            console.error('[EHS CSV a partir da data]', err);
            setButtonState(btn, 'error');
        }
    }


    // ─────────────────────────────────────────────────────────────────
    // COLETA SOMENTE ONTEM (Yesterday)
    // ─────────────────────────────────────────────────────────────────
    async function collectYesterday(btn) {
        const all  = [];
        let   page = 1;


        try {
            while (page <= CONFIG.MAX_PAGES) {
                setBtnProgress(btn, `⏳ pág. ${page} (${all.length} ontem)`, '#e6a817');


                // Filtra apenas registros cujo startDate era "Yesterday" antes da normalização
                const pageRecords = extractPageData();
                all.push(...pageRecords.filter(r => r.isYesterday));


                const pathNode  = getNodeByXPath(CONFIG.NEXT_BTN_XPATH);
                const nextBtn   = pathNode ? pathNode.closest('button') || pathNode.parentElement : null;
                const isDisabled = !nextBtn ||
                    nextBtn.disabled ||
                    nextBtn.hasAttribute('disabled') ||
                    nextBtn.classList.contains('Mui-disabled') ||
                    nextBtn.getAttribute('aria-disabled') === 'true';


                if (isDisabled) break;


                nextBtn.click();
                await sleep(CONFIG.PAGE_LOAD_WAIT);
                page++;
            }


            if (all.length === 0) {
                alert(
                    '⚠️ Nenhum registro de ontem encontrado.\n\n' +
                    'Certifique-se de que os filtros estão aplicados e\n' +
                    'que existem registros com data de ontem.'
                );
                setButtonState(btn, 'error');
                return;
            }


            // Nome: (modalidade)_(semana de ontem)_(data de ontem).csv
            const { week, date } = getYesterdayLabel();
            const type           = selectedType || 'inspections';
            downloadCSV(buildCSV(all), `${type}_${week}_${date}.csv`);
            setButtonState(btn, 'done', all.length);

            // Alimenta o dashboard com os dados coletados e abre automaticamente
            storeDashData(type, all, 'yesterday');
            openDashboard();


        } catch (err) {
            console.error('[EHS CSV Yesterday]', err);
            setButtonState(btn, 'error');
        }
    }


    // ─────────────────────────────────────────────────────────────────
    // BOTÕES DE ATALHO — Floor / Area Organization
    // ─────────────────────────────────────────────────────────────────


    /**
     * Preenche o input de pesquisa React corretamente.
     * Inputs gerenciados pelo React ignoram .value = "x" simples —
     * é necessário usar o setter nativo e disparar eventos sintéticos.
     */
    function fillSearchInput(value) {
        // Tenta pelo ID confirmado (:r2:) e por fallbacks
        const input = findSearchInput();
        if (!input) {
            alert('⚠️ Campo de pesquisa não encontrado.\nTente rolar a página para que ele fique visível.');
            return;
        }


        // Setter nativo do HTMLInputElement (burla o React)
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeSetter.call(input, value);


        // Dispara eventos que o React escuta
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
    }


    function findSearchInput() {
        // Tentativa 1: ID confirmado pelo usuário (:r2:)
        const byId = document.getElementById(':r2:');
        if (byId && byId.tagName === 'INPUT') return byId;


        // Tentativa 2: XPath do input direto
        const byXPath = document.evaluate(
            '//*[@id=":r2:"]', document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (byXPath) return byXPath;


        // Tentativa 3: XPath do container da barra de pesquisa — busca o input dentro dele
        const container = document.evaluate(
            '/html/body/div[1]/div/div/div/div/main/div[2]/div/div[2]/div/div/div[1]/div[1]/div[1]/div',
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (container) {
            const inp = container.querySelector('input');
            if (inp) return inp;
        }


        // Tentativa 4: Qualquer input[type=text] visível (fallback geral)
        const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (const inp of inputs) {
            const rect = inp.getBoundingClientRect();
            if (rect.width > 100 && rect.top > 50) return inp;
        }
        return null;
    }


    /**
     * Injeta os botões [Floor] e [Area Org] dentro da div alvo fornecida pelo usuário.
     * XPath alvo: /html/body/div[1]/div/div/div/div/main/div[2]/div/div[1]/div/div[2]/div
     * Fallback: flutuante no topo-direito caso o container não seja encontrado.
     */
    const EHS_DL_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" '
        + 'stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/>'
        + '<path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';

    function injectPanel() {
        if (document.getElementById('ehs-fab-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'ehs-fab-panel';
        panel.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:99999;background:#2b3440;'
            + 'border:2px solid #f59e0b;border-radius:20px;padding:16px;display:flex;flex-direction:column;'
            + "gap:12px;box-shadow:0 14px 36px rgba(0,0,0,0.5);font-family:'Amazon Ember',Arial,sans-serif;width:260px;"
            + 'transition:transform .28s cubic-bezier(.18,.9,.32,1.2),opacity .22s ease;transform-origin:bottom left;';

        // ── Week atual + recomendação (botão "?") ──
        // O detalhe expande DENTRO do painel (inline). Como o painel é ancorado
        // embaixo (bottom:24px), o conteúdo cresce para CIMA ao abrir.
        (function addWeekBar() {
            const rec = getWeekRecommendation();
            const parity = rec.isOdd ? 'ímpar' : 'par';

            const weekWrap = document.createElement('div');
            weekWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;'
                + 'background:#1f2732;border:1px solid #3a4654;border-radius:12px;padding:8px 10px;'
                + 'font-size:12px;color:#dbe6f2;';

            // Linha principal: Week atual + botão "?"
            const weekRow = document.createElement('div');
            weekRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

            const weekTxt = document.createElement('span');
            weekTxt.style.cssText = 'flex:1;line-height:1.25;';
            weekTxt.innerHTML = `📅 Week atual: <b style="color:#ffce7a;">${wLabel(rec.cur)}</b><br>`
                + `<span style="color:#9fb3c8;">${fmtDM(rec.cur.sunday)}–${fmtDM(rec.cur.saturday)} (${parity})</span>`;

            const helpBtn = document.createElement('button');
            helpBtn.textContent = '?';
            helpBtn.title = 'Como escolher a Week para filtrar';
            helpBtn.style.cssText = 'width:24px;height:24px;flex:none;border-radius:50%;border:1px solid #f59e0b;'
                + 'background:transparent;color:#f59e0b;font-weight:800;cursor:pointer;line-height:1;padding:0;transition:all .15s;';

            weekRow.appendChild(weekTxt);
            weekRow.appendChild(helpBtn);

            // Detalhe expansível (inline) — começa oculto
            const details = document.createElement('div');
            details.style.cssText = 'display:none;border-top:1px solid #3a4654;padding-top:8px;line-height:1.5;';

            const recHtml = rec.isOdd
                ? `Semana atual é <b>ímpar</b> → <b>filtre só a semana atual</b>:<br>`
                    + `<b style="color:#ffce7a;">${wLabel(rec.cur)}</b> (${fmtDM(rec.cur.sunday)}–${fmtDM(rec.cur.saturday)})<br>`
                    + `No filtro de data da página, use <b>a partir de ${fmtDMY(rec.cur.sunday)}</b>.`
                : `Semana atual é <b>par</b> → <b>filtre a anterior + a atual</b>:<br>`
                    + `<b style="color:#ffce7a;">${wLabel(rec.prev)} + ${wLabel(rec.cur)}</b> (${fmtDM(rec.prev.sunday)}–${fmtDM(rec.cur.saturday)})<br>`
                    + `No filtro de data da página, use <b>a partir de ${fmtDMY(rec.prev.sunday)}</b>.`;

            details.innerHTML = `<div style="font-weight:800;color:#f59e0b;margin-bottom:6px;">📅 Qual Week filtrar?</div>`
                + `<div style="background:#0f1e30;border:1px solid #1f3a57;border-radius:8px;padding:9px 11px;margin-bottom:10px;">${recHtml}</div>`
                + `<div style="font-weight:700;margin-bottom:4px;">Regras gerais</div>`
                + `<ul style="margin:0;padding-left:18px;">`
                    + `<li>Semana <b>ímpar</b> → só a atual.</li>`
                    + `<li>Semana <b>par</b> → anterior + atual.</li>`
                    + `<li><b>Retroativo</b> → 2 semanas subsequentes (quinzena: `
                        + `${wLabel(rec.pairStart)}→${wLabel(rec.pairEnd)}, ${fmtDM(rec.pairStart.sunday)}–${fmtDM(rec.pairEnd.saturday)}).</li>`
                + `</ul>`
                + `<div style="margin-top:10px;padding:8px 10px;background:#0f1e30;border:1px solid #1f3a57;border-radius:8px;color:#c2d2e0;">`
                    + `ℹ️ Selecionar <b>2 semanas</b> é para contemplar o <b>Area Organization</b>, `
                    + `que usa janela <b>quinzenal</b> (soma as 2 semanas do par). O FSI+DOCK é semanal.`
                + `</div>`;

            // Alterna: abre expandindo o painel pra cima; fecha ao apertar de novo.
            helpBtn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const open = details.style.display === 'none';
                details.style.display = open ? 'block' : 'none';
                helpBtn.style.background = open ? '#f59e0b' : 'transparent';
                helpBtn.style.color      = open ? '#1b2733' : '#f59e0b';
            });

            weekWrap.appendChild(weekRow);
            weekWrap.appendChild(details);
            panel.appendChild(weekWrap);
        })();

        // ── DASHBOARD + ⚙️ (mesma linha) ──
        const dashRow = document.createElement('div');
        dashRow.style.cssText = 'display:flex;gap:8px;align-items:stretch;';

        const dashBtn = document.createElement('button');
        dashBtn.id = 'ehs-dash-btn';
        dashBtn.textContent = 'DASHBOARD';
        dashBtn.title = 'Coletar Dock + Floor + Area Org e gerar o dashboard';
        dashBtn.style.cssText = 'flex:1;background:linear-gradient(180deg,#ffab2e 0%,#f59e0b 100%);color:#fff;border:none;'
            + 'border-radius:20px;padding:11px;font-size:14px;font-weight:800;letter-spacing:.05em;cursor:pointer;'
            + 'box-shadow:0 3px 12px rgba(245,158,11,.45);transition:filter .15s,transform .12s;';
        dashBtn.onmouseenter = () => { if (!dashBtn.disabled) { dashBtn.style.filter = 'brightness(1.07)'; dashBtn.style.transform = 'translateY(-1px)'; } };
        dashBtn.onmouseleave = () => { dashBtn.style.filter = 'none'; dashBtn.style.transform = 'none'; };
        dashBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            // Cache: se já coletou nesta sessão da página, reabre os dados salvos sem remapear.
            // Nova coleta só ao recarregar/reabrir a página (a flag reinicia).
            if (dashCollectedThisSession && Object.keys(loadDashStore()).length) {
                openDashboard();
            } else {
                ehsdConfirmCollect(dashBtn);
            }
        });
        dashRow.appendChild(dashBtn);

        const gear = document.createElement('button');
        gear.id = 'ehs-panel-gear';
        gear.textContent = '⚙️';
        gear.title = 'Gestores & Turnos (config de meta)';
        gear.style.cssText = 'width:42px;background:rgba(255,153,0,0.15);border:1px solid #f59e0b;color:#f59e0b;'
            + 'border-radius:20px;cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;'
            + 'transition:all .18s;flex-shrink:0;';
        gear.onmouseenter = () => { gear.style.transform = 'rotate(45deg)'; gear.style.background = 'rgba(255,153,0,0.3)'; };
        gear.onmouseleave = () => { gear.style.transform = 'none'; gear.style.background = 'rgba(255,153,0,0.15)'; };
        gear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMgrConfig(); });
        dashRow.appendChild(gear);

        panel.appendChild(dashRow);

        // ── Atalhos circulares (dock / floor / Area) ──
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:8px;';
        const shortcuts = [
            { label: 'dock',  icon: '🚢', value: 'dock',              key: 'dock'     },
            { label: 'floor', icon: '🏢', value: 'floor',             key: 'floor'    },
            { label: 'Area',  icon: '📋', value: 'area organization', key: 'area_org' },
        ];
        shortcuts.forEach(sc => {
            const b = document.createElement('button');
            b.title = `Pesquisar por "${sc.value}"`;
            b.style.cssText = 'flex:1;aspect-ratio:1;border-radius:50%;background:#fff;border:none;cursor:pointer;'
                + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:0;'
                + 'box-shadow:0 2px 8px rgba(0,0,0,.35);transition:transform .12s;';
            b.innerHTML = '<span style="font-size:22px;line-height:1;">' + sc.icon + '</span>'
                + '<span style="font-size:11px;font-weight:800;color:#1b2733;">' + sc.label + '</span>';
            b.onmouseenter = () => b.style.transform = 'scale(1.08)';
            b.onmouseleave = () => b.style.transform = 'none';
            b.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                selectedType = sc.key;
                fillSearchInput(sc.value);
            });
            row.appendChild(b);
        });
        panel.appendChild(row);

        // O botão "Extrair CSV" foi movido para o overlay "Confirmar filtros antes
        // de coletar" (ver ehsdConfirmCollect), para reaproveitar o mesmo caminho de
        // filtros (data "on or after" + status Lifecycle) antes de extrair.

        // ── Botão de minimizar (volta para o círculo) ──
        const minBtn = document.createElement('button');
        minBtn.id = 'ehs-fab-min';
        minBtn.textContent = '–';
        minBtn.title = 'Minimizar';
        minBtn.style.cssText = 'position:absolute;top:-10px;right:-10px;width:26px;height:26px;border-radius:50%;'
            + 'background:#232F3E;color:#fff;border:2px solid #f59e0b;cursor:pointer;font-size:16px;line-height:1;'
            + 'display:flex;align-items:center;justify-content:center;padding:0;z-index:3;box-shadow:0 2px 8px rgba(0,0,0,.45);'
            + 'transition:transform .15s;';
        minBtn.onmouseenter = () => minBtn.style.transform = 'scale(1.15)';
        minBtn.onmouseleave = () => minBtn.style.transform = 'none';
        panel.appendChild(minBtn);

        // ── Launcher circular (estado inicial) ──
        const launcher = document.createElement('button');
        launcher.id = 'ehs-fab-launcher';
        launcher.title = 'EHS Inspections — abrir painel';
        launcher.innerHTML = '🛡️';
        launcher.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:99999;width:56px;height:56px;'
            + 'border-radius:50%;background:linear-gradient(180deg,#ffab2e 0%,#f59e0b 100%);color:#fff;'
            + 'border:2px solid #fff;cursor:pointer;font-size:24px;display:flex;align-items:center;justify-content:center;'
            + 'box-shadow:0 6px 18px rgba(0,0,0,0.45);transition:transform .2s ease,opacity .2s ease;transform-origin:bottom left;';
        launcher.onmouseenter = () => { if (!launcher._busy) launcher.style.transform = 'scale(1.08)'; };
        launcher.onmouseleave = () => { if (!launcher._busy) launcher.style.transform = 'none'; };

        // Abre: círculo encolhe/some e o painel "explode" a partir do canto.
        const showPanel = () => {
            launcher._busy = true;
            launcher.style.opacity = '0';
            launcher.style.transform = 'scale(.35)';
            setTimeout(() => { launcher.style.display = 'none'; launcher._busy = false; }, 180);

            panel.style.display = 'flex';
            panel.style.opacity = '0';
            panel.style.transform = 'scale(.2)';
            requestAnimationFrame(() => {
                panel.style.opacity = '1';
                panel.style.transform = 'scale(1)';
            });
        };
        // Minimiza: painel encolhe de volta ao círculo.
        const hidePanel = () => {
            panel.style.opacity = '0';
            panel.style.transform = 'scale(.2)';
            setTimeout(() => { panel.style.display = 'none'; }, 240);

            launcher.style.display = 'flex';
            launcher.style.opacity = '0';
            launcher.style.transform = 'scale(.35)';
            requestAnimationFrame(() => {
                launcher.style.opacity = '1';
                launcher.style.transform = 'scale(1)';
            });
        };
        launcher.onclick = showPanel;
        minBtn.onclick = hidePanel;

        // Estado inicial: minimizado (círculo).
        panel.style.display = 'none';

        document.body.appendChild(panel);
        document.body.appendChild(launcher);
    }


    // ─────────────────────────────────────────────────────────────────
    // BOTÃO FLUTUANTE
    // ─────────────────────────────────────────────────────────────────
    function addButton() {
        // Substituída por injectPanel() — mantida como alias para compatibilidade
        injectPanel();
    }


    // ─────────────────────────────────────────────────────────────────
    // DASHBOARD — estilo AUSTIN WHS (dark + accent laranja)
    // Agrupa os dados coletados em: FSI + DOCK (floor+dock) e Area Organization
    // Métricas a partir dos dados disponíveis (login, startDate, dueDate):
    //   volume, responsáveis únicos, atrasadas (due date vencido), ranking por login
    // ─────────────────────────────────────────────────────────────────
    const DASH_STORE_KEY = 'ehs_dash_store';
    let ehsdActiveTab = 'overview';
    let ehsdWeekSel = {};   // { groupId: weekKey } — semana selecionada por grupo
    let ehsdMetaFilter = {}; // { groupId: 'all'|'met'|'notmet' } — filtro da matriz por meta
    let ehsdCutoff = null;  // Date — "Scheduled start date" mínima (filtro do usuário)

    // Parse data do filtro da página — SEMPRE americano (mm/dd/aaaa).
    // O campo "Date on or after" do EHS é lido no padrão americano.
    function parseUsDate(s) {
        const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!m) return null;
        return new Date(+m[3], +m[1] - 1, +m[2]);
    }
    // Date → valor de <input type="date"> (yyyy-mm-dd)
    function toInputDate(d) {
        if (!d) return '';
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    // input[type=date] (yyyy-mm-dd) → Date local
    function fromInputDate(s) {
        const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    // Tenta descobrir a data filtrada (Due date "on or after")
    function readFilterDate() {
        const inp = document.querySelector('[data-testid="ListViewFiltersGrouped-dueDateAfter"]');
        if (inp && inp.value) { const d = parseUsDate(inp.value); if (d) return d; }
        for (let i = 0; i < localStorage.length; i++) {
            try {
                const raw = localStorage.getItem(localStorage.key(i)) || '';
                if (raw.indexOf('dueDateAfter') === -1) continue;
                const m = raw.match(/dueDateAfter"?\s*[:=]\s*"?(\d{1,2}\/\d{1,2}\/\d{4})/);
                if (m) { const d = parseUsDate(m[1]); if (d) return d; }
            } catch (e) {}
        }
        return null;
    }

    // Seta valor num input controlado pelo React (setter nativo + eventos)
    function setReactValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Acha o botão que abre o drawer de Filters (best-effort)
    function findFilterOpener() {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
            const t  = (b.textContent || '').trim().toLowerCase();
            const al = (b.getAttribute('aria-label') || '').toLowerCase();
            if (t.indexOf('clear') !== -1) continue;
            if (/^filters?$/.test(t) || al.indexOf('filter') !== -1) return b;
        }
        return null;
    }

    // Escreve a data no filtro "Date on or after" da página e aplica
    async function applyPageDateFilter(dateObj) {
        if (!dateObj) return false;
        // SEMPRE em formato americano (mm/dd/aaaa): o filtro da página é lido assim.
        const us = String(dateObj.getMonth() + 1).padStart(2, '0') + '/'
                 + String(dateObj.getDate()).padStart(2, '0') + '/'
                 + dateObj.getFullYear();

        let inp = document.querySelector('[data-testid="ListViewFiltersGrouped-dueDateAfter"]');
        if (!inp) {
            const opener = findFilterOpener();
            if (opener) { opener.click(); await sleep(800); }
            inp = document.querySelector('[data-testid="ListViewFiltersGrouped-dueDateAfter"]');
        }
        if (!inp) return false;

        inp.focus();
        setReactValue(inp, us);
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        inp.blur();
        await sleep(400);

        const apply = document.querySelector('[data-testid="applyFiltersBtn"]');
        if (apply && !apply.disabled) apply.click();
        await sleep(CONFIG.SEARCH_WAIT);
        return true;
    }

    // Expande um grupo de filtro pelo rótulo (ex: "Lifecycle")
    function expandFilterGroup(label) {
        const heads = document.querySelectorAll('[data-testid="FilterGroup-SectionHeading"]');
        for (const h of heads) {
            const lbl = h.querySelector('[class*="filterGroupLabel"]') || h.querySelector('p');
            if (lbl && lbl.textContent.trim().toLowerCase() === label.toLowerCase()) {
                if (h.getAttribute('aria-expanded') !== 'true') h.click();
                return true;
            }
        }
        return false;
    }

    // Seleciona os status desejados no filtro Lifecycle (multi-select MUI)
    async function setStatusFilter(targets) {
        // Garante o drawer aberto
        let cont = document.querySelector('[data-testid="ListViewFiltersGrouped-lifeCycleFilters-status"]');
        if (!cont) {
            const opener = findFilterOpener();
            if (opener) { opener.click(); await sleep(800); }
        }
        // Expande o grupo Lifecycle
        expandFilterGroup('Lifecycle');
        await sleep(400);
        cont = document.querySelector('[data-testid="ListViewFiltersGrouped-lifeCycleFilters-status"]');
        if (!cont) return false;

        const input = cont.querySelector('input[role="combobox"]') || cont.querySelector('input');
        if (!input) return false;

        // Abre o dropdown
        input.focus();
        const openBtn = cont.querySelector('[aria-label="Open"]');
        if (openBtn) openBtn.click();
        else input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await sleep(350);

        // Seleciona cada status. Cada alvo pode ser uma string OU um array de
        // sinônimos (EN/PT) — tenta cada um até achar a opção correspondente.
        for (const target of targets) {
            const syns = Array.isArray(target) ? target : [target];
            let selected = false;
            for (const label of syns) {
                setReactValue(input, label);
                await sleep(450);
                const opts = document.querySelectorAll('li[role="option"]');
                for (const o of opts) {
                    const t = o.textContent.trim().toLowerCase();
                    if (t === label.toLowerCase() || t.indexOf(label.toLowerCase()) !== -1) {
                        if (o.getAttribute('aria-selected') !== 'true') o.click();
                        selected = true;
                        break;
                    }
                }
                if (selected) break;   // achou nesse idioma, não tenta os outros
                await sleep(120);
            }
            await sleep(250);
        }

        // Limpa o texto e fecha o dropdown
        setReactValue(input, '');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(250);

        const apply = document.querySelector('[data-testid="applyFiltersBtn"]');
        if (apply && !apply.disabled) apply.click();
        await sleep(CONFIG.SEARCH_WAIT);
        return true;
    }

    let statusFiltering = false;
    async function runStatusFilter(btn) {
        if (statusFiltering) return;
        statusFiltering = true;
        const orig = btn.textContent;
        btn.disabled = true; btn.style.cursor = 'wait';
        btn.textContent = '⏳ Aplicando status...';
        try {
            const ok = await setStatusFilter([
                ['Completed', 'Concluído', 'Concluida', 'Concluída'],
                ['Submitted', 'Enviado', 'Submetido'],
            ]);
            btn.textContent = ok ? '✅ Status aplicado' : '⚠️ Abra o painel Filters';
        } catch (e) {
            console.error('[EHS Status]', e);
            btn.textContent = '❌ Erro';
        } finally {
            statusFiltering = false;
            btn.disabled = false; btn.style.cursor = 'pointer';
            setTimeout(() => { btn.textContent = orig; }, 2500);
        }
    }

    const DASH_GROUPS = [
        { id: 'fsidock', label: 'FSI + DOCK',        icon: '🏢', types: ['floor', 'dock'] },
        { id: 'areaorg', label: 'Area Organization', icon: '📋', types: ['area_org'] },
    ];

    function loadDashStore() {
        try { return JSON.parse(localStorage.getItem(DASH_STORE_KEY)) || {}; } catch (e) { return {}; }
    }
    function storeDashData(type, records, scope) {
        const store = loadDashStore();
        store[type] = { records: records, scope: scope || 'week', ts: Date.now() };
        localStorage.setItem(DASH_STORE_KEY, JSON.stringify(store));
    }
    function clearDashStore() {
        localStorage.removeItem(DASH_STORE_KEY);
    }

    // Parse data do EHS ("4/28/2026 8:00 AM GMT-3") → Date (ou null)
    function parseEhsDate(s) {
        return parseFlexibleDate(s);
    }

    // Combina registros de todos os tipos de um grupo
    function groupRecords(store, types) {
        let recs = [];
        types.forEach(t => { if (store[t] && Array.isArray(store[t].records)) recs = recs.concat(store[t].records); });
        return recs;
    }

    function dashStats(records) {
        const now = new Date(); now.setHours(0, 0, 0, 0);
        const byLogin = {};
        let overdue = 0;
        records.forEach(r => {
            const login = (r.login || '—').trim() || '—';
            if (!byLogin[login]) byLogin[login] = { login: login, count: 0, overdue: 0, nextDue: null };
            byLogin[login].count++;
            const due = parseEhsDate(r.dueDate);
            const isOverdue = due && due < now;
            if (isOverdue) { overdue++; byLogin[login].overdue++; }
            if (due && !isOverdue && (!byLogin[login].nextDue || due < byLogin[login].nextDue)) byLogin[login].nextDue = due;
        });
        const ranking = Object.values(byLogin).sort((a, b) => b.count - a.count || b.overdue - a.overdue);
        const total = records.length;
        return {
            total: total,
            assignees: ranking.length,
            overdue: overdue,
            onTime: total - overdue,
            onTimePct: total ? Math.round(((total - overdue) / total) * 100) : 0,
            ranking: ranking,
        };
    }

    function injectDashCSS() {
        if (document.getElementById('ehsd-css')) return;
        const st = document.createElement('style');
        st.id = 'ehsd-css';
        st.textContent = `
            #ehsd-ov{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
                background:rgba(5,10,18,0.72);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
                font-family:'Amazon Ember','Segoe UI',Arial,sans-serif;animation:ehsdFade .2s ease;}
            @keyframes ehsdFade{from{opacity:0}to{opacity:1}}
            @keyframes ehsdPop{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
            #ehsd-panel{width:1000px;max-width:96vw;max-height:92vh;display:flex;flex-direction:column;
                background:#0d1b2a;border-radius:16px;overflow:hidden;
                box-shadow:0 26px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,153,0,0.18);
                animation:ehsdPop .26s cubic-bezier(.18,.9,.32,1.2);color:#e6edf3;}
            #ehsd-hdr{background:linear-gradient(135deg,#1b3a5b 0%,#13243a 55%,#0a1626 100%);
                padding:18px 24px;display:flex;align-items:center;gap:14px;border-bottom:3px solid #ff9900;flex-shrink:0;}
            #ehsd-hdr .ehsd-title{font-size:18px;font-weight:800;letter-spacing:.01em;}
            #ehsd-hdr .ehsd-sub{font-size:11px;color:#ffb347;margin-top:3px;}
            #ehsd-hdr-icon{width:42px;height:42px;border-radius:11px;background:rgba(255,153,0,0.16);
                display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;}
            #ehsd-x{margin-left:auto;background:rgba(255,255,255,0.08);border:none;color:#fff;width:34px;height:34px;
                border-radius:9px;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;transition:all .15s;}
            #ehsd-x:hover{background:#c0392b;transform:rotate(90deg);}
            #ehsd-clear{background:rgba(255,255,255,0.08);border:none;color:#ffb347;padding:8px 14px;border-radius:9px;
                cursor:pointer;font-size:12px;font-weight:700;transition:all .15s;}
            #ehsd-clear:hover{background:rgba(192,57,43,0.4);color:#fff;}
            #ehsd-tabs{display:flex;background:#0a1626;border-bottom:1px solid #1c3149;flex-shrink:0;}
            .ehsd-tab{flex:1;padding:13px 16px;background:transparent;color:#7d93a8;border:none;border-bottom:3px solid transparent;
                margin-bottom:-1px;cursor:pointer;font-size:13px;font-weight:700;transition:all .15s;font-family:inherit;letter-spacing:.02em;}
            .ehsd-tab:hover{color:#e6edf3;background:rgba(255,255,255,0.04);}
            .ehsd-tab.on{color:#ff9900;border-bottom-color:#ff9900;background:rgba(255,153,0,0.08);}
            #ehsd-body{flex:1;overflow-y:auto;padding:22px;background:#0d1b2a;}
            #ehsd-body::-webkit-scrollbar{width:10px;height:10px}
            #ehsd-body::-webkit-scrollbar-thumb{background:#23405e;border-radius:8px;border:2px solid transparent;background-clip:padding-box}
            .ehsd-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;}
            .ehsd-grid.ehsd-grid-center{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
            .ehsd-grid.ehsd-grid-center .ehsd-kpi{padding:10px 6px;}
            .ehsd-grid.ehsd-grid-center .ehsd-kpi .v{font-size:21px;}
            .ehsd-grid.ehsd-grid-center .ehsd-kpi .l{font-size:8px;margin-top:5px;letter-spacing:.04em;}
            .ehsd-kpi{background:linear-gradient(145deg,#16273c,#0f1e30);border:1px solid #1f3a57;border-radius:12px;
                padding:16px 18px;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,0.25);}
            .ehsd-kpi .v{font-size:32px;font-weight:800;line-height:1;}
            .ehsd-kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8aa1b6;margin-top:8px;}
            .ehsd-kpi.accent .v{color:#ff9900;} .ehsd-kpi.danger .v{color:#ff6b6b;}
            .ehsd-kpi.ok .v{color:#37d67a;} .ehsd-kpi.info .v{color:#5dade2;}
            .ehsd-section{background:#0f1e30;border:1px solid #1f3a57;border-radius:12px;overflow:hidden;margin-bottom:20px;}
            .ehsd-section-hd{background:linear-gradient(135deg,#1b3a5b,#13243a);padding:11px 16px;font-size:12px;font-weight:800;
                text-transform:uppercase;letter-spacing:.05em;color:#fff;border-bottom:2px solid #ff9900;display:flex;align-items:center;gap:8px;}
            .ehsd-section-bd{padding:16px;}
            .ehsd-bar-wrap{display:flex;flex-direction:column;gap:7px;}
            .ehsd-bar-item{display:flex;align-items:center;gap:10px;}
            .ehsd-bar-label{width:140px;font-size:12px;color:#c2d2e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;}
            .ehsd-bar-track{flex:1;background:#0a1626;border-radius:6px;height:22px;overflow:hidden;}
            .ehsd-bar-fill{height:100%;border-radius:6px;display:flex;align-items:center;justify-content:flex-end;
                padding-right:8px;font-size:11px;font-weight:800;color:#0d1b2a;min-width:26px;
                background:linear-gradient(90deg,#ff9900,#ffb347);transition:width .4s ease;}
            .ehsd-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;}
            .ehsd-tbl th{background:#13243a;color:#9fb4c8;text-align:left;padding:9px 12px;font-size:10px;
                text-transform:uppercase;letter-spacing:.05em;position:sticky;top:0;}
            .ehsd-tbl td{padding:8px 12px;border-bottom:1px solid #16273c;color:#dbe6f0;}
            .ehsd-tbl tr:nth-child(even) td{background:#0c1a2b;}
            .ehsd-tbl tr:hover td{background:#15243a;}
            .ehsd-pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:800;}
            .ehsd-pill.over{background:rgba(255,107,107,0.16);color:#ff8585;}
            .ehsd-pill.ok{background:rgba(55,214,122,0.16);color:#46e08a;}
            .ehsd-empty{text-align:center;color:#6b8199;padding:60px 20px;font-size:14px;}
            .ehsd-cmp{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
            .ehsd-wk-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;}
            .ehsd-wk-lead{font-size:11px;color:#8aa1b6;font-weight:700;text-transform:uppercase;letter-spacing:.05em;}
            .ehsd-wk{background:#13243a;border:1px solid #1f3a57;color:#9fb4c8;padding:6px 12px;border-radius:8px;cursor:pointer;
                font-size:12px;font-weight:700;font-family:inherit;transition:all .15s;}
            .ehsd-wk:hover{border-color:#ff9900;color:#fff;}
            .ehsd-wk.on{background:linear-gradient(145deg,#2a3f5a,#1b3a5b);border-color:#ff9900;color:#ff9900;}
            .ehsd-matrix-wrap{overflow-x:auto;border-radius:10px;}
            .ehsd-matrix{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;}
            .ehsd-matrix th{background:#13243a;color:#ff9900;padding:9px 10px;text-align:center;font-size:11px;font-weight:800;
                white-space:nowrap;border-bottom:2px solid #1f3a57;}
            .ehsd-matrix th span{display:block;font-size:9px;color:#6b8199;font-weight:600;margin-top:2px;}
            .ehsd-matrix th.ehsd-mx-owner{text-align:left;}
            .ehsd-matrix th.ehsd-mx-num{text-align:center;width:38px;}
            .ehsd-mx-num{text-align:center;color:#6b8199;font-weight:700;font-size:11px;padding:8px 6px;
                border-bottom:1px solid #16273c;background:#0c1a2b;}
            .ehsd-matrix th.today,.ehsd-matrix td.today{background:rgba(255,153,0,0.12);}
            .ehsd-matrix th.today{border-bottom-color:#ff9900;}
            .ehsd-mx-owner{text-align:left;font-weight:700;color:#e6edf3;padding:8px 12px;white-space:nowrap;
                border-bottom:1px solid #16273c;}
            .ehsd-mx-cell{text-align:center;color:#6b8199;padding:8px 10px;border-bottom:1px solid #16273c;}
            .ehsd-mx-cell.has{background:rgba(255,153,0,0.18);color:#ffcf80;font-weight:800;}
            .ehsd-mx-total{text-align:center;font-weight:800;color:#ff9900;border-bottom:1px solid #16273c;padding:8px 10px;background:#0c1a2b;}
            .ehsd-mx-chk{text-align:center;font-weight:800;color:#46e08a;border-bottom:1px solid #16273c;padding:8px 10px;}
            .ehsd-matrix tbody tr:hover td{background:#15243a;}
            .ehsd-matrix tbody tr:hover td.has{background:rgba(255,153,0,0.26);}
            @media(max-width:760px){.ehsd-grid{grid-template-columns:repeat(2,1fr)}.ehsd-cmp{grid-template-columns:1fr}}
        `;
        document.head.appendChild(st);
    }

    function ehsdBarChart(ranking, max) {
        if (!ranking.length) return '<p style="color:#6b8199;font-size:12px;">Sem dados</p>';
        const top = ranking.slice(0, 15);
        let h = '<div class="ehsd-bar-wrap">';
        top.forEach(r => {
            const pct = max ? Math.round((r.count / max) * 100) : 0;
            const safe = String(r.login).replace(/</g, '&lt;');
            h += `<div class="ehsd-bar-item"><div class="ehsd-bar-label" title="${safe}">${safe}</div>`
               + `<div class="ehsd-bar-track"><div class="ehsd-bar-fill" style="width:${Math.max(pct, 6)}%;">${r.count}</div></div></div>`;
        });
        return h + '</div>';
    }

    function ehsdRankingTable(ranking) {
        if (!ranking.length) return '<p style="color:#6b8199;font-size:12px;">Sem dados</p>';
        let h = '<div style="max-height:340px;overflow-y:auto;"><table class="ehsd-tbl"><thead><tr>'
              + '<th>#</th><th>Login</th><th>Inspeções</th><th>Atrasadas</th><th>Próx. vencimento</th></tr></thead><tbody>';
        ranking.forEach((r, i) => {
            const safe = String(r.login).replace(/</g, '&lt;');
            const overPill = r.overdue > 0 ? `<span class="ehsd-pill over">${r.overdue}</span>` : `<span class="ehsd-pill ok">0</span>`;
            const next = r.nextDue ? r.nextDue.toLocaleDateString('pt-BR') : '—';
            h += `<tr><td style="color:#6b8199;">${i + 1}</td><td style="font-weight:700;">${safe}</td>`
               + `<td style="font-weight:700;color:#ff9900;">${r.count}</td><td>${overPill}</td><td style="color:#9fb4c8;">${next}</td></tr>`;
        });
        return h + '</tbody></table></div>';
    }

    // ── Matriz semanal (Owner × dias Dom-Sáb + Total) ──
    function startOfWeekSun(d) {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        x.setDate(x.getDate() - x.getDay());
        return x;
    }
    function ddmm(d) {
        return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
    }
    function weeksFromRecords(records) {
        const map = {};
        records.forEach(r => {
            const sd = parseEhsDate(r.startDate);   // semana pela Scheduled start date
            if (!sd) return;
            const sun = startOfWeekSun(sd);
            const key = sun.getFullYear() + '-' + (sun.getMonth() + 1) + '-' + sun.getDate();
            if (!map[key]) {
                const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
                map[key] = { key: key, sunday: sun, saturday: sat, records: [] };
            }
            map[key].records.push(r);
        });
        return Object.values(map).sort((a, b) => b.sunday - a.sunday);
    }

    // Lista de semanas para o SELETOR: todas as semanas da data filtrada (cutoff)
    // até a semana atual — mesmo as que ainda não têm registros —, unidas às semanas
    // que têm dados. Assim o dashboard "cria" todas as semanas a partir do corte.
    function buildWeekList(gd) {
        const withData = weeksFromRecords(gd.recs);
        const byKey = {};
        withData.forEach(function (w) { byKey[w.key] = w; });

        let startSun = null;
        if (ehsdCutoff) startSun = startOfWeekSun(ehsdCutoff);
        else if (withData.length) startSun = withData[withData.length - 1].sunday;

        if (startSun) {
            const endSun = startOfWeekSun(new Date());   // semana atual
            const cur = new Date(startSun);
            let guard = 0;
            while (cur <= endSun && guard < 106) {        // trava anti-loop (~2 anos)
                const key = cur.getFullYear() + '-' + (cur.getMonth() + 1) + '-' + cur.getDate();
                if (!byKey[key]) {
                    const sat = new Date(cur); sat.setDate(cur.getDate() + 6);
                    byKey[key] = { key: key, sunday: new Date(cur), saturday: sat, records: [] };
                }
                cur.setDate(cur.getDate() + 7);
                guard++;
            }
        }
        return Object.values(byKey).sort(function (a, b) { return b.sunday - a.sunday; });
    }

    // Seleciona a week ativa de um grupo (default: week do cutoff, senão a mais recente)
    function selectWeek(gd) {
        const weeks = buildWeekList(gd);
        if (!weeks.length) return { weeks: [], wk: null };
        let sel = ehsdWeekSel[gd.g.id];
        if (!sel || !weeks.find(w => w.key === sel)) {
            // Padrão: semana MAIS RECENTE (última). FSI+DOCK sempre usa a última.
            // Default: semana mais recente COM dados (evita cair numa semana vazia gerada).
            const withRecs = weeks.filter(function (w) { return w.records && w.records.length; });
            sel = (withRecs[0] || weeks[0]).key;
            // Area Org: ancora na semana do cutoff (início da quinzena filtrada), se existir,
            // pra que a quinzena comece na data filtrada (ex.: 28/06 → 28/06–11/07).
            if (gd.g.id === 'areaorg' && ehsdCutoff) {
                const cutSun = startOfWeekSun(ehsdCutoff);
                const cutKey = cutSun.getFullYear() + '-' + (cutSun.getMonth() + 1) + '-' + cutSun.getDate();
                if (weeks.find(w => w.key === cutKey)) sel = cutKey;
            }
            ehsdWeekSel[gd.g.id] = sel;
        }
        return { weeks: weeks, wk: weeks.find(w => w.key === sel) };
    }

    // Monta as linhas (owner × dados) EXATAMENTE como a matriz exibe:
    // gestores da config na ORDEM cadastrada + os "não mapeados" (que fizeram) ao final.
    function ehsdBuildOwnerRows(gd, wk) {
        const owners = {};
        // Area Org agrega as 2 semanas do par; FSI+DOCK usa só a semana.
        (wk ? groupWindowRecords(gd, wk) : []).forEach(r => {
            const sd = parseEhsDate(r.startDate);
            if (!sd) return;
            const login = (r.login || '—').trim() || '—';
            const key = login.toLowerCase();
            const idx = sd.getDay();
            if (!owners[key]) owners[key] = { login: login, days: [0, 0, 0, 0, 0, 0, 0], total: 0, completed: 0 };
            owners[key].days[idx]++;
            owners[key].total++;
            if (isDoneStatus(r.status)) owners[key].completed++;
        });
        const cfg = loadMgrCfg();
        const usedKeys = {};
        const mapped = [];
        cfg.forEach(m => {
            const nm = String(m.name || '').trim();
            if (!nm) return;
            const key = nm.toLowerCase();
            if (usedKeys[key]) return;
            usedKeys[key] = true;
            const data = owners[key];
            mapped.push(data
                ? { login: nm, days: data.days, total: data.total, completed: data.completed }
                : { login: nm, days: [0, 0, 0, 0, 0, 0, 0], total: 0, completed: 0 });
        });
        const unmapped = Object.keys(owners).filter(k => !usedKeys[k]).map(k => owners[k])
            .sort((a, b) => b.total - a.total || a.login.localeCompare(b.login));
        return { mapped, unmapped };
    }

    // Exporta XLSX igual ao que aparece na tela: gestores da config na ordem + não mapeados.
    // Quem foi desconsiderado para NÃO fazer (não faz FSI / férias / atestado) não é exportado.
    function exportGroupXlsx(gd, wk) {
        if (typeof XLSX === 'undefined') { alert('⚠️ Biblioteca XLSX não carregou. Recarregue a página (Ctrl+F5).'); return; }
        if (!wk) { alert('⚠️ Nenhuma semana selecionada para exportar.'); return; }
        const isArea = gd.g.id === 'areaorg';
        const built = ehsdBuildOwnerRows(gd, wk);
        const out = [];
        built.mapped.forEach(o => {
            const mgr = findMgrByLogin(o.login);
            const dis = (mgr && mgr.dis) ? mgr.dis : null;
            const excused = dis && (dis.areaOrg === 'ferias' || dis.areaOrg === 'atestado' || (!isArea && dis.fsiAll));
            if (excused) return;
            out.push([o.login, mgr ? shiftLabel(mgr.shift) : '—', o.total]);
        });
        built.unmapped.forEach(o => { out.push([o.login, '—', o.total]); });
        const qtyHeader = isArea ? 'Qtd AO' : 'Qtd FSI+DOCK';
        const aoa = [['Login', 'Turno', qtyHeader]].concat(out);
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, isArea ? 'AO' : 'FSI_DOCK');
        let lbl;
        if (isArea) {
            const rng = areaPairRange(wk);
            lbl = (ddmm(rng.firstSun) + '_' + ddmm(rng.lastSat)).replace(/\//g, '-');
        } else {
            lbl = (ddmm(wk.sunday) + '_' + ddmm(wk.saturday)).replace(/\//g, '-');
        }
        XLSX.writeFile(wb, (isArea ? 'AreaOrg' : 'FSI_DOCK') + '_' + lbl + '.xlsx');
    }

    // ─────────────────────────────────────────────────────────────────
    // EXTRAÇÃO POR DATA FILTRADA, COM ABAS (XLSX)
    // FSI+DOCK  → 1 aba por SEMANA (Dom→Sáb).
    // Area Org  → 1 aba por QUINZENA (semana ímpar + par), com coluna "Semana".
    // Coleta a lista da página (todas as categorias), filtra pela categoria do
    // botão e pela data (Scheduled start date >= data filtrada).
    // ─────────────────────────────────────────────────────────────────
    function _sheetName(s) {
        var n = String(s == null ? 'Aba' : s).replace(/[\\/?*\[\]:]/g, '-').slice(0, 31).trim();
        return n || 'Aba';
    }
    function _recRow(r) {
        var mgr = findMgrByLogin(r.login);
        return [r.login, mgr ? shiftLabel(mgr.shift) : '', r.title, r.status, r.startDate, r.dueDate, r.doneDate];
    }
    async function extractPeriodXlsx(btn, filterDate, kind) {
        if (typeof XLSX === 'undefined') { alert('⚠️ Biblioteca XLSX não carregou. Recarregue a página (Ctrl+F5).'); return; }
        const isArea = kind === 'areaorg';
        const cats = isArea ? ['area_org'] : ['floor', 'dock'];
        const nice = isArea ? 'Area Organization' : 'FSI+DOCK';

        // Aplica o filtro de TEXTO por categoria e pagina para cada termo.
        // FSI+DOCK: digita "floor" (pagina) e depois "dock" (pagina).
        // Area Org: digita "area organization" (pagina).
        const terms = isArea ? ['area organization'] : ['floor', 'dock'];
        let all = [];
        for (const term of terms) {
            setBtnProgress(btn, '⏳ filtrando "' + term + '"…', '#e6a817');
            fillSearchInput(term);
            await sleep(CONFIG.SEARCH_WAIT);
            const part = await paginateCollect(function (page, count) {
                setBtnProgress(btn, '⏳ ' + term + ' — pág. ' + page + ' (' + count + ')', '#e6a817');
            });
            all = all.concat(part);
        }
        // Dedup defensivo (caso algum título case com mais de um termo)
        const seenRec = {};
        all = all.filter(function (r) {
            const k = [r.login, r.title, r.startDate, r.dueDate].join('|');
            if (seenRec[k]) return false; seenRec[k] = true; return true;
        });

        var recs = all.filter(function (r) { return cats.indexOf(r.category) !== -1; });
        if (filterDate) {
            var minMs = new Date(filterDate.getFullYear(), filterDate.getMonth(), filterDate.getDate()).getTime();
            recs = recs.filter(function (r) {
                var sd = parseEhsDate(r.startDate);
                return sd && new Date(sd.getFullYear(), sd.getMonth(), sd.getDate()).getTime() >= minMs;
            });
        }
        if (!recs.length) {
            alert('⚠️ Nenhum registro de ' + nice + ' a partir da data filtrada.\n\n'
                + 'Confirme que a lista da página mostra as inspeções (de preferência SEM filtro de categoria) e que a data foi aplicada.');
            btn.textContent = '⚠️ nada encontrado';
            return;
        }

        const wb = XLSX.utils.book_new();
        const used = {};
        function addSheet(name, aoa) {
            var nm = _sheetName(name), i = 2;
            while (used[nm.toLowerCase()]) { nm = _sheetName(String(name).slice(0, 27) + ' (' + i + ')'); i++; }
            used[nm.toLowerCase()] = true;
            var ws = XLSX.utils.aoa_to_sheet(aoa);
            ws['!cols'] = aoa[0].map(function () { return { wch: 16 }; });
            XLSX.utils.book_append_sheet(wb, ws, nm);
        }

        if (isArea) {
            // Agrupa por QUINZENA (par ímpar+par)
            const groups = {};
            recs.forEach(function (r) {
                var sd = parseEhsDate(r.startDate); if (!sd) return;
                var sun = startOfWeekSun(sd);
                var n = getWeekNumberSunSat(sun);
                var oddSun = new Date(sun); if (n % 2 === 0) oddSun.setDate(oddSun.getDate() - 7);
                var pk = oddSun.getTime();
                if (!groups[pk]) groups[pk] = { oddSun: oddSun, rows: [] };
                groups[pk].rows.push({ r: r, n: n, tag: (n % 2 === 1 ? 'Ímpar (W' + n + ')' : 'Par (W' + n + ')') });
            });
            Object.keys(groups).map(Number).sort(function (a, b) { return a - b; }).forEach(function (pk) {
                var g = groups[pk];
                var oddN = getWeekNumberSunSat(g.oddSun);
                var lastSat = new Date(g.oddSun); lastSat.setDate(g.oddSun.getDate() + 13);
                var name = 'W' + oddN + '-W' + (oddN + 1) + ' ' + ddmm(g.oddSun).replace('/', '-') + '_' + ddmm(lastSat).replace('/', '-');
                g.rows.sort(function (a, b) { return a.n - b.n || String(a.r.login).localeCompare(String(b.r.login)); });
                var aoa = [['Semana', 'Login', 'Turno', 'Título', 'Status', 'Data início', 'Prazo', 'Concluído em']];
                g.rows.forEach(function (x) { aoa.push([x.tag].concat(_recRow(x.r))); });
                addSheet(name, aoa);
            });
        } else {
            // Agrupa por SEMANA (Dom→Sáb)
            const gw = {};
            recs.forEach(function (r) {
                var sd = parseEhsDate(r.startDate); if (!sd) return;
                var sun = startOfWeekSun(sd);
                var key = sun.getTime();
                if (!gw[key]) gw[key] = { sun: sun, rows: [] };
                gw[key].rows.push(r);
            });
            Object.keys(gw).map(Number).sort(function (a, b) { return a - b; }).forEach(function (key) {
                var g = gw[key];
                var sat = new Date(g.sun); sat.setDate(g.sun.getDate() + 6);
                var name = 'W' + getWeekNumberSunSat(g.sun) + ' ' + ddmm(g.sun).replace('/', '-') + '_' + ddmm(sat).replace('/', '-');
                g.rows.sort(function (a, b) { return String(a.login).localeCompare(String(b.login)); });
                var aoa = [['Login', 'Turno', 'Título', 'Status', 'Data início', 'Prazo', 'Concluído em']];
                g.rows.forEach(function (r) { aoa.push(_recRow(r)); });
                addSheet(name, aoa);
            });
        }

        var dLbl = filterDate
            ? (String(filterDate.getMonth() + 1).padStart(2, '0') + '-' + String(filterDate.getDate()).padStart(2, '0') + '-' + filterDate.getFullYear())
            : 'todos';
        XLSX.writeFile(wb, (isArea ? 'AreaOrg_quinzenal' : 'FSI_DOCK_semanal') + '_apartir_' + dLbl + '.xlsx');
        btn.textContent = '✅ ' + recs.length + ' reg.';
    }

    // ── Integração Slack (Incoming Webhook) — cobrança de quem não bateu a meta ──
    const SLACK_WEBHOOK_KEY = 'ehs_slack_webhook';
    const EMAIL_TO_KEY = 'ehs_email_to';             // destinatário(s) do email report
    const FCLM_WAREHOUSE = 'GRU5';   // warehouseId usado nos links do FCLM
    function getSlackWebhook() { return (localStorage.getItem(SLACK_WEBHOOK_KEY) || '').trim(); }
    function getEmailTo() { return (localStorage.getItem(EMAIL_TO_KEY) || '').trim(); }

    // Monta o link clicável do Slack para o login (abre o FCLM Time Details do funcionário).
    function slackLoginLink(login) {
        const lg  = String(login || '').replace(/^@/, '').trim();
        const url = 'https://fclm-portal.amazon.com/employee/timeDetails?reportFormat=HTML'
                  + '&employeeId=' + encodeURIComponent(lg) + '&warehouseId=' + FCLM_WAREHOUSE;
        return '<' + url + '|@' + lg + '>';   // formato mrkdwn: <url|texto>
    }

    function buildSlackCobranca(gd, wk) {
        const comp = ehsdWeekCompliance(gd, wk);
        const wkLabel = wk ? (ddmm(wk.sunday) + ' a ' + ddmm(wk.saturday)) : '';
        let txt = ':rotating_light: *Cobrança ' + gd.g.label + '* — Semana ' + wkLabel + '\n';
        txt += 'Compliance atual: *' + Math.round(comp.pct) + '%* (' + comp.compliant + '/' + comp.total + ')\n\n';
        if (!comp.non.length) {
            txt += ':white_check_mark: Todos os gestores bateram a meta!';
            return txt;
        }
        txt += '*Ainda não bateram a meta (' + comp.non.length + '):*\n';

        // Agrupa por turno (na ordem de SHIFTS); turnos sem ninguém são omitidos.
        const byShift = {};
        comp.non.forEach(it => {
            const mgr = findMgrByLogin(it.login);
            const sh = (mgr && mgr.shift) ? mgr.shift : '';
            (byShift[sh] = byShift[sh] || []).push(it);
        });
        const known = SHIFTS.map(s => s.v);
        const order = known
            .concat(Object.keys(byShift).filter(k => k && known.indexOf(k) === -1))   // turnos desconhecidos
            .concat(['']);                                                            // sem turno por último

        order.forEach(sh => {
            const list = byShift[sh];
            if (!list || !list.length) return;
            txt += '\n*' + (sh ? shiftLabel(sh) : 'Sem turno') + '* (' + list.length + ')\n';
            list.forEach(it => {
                const falta = Math.max(it.meta - it.completed, 0);
                const at = slackLoginLink(it.login);   // link clicável → FCLM do login
                txt += '• ' + at + ' — ' + it.completed + '/' + it.meta + ' (faltam ' + falta + ')\n';
            });
        });
        return txt;
    }

    function sendSlackCobranca(gd, wk) {
        let wh = getSlackWebhook();
        if (!wh) {
            wh = prompt('🔗 Integração Slack (EHS):\nCole a URL do Incoming Webhook do seu canal:\n(ex.: https://hooks.slack.com/services/...)');
            if (!wh) return;
            wh = wh.trim();
            localStorage.setItem(SLACK_WEBHOOK_KEY, wh);
        }
        const text = buildSlackCobranca(gd, wk);
        if (!confirm('Enviar cobrança de "' + gd.g.label + '" para o Slack?\n\n— Prévia —\n\n' + text.slice(0, 600))) return;
        GM_xmlhttpRequest({
            method: 'POST',
            url: wh,
            data: JSON.stringify({ text: text }),
            headers: { 'Content-Type': 'application/json' },
            onload: res => {
                if (res.status >= 200 && res.status < 300) alert('✅ Cobrança de ' + gd.g.label + ' enviada para o Slack!');
                else if (confirm('❌ Erro ' + res.status + ' ao enviar. Deseja resetar o webhook?')) localStorage.removeItem(SLACK_WEBHOOK_KEY);
            },
            onerror: () => alert('❌ Falha de conexão ao enviar para o Slack.'),
        });
    }

    // ── EMAIL REPORT (HTML) — copia o corpo formatado e abre um email novo ──
    // Monta o mesmo conteúdo da cobrança (por turno) em HTML, com os logins linkados ao FCLM.
    function buildEmailHtml(gd, wk) {
        const comp = ehsdWeekCompliance(gd, wk);
        const wkLabel = wk ? (ddmm(wk.sunday) + ' a ' + ddmm(wk.saturday)) : '';
        const linkOf = (login) => {
            const lg = String(login || '').replace(/^@/, '').trim();
            const url = 'https://fclm-portal.amazon.com/employee/timeDetails?reportFormat=HTML'
                      + '&employeeId=' + encodeURIComponent(lg) + '&warehouseId=' + FCLM_WAREHOUSE;
            return '<a href="' + url + '" style="color:#1f6fd6;text-decoration:none;">' + lg + '</a>';
        };

        let h = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">';
        h += '<h2 style="color:#c0392b;margin:0 0 6px;">Cobrança ' + gd.g.label + ' — Semana ' + wkLabel + '</h2>';
        h += '<p style="margin:0 0 12px;">Compliance atual: <b>' + Math.round(comp.pct) + '%</b> ('
           + comp.compliant + '/' + comp.total + ')</p>';

        if (!comp.non.length) {
            h += '<p style="color:#27ae60;font-weight:bold;">✅ Todos os gestores bateram a meta!</p></div>';
            return h;
        }

        h += '<p style="font-weight:bold;margin:0 0 6px;">Ainda não bateram a meta (' + comp.non.length + '):</p>';

        // Agrupa por turno (mesma lógica do Slack)
        const byShift = {};
        comp.non.forEach(it => {
            const mgr = findMgrByLogin(it.login);
            const sh = (mgr && mgr.shift) ? mgr.shift : '';
            (byShift[sh] = byShift[sh] || []).push(it);
        });
        const known = SHIFTS.map(s => s.v);
        const order = known.concat(Object.keys(byShift).filter(k => k && known.indexOf(k) === -1)).concat(['']);

        order.forEach(sh => {
            const list = byShift[sh];
            if (!list || !list.length) return;
            h += '<h3 style="margin:14px 0 4px;color:#2c3e50;">' + (sh ? shiftLabel(sh) : 'Sem turno')
               + ' (' + list.length + ')</h3>';
            h += '<table style="border-collapse:collapse;width:100%;max-width:520px;font-size:13px;">';
            h += '<tr style="background:#2c3e50;color:#fff;">'
               + '<th style="text-align:left;padding:6px 10px;border:1px solid #cfd8dc;">Login</th>'
               + '<th style="padding:6px 10px;border:1px solid #cfd8dc;">Realizadas</th>'
               + '<th style="padding:6px 10px;border:1px solid #cfd8dc;">Faltam</th></tr>';
            list.forEach((it, i) => {
                const falta = Math.max(it.meta - it.completed, 0);
                const bg = (i % 2) ? '#f7f9fb' : '#ffffff';
                h += '<tr style="background:' + bg + ';">'
                   + '<td style="padding:6px 10px;border:1px solid #cfd8dc;">' + linkOf(it.login) + '</td>'
                   + '<td style="text-align:center;padding:6px 10px;border:1px solid #cfd8dc;">' + it.completed + '/' + it.meta + '</td>'
                   + '<td style="text-align:center;padding:6px 10px;border:1px solid #cfd8dc;color:#c0392b;font-weight:bold;">' + falta + '</td></tr>';
            });
            h += '</table>';
        });
        h += '</div>';
        return h;
    }

    // Copia HTML "rico" (formatado) para o clipboard — cola no Outlook renderizado, não como código.
    function copyRichHtml(html) {
        const div = document.createElement('div');
        div.contentEditable = 'true';
        div.innerHTML = html;
        div.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(div);
        const range = document.createRange();
        range.selectNodeContents(div);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        sel.removeAllRanges();
        div.remove();
        return ok;
    }

    function sendEmailReport(gd, wk) {
        const html = buildEmailHtml(gd, wk);
        const wkLabel = wk ? (ddmm(wk.sunday) + ' a ' + ddmm(wk.saturday)) : '';
        const subject = 'Cobrança ' + gd.g.label + ' — Semana ' + wkLabel;

        // Destinatário: pergunta 1x e memoriza (separe vários por vírgula). Fica salvo p/ as próximas.
        let to = getEmailTo();
        if (!to) {
            to = (prompt('✉️ Email(s) de destino do report:\n(separe vários por vírgula)') || '').trim();
            if (to) localStorage.setItem(EMAIL_TO_KEY, to);
        }

        const ok = copyRichHtml(html);   // copia primeiro (síncrono, dentro do clique)

        if (ok) {
            // Abre um email novo já endereçado (corpo vazio) — o usuário cola (Ctrl+V) o HTML.
            window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject);
            alert('✅ Email HTML copiado!\n\nUm email novo foi aberto' + (to ? ' para: ' + to : '')
                + '.\nClique no corpo e cole (Ctrl+V) — aparece formatado, com a tabela por turno.');
        } else {
            // Fallback: abre uma janela com o HTML renderizado pra copiar manualmente.
            const w = window.open('', '_blank');
            if (w) {
                w.document.write('<title>Email report — ' + gd.g.label + '</title>'
                    + '<p style="font-family:Arial;color:#555;">Selecione tudo (Ctrl+A), copie (Ctrl+C) e cole no corpo do email:</p><hr>'
                    + html);
                w.document.close();
            } else {
                alert('⚠️ Não consegui copiar nem abrir a janela. Verifique o bloqueador de pop-ups.');
            }
        }
    }

    // ── META GERAL por grupo (alimenta "Inspeções faltantes" e "% da meta") ──
    function getMeta(groupId, wk) {
        var g = loadGeneralMeta();
        return groupId === 'areaorg' ? g.areaorg : g.fsidock;
    }

    // "Gestores responsáveis" = total cadastrado na config (quem é cobrado).
    // Fallback: se a config estiver vazia, conta os logins únicos que fizeram inspeção na semana.
    function responsibleCount(wsel) {
        var n = loadMgrCfg().length;
        if (n > 0) return n;
        return wsel ? new Set(wsel.records.map(function (r) { return (r.login || '—').trim() || '—'; })).size : 0;
    }

    // Compliance da semana por grupo: para cada gestor da config, compara concluídas × meta individual.
    // Retorna total, quantos cumpriram (compliant), % e a lista dos que NÃO bateram.
    function ehsdWeekCompliance(gd, wk) {
        const isArea = gd.g.id === 'areaorg';
        const owners = {};
        // Area Org soma as concluídas das 2 semanas do par; FSI+DOCK só a semana.
        (wk ? groupWindowRecords(gd, wk) : []).forEach(r => {
            const key = ((r.login || '—').trim() || '—').toLowerCase();
            if (!owners[key]) owners[key] = { completed: 0 };
            if (isDoneStatus(r.status)) owners[key].completed++;
        });
        const cfg = loadMgrCfg();
        let compliant = 0, total = 0;
        const non = [];
        cfg.forEach(m => {
            const nm = String(m.name || '').trim();
            if (!nm) return;
            const completed = owners[nm.toLowerCase()] ? owners[nm.toLowerCase()].completed : 0;
            const meta = isArea ? individualAreaMeta(m) : individualFsiMeta(m, wk);
            total++;
            if (meta == null || completed >= meta) compliant++;
            else non.push({ login: nm, completed: completed, meta: meta });
        });
        const pct = total ? (compliant / total) * 100 : 0;
        return { total, compliant, pct, non };
    }

    // Gráfico de pizza (donut) de compliance.
    function ehsdPie(pct, compliant, total) {
        const p = Math.max(0, Math.min(100, Math.round(pct)));
        const color = p >= 90 ? '#34d399' : p >= 70 ? '#ffb347' : '#ff7a7a';
        return `<div style="display:flex;align-items:center;gap:16px;justify-content:center;margin:4px 0 16px;">
            <div style="width:104px;height:104px;border-radius:50%;flex-shrink:0;
                background:conic-gradient(${color} ${p * 3.6}deg, #1f3a57 0);
                display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.35);">
                <div style="width:72px;height:72px;border-radius:50%;background:#0d1b2a;display:flex;flex-direction:column;
                    align-items:center;justify-content:center;">
                    <div style="font-size:22px;font-weight:800;color:${color};line-height:1;">${p}%</div>
                    <div style="font-size:8px;color:#6b8199;text-transform:uppercase;letter-spacing:.06em;margin-top:3px;">Compliance</div>
                </div>
            </div>
            <div style="font-size:12px;line-height:1.7;">
                <div style="color:#34d399;font-weight:700;">● Bateram a meta: ${compliant}</div>
                <div style="color:#ff7a7a;font-weight:700;">● Não bateram: ${total - compliant}</div>
                <div style="color:#6b8199;margin-top:2px;">Total de gestores: ${total}</div>
            </div>
        </div>`;
    }

    // Lista somente os gestores que NÃO bateram a meta semanal.
    function ehsdNonCompliantList(items) {
        if (!items.length) {
            return '<p style="color:#34d399;font-size:12.5px;text-align:center;padding:16px 0;font-weight:700;">✅ Todos os gestores bateram a meta!</p>';
        }
        let h = '<div style="font-size:11px;font-weight:700;color:#ff7a7a;text-transform:uppercase;letter-spacing:.05em;margin:6px 0 8px;">⚠️ Não bateram a meta (' + items.length + ')</div>';
        h += '<div style="max-height:320px;overflow:auto;">';
        items.forEach(it => {
            const falta = Math.max(it.meta - it.completed, 0);
            h += `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-bottom:1px solid #16273c;font-size:12px;">
                <span style="color:#e6edf3;font-weight:600;">${String(it.login).replace(/</g, '&lt;')}</span>
                <span style="color:#ff7a7a;font-weight:800;">${it.completed}/${it.meta} <span style="color:#6b8199;font-weight:500;">(faltam ${falta})</span></span>
            </div>`;
        });
        h += '</div>';
        return h;
    }

    // KPIs por semana: realizadas / responsáveis / faltantes / % da meta
    function ehsdWeekKpis(realizadas, auditores, meta, hideFaltantes) {
        const faltam = (meta != null) ? Math.max(meta - realizadas, 0) : null;
        const pct    = (meta != null && meta > 0) ? Math.round((realizadas / meta) * 100) : null;
        const cardFaltantes = hideFaltantes ? '' :
            `<div class="ehsd-kpi danger"><div class="v">${faltam == null ? '—' : faltam}</div><div class="l">Inspeções faltantes</div></div>`;
        return `<div class="ehsd-grid${hideFaltantes ? ' ehsd-grid-center' : ''}">
            <div class="ehsd-kpi accent"><div class="v">${realizadas}</div><div class="l">Inspeções realizadas</div></div>
            <div class="ehsd-kpi info"><div class="v">${auditores}</div><div class="l">Gestores responsáveis</div></div>
            ${cardFaltantes}
            <div class="ehsd-kpi ok"><div class="v">${pct == null ? '—' : pct + '%'}</div><div class="l">% da meta</div></div>
        </div>`;
    }

    function ehsdWeeklyMatrix(gd) {
        const { weeks, wk } = selectWeek(gd);
        if (!weeks.length) return '<div class="ehsd-empty">Sem datas válidas para montar a semana.</div>';
        const sel = wk.key;
        const isAreaGrp = gd.g.id === 'areaorg';

        // Seletor de período: Area Org mostra QUINZENAS (par de semanas); os demais, semanas.
        let pills = '<div class="ehsd-wk-bar"><span class="ehsd-wk-lead">'
                  + (isAreaGrp ? 'Quinzena:' : 'Semana:') + '</span>';
        if (isAreaGrp) {
            const seenPairs = {};
            weeks.forEach(w => {
                const pk = pairKeyOf(w);
                if (seenPairs[pk]) return;
                seenPairs[pk] = true;
                const rng = areaPairRange(w);
                const on = pairKeyOf(w) === pairKeyOf(wk);
                pills += `<button class="ehsd-wk${on ? ' on' : ''}" data-wk="${w.key}" data-grp="${gd.g.id}">`
                       + `${on ? '⭐ ' : ''}${ddmm(rng.firstSun)} — ${ddmm(rng.lastSat)}</button>`;
            });
        } else {
            weeks.forEach(w => {
                const on = w.key === sel;
                pills += `<button class="ehsd-wk${on ? ' on' : ''}" data-wk="${w.key}" data-grp="${gd.g.id}">`
                       + `${on ? '⭐ ' : ''}${ddmm(w.sunday)} — ${ddmm(w.saturday)}</button>`;
            });
        }
        // Filtro por meta individual: Todos / Não bateram / Bateram
        const mf = ehsdMetaFilter[gd.g.id] || 'all';
        const mfStyle = (on) => `background:${on ? '#2e7d32' : '#13243a'};color:${on ? '#fff' : '#9fb4cc'};`
            + `border:1px solid ${on ? '#2e7d32' : '#24405f'};border-radius:8px;padding:6px 10px;font-size:11px;`
            + `font-weight:800;cursor:pointer;transition:all .15s;`;
        const mfBtn = (val, label) => `<button class="ehsd-metaf" data-metaf="${val}" data-grp="${gd.g.id}" `
            + `style="${mfStyle(mf === val)}">${label}</button>`;
        pills += `<span style="display:inline-flex;gap:4px;margin-left:12px;">`
               + mfBtn('all', 'Todos') + mfBtn('notmet', '❌ Não bateram') + mfBtn('met', '✅ Bateram') + `</span>`;

        pills += `<button class="ehsd-export-xlsx" data-grp="${gd.g.id}" style="margin-left:auto;background:#13243a;`
               + `border:1px solid #2e7d32;color:#5fd38a;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:800;`
               + `cursor:pointer;transition:all .15s;">📥 Extrair XLSX</button>`;
        pills += '</div>';

        // Agregação por owner × dia da semana
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const todayIdx = (today >= wk.sunday && today <= wk.saturday) ? today.getDay() : -1;
        // Mesma fonte de dados do export (config na ordem + não mapeados)
        const built = ehsdBuildOwnerRows(gd, wk);
        // Aplica o filtro por meta individual (Todos / Não bateram / Bateram)
        const metaMatch = (o) => {
            if (mf === 'all') return true;
            const mgr = findMgrByLogin(o.login);
            const mi = isAreaGrp ? individualAreaMeta(mgr) : individualFsiMeta(mgr, wk);
            if (mi == null) return false;             // sem meta definida → fora dos filtros específicos
            const ok = o.completed >= mi;
            return mf === 'met' ? ok : !ok;
        };
        const rows = built.mapped.filter(metaMatch);
        // "Não mapeados" (sem meta) só aparecem quando o filtro é "Todos"
        if (mf === 'all' && built.unmapped.length) {
            rows.push({ separator: true, label: '⚠️ Responsáveis não mapeados (' + built.unmapped.length + ')' });
            built.unmapped.forEach(o => rows.push(o));
        }

        const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const dowCodes = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
        const colDates = [];
        for (let i = 0; i < 7; i++) { const d = new Date(wk.sunday); d.setDate(wk.sunday.getDate() + i); colDates.push(d); }

        // Area Org: em vez de dia-a-dia, mostra 2 colunas (semana ÍMPAR e PAR do par
        // quinzenal). Aqui contamos, por owner, quanto caiu em cada semana do par.
        let areaWeekCounts = null, oddNum = 0, evenNum = 0, oddSun = null, oddSat = null, evenSun = null, evenSat = null;
        if (isAreaGrp) {
            const rng = areaPairRange(wk);
            oddSun  = rng.firstSun;
            oddSat  = new Date(oddSun);  oddSat.setDate(oddSun.getDate() + 6);
            evenSun = new Date(oddSun);  evenSun.setDate(oddSun.getDate() + 7);
            evenSat = rng.lastSat;
            oddNum  = getWeekNumberSunSat(oddSun);
            evenNum = oddNum + 1;
            areaWeekCounts = {};
            groupWindowWeeks(gd, wk).forEach(w => {
                const isOdd = getWeekNumberSunSat(w.sunday) % 2 === 1;
                w.records.forEach(r => {
                    const key = ((r.login || '—').trim() || '—').toLowerCase();
                    if (!areaWeekCounts[key]) areaWeekCounts[key] = { odd: 0, even: 0 };
                    if (isOdd) areaWeekCounts[key].odd++; else areaWeekCounts[key].even++;
                });
            });
        }
        // Nº total de colunas (para colspan): # + Owner + colunas de valor + Total + ✔
        const totalCols = (isAreaGrp ? 2 : 7) + 4;

        let h = '<div class="ehsd-matrix-wrap"><table class="ehsd-matrix"><thead><tr>';
        h += '<th class="ehsd-mx-num" title="Nº da linha">#</th>';
        h += '<th class="ehsd-mx-owner">👤 Owner</th>';
        if (isAreaGrp) {
            h += `<th>W${String(oddNum).padStart(2, '0')} <span style="opacity:.7;">(ímpar)</span><span>${ddmm(oddSun)}–${ddmm(oddSat)}</span></th>`;
            h += `<th>W${String(evenNum).padStart(2, '0')} <span style="opacity:.7;">(par)</span><span>${ddmm(evenSun)}–${ddmm(evenSat)}</span></th>`;
        } else {
            dayNames.forEach((dn, i) => {
                h += `<th class="${i === todayIdx ? 'today' : ''}">${dn}<span>${ddmm(colDates[i])}</span></th>`;
            });
        }
        h += '<th class="ehsd-mx-total">Total</th><th class="ehsd-mx-chk" title="Realizadas (Completed + Submitted)">✔</th></tr></thead><tbody>';
        let rowNum = 0;
        rows.forEach(o => {
            if (o.separator) {
                rowNum = 0;   // reinicia a numeração para a seção "não mapeados"
                h += '<tr><td colspan="' + totalCols + '" style="background:#13243a;color:#ffb347;font-weight:800;font-size:11px;'
                   + 'text-transform:uppercase;letter-spacing:.04em;padding:9px 10px;border-top:2px solid #ff9900;">'
                   + o.label + '</td></tr>';
                return;
            }
            rowNum++;
            const mgr = findMgrByLogin(o.login);
            const dis = (mgr && mgr.dis) ? mgr.dis : null;
            const fsiAllOff = dis && dis.fsiAll && gd.g.id !== 'areaorg';   // só faz Area Org
            const fullOff = (dis && (dis.areaOrg === 'ferias' || dis.areaOrg === 'atestado')) || fsiAllOff;  // zera todos os FSI
            const offIcon = (dis && dis.areaOrg === 'ferias') ? '🏖️' : (dis && dis.areaOrg === 'atestado') ? '🩺' : fsiAllOff ? '🚷' : '';
            const offTip = (dis && dis.areaOrg === 'ferias') ? 'Férias — todos os FSI desconsiderados' : (dis && dis.areaOrg === 'atestado') ? 'Atestado — todos os FSI desconsiderados' : fsiAllOff ? 'Não faz FSI+DOCK' : '';
            const ownerTag = fullOff ? ' <span title="' + offTip + '" style="font-size:11px;">' + offIcon + '</span>' : '';
            // (Des)considerar por clique: FSI+DOCK usa dia/semana; Area Org usa o Total (Atestado).
            const canDisregard = !isAreaGrp && !!mgr;         // FSI+DOCK
            const canAreaDisregard = isAreaGrp && !!mgr;      // Area Org (Total → Atestado)
            const loginAttr = String(o.login).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
            h += '<tr><td class="ehsd-mx-num">' + rowNum + '</td>';
            h += '<td class="ehsd-mx-owner">' + String(o.login).replace(/</g, '&lt;') + ownerTag + '</td>';
            if (isAreaGrp) {
                // Area Org: 2 colunas (semana ímpar e par do par quinzenal).
                const wc = areaWeekCounts[o.login.toLowerCase()] || { odd: 0, even: 0 };
                [wc.odd, wc.even].forEach(cnt => {
                    if (fullOff) {
                        const inner = cnt > 0 ? (cnt + ' 🚫') : '🚫';
                        h += `<td class="ehsd-mx-cell" title="${offTip}" `
                           + `style="background:repeating-linear-gradient(45deg,rgba(255,153,0,.10),rgba(255,153,0,.10) 6px,rgba(255,153,0,.02) 6px,rgba(255,153,0,.02) 12px);color:#ffb347;font-weight:700;">${inner}</td>`;
                    } else {
                        h += `<td class="ehsd-mx-cell${cnt > 0 ? ' has' : ''}">${cnt > 0 ? cnt : '—'}</td>`;
                    }
                });
            } else {
                for (let i = 0; i < 7; i++) {
                    const v = o.days[i];
                    // dia desconsiderado? (Férias/Atestado/Não faz FSI = todos; senão os dias FSI marcados)
                    const dayOff = fullOff || (dis && (dis.fsiDays || []).indexOf(dowCodes[i]) !== -1);
                    // Clicável só quando não está em férias/atestado/fsiAll (fullOff).
                    const dayClickable = canDisregard && !fullOff;
                    const dataAttrs = dayClickable ? ` data-login="${loginAttr}" data-dow="${dowCodes[i]}"` : '';
                    if (dayOff) {
                        const tip = fullOff ? offTip : 'Desconsiderado — clique para reconsiderar';
                        const inner = v > 0 ? (v + ' 🚫') : '🚫';
                        const cls = 'ehsd-mx-cell' + (i === todayIdx ? ' today' : '') + (dayClickable ? ' ehsd-day-click' : '');
                        h += `<td class="${cls}"${dataAttrs} title="${tip}" `
                           + `style="background:repeating-linear-gradient(45deg,rgba(255,153,0,.10),rgba(255,153,0,.10) 6px,rgba(255,153,0,.02) 6px,rgba(255,153,0,.02) 12px);color:#ffb347;font-weight:700;${dayClickable ? 'cursor:pointer;' : ''}">${inner}</td>`;
                    } else {
                        const cls = 'ehsd-mx-cell' + (v > 0 ? ' has' : '') + (i === todayIdx ? ' today' : '') + (dayClickable ? ' ehsd-day-click' : '');
                        const tip = dayClickable ? ' title="Clique para desconsiderar este dia"' : '';
                        h += `<td class="${cls}"${dataAttrs}${tip}${dayClickable ? ' style="cursor:pointer;"' : ''}>${v > 0 ? v : '—'}</td>`;
                    }
                }
            }
            // Meta individual → colore a coluna ✔ (verde bateu / vermelho não bateu).
            // o.completed já é o total da janela (quinzena p/ Area Org; semana p/ FSI+DOCK).
            const metaInd = isAreaGrp ? individualAreaMeta(mgr) : individualFsiMeta(mgr, wk);
            let chk;
            if (metaInd == null) {
                chk = `<td class="ehsd-mx-chk">${o.completed}</td>`;
            } else {
                const ok = o.completed >= metaInd;
                const stl = ok ? 'background:rgba(39,174,96,.20);color:#34d399;font-weight:800;'
                               : 'background:rgba(192,57,43,.20);color:#ff7a7a;font-weight:800;';
                const title = isAreaGrp
                    ? `Meta quinzenal: ${metaInd} · Realizadas na quinzena: ${o.completed}`
                    : `Meta individual: ${metaInd} · Realizadas: ${o.completed}`;
                chk = `<td class="ehsd-mx-chk" style="${stl}" title="${title}">${o.completed}/${metaInd}</td>`;
            }
            let totCls = 'ehsd-mx-total', totAttrs = '';
            if (canDisregard) {
                totCls += ' ehsd-total-click';
                totAttrs = ` data-login="${loginAttr}" title="Clique para desconsiderar/reconsiderar a semana toda" style="cursor:pointer;"`;
            } else if (canAreaDisregard) {
                totCls += ' ehsd-areatotal-click';
                totAttrs = ` data-login="${loginAttr}" title="Clique para desconsiderar/reconsiderar por Atestado (quinzena)" style="cursor:pointer;"`;
            }
            h += `<td class="${totCls}"${totAttrs}>${o.total}</td>` + chk + '</tr>';
        });
        if (!rows.some(r => !r.separator)) {
            const msg = mf === 'met' ? 'Ninguém bateu a meta neste filtro.'
                      : mf === 'notmet' ? '✅ Todos bateram a meta!' : 'Sem responsáveis para exibir.';
            h += '<tr><td colspan="' + totalCols + '" style="text-align:center;color:#6b8199;padding:16px;font-weight:600;">' + msg + '</td></tr>';
        }
        h += '</tbody></table></div>';
        if (isAreaGrp) {
            const rng = areaPairRange(wk);
            h += `<div style="font-size:11px;color:#ffb347;margin-top:7px;font-weight:700;">`
               + `📌 Janela quinzenal: ${ddmm(rng.firstSun)} — ${ddmm(rng.lastSat)} · contagem somada das 2 semanas (por dia da semana).</div>`;
        }
        h += '<div style="font-size:10.5px;color:#6b8199;margin-top:7px;display:flex;gap:14px;flex-wrap:wrap;">'
           + '<span>🚫 dia desconsiderado</span><span>🚷 não faz FSI+DOCK</span><span>🏖️ férias</span><span>🩺 atestado <span style="opacity:.7;">(zera todos os FSI)</span></span></div>';
        if (!isAreaGrp) {
            h += '<div style="font-size:10.5px;color:#8aa1b6;margin-top:5px;">'
               + '💡 Clique numa célula de <b>dia</b> para desconsiderar/reconsiderar; clique no <b>Total</b> para a semana toda. Salva na desconsideração do gestor (⚙️).</div>';
        } else {
            h += '<div style="font-size:10.5px;color:#8aa1b6;margin-top:5px;">'
               + '💡 Clique no <b>Total</b> para desconsiderar/reconsiderar por <b>Atestado</b> (zera a meta da quinzena). Salva na desconsideração do gestor (⚙️).</div>';
        }
        return pills + h;
    }

    function ehsdKpis(st) {
        return `<div class="ehsd-grid">
            <div class="ehsd-kpi accent"><div class="v">${st.total}</div><div class="l">Inspeções</div></div>
            <div class="ehsd-kpi info"><div class="v">${st.assignees}</div><div class="l">Responsáveis</div></div>
            <div class="ehsd-kpi danger"><div class="v">${st.overdue}</div><div class="l">Atrasadas</div></div>
            <div class="ehsd-kpi ok"><div class="v">${st.onTimePct}%</div><div class="l">No prazo</div></div>
        </div>`;
    }

    function ehsdRenderBody() {
        const store = loadDashStore();
        const body = document.getElementById('ehsd-body');
        if (!body) return;

        const groupsData = DASH_GROUPS.map(g => ({ g: g, recs: groupRecords(store, g.types), st: null }));
        groupsData.forEach(gd => gd.st = dashStats(gd.recs));
        const hasAny = groupsData.some(gd => gd.recs.length > 0);

        if (!hasAny) {
            body.innerHTML = `<div class="ehsd-empty">📭 Nenhum dado coletado ainda.<br><br>
                Use os botões <b>🚢 Dock</b>, <b>🏢 Floor</b> e <b>📋 Area Org</b> e faça uma coleta
                (<b>📥 Download Week</b>) — os dados aparecem aqui automaticamente.</div>`;
            return;
        }

        if (ehsdActiveTab === 'overview') {
            const slackIcon = '<svg width="14" height="14" viewBox="0 0 122.8 122.8" style="vertical-align:-2px;margin-right:6px;">'
                + '<path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#e01e5a"/>'
                + '<path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#e01e5a"/>'
                + '<path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36c5f0"/>'
                + '<path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36c5f0"/>'
                + '<path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2eb67d"/>'
                + '<path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2eb67d"/>'
                + '<path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ecb22e"/>'
                + '<path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ecb22e"/>'
                + '</svg>';
            let h = '<div class="ehsd-cmp">';
            groupsData.forEach(gd => {
                h += `<div class="ehsd-section"><div class="ehsd-section-hd">${gd.g.icon} ${gd.g.label}</div>
                    <div class="ehsd-section-bd">`;
                if (!gd.recs.length) {
                    h += '<p style="color:#6b8199;font-size:12px;text-align:center;padding:20px 0;">Sem coleta para este grupo</p>';
                } else {
                    const wsel = selectWeek(gd).wk;
                    const realizadas = wsel ? groupWindowRecords(gd, wsel).length : 0;
                    const auditores  = responsibleCount(wsel);
                    const meta = getMeta(gd.g.id, wsel);
                    const comp = ehsdWeekCompliance(gd, wsel);
                    h += ehsdWeekKpis(realizadas, auditores, meta, true)
                       + ehsdPie(comp.pct, comp.compliant, comp.total)
                       + ehsdNonCompliantList(comp.non)
                       + `<div style="display:flex;gap:8px;margin-top:14px;">
                            <button class="ehsd-act-btn" data-grp="${gd.g.id}" data-act="slack"
                                style="flex:1;background:#fff;color:#1d1c1d;border:1px solid #e0e0e0;
                                border-radius:10px;padding:10px;font-size:12px;font-weight:800;cursor:pointer;transition:filter .15s;
                                display:flex;align-items:center;justify-content:center;">
                                ${slackIcon} Cobrar no Slack</button>
                            <button class="ehsd-act-btn" data-grp="${gd.g.id}" data-act="email"
                                style="flex:1;background:linear-gradient(180deg,#3aa0ff,#1f6fd6);color:#fff;border:none;
                                border-radius:10px;padding:10px;font-size:12px;font-weight:800;cursor:pointer;transition:filter .15s;">
                                ✉️ Enviar email report</button>
                          </div>`;
                }
                h += '</div></div>';
            });
            h += '</div>';
            body.innerHTML = h;
            // Botões de ação
            body.querySelectorAll('.ehsd-act-btn').forEach(b => {
                b.onmouseenter = () => b.style.filter = 'brightness(1.08)';
                b.onmouseleave = () => b.style.filter = 'none';
                b.onclick = () => {
                    const gdb = groupsData.find(g => g.g.id === b.dataset.grp);
                    if (!gdb) return;
                    if (b.dataset.act === 'slack') {
                        const wsb = selectWeek(gdb).wk;
                        sendSlackCobranca(gdb, wsb);
                    } else {
                        sendEmailReport(gdb, selectWeek(gdb).wk);
                    }
                };
            });
            return;
        }

        const gd = groupsData.find(x => x.g.id === ehsdActiveTab);
        if (!gd || !gd.recs.length) {
            body.innerHTML = `<div class="ehsd-empty">Sem dados para <b>${gd ? gd.g.label : ''}</b>.<br><br>
                Selecione a categoria correspondente e faça uma coleta.</div>`;
            return;
        }
        const wsel = selectWeek(gd).wk;
        const realizadas = wsel ? groupWindowRecords(gd, wsel).length : 0;
        const auditores  = responsibleCount(wsel);
        const meta = getMeta(gd.g.id, wsel);
        const secTitle = gd.g.id === 'areaorg'
            ? 'Area Org por quinzena e responsável'
            : 'FSI por semana e responsável';
        body.innerHTML = ehsdWeekKpis(realizadas, auditores, meta)
            + `<div class="ehsd-section"><div class="ehsd-section-hd">📅 ${secTitle} — ${gd.g.label}</div>`
            + `<div class="ehsd-section-bd">${ehsdWeeklyMatrix(gd)}</div></div>`;

        // Liga os cliques do seletor de semanas
        body.querySelectorAll('.ehsd-wk').forEach(p => {
            p.onclick = () => { ehsdWeekSel[p.dataset.grp] = p.dataset.wk; ehsdRenderBody(); };
        });
        // Liga os cliques do filtro por meta (Todos / Não bateram / Bateram)
        body.querySelectorAll('.ehsd-metaf').forEach(p => {
            p.onclick = () => { ehsdMetaFilter[p.dataset.grp] = p.dataset.metaf; ehsdRenderBody(); };
        });
        const expBtn = body.querySelector('.ehsd-export-xlsx');
        if (expBtn) {
            expBtn.onmouseenter = () => { expBtn.style.background = '#1b5e20'; expBtn.style.color = '#fff'; };
            expBtn.onmouseleave = () => { expBtn.style.background = '#13243a'; expBtn.style.color = '#5fd38a'; };
            expBtn.onclick = () => exportGroupXlsx(gd, wsel);
        }
        // (Des)considerar por clique: dia (célula) e semana toda (Total).
        body.querySelectorAll('.ehsd-day-click').forEach(td => {
            td.onclick = () => toggleDisregardDay(td.dataset.login, td.dataset.dow);
        });
        body.querySelectorAll('.ehsd-total-click').forEach(td => {
            td.onclick = () => toggleDisregardWeek(td.dataset.login);
        });
        // Area Org: clicar no Total desconsidera/reconsidera por Atestado (quinzena).
        body.querySelectorAll('.ehsd-areatotal-click').forEach(td => {
            td.onclick = () => toggleDisregardAtestado(td.dataset.login);
        });
    }

    // Acha a entrada do gestor na config pelo login (case-insensitive).
    function findCfgMgr(cfg, login) {
        const l = String(login || '').trim().toLowerCase();
        return cfg.find(m => String(m.name || '').trim().toLowerCase() === l) || null;
    }

    // Desconsidera/reconsidera UM dia da semana (FSI+DOCK) do gestor e salva.
    function toggleDisregardDay(login, dow) {
        const cfg = loadMgrCfg();
        const m = findCfgMgr(cfg, login);
        if (!m) { alert('⚠️ "' + login + '" não está cadastrado em Gestores & Turnos.'); return; }
        if (!m.dis) m.dis = { fsiDays: [], areaOrg: '', fsiAll: false };
        if (!Array.isArray(m.dis.fsiDays)) m.dis.fsiDays = [];
        const dayLabel = (WEEKDAYS.find(w => w.v === dow) || {}).t || dow;
        const idx = m.dis.fsiDays.indexOf(dow);
        if (idx === -1) {
            if (!confirm('Desconsiderar ' + dayLabel + ' de "' + login + '"?\nEsse dia deixará de contar na meta de FSI+DOCK.')) return;
            m.dis.fsiDays.push(dow);
        } else {
            if (!confirm('Reconsiderar ' + dayLabel + ' de "' + login + '"?\nEsse dia voltará a contar.')) return;
            m.dis.fsiDays.splice(idx, 1);
        }
        saveMgrCfg(cfg);
        ehsdRenderBody();
    }

    // Desconsidera/reconsidera a SEMANA TODA (todos os dias) do gestor e salva.
    function toggleDisregardWeek(login) {
        const cfg = loadMgrCfg();
        const m = findCfgMgr(cfg, login);
        if (!m) { alert('⚠️ "' + login + '" não está cadastrado em Gestores & Turnos.'); return; }
        if (!m.dis) m.dis = { fsiDays: [], areaOrg: '', fsiAll: false };
        if (!Array.isArray(m.dis.fsiDays)) m.dis.fsiDays = [];
        const allCodes = WEEKDAYS.map(w => w.v);
        const allOff = allCodes.every(c => m.dis.fsiDays.indexOf(c) !== -1);
        if (!allOff) {
            if (!confirm('Desconsiderar a SEMANA TODA de "' + login + '"?\nTodos os dias deixarão de contar na meta de FSI+DOCK.')) return;
            m.dis.fsiDays = allCodes.slice();
        } else {
            if (!confirm('Reconsiderar a semana toda de "' + login + '"?')) return;
            m.dis.fsiDays = [];
        }
        saveMgrCfg(cfg);
        ehsdRenderBody();
    }

    // Area Org: desconsidera/reconsidera por ATESTADO (zera a meta da quinzena) e salva.
    function toggleDisregardAtestado(login) {
        const cfg = loadMgrCfg();
        const m = findCfgMgr(cfg, login);
        if (!m) { alert('⚠️ "' + login + '" não está cadastrado em Gestores & Turnos.'); return; }
        if (!m.dis) m.dis = { fsiDays: [], areaOrg: '', fsiAll: false };
        if (m.dis.areaOrg === 'atestado' || m.dis.areaOrg === 'ferias') {
            const atual = m.dis.areaOrg === 'ferias' ? 'Férias' : 'Atestado';
            if (!confirm('Reconsiderar "' + login + '" (remover ' + atual + ')?\nA meta de Area Org voltará a valer.')) return;
            m.dis.areaOrg = '';
        } else {
            if (!confirm('Desconsiderar "' + login + '" por ATESTADO?\nA quinzena de Area Org não será cobrada (meta = 0).')) return;
            m.dis.areaOrg = 'atestado';
        }
        saveMgrCfg(cfg);
        ehsdRenderBody();
    }

    function ehsdSetTab(tab) {
        ehsdActiveTab = tab;
        document.querySelectorAll('.ehsd-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
        ehsdRenderBody();
    }

    function openDashboard() {
        injectDashCSS();
        document.getElementById('ehsd-ov')?.remove();

        const store = loadDashStore();
        const tsList = Object.values(store).map(s => s.ts).filter(Boolean);
        const lastTs = tsList.length ? new Date(Math.max(...tsList)) : null;
        const sub = (lastTs ? 'Última coleta: ' + lastTs.toLocaleString('pt-BR') : 'Nenhum dado coletado') + ' · v4.0';

        const ov = document.createElement('div');
        ov.id = 'ehsd-ov';
        ov.innerHTML = `<div id="ehsd-panel">
            <div id="ehsd-hdr">
                <div id="ehsd-hdr-icon">🛡️</div>
                <div><div class="ehsd-title">EHS Inspections — Dashboard</div><div class="ehsd-sub">${sub}</div></div>
                <button id="ehsd-clear" title="Limpar dados coletados">🗑️ Limpar</button>
                <button id="ehsd-x">✖</button>
            </div>
            <div id="ehsd-tabs">
                <button class="ehsd-tab" data-tab="overview">📈 Visão Geral</button>
                <button class="ehsd-tab" data-tab="fsidock">🏢 FSI + DOCK</button>
                <button class="ehsd-tab" data-tab="areaorg">📋 Area Organization</button>
            </div>
            <div id="ehsd-body"></div>
        </div>`;
        document.body.appendChild(ov);

        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        ov.querySelector('#ehsd-x').onclick = () => ov.remove();
        ov.querySelector('#ehsd-clear').onclick = () => {
            if (confirm('Limpar todos os dados coletados do dashboard?')) { clearDashStore(); dashCollectedThisSession = false; ehsdRenderBody(); }
        };
        ov.querySelectorAll('.ehsd-tab').forEach(t => { t.onclick = () => ehsdSetTab(t.dataset.tab); });
        const escClose = e => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', escClose); } };
        document.addEventListener('keydown', escClose);

        ehsdSetTab(ehsdActiveTab);
    }

    // ─────────────────────────────────────────────────────────────────
    // ORQUESTRADOR — coleta Dock + Floor + Area Org e gera o dashboard
    // Para cada categoria: aplica o filtro, espera recarregar, pagina e
    // armazena. Ao final, abre o dashboard consolidado.
    // ─────────────────────────────────────────────────────────────────
    let dashCollecting = false;
    let dashCollectedThisSession = false;   // cache: coleta só 1x por carregamento da página

    // Modal de confirmação de pré-requisitos antes de coletar
    function ehsdConfirmCollect(btn) {
        injectDashCSS();
        document.getElementById('ehsd-confirm-ov')?.remove();

        const ov = document.createElement('div');
        ov.id = 'ehsd-confirm-ov';
        ov.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;'
            + 'background:rgba(5,10,18,0.72);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);'
            + "font-family:'Amazon Ember','Segoe UI',Arial,sans-serif;animation:ehsdFade .2s ease;";
        ov.innerHTML =
            '<div style="width:480px;max-width:94vw;background:#0d1b2a;border-radius:16px;overflow:hidden;color:#e6edf3;'
                + 'box-shadow:0 26px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,153,0,0.18);animation:ehsdPop .26s cubic-bezier(.18,.9,.32,1.2);">'
            + '<div style="background:linear-gradient(135deg,#1b3a5b 0%,#13243a 55%,#0a1626 100%);padding:16px 20px;'
                + 'border-bottom:3px solid #ff9900;display:flex;align-items:center;gap:12px;">'
                + '<div style="width:40px;height:40px;border-radius:11px;background:rgba(255,153,0,0.16);display:flex;'
                    + 'align-items:center;justify-content:center;font-size:21px;">⚙️</div>'
                + '<div style="font-size:16px;font-weight:800;">Confirmar filtros antes de coletar</div>'
            + '</div>'
            + '<div style="padding:22px 22px 8px;font-size:13px;line-height:1.6;color:#c2d2e0;">'
                + 'Antes de gerar o dashboard, confirme que você já aplicou na página:'
                + '<div style="margin:14px 0;display:flex;flex-direction:column;gap:10px;">'
                    + '<div style="display:flex;gap:10px;align-items:flex-start;background:#0f1e30;border:1px solid #1f3a57;'
                        + 'border-radius:10px;padding:12px 14px;">'
                        + '<span style="font-size:18px;">🔄</span><div><b style="color:#ff9900;">Lifecycle</b><br>'
                        + 'Marque <b>Completed/Concluído</b> e <b>Submitted/Enviado</b> no status.</div></div>'
                    + '<div style="display:flex;gap:10px;align-items:flex-start;background:#0f1e30;border:1px solid #1f3a57;'
                        + 'border-radius:10px;padding:12px 14px;">'
                        + '<span style="font-size:18px;">📅</span><div><b style="color:#ff9900;">Data</b><br>'
                        + 'Defina <b>"Date on or after"</b> = primeiro dia (domingo) da week que deseja analisar.</div></div>'
                + '</div>'
                + '<div style="font-size:12px;color:#8aa1b6;margin-bottom:8px;">Informe a data inicial (primeiro dia da week). Ela será <b>aplicada automaticamente</b> no filtro "Date on or after" da página, e só serão considerados registros com <b>Scheduled start date</b> a partir dela:</div>'
                + '<input type="date" id="ehsd-cf-date" value="' + toInputDate(readFilterDate()) + '" '
                    + 'style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #32465f;border-radius:9px;'
                    + 'background:#0f1e30;color:#e6edf3;font-size:13px;font-family:inherit;outline:none;" />'
                + '<div id="ehsd-cf-daywarn" style="font-size:11.5px;margin-top:7px;font-weight:700;"></div>'
                + '<button id="ehsd-cf-status" style="width:100%;margin-top:12px;background:#1e8449;color:#fff;'
                    + 'border:1px solid #27ae60;padding:10px 14px;border-radius:9px;cursor:pointer;font-size:13px;'
                    + "font-weight:700;font-family:inherit;\">🟢 Aplicar Status (Completed + Submitted)</button>"
                + '<div style="display:flex;gap:8px;margin-top:10px;">'
                    + '<button id="ehsd-cf-extract-fsi" style="flex:1;background:linear-gradient(180deg,#ffab2e,#f59e0b);'
                        + 'color:#fff;border:none;padding:11px 10px;border-radius:9px;cursor:pointer;font-size:12.5px;font-weight:800;'
                        + "font-family:inherit;box-shadow:0 3px 10px rgba(245,158,11,0.35);\">⬇️ Extrair FSI+DOCK</button>"
                    + '<button id="ehsd-cf-extract-area" style="flex:1;background:linear-gradient(180deg,#3aa0ff,#1f6fd6);'
                        + 'color:#fff;border:none;padding:11px 10px;border-radius:9px;cursor:pointer;font-size:12.5px;font-weight:800;'
                        + "font-family:inherit;box-shadow:0 3px 10px rgba(31,111,214,0.35);\">⬇️ Extrair Area Org</button>"
                + '</div>'
                + '<div style="font-size:11px;color:#8aa1b6;margin-top:6px;">Aplica a data e digita o filtro de categoria sozinho '
                    + '(FSI+DOCK: <b>floor</b> → pagina → <b>dock</b> → pagina · Area Org: <b>area organization</b>). '
                    + 'Baixa um <b>XLSX com abas</b>: <b>FSI+DOCK por semana</b> · <b>Area Org por quinzena (W ímpar/par)</b>. Não gera o dashboard.</div>'
            + '</div>'
            + '<div style="padding:16px 22px 20px;display:flex;justify-content:flex-end;gap:10px;">'
                + '<button id="ehsd-cf-no" style="background:rgba(255,255,255,0.08);color:#c2d2e0;'
                    + 'border:1px solid #32465f;padding:10px 18px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700;'
                    + "font-family:inherit;\">✖ Não</button>"
                + '<button id="ehsd-cf-yes" style="background:linear-gradient(145deg,#2ecc71,#1e8449);border:none;color:#fff;'
                    + 'padding:10px 20px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:800;font-family:inherit;'
                    + "box-shadow:0 3px 10px rgba(46,204,113,0.3);\">✅ Sim, já filtrei</button>"
            + '</div></div>';
        document.body.appendChild(ov);

        const close = () => ov.remove();
        ov.addEventListener('click', e => { if (e.target === ov) close(); });
        const stBtn = ov.querySelector('#ehsd-cf-status');
        stBtn.onclick = () => runStatusFilter(stBtn);
        ov.querySelector('#ehsd-cf-no').onclick = close;

        // Extração por data filtrada com ABAS: aplica a data "on or after" na página,
        // pagina a lista, filtra pela categoria do botão e baixa XLSX (FSI+DOCK por
        // semana; Area Org por quinzena). A data do modal é o corte (não ambígua).
        const runExtract = async (btn, kind) => {
            const d = fromInputDate(ov.querySelector('#ehsd-cf-date').value);
            if (d && d.getDay() !== 0) {
                const ok = confirm('⚠️ A data escolhida (' + ddmm(d) + ') NÃO é um domingo.\n\n'
                    + 'Escolha SEMPRE o PRIMEIRO DIA DA SEMANA (domingo), senão a semana virá parcial '
                    + '(faltando os dias anteriores ao que você filtrou).\n\n'
                    + 'Deseja continuar assim mesmo?');
                if (!ok) return;
            }
            const prev = btn.textContent;
            btn.disabled = true; btn.style.cursor = 'wait';
            try {
                if (d) { btn.textContent = '⏳ Aplicando data...'; await applyPageDateFilter(d); }
                await extractPeriodXlsx(btn, d, kind);
            } catch (e) { console.error('[EHS extrair]', e); btn.textContent = '❌ erro'; }
            btn.disabled = false; btn.style.cursor = 'pointer';
            setTimeout(function () { btn.textContent = prev; }, 2800);
        };
        ov.querySelector('#ehsd-cf-extract-fsi').onclick = function () { runExtract(this, 'fsidock'); };
        ov.querySelector('#ehsd-cf-extract-area').onclick = function () { runExtract(this, 'areaorg'); };
        // Aviso ao vivo: data deve ser domingo (primeiro dia da week)
        const dateInp = ov.querySelector('#ehsd-cf-date');
        const dayWarn = ov.querySelector('#ehsd-cf-daywarn');
        const DOW_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
        const refreshDayWarn = () => {
            const d = fromInputDate(dateInp.value);
            if (!d) { dayWarn.textContent = ''; return; }
            if (d.getDay() === 0) {
                dayWarn.style.color = '#34d399';
                dayWarn.textContent = '✅ Domingo — primeiro dia da week. Será analisada só esta semana.';
            } else {
                dayWarn.style.color = '#ff7a7a';
                dayWarn.textContent = '⚠️ ' + DOW_PT[d.getDay()] + ' — escolha o PRIMEIRO DIA DA WEEK (domingo), senão a semana virá parcial.';
            }
        };
        dateInp.oninput = refreshDayWarn;
        refreshDayWarn();
        ov.querySelector('#ehsd-cf-yes').onclick = () => {
            const d = fromInputDate(ov.querySelector('#ehsd-cf-date').value);
            // Aviso: a data tem que ser o primeiro dia da semana (domingo)
            if (d && d.getDay() !== 0) {
                const ok = confirm('⚠️ A data escolhida (' + ddmm(d) + ') NÃO é um domingo.\n\n'
                    + 'Escolha SEMPRE o PRIMEIRO DIA DA SEMANA (domingo), senão a semana virá parcial '
                    + '(faltando os dias anteriores ao que você filtrou).\n\n'
                    + 'Deseja continuar assim mesmo?');
                if (!ok) return;   // mantém o modal aberto para corrigir a data
            }
            ehsdCutoff = d;   // null se vazio → sem corte
            close();
            runDashboardCollect(btn, d);
        };
        const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
    }

    async function runDashboardCollect(btn, cutoff) {
        if (dashCollecting) return;
        dashCollecting = true;

        // Corte: coleta TUDO a partir da data filtrada (Scheduled start date >= data).
        // Sem teto de 2 semanas — o dashboard organiza por semana (FSI+DOCK) e por quinzena
        // (Area Org) e o seletor mostra todos os períodos com dados a partir do corte.
        const cutMs = cutoff ? new Date(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate()).getTime() : null;
        const passCutoff = (r) => {
            if (cutMs === null) return true;
            const sd = parseEhsDate(r.startDate);
            if (!sd) return false;
            const t = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate()).getTime();
            return t >= cutMs;
        };

        const cats = [
            { key: 'dock',     value: 'dock',              label: '🚢 Dock'     },
            { key: 'floor',    value: 'floor',             label: '🏢 Floor'    },
            { key: 'area_org', value: 'area organization', label: '📋 Area Org' },
        ];

        const restore = () => {
            btn.disabled = false;
            btn.style.cursor = 'pointer';
            btn.style.opacity = '1';
            setTimeout(() => { btn.textContent = 'DASHBOARD'; }, 2500);
        };

        btn.disabled = true;
        btn.style.cursor = 'wait';

        try {
            // Garante que o campo de pesquisa existe antes de começar
            if (!findSearchInput()) {
                alert('⚠️ Campo de pesquisa não encontrado.\nRole a página até a lista de inspeções ficar visível e tente novamente.');
                dashCollecting = false;
                restore();
                return;
            }

            // Escreve a data no filtro "Date on or after" da página e aplica
            if (cutoff) {
                btn.textContent = '⏳ Aplicando data no filtro...';
                const ok = await applyPageDateFilter(cutoff);
                if (!ok) {
                    console.warn('[EHS Dashboard] Não foi possível escrever no filtro de data — usando corte interno.');
                }
            }

            let grandTotal = 0;
            for (const c of cats) {
                selectedType = c.key;

                // 1) Aplica o filtro de pesquisa da categoria
                btn.textContent = `⏳ ${c.label}: aplicando filtro...`;
                fillSearchInput('');             // limpa busca anterior
                await sleep(300);
                fillSearchInput(c.value);        // aplica nova busca
                await sleep(CONFIG.SEARCH_WAIT); // aguarda a lista recarregar

                // 2) Pagina e coleta tudo dessa categoria
                const recs = await paginateCollect((page, count) => {
                    btn.textContent = `⏳ ${c.label}: pág. ${page} (${count})`;
                });

                // 3) Aplica corte por data e armazena para o dashboard
                const filtered = recs.filter(passCutoff);
                storeDashData(c.key, filtered, 'week');
                grandTotal += filtered.length;
            }

            btn.textContent = `✅ ${grandTotal} registros`;
            dashCollectedThisSession = true;   // cache: próximas aberturas reutilizam os dados
            openDashboard();

        } catch (err) {
            console.error('[EHS Dashboard]', err);
            alert('❌ Erro ao coletar dados para o dashboard. Veja o console (F12).');
        } finally {
            dashCollecting = false;
            restore();
        }
    }


    // ─────────────────────────────────────────────────────────────────
    // CONFIG DE GESTORES & TURNOS (⚙️) — base para o cálculo de meta
    //   Meta (a implementar): 1 FSI por dia trabalhado + 1 Area Org por semana
    //   Turnos: Red/Blue = 3x2 (calendário), ADM = 5x2, MID = 4x3
    // ─────────────────────────────────────────────────────────────────
    const MGR_CFG_KEY = 'ehs_mgr_config';
    const SHIFTS = [
        { v: 'red_day',    t: 'Red Day' },
        { v: 'red_night',  t: 'Red Night' },
        { v: 'blue_day',   t: 'Blue Day' },
        { v: 'blue_night', t: 'Blue Night' },
        { v: 'adm',        t: 'ADM' },
        { v: 'mid',        t: 'MID' },
    ];
    const WEEKDAYS = [
        { v: 'dom', t: 'Dom' }, { v: 'seg', t: 'Seg' }, { v: 'ter', t: 'Ter' },
        { v: 'qua', t: 'Qua' }, { v: 'qui', t: 'Qui' }, { v: 'sex', t: 'Sex' }, { v: 'sab', t: 'Sáb' },
    ];
    let mgrWorking = [];   // cópia de trabalho enquanto o modal está aberto

    function ehsEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function loadMgrCfg() { try { return JSON.parse(localStorage.getItem(MGR_CFG_KEY)) || []; } catch (e) { return []; } }
    function saveMgrCfg(arr) { localStorage.setItem(MGR_CFG_KEY, JSON.stringify(arr)); }
    function shiftLabel(v) { var s = SHIFTS.find(function (x) { return x.v === v; }); return s ? s.t : v; }

    // ── META GERAL (para o KPI "% da meta" e "faltantes") ──
    const EHS_META_KEY = 'ehs_general_meta';
    function loadGeneralMeta() {
        try { var m = JSON.parse(localStorage.getItem(EHS_META_KEY)); if (m && typeof m === 'object') return { fsidock: +m.fsidock || 128, areaorg: +m.areaorg || 32 }; } catch (e) {}
        return { fsidock: 128, areaorg: 32 };
    }
    function saveGeneralMeta(m) { localStorage.setItem(EHS_META_KEY, JSON.stringify({ fsidock: +m.fsidock || 128, areaorg: +m.areaorg || 32 })); }

    // ── ESCALA RED/BLUE POR LÓGICA (sem tabela) — para a META INDIVIDUAL ──
    // Ciclo contínuo de 10 dias: 3 RED, 3 BLUE, 2 RED, 2 BLUE → repete.
    // Âncora: 01/01/2026 (quinta) = 1º dia do bloco de 3 vermelhos. A week vai de Dom→Sáb.
    const SHIFT_ANCHOR = new Date(2026, 0, 1);   // 01/01/2026
    const SHIFT_CYCLE  = ['RED', 'RED', 'RED', 'BLUE', 'BLUE', 'BLUE', 'RED', 'RED', 'BLUE', 'BLUE'];
    // Feriados (ADM não trabalha nesses dias): 'AAAA-MM-DD': true (opcional)
    const EHS_HOLIDAYS = {
        // EX: '2026-01-01': true
    };
    function ehsYmd(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    // Cor da escala (RED/BLUE) que trabalha numa data — calculada pelo ciclo a partir da âncora.
    function shiftColorForDate(d) {
        var a = new Date(SHIFT_ANCHOR.getFullYear(), SHIFT_ANCHOR.getMonth(), SHIFT_ANCHOR.getDate());
        var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var diff = Math.round((t - a) / 86400000);
        var idx = diff % SHIFT_CYCLE.length;
        if (idx < 0) idx += SHIFT_CYCLE.length;
        return SHIFT_CYCLE[idx];
    }
    // Conta os dias da cor (RED/BLUE) que caem na semana selecionada (Dom→Sáb).
    function colorDaysInWeek(color, wk) {
        if (!wk) return null;
        var n = 0;
        for (var i = 0; i < 7; i++) {
            var d = new Date(wk.sunday); d.setDate(wk.sunday.getDate() + i);
            if (shiftColorForDate(d) === color) n++;
        }
        return n;
    }
    // ADM trabalha seg–sex, menos feriados.
    function admDaysInWeek(wk) {
        if (!wk) return null;
        var n = 0;
        for (var i = 0; i < 7; i++) {
            var d = new Date(wk.sunday); d.setDate(wk.sunday.getDate() + i);
            var dow = d.getDay();
            if (dow >= 1 && dow <= 5 && !EHS_HOLIDAYS[ehsYmd(d)]) n++;
        }
        return n;
    }
    function findMgrByLogin(login) {
        var l = String(login || '').trim().toLowerCase();
        if (!l || l === '—') return null;
        return loadMgrCfg().find(function (m) { return String(m.name || '').trim().toLowerCase() === l; }) || null;
    }
    // Meta individual de FSI na semana: FIXA em 2 por semana (regra nova — v4.1).
    // Antes era 1 por dia trabalhado (escala Red/Blue/ADM/Mid) menos desconsiderações.
    // Férias/Atestado/"não faz FSI" zeram a meta. null só quando o gestor não está mapeado.
    var WEEKLY_FSI_META = 2;
    function individualFsiMeta(mgr, wk) {
        if (!mgr) return null;
        var dis = mgr.dis || {};
        if (dis.areaOrg === 'ferias' || dis.areaOrg === 'atestado' || dis.fsiAll) return 0;
        return WEEKLY_FSI_META;
    }
    // Meta individual de Area Org: 1 a cada 2 semanas (quinzenal). 0 se Férias/Atestado.
    // A meta é avaliada sobre o PAR de semanas (ímpar + par: W17+W18, W19+W20, ...).
    function individualAreaMeta(mgr) {
        if (!mgr) return null;
        var dis = mgr.dis || {};
        if (dis.areaOrg === 'ferias' || dis.areaOrg === 'atestado') return 0;
        return 1;
    }

    // ── Janela de cálculo por grupo ──────────────────────────────────
    // FSI+DOCK: conta só a semana selecionada (semanal).
    // Area Org: conta o PAR quinzenal (ímpar+par: W25+W26, W27+W28...),
    // identificado por ceil(nº da semana / 2).
    function pairKeyOf(wk) {
        return wk.sunday.getFullYear() + '-P' + Math.ceil(getWeekNumberSunSat(wk.sunday) / 2);
    }
    function groupWindowWeeks(gd, wk) {
        if (!wk) return [];
        if (gd.g.id !== 'areaorg') return [wk];
        var pk = pairKeyOf(wk);
        var res = weeksFromRecords(gd.recs).filter(function (w) { return pairKeyOf(w) === pk; });
        if (!res.some(function (w) { return w.key === wk.key; })) res.push(wk);
        res.sort(function (a, b) { return a.sunday - b.sunday; });   // semana mais antiga primeiro
        return res;
    }
    function groupWindowRecords(gd, wk) {
        var recs = [];
        groupWindowWeeks(gd, wk).forEach(function (w) { recs = recs.concat(w.records); });
        return recs;
    }
    // Range de datas da QUINZENA (par) calculado pela paridade da semana, mesmo que a
    // semana parceira ainda não tenha dados. Semana ímpar = 1ª do par; par = 2ª do par.
    function areaPairRange(wk) {
        var n = getWeekNumberSunSat(wk.sunday);
        var firstSun = new Date(wk.sunday);
        if (n % 2 === 0) firstSun.setDate(firstSun.getDate() - 7);   // semana par começa na anterior
        var lastSat = new Date(firstSun);
        lastSat.setDate(firstSun.getDate() + 13);                    // 2 semanas = 14 dias (Dom→Sáb)
        return { firstSun: firstSun, lastSat: lastSat };
    }
    function disSummary(dis) {
        if (!dis) return '— sem desconsideração';
        if (dis.areaOrg === 'ferias')   return '🏖️ Férias (todos FSI)';
        if (dis.areaOrg === 'atestado') return '🩺 Atestado (todos FSI)';
        if (dis.fsiAll) return '🚷 Não faz FSI+DOCK';
        if (dis.fsiDays && dis.fsiDays.length) {
            return 'FSI: ' + dis.fsiDays.map(function (d) { var w = WEEKDAYS.find(function (x) { return x.v === d; }); return w ? w.t : d; }).join(', ');
        }
        return '— sem desconsideração';
    }

    function injectCfgCSS() {
        if (document.getElementById('ehs-cfg-css')) return;
        const st = document.createElement('style');
        st.id = 'ehs-cfg-css';
        st.textContent =
            '@keyframes ehsdFade{from{opacity:0}to{opacity:1}}@keyframes ehsdPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}' +
            "#ehs-cfg-gear{position:fixed;top:18px;right:18px;z-index:99997;width:46px;height:46px;border-radius:12px;background:linear-gradient(145deg,#1b3a5b,#13243a);border:2px solid #ff9900;color:#ff9900;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.4);transition:all .18s;}" +
            '#ehs-cfg-gear:hover{transform:rotate(45deg) scale(1.06);box-shadow:0 6px 20px rgba(0,0,0,.5);}' +
            "#ehs-cfg-ov,#ehs-dis-ov{position:fixed;inset:0;z-index:100003;display:flex;align-items:center;justify-content:center;background:rgba(5,10,18,.7);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);font-family:'Amazon Ember','Segoe UI',Arial,sans-serif;animation:ehsdFade .2s ease;}" +
            '#ehs-dis-ov{z-index:100004;}' +
            '#ehs-cfg-panel{width:740px;max-width:95vw;max-height:88vh;display:flex;flex-direction:column;background:#0d1b2a;border-radius:16px;overflow:hidden;color:#e6edf3;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 1px rgba(255,153,0,.18);animation:ehsdPop .24s cubic-bezier(.18,.9,.32,1.2);}' +
            '#ehs-cfg-hdr{background:linear-gradient(135deg,#1b3a5b,#13243a);padding:16px 20px;display:flex;align-items:center;gap:12px;border-bottom:3px solid #ff9900;flex-shrink:0;}' +
            '#ehs-cfg-hdr .t{font-size:16px;font-weight:800;}#ehs-cfg-hdr .s{font-size:11px;color:#ffb347;margin-top:2px;}' +
            '#ehs-cfg-hdr-ic{width:40px;height:40px;border-radius:11px;background:rgba(255,153,0,.16);display:flex;align-items:center;justify-content:center;font-size:20px;}' +
            '#ehs-cfg-x{margin-left:auto;background:rgba(255,255,255,.08);border:none;color:#fff;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:14px;transition:all .15s;}#ehs-cfg-x:hover{background:#c0392b;transform:rotate(90deg);}' +
            '#ehs-cfg-body{flex:1;overflow:auto;padding:18px;}' +
            '#ehs-mgr-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;}' +
            '#ehs-mgr-table th{text-align:left;color:#9fb4c8;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #1f3a57;}' +
            '#ehs-mgr-table td{padding:6px 8px;border-bottom:1px solid #16273c;vertical-align:middle;}' +
            '.ehs-cfg-in,.ehs-cfg-sel{width:100%;box-sizing:border-box;background:#0f1e30;border:1px solid #32465f;color:#e6edf3;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;}' +
            '.ehs-cfg-in:focus,.ehs-cfg-sel:focus{outline:none;border-color:#ff9900;box-shadow:0 0 0 3px rgba(255,153,0,.18);}' +
            '.ehs-dis-btn{background:#13243a;border:1px solid #32465f;color:#ffb347;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;}.ehs-dis-btn:hover{border-color:#ff9900;color:#fff;}' +
            '.ehs-cfg-del{background:rgba(192,57,43,.15);border:none;color:#ff8585;width:30px;height:30px;border-radius:8px;cursor:pointer;font-weight:bold;}.ehs-cfg-del:hover{background:#c0392b;color:#fff;}' +
            '#ehs-mgr-add{margin-top:14px;width:100%;background:rgba(255,153,0,.08);border:1.5px dashed #ffb44d;color:#ffb347;border-radius:9px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;}#ehs-mgr-add:hover{background:rgba(255,153,0,.16);}' +
            '#ehs-cfg-footer{padding:14px 18px;background:#0a1626;border-top:1px solid #1c3149;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0;}' +
            '#ehs-cfg-cancel{background:rgba(255,255,255,.08);border:1px solid #32465f;color:#c2d2e0;padding:9px 16px;border-radius:9px;cursor:pointer;font-weight:700;}' +
            '#ehs-cfg-save{background:linear-gradient(145deg,#2ecc71,#1e8449);border:none;color:#fff;padding:9px 20px;border-radius:9px;cursor:pointer;font-weight:800;}' +
            '#ehs-dis-panel{width:470px;max-width:94vw;background:#0d1b2a;border-radius:16px;overflow:hidden;color:#e6edf3;box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 0 1px rgba(255,153,0,.18);animation:ehsdPop .24s cubic-bezier(.18,.9,.32,1.2);}' +
            '#ehs-dis-hdr{background:linear-gradient(135deg,#1b3a5b,#13243a);padding:14px 18px;font-weight:800;font-size:15px;border-bottom:3px solid #ff9900;}' +
            '#ehs-dis-body{padding:18px;}' +
            '.ehs-dis-sec{margin-bottom:18px;}.ehs-dis-tt{font-size:12px;font-weight:800;color:#ff9900;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;}' +
            '.ehs-dis-days{display:flex;flex-wrap:wrap;gap:8px;}' +
            '.ehs-dis-day{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;background:#0f1e30;border:1px solid #1f3a57;padding:6px 10px;border-radius:8px;}' +
            '.ehs-dis-rad{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:7px 0;}.ehs-dis-note{color:#8aa1b6;font-size:11px;}' +
            '#ehs-dis-footer{padding:14px 18px;background:#0a1626;border-top:1px solid #1c3149;display:flex;justify-content:flex-end;gap:10px;}' +
            '#ehs-dis-cancel{background:rgba(255,255,255,.08);border:1px solid #32465f;color:#c2d2e0;padding:9px 16px;border-radius:9px;cursor:pointer;font-weight:700;}' +
            '#ehs-dis-ok{background:linear-gradient(145deg,#37475A,#232F3E);border:1px solid #ff9900;color:#fff;padding:9px 20px;border-radius:9px;cursor:pointer;font-weight:800;}';
        document.head.appendChild(st);
    }

    function injectCfgGear() {
        if (document.getElementById('ehs-cfg-gear')) return;
        injectCfgCSS();
        const b = document.createElement('button');
        b.id = 'ehs-cfg-gear';
        b.title = 'Gestores & Turnos (config de meta)';
        b.textContent = '⚙️';
        b.onclick = openMgrConfig;
        document.body.appendChild(b);
    }

    function renderMgrRows() {
        const tb = document.getElementById('ehs-mgr-tbody');
        if (!tb) return;
        tb.innerHTML = '';
        if (!mgrWorking.length) {
            const tr0 = document.createElement('tr');
            tr0.innerHTML = '<td colspan="4" style="text-align:center;color:#6b8199;padding:20px;">Nenhum gestor cadastrado. Clique em "＋ Adicionar gestor".</td>';
            tb.appendChild(tr0);
            return;
        }
        // Filtros do topo (por gestor e por turno). O índice original (i) é
        // preservado para edição/remoção/desconsideração — só ocultamos linhas.
        const fnEl = document.getElementById('ehs-mgr-filter-name');
        const fsEl = document.getElementById('ehs-mgr-filter-shift');
        const fName = (fnEl ? fnEl.value : '').trim().toLowerCase();
        const fShift = fsEl ? fsEl.value : '';
        let shown = 0;
        mgrWorking.forEach(function (m, i) {
            if (fName && String(m.name || '').toLowerCase().indexOf(fName) === -1) return;
            if (fShift && m.shift !== fShift) return;
            shown++;
            const tr = document.createElement('tr');

            const tdN = document.createElement('td');
            const inp = document.createElement('input');
            inp.type = 'text'; inp.className = 'ehs-cfg-in'; inp.value = m.name || ''; inp.placeholder = 'Ex: Silva,Mari';
            inp.oninput = function () { m.name = inp.value; };
            tdN.appendChild(inp); tr.appendChild(tdN);

            const tdS = document.createElement('td'); tdS.style.width = '140px';
            const sel = document.createElement('select'); sel.className = 'ehs-cfg-sel';
            SHIFTS.forEach(function (s) { const o = document.createElement('option'); o.value = s.v; o.textContent = s.t; if (s.v === m.shift) o.selected = true; sel.appendChild(o); });
            sel.onchange = function () { m.shift = sel.value; };
            tdS.appendChild(sel); tr.appendChild(tdS);

            const tdD = document.createElement('td'); tdD.style.width = '270px';
            const db = document.createElement('button'); db.className = 'ehs-dis-btn'; db.textContent = '🚫 ' + disSummary(m.dis);
            db.title = 'Configurar desconsideração';
            db.onclick = function () { openDisregardModal(i); };
            tdD.appendChild(db); tr.appendChild(tdD);

            const tdX = document.createElement('td'); tdX.style.width = '40px';
            const xb = document.createElement('button'); xb.className = 'ehs-cfg-del'; xb.textContent = '✕';
            xb.onclick = function () { mgrWorking.splice(i, 1); renderMgrRows(); };
            tdX.appendChild(xb); tr.appendChild(tdX);

            tb.appendChild(tr);
        });
        if (!shown) {
            const trF = document.createElement('tr');
            trF.innerHTML = '<td colspan="4" style="text-align:center;color:#6b8199;padding:16px;">🔎 Nenhum gestor encontrado para o filtro.</td>';
            tb.appendChild(trF);
        }
    }

    function openMgrConfig() {
        injectCfgCSS();
        document.getElementById('ehs-cfg-ov')?.remove();
        mgrWorking = loadMgrCfg().map(function (m) {
            return { name: m.name || '', shift: m.shift || 'red_day', dis: m.dis ? { fsiDays: (m.dis.fsiDays || []).slice(), areaOrg: m.dis.areaOrg || '', fsiAll: !!m.dis.fsiAll } : { fsiDays: [], areaOrg: '', fsiAll: false } };
        });

        const shiftOptsHtml = SHIFTS.map(function (s) { return '<option value="' + s.v + '">' + s.t + '</option>'; }).join('');

        const ov = document.createElement('div');
        ov.id = 'ehs-cfg-ov';
        ov.innerHTML = '<div id="ehs-cfg-panel">'
            + '<div id="ehs-cfg-hdr"><div id="ehs-cfg-hdr-ic">⚙️</div>'
                + '<div><div class="t">Gestores &amp; Turnos</div><div class="s">Quem será cobrado, o turno e as desconsiderações</div></div>'
                + '<button id="ehs-cfg-x">✖</button></div>'
            + '<div id="ehs-cfg-body">'
                + '<div style="display:flex;gap:8px;margin-bottom:12px;">'
                    + '<input type="text" id="ehs-mgr-filter-name" placeholder="🔎 Filtrar por gestor..." '
                        + 'style="flex:1;background:#13243a;border:1px solid #32465f;color:#e6edf3;border-radius:9px;padding:8px 11px;font-size:13px;font-family:inherit;outline:none;" />'
                    + '<select id="ehs-mgr-filter-shift" '
                        + 'style="width:160px;background:#13243a;border:1px solid #32465f;color:#e6edf3;border-radius:9px;padding:8px 10px;font-size:13px;font-family:inherit;cursor:pointer;">'
                        + '<option value="">Todos os turnos</option>' + shiftOptsHtml + '</select>'
                    + '<button id="ehs-mgr-filter-clear" title="Limpar filtros" '
                        + 'style="background:#13243a;border:1px solid #32465f;color:#9fb4cc;border-radius:9px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;">✖</button>'
                + '</div>'
                + '<table id="ehs-mgr-table"><thead><tr>'
                + '<th>Gestor (responsável)</th><th>Turno</th><th>Desconsideração</th><th></th>'
                + '</tr></thead><tbody id="ehs-mgr-tbody"></tbody></table>'
                + '<button id="ehs-mgr-add">＋ Adicionar gestor</button>'
                + '<div style="display:flex;gap:8px;margin-top:10px;">'
                    + '<button id="ehs-mgr-import" style="flex:1;background:#13243a;border:1px solid #32465f;color:#ffb347;border-radius:9px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">📂 Importar CSV/XLSX</button>'
                    + '<button id="ehs-mgr-export" style="flex:1;background:#13243a;border:1px solid #2e7d32;color:#5fd38a;border-radius:9px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">⬇️ Exportar (Login e Turno)</button>'
                    + '<button id="ehs-mgr-clear" style="background:#13243a;border:1px solid #32465f;color:#ff8585;border-radius:9px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;">🗑️ Limpar lista</button>'
                    + '<input type="file" id="ehs-mgr-file" accept=".csv,.xlsx" style="display:none;" />'
                + '</div>'
                + '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #1e3550;">'
                    + '<div style="font-size:12px;font-weight:800;color:#ffb347;margin-bottom:9px;">🎯 Meta geral <span style="font-weight:500;color:#6b8199;">(usada no cálculo de % da meta e faltantes)</span></div>'
                    + '<div style="display:flex;gap:12px;">'
                        + '<label style="flex:1;font-size:11px;color:#8aa1b6;font-weight:700;">FSI + DOCK'
                            + '<input type="number" id="ehs-meta-fsi" min="0" style="width:100%;margin-top:5px;background:#13243a;border:1px solid #32465f;color:#e6edf3;border-radius:8px;padding:8px 10px;font-size:14px;font-weight:700;" /></label>'
                        + '<label style="flex:1;font-size:11px;color:#8aa1b6;font-weight:700;">Area Organization'
                            + '<input type="number" id="ehs-meta-area" min="0" style="width:100%;margin-top:5px;background:#13243a;border:1px solid #32465f;color:#e6edf3;border-radius:8px;padding:8px 10px;font-size:14px;font-weight:700;" /></label>'
                    + '</div>'
                + '</div>'
                + '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #1e3550;">'
                    + '<div style="font-size:12px;font-weight:800;color:#ffb347;margin-bottom:9px;">🔗 Integrações <span style="font-weight:500;color:#6b8199;">(mude sem tocar no código)</span></div>'
                    + '<label style="display:block;font-size:11px;color:#8aa1b6;font-weight:700;margin-bottom:10px;">Webhook do Slack'
                        + '<input type="text" id="ehs-slack-wh" placeholder="https://hooks.slack.com/services/..." style="width:100%;margin-top:5px;background:#13243a;border:1px solid #32465f;color:#e6edf3;border-radius:8px;padding:8px 10px;font-size:13px;" /></label>'
                    + '<label style="display:block;font-size:11px;color:#8aa1b6;font-weight:700;">Email de destino <span style="font-weight:500;color:#6b8199;">(vários separados por vírgula)</span>'
                        + '<input type="text" id="ehs-email-to" placeholder="fulano@amazon.com, ciclano@amazon.com" style="width:100%;margin-top:5px;background:#13243a;border:1px solid #32465f;color:#e6edf3;border-radius:8px;padding:8px 10px;font-size:13px;" /></label>'
                + '</div></div>'
            + '<div id="ehs-cfg-footer"><span style="font-size:11px;color:#6b8199;">Meta: 1 FSI por dia trabalhado · 1 Area Org por semana</span>'
                + '<span style="display:flex;gap:10px;"><button id="ehs-cfg-cancel">Cancelar</button><button id="ehs-cfg-save">💾 Salvar</button></span></div>'
            + '</div>';
        document.body.appendChild(ov);

        // Popula a meta geral salva
        var gmeta = loadGeneralMeta();
        document.getElementById('ehs-meta-fsi').value = gmeta.fsidock;
        document.getElementById('ehs-meta-area').value = gmeta.areaorg;
        // Popula as integrações salvas (Slack webhook / email de destino)
        document.getElementById('ehs-slack-wh').value = getSlackWebhook();
        document.getElementById('ehs-email-to').value = getEmailTo();

        ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
        document.getElementById('ehs-cfg-x').onclick = function () { ov.remove(); };
        document.getElementById('ehs-cfg-cancel').onclick = function () { ov.remove(); };
        document.getElementById('ehs-mgr-add').onclick = function () { mgrWorking.push({ name: '', shift: 'red_day', dis: { fsiDays: [], areaOrg: '' } }); renderMgrRows(); };

        // Filtros do topo (por gestor / por turno)
        document.getElementById('ehs-mgr-filter-name').oninput = renderMgrRows;
        document.getElementById('ehs-mgr-filter-shift').onchange = renderMgrRows;
        document.getElementById('ehs-mgr-filter-clear').onclick = function () {
            document.getElementById('ehs-mgr-filter-name').value = '';
            document.getElementById('ehs-mgr-filter-shift').value = '';
            renderMgrRows();
        };

        // ── Import CSV/XLSX ──
        function normalizeShift(raw) {
            const v = String(raw || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            // English
            if (/redday|redd/.test(v))       return 'red_day';
            if (/rednight|redn/.test(v))     return 'red_night';
            if (/blueday|blued/.test(v))     return 'blue_day';
            if (/bluenight|bluen/.test(v))   return 'blue_night';
            // Português
            if (/vermelhodia|vermelhod/.test(v))   return 'red_day';
            if (/vermelhonoite|vermelhon/.test(v)) return 'red_night';
            if (/azuldia|azuld/.test(v))           return 'blue_day';
            if (/azulnoite|azuln/.test(v))         return 'blue_night';
            // Genéricos
            if (/^adm/.test(v))              return 'adm';
            if (/^mid/.test(v))              return 'mid';
            if (/^red$|^vermelho$/.test(v))  return 'red_day';
            if (/^blue$|^azul$/.test(v))     return 'blue_day';
            return 'red_day'; // fallback
        }
        function detectColumns(hdrs) {
            let ni = -1, si = -1;
            hdrs.forEach(function (h, i) {
                const n = h.toLowerCase().replace(/[^a-z]/g, '');
                if ((n === 'login' || n === 'manager' || n === 'gestor' || n === 'nome' || n === 'name') && ni < 0) ni = i;
                if ((n === 'turno' || n === 'shift') && si < 0) si = i;
            });
            return { ni: ni >= 0 ? ni : 0, si: si >= 0 ? si : 1 };
        }
        function importParsed(rows) {
            if (!rows.length) { alert('⚠️ Nenhum gestor encontrado. Verifique os cabeçalhos (Login/Manager/Gestor + Turno/Shift).'); return; }
            rows.forEach(function (r) {
                mgrWorking.push({ name: r.name, shift: normalizeShift(r.shift), dis: { fsiDays: [], areaOrg: '' } });
            });
            renderMgrRows();
        }
        document.getElementById('ehs-mgr-import').onclick = function () { document.getElementById('ehs-mgr-file').click(); };
        // Exporta a lista atual de gestores (Login + Turno). Reimportável (round-trip).
        document.getElementById('ehs-mgr-export').onclick = function () {
            const list = mgrWorking.filter(function (m) { return (m.name || '').trim(); });
            if (!list.length) { alert('⚠️ Nenhum gestor para exportar.'); return; }
            const aoa = [['Login', 'Turno']].concat(list.map(function (m) { return [m.name.trim(), shiftLabel(m.shift)]; }));
            if (typeof XLSX !== 'undefined') {
                const ws = XLSX.utils.aoa_to_sheet(aoa);
                ws['!cols'] = [{ wch: 24 }, { wch: 14 }];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Gestores');
                XLSX.writeFile(wb, 'gestores_turnos.xlsx');
            } else {
                const esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
                const csv = aoa.map(function (row) { return row.map(esc).join(','); }).join('\n');
                downloadCSV(csv, 'gestores_turnos.csv');
            }
        };
        document.getElementById('ehs-mgr-clear').onclick = function () {
            if (!mgrWorking.length || confirm('Limpar todos os gestores da lista?')) {
                mgrWorking = [];
                renderMgrRows();
            }
        };
        document.getElementById('ehs-mgr-file').onchange = function (e) {
            const file = e.target.files[0]; if (!file) return;
            const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
            const reader = new FileReader();
            if (isXlsx) {
                if (typeof XLSX === 'undefined') { alert('⚠️ Biblioteca XLSX não carregou. Recarregue a página (Ctrl+F5) e tente de novo.'); return; }
                reader.onload = function (ev) {
                    try {
                        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
                        const ws = wb.Sheets[wb.SheetNames[0]];
                        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
                        if (data.length < 2) { alert('⚠️ Planilha vazia.'); return; }
                        const c = detectColumns(data[0].map(String));
                        const rows = data.slice(1).filter(function (r) { return r[c.ni]; }).map(function (r) { return { name: String(r[c.ni]).trim(), shift: String(r[c.si] || '').trim() }; });
                        importParsed(rows);
                    } catch (err) {
                        console.error('[EHS Import XLSX]', err);
                        alert('❌ Erro ao ler o XLSX: ' + err.message);
                    }
                };
                reader.readAsArrayBuffer(file);
            } else {
                reader.onload = function (ev) {
                    const lines = ev.target.result.split(/\r?\n/).filter(function (l) { return l.trim(); });
                    if (lines.length < 2) { alert('⚠️ Arquivo vazio.'); return; }
                    const sep = lines[0].indexOf(';') !== -1 ? ';' : ',';
                    const hdrs = lines[0].split(sep);
                    const c = detectColumns(hdrs);
                    const rows = lines.slice(1).map(function (l) { const cols = l.split(sep); return { name: (cols[c.ni] || '').trim(), shift: (cols[c.si] || '').trim() }; }).filter(function (r) { return r.name; });
                    importParsed(rows);
                };
                reader.readAsText(file, 'UTF-8');
            }
            e.target.value = '';
        };
        document.getElementById('ehs-cfg-save').onclick = function () {
            const clean = mgrWorking.filter(function (m) { return (m.name || '').trim(); }).map(function (m) { return { name: m.name.trim(), shift: m.shift, dis: m.dis }; });
            saveMgrCfg(clean);
            saveGeneralMeta({
                fsidock: document.getElementById('ehs-meta-fsi').value,
                areaorg: document.getElementById('ehs-meta-area').value
            });
            // Integrações: salva (ou limpa, se o campo ficar vazio)
            const wh = (document.getElementById('ehs-slack-wh').value || '').trim();
            if (wh) localStorage.setItem(SLACK_WEBHOOK_KEY, wh); else localStorage.removeItem(SLACK_WEBHOOK_KEY);
            const em = (document.getElementById('ehs-email-to').value || '').trim();
            if (em) localStorage.setItem(EMAIL_TO_KEY, em); else localStorage.removeItem(EMAIL_TO_KEY);
            const sv = document.getElementById('ehs-cfg-save');
            sv.textContent = '✅ Salvo (' + clean.length + ')';
            setTimeout(function () { ov.remove(); }, 700);
        };
        renderMgrRows();
    }

    function openDisregardModal(i) {
        const m = mgrWorking[i];
        if (!m) return;
        const dis = m.dis || (m.dis = { fsiDays: [], areaOrg: '', fsiAll: false });
        document.getElementById('ehs-dis-ov')?.remove();

        const dayBoxes = WEEKDAYS.map(function (w) {
            const on = dis.fsiDays.indexOf(w.v) !== -1;
            return '<label class="ehs-dis-day"><input type="checkbox" data-day="' + w.v + '"' + (on ? ' checked' : '') + '/> ' + w.t + '</label>';
        }).join('');
        const allOn = dis.fsiDays.length === WEEKDAYS.length;

        const ov = document.createElement('div');
        ov.id = 'ehs-dis-ov';
        ov.innerHTML = '<div id="ehs-dis-panel">'
            + '<div id="ehs-dis-hdr">🚫 Desconsideração — ' + (m.name ? ehsEsc(m.name) : '(sem nome)') + '</div>'
            + '<div id="ehs-dis-body">'
                + '<div class="ehs-dis-sec"><div class="ehs-dis-tt">🏢 FSI + DOCK — dias da semana a desconsiderar</div>'
                    + '<div class="ehs-dis-days">' + dayBoxes + '</div>'
                    + '<label class="ehs-dis-day" style="margin-top:10px;"><input type="checkbox" id="ehs-dis-all"' + (allOn ? ' checked' : '') + '/> <b>Todos os dias</b></label>'
                    + '<label class="ehs-dis-rad" style="margin-top:6px;"><input type="checkbox" id="ehs-dis-fsiall"' + (dis.fsiAll ? ' checked' : '') + '/> 🚷 <b>Não faz FSI+DOCK</b> <span class="ehs-dis-note">— só faz Area Organization</span></label></div>'
                + '<div class="ehs-dis-sec"><div class="ehs-dis-tt">📋 Area Organization</div>'
                    + '<label class="ehs-dis-rad"><input type="radio" name="ehs-ao" value=""' + (!dis.areaOrg ? ' checked' : '') + '/> Nenhuma</label>'
                    + '<label class="ehs-dis-rad"><input type="radio" name="ehs-ao" value="ferias"' + (dis.areaOrg === 'ferias' ? ' checked' : '') + '/> 🏖️ Férias <span class="ehs-dis-note">— desconsidera TODOS os FSI</span></label>'
                    + '<label class="ehs-dis-rad"><input type="radio" name="ehs-ao" value="atestado"' + (dis.areaOrg === 'atestado' ? ' checked' : '') + '/> 🩺 Atestado <span class="ehs-dis-note">— desconsidera TODOS os FSI</span></label>'
                + '</div></div>'
            + '<div id="ehs-dis-footer"><button id="ehs-dis-cancel">Cancelar</button><button id="ehs-dis-ok">Aplicar</button></div>'
            + '</div>';
        document.body.appendChild(ov);

        ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
        const allCb = ov.querySelector('#ehs-dis-all');
        allCb.onchange = function () { ov.querySelectorAll('input[data-day]').forEach(function (c) { c.checked = allCb.checked; }); };
        ov.querySelectorAll('input[data-day]').forEach(function (c) {
            c.onchange = function () { var all = true; ov.querySelectorAll('input[data-day]').forEach(function (x) { if (!x.checked) all = false; }); allCb.checked = all; };
        });
        document.getElementById('ehs-dis-cancel').onclick = function () { ov.remove(); };
        document.getElementById('ehs-dis-ok').onclick = function () {
            const days = [];
            ov.querySelectorAll('input[data-day]').forEach(function (c) { if (c.checked) days.push(c.getAttribute('data-day')); });
            let ao = ov.querySelector('input[name="ehs-ao"]:checked');
            ao = ao ? ao.value : '';
            const fsiAll = ov.querySelector('#ehs-dis-fsiall').checked;
            m.dis = { fsiDays: days, areaOrg: ao, fsiAll: fsiAll };
            ov.remove();
            renderMgrRows();
        };
    }


    // ─────────────────────────────────────────────────────────────────
    // INIT — observa o DOM da SPA e injeta o botão quando a página carregar
    // ─────────────────────────────────────────────────────────────────
    function init() {
        // Tenta imediatamente caso a página já esteja pronta
        setTimeout(injectPanel, 1500);


        new MutationObserver(() => {
            if (window.location.href.includes('inspection/list')) {
                injectPanel();
            }
        }).observe(document.body, { childList: true, subtree: true });
    }


    init();


})();

