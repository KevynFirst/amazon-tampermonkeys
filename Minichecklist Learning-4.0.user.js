// ==UserScript==
// @name         SIM - Tickets Learning GRU5 → Slack (a cada 4h)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Conta tickets Pendentes e Em Progresso do grupo Learning - GRU5, agrupa por login do assignee e reporta no Slack (intervalo configurável)
// @author       ladislke
// @icon         https://t.corp.amazon.com/favicon.ico
// @match        https://t.corp.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// ==/UserScript==
//
// COMO USAR
// 1) Deixe aberta QUALQUER página /issues do SIM.
// 2) Configure o Webhook do Slack (botão 🔗 no painel flutuante).
// 3) Clique em "🚀 Enviar agora" (painel ou menu do Tampermonkey). O script
//    abre sozinho, em ABAS DE FUNDO, as filas "Pendentes" e "Em Progresso",
//    conta os tickets por login do assignee, fecha as abas e envia no Slack.
//    (Envio é manual — não há disparo automático.)
//
// FORMATO DA MENSAGEM
//   *Tickets Pendentes para Learning - GRU5* — <total> tickets
//   • <login> - N tickets      (login é link para a fila filtrada por esse login)
//   ...
//   *Tickets em Progresso para Learning - GRU5* — <total> tickets
//   • <login> - N tickets
//
(function () {
    'use strict';

    // Não roda dentro dos iframes de scraping (eles também casam com o @match).
    if (window.top !== window.self) return;

    // Aba de coleta (aberta pelo próprio script): só lê/cacheia a fila, nunca
    // envia nem abre outras abas. O tipo da fila (pend/prog) vem na própria hash
    // (#simfetch-pend / #simfetch-prog), então não depende de heurística de URL.
    // É worker só se tiver hash #simfetch E um token recente gravado ao abrir —
    // assim, abrir o link manualmente NÃO vira worker (mostra o painel normal).
    const WORKER_TOKEN = (kind) => 'sim_worker_' + kind;
    const WORKER_KIND = (function () {
        const m = location.hash.match(/simfetch-(pend|prog)/);
        return m ? m[1] : null;
    })();
    const IS_WORKER = (function () {
        if (!WORKER_KIND) return false;
        const t = parseInt(localStorage.getItem(WORKER_TOKEN(WORKER_KIND)) || '0', 10);
        if (Date.now() - t < 20000) { localStorage.removeItem(WORKER_TOKEN(WORKER_KIND)); return true; }
        return false;
    })();

    // ── Paleta Amazon ────────────────────────────────────────────────────
    const C = {
        dark:   '#232F3E', darker: '#131921', accent: '#FF9900', gold: '#FEBD69',
        blue:   '#4A86C8', grey: '#607D8B', red: '#CC0000', amber: '#E88B00',
        green:  '#27AE60', white: '#FFFFFF', light: '#F7F7F7', border: '#E8E8E8',
        headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
        btnGrad:    'linear-gradient(145deg,#37475A 0%,#232F3E 100%)',
        btnGradH:   'linear-gradient(145deg,#4A5D72 0%,#37475A 100%)',
        bodyBg:     '#EEF1F4',
    };

    const SLACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 122.8 122.8" width="14" height="14" style="vertical-align:middle;margin-right:6px;"><path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E"/></svg>`;

    // ── Configuração ─────────────────────────────────────────────────────
    const WEBHOOK_KEY   = 'sim_slack_webhook';
    const LASTSENT_KEY  = 'sim_tickets_lastsent';
    const POSKEY        = 'sim_panel_pos';       // posição salva do painel
    const SENDLOCK_KEY  = 'sim_sendlock';        // trava anti-duplicação entre abas
    const HEARTBEAT_MS  = 60 * 1000;            // 1 min: mantém o cache da fila atual
    const QUEUE_NAME    = 'Learning - GRU5';
    const FETCH_TIMEOUT = 90000;                // espera máx. por aba de fundo carregar (ms)

    // Coluna do assignee (login). Pela estrutura do SIM é a 6ª coluna
    // (td[6] no XPath) → índice 5. Deixe -1 para tentar detecção automática.
    const ASSIGNEE_COL_INDEX = 5;

    // ── URLs das filas (contagem completa) ───────────────────────────────
    const URL_PEND = 'https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%7B%22OR%22%3A%5B%22Assigned%22%2C%7B%22OR%22%3A%5B%22Pending%22%2C%22Researching%22%5D%7D%5D%7D%2C%22assignedGroup%22%3A%22Learning%20-%20GRU5%22%7D%7D';
    const URL_PROG = 'https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%22Work%20In%20Progress%22%2C%22assignedGroup%22%3A%22Learning%20-%20GRU5%22%7D%7D';

    // ── Templates de link por login (substitui LOGIN pelo alias) ─────────
    const TPL_PEND = 'https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%7B%22OR%22%3A%5B%22Assigned%22%2C%7B%22OR%22%3A%5B%22Pending%22%2C%22Researching%22%5D%7D%5D%7D%2C%22AND%22%3A%7B%22assignedGroup%22%3A%22Learning%20-%20GRU5%22%2C%22keyword%22%3A%22(LOGIN)%22%7D%7D%7D';
    const TPL_PROG = 'https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%22Work%20In%20Progress%22%2C%22AND%22%3A%7B%22assignedGroup%22%3A%22Learning%20-%20GRU5%22%2C%22keyword%22%3A%22(LOGIN)%22%7D%7D%7D';

    function loginUrl(tpl, login) { return tpl.replace('LOGIN', encodeURIComponent(login)); }

    // ── CSS global (keyframes) ───────────────────────────────────────────
    function injectUICss() {
        if (document.getElementById('sim-ui-css')) return;
        const st = document.createElement('style');
        st.id = 'sim-ui-css';
        st.textContent =
            '@keyframes simFade{from{opacity:0}to{opacity:1}}' +
            '@keyframes simPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}';
        document.head.appendChild(st);
    }

    // ── XPath helper (funciona em document ou em iframe.contentDocument) ─
    function xpath(path, doc) {
        doc = doc || document;
        try {
            const r = doc.evaluate(path, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return r.singleNodeValue;
        } catch (e) { return null; }
    }

    // ── Localiza a tabela de tickets em um documento ─────────────────────
    function findTable(doc) {
        doc = doc || document;
        const XP = '/html/body/div[1]/div[2]/div/div[1]/div/main/div[3]/div/div/div[2]/div/div[4]/div/div[2]/div/div[1]/table';
        const t = xpath(XP, doc);
        if (t && t.querySelector('tbody tr')) return t;

        // Fallback: tabela com mais linhas de dados
        let best = null, bestRows = 0;
        doc.querySelectorAll('table').forEach(tbl => {
            const rows = [...tbl.querySelectorAll('tbody tr')]
                .filter(tr => tr.querySelectorAll('td').length >= 2);
            if (rows.length > bestRows) { bestRows = rows.length; best = tbl; }
        });
        return best;
    }

    // ── Descobre a coluna do assignee pela linha de cabeçalho ────────────
    function findAssigneeCol(table) {
        if (ASSIGNEE_COL_INDEX >= 0) return ASSIGNEE_COL_INDEX;
        const headRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (headRow) {
            const cells = headRow.querySelectorAll('th,td');
            for (let i = 0; i < cells.length; i++) {
                const t = cells[i].textContent.trim().toLowerCase();
                if (t.includes('assign') || t.includes('atribu') || t.includes('owner') || t.includes('respons')) return i;
            }
        }
        return 5; // fallback: 6ª coluna (td[6]) = Assignee
    }

    // ── Coluna de Status + filtro por status real da linha ──────────────
    // O SIM (SPA) costuma renderizar TODOS os tickets do grupo antes de
    // aplicar o filtro de status da URL. Em aba de fundo, a leitura pode
    // pegar essa lista "crua". Para não depender do filtro da URL, lemos a
    // coluna de Status de cada linha e contamos só as que batem com a fila.
    const STATUS_MATCH = {
        pend: /assigned|pending|researching/i,
        prog: /work\s*in\s*progress|in\s*progress/i,
    };

    // Índice da coluna de Status (pelo cabeçalho). -1 se não encontrar.
    function findStatusCol(table) {
        const headRow = (table && (table.querySelector('thead tr') || table.querySelector('tr')));
        if (headRow) {
            const cells = headRow.querySelectorAll('th,td');
            for (let i = 0; i < cells.length; i++) {
                const t = cells[i].textContent.replace(/\s+/g, ' ').trim().toLowerCase();
                if (t === 'status' || t.includes('status') || t.includes('estado')) return i;
            }
        }
        return -1;
    }

    // Texto do status de uma linha (ou '' se a coluna não existir).
    function statusOfRow(tr, statusCol) {
        if (statusCol < 0) return '';
        const cell = tr.querySelectorAll('td')[statusCol];
        return cell ? (cell.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    // Filtra as linhas para conter só as da fila (pend/prog) pelo status real.
    // Se a coluna de status não for encontrada, devolve as linhas originais
    // (fallback: mantém o comportamento antigo, sem quebrar).
    function filterRowsByKind(table, rows, kind) {
        const rx = STATUS_MATCH[kind];
        const col = findStatusCol(table);
        if (col < 0 || !rx) return rows;
        return rows.filter(tr => rx.test(statusOfRow(tr, col)));
    }

    // ── Extrai o login do assignee de uma célula ─────────────────────────
    // O SIM exibe o login (alias) do assignee direto na célula — usamos esse
    // texto como está (os links de redirecionamento são só por login).
    function loginFromCell(cell) {
        if (!cell) return '';
        const a = cell.querySelector('a');
        const txt = (a ? a.textContent : cell.textContent).replace(/\s+/g, ' ').trim();
        return txt;
    }

    // ── Conta tickets por login numa tabela ──────────────────────────────
    // Linhas "reais" de ticket: têm ao menos um link e o nº de colunas esperado
    // (descarta linhas-esqueleto/placeholder mostradas durante o carregamento).
    function realTicketRows(table) {
        return [...table.querySelectorAll('tbody tr')].filter(tr =>
            tr.querySelectorAll('td').length >= 6 && tr.querySelector('a[href]'));
    }

    function countByAssignee(table, rowsList) {
        const col = findAssigneeCol(table);
        const counts = {};
        const rows = rowsList || realTicketRows(table);
        rows.forEach(tr => {
            const cells = tr.querySelectorAll('td');
            if (!cells.length) return; // pula cabeçalho
            let login = (col >= 0 && cells[col]) ? loginFromCell(cells[col]) : '';
            if (!login) login = 'Não atribuído';
            counts[login] = (counts[login] || 0) + 1;
        });
        return counts;
    }

    // ── Cache por fila (alimentado pela aba aberta) ──────────────────────
    const CACHE_KEY = { pend: 'sim_cache_pend', prog: 'sim_cache_prog' };
    const URLS      = { pend: URL_PEND,        prog: URL_PROG };

    function saveCache(kind, counts, total, rows) {
        localStorage.setItem(CACHE_KEY[kind], JSON.stringify({ counts, total, rows, ts: Date.now() }));
    }
    function loadCache(kind) {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY[kind])); } catch (e) { return null; }
    }
    function entryOf(c) {
        if (!c) return { counts: null, total: null, rows: 0 };
        return { counts: c.counts, total: (c.total != null ? c.total : sumCounts(c.counts)), rows: c.rows || 0 };
    }

    // Lê o "Tickets (N)" / "N results" que o SIM exibe. ATENÇÃO: esse número é
    // o total do GRUPO (todas as filas somadas), não o resultado do filtro atual.
    // Por isso é usado APENAS como sinal de carregamento/vazio — nunca como o
    // total da fila (esse vem da contagem real de linhas filtradas).
    function getListTotal(doc) {
        doc = doc || document;
        const txt = doc.body ? doc.body.textContent : '';
        const m = txt.match(/Tickets?\s*\((\d+)\)/i) || txt.match(/(\d+)\s+results?/i);
        return m ? parseInt(m[1], 10) : null;
    }

    // Identifica se a aba ABERTA é a fila Pendentes ou Work In Progress do
    // Learning - GRU5 (ignora filas com keyword = filtro por login).
    function currentQueueKind() {
        // Aba de coleta já sabe o tipo pela hash.
        if (WORKER_KIND) return WORKER_KIND;
        let q = location.href;
        try { q = decodeURIComponent(location.href); } catch (e) {}
        if (!q.includes('Learning - GRU5')) return null;
        if (q.includes('keyword')) return null;
        if (q.includes('Work In Progress')) return 'prog';       // só na fila em progresso
        if (q.includes('Researching')) return 'pend';            // "Researching" só existe na fila pendentes
        return null;
    }

    // Estado de estabilidade por fila (evita ler a tabela ainda carregando).
    const _stable = {};

    // Lê a fila da aba atual e SÓ cacheia quando a tabela realmente carregou.
    // Cuidados: o contador "Tickets (N)" começa em 0 durante o carregamento e
    // pode haver linhas-esqueleto — então nunca tratamos total=0 como "pronto"
    // e só contamos linhas reais de ticket. Retorna true se cacheou.
    function scrapeCurrentIfQueue() {
        const kind = currentQueueKind();
        if (!kind) return false;
        const table = findTable(document);
        const allRows = table ? realTicketRows(table) : [];
        // Conta só as linhas cujo status bate com a fila (pend/prog). Isso
        // torna a contagem imune ao filtro da URL não ter sido aplicado ainda:
        // mesmo que a página mostre o grupo inteiro, filtramos pelo status real.
        const rows = table ? filterRowsByKind(table, allRows, kind) : [];
        const nAll  = allRows.length;   // linhas na tabela (todos os status)
        const nRows = rows.length;      // linhas desta fila (status filtrado)
        // ATENÇÃO: getListTotal lê o "Tickets (N)" da página, que é o total do
        // GRUPO (Pendentes + Em Progresso somados), NÃO o resultado do filtro
        // atual. Por isso é usado só como sinal de carregamento/vazio — o total
        // exibido vem da contagem real de linhas da fila filtrada (abaixo).
        const pageTotal = getListTotal(document); // pode ser 0/null enquanto carrega
        const bodyText = (document.body ? document.body.textContent : '').toLowerCase();
        const emptyMsg = /(no results|no issues|no tickets|no matching|nothing to show|0 results|no data|nenhum resultado)/.test(bodyText);

        // Estabilidade medida pelo TOTAL de linhas da tabela (não pelo filtrado),
        // para detectar corretamente uma fila vazia mesmo com a tabela cheia
        // de tickets de outros status.
        const st = _stable[kind] || { count: -2, hits: 0 };
        if (nAll === st.count) st.hits++; else st.hits = 0;
        st.count = nAll; _stable[kind] = st;

        let loaded = false, counts = null;

        if (nAll > 0) {
            // Tabela renderizou linhas e a contagem estabilizou (~5s).
            if (st.hits >= 4) { loaded = true; counts = countByAssignee(table, rows); }
        } else {
            // 0 linhas: só é "vazio de verdade" com mensagem explícita OU 0 estável por bastante tempo
            if ((emptyMsg && st.hits >= 3) || (pageTotal === 0 && st.hits >= 6)) {
                loaded = true; counts = {};
            }
        }

        if (loaded) {
            // Total = quantidade real de tickets DESTA fila (respeita o filtro).
            const useTotal = sumCounts(counts);
            saveCache(kind, counts, useTotal, nRows);
            updateStatus();
            return true;
        }
        return false;
    }

    // Obtém a contagem de uma fila, sempre a partir de um cache "fresco"
    // (ts >= início da chamada):
    //  (1) aba ATUAL é essa fila → fica lendo até estabilizar;
    //  (2) senão → abre a fila numa ABA DE FUNDO (#simfetch), espera cachear e fecha;
    //  (3) fallback → iframe; por fim, cache antigo.
    function ensureQueue(kind, cb) {
        const start = Date.now();

        if (currentQueueKind() === kind) {
            const timer = setInterval(() => {
                scrapeCurrentIfQueue();
                const c = loadCache(kind);
                if ((c && c.ts >= start) || Date.now() - start > FETCH_TIMEOUT) {
                    clearInterval(timer);
                    if (c && c.ts >= start) return cb(entryOf(c), 'live');
                    return cb(entryOf(c), c ? 'cache:' + c.ts : 'fail');
                }
            }, 1000);
            return;
        }

        if (typeof GM_openInTab === 'function') {
            let tab = null;
            try {
                localStorage.setItem(WORKER_TOKEN(kind), String(Date.now())); // marca esta abertura como coleta
                tab = GM_openInTab(URLS[kind] + '#simfetch-' + kind, { active: false, insert: true, setParent: true });
            } catch (e) { tab = null; }
            if (tab) {
                const timer = setInterval(() => {
                    const c = loadCache(kind);
                    const fresh = c && c.ts >= start;
                    if (fresh || Date.now() - start > FETCH_TIMEOUT) {
                        clearInterval(timer);
                        try { if (tab && typeof tab.close === 'function') tab.close(); } catch (e) {}
                        if (fresh)  return cb(entryOf(c), 'tab');
                        if (c)      return cb(entryOf(c), 'cache:' + c.ts);
                        return scrapeUrl(URLS[kind], counts => {
                            if (counts !== null) { saveCache(kind, counts, null, sumCounts(counts)); return cb(entryOf(loadCache(kind)), 'iframe'); }
                            cb({ counts: null, total: null }, 'fail');
                        });
                    }
                }, 1000);
                return;
            }
        }

        scrapeUrl(URLS[kind], counts => {
            if (counts !== null) { saveCache(kind, counts, null, sumCounts(counts)); return cb(entryOf(loadCache(kind)), 'iframe'); }
            const cache = loadCache(kind);
            if (cache) return cb(entryOf(cache), 'cache:' + cache.ts);
            cb({ counts: null, total: null }, 'fail');
        });
    }

    // ── Carrega uma URL em iframe oculto e conta por assignee ────────────
    function scrapeUrl(url, cb) {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:900px;opacity:0;border:0;pointer-events:none;';
        iframe.src = url;
        document.body.appendChild(iframe);

        let tries = 0, finished = false;
        const done = (counts) => {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            setTimeout(() => iframe.remove(), 200);
            cb(counts);
        };
        const timer = setInterval(() => {
            tries++;
            try {
                const doc = iframe.contentDocument;
                if (doc) {
                    const table = findTable(doc);
                    if (table && table.querySelector('tbody tr')) { done(countByAssignee(table)); return; }
                    // "Sem resultados": página carregou mas não há tabela → 0 tickets
                    const body = doc.body ? doc.body.textContent.toLowerCase() : '';
                    if (tries >= 6 && (body.includes('no results') || body.includes('no issues') || body.includes('nenhum'))) {
                        done({}); return;
                    }
                }
            } catch (e) { /* iframe pode negar acesso (X-Frame-Options) */ }
            if (tries > 45) done(null); // timeout ~45s → falha
        }, 1000);
    }

    // ── Total de tickets em um mapa de contagem ──────────────────────────
    function sumCounts(counts) {
        return Object.values(counts || {}).reduce((s, n) => s + n, 0);
    }

    // ── Monta os dados de uma seção (cabeçalho + linhas por login) ───────
    function buildSectionData(title, allUrl, entry, tpl, src) {
        const counts = entry ? entry.counts : null;
        if (counts === null) {
            return { header: `*${title}*\n⚠️ _Não carregou a tempo — tente "Enviar agora" novamente._`, lines: [] };
        }
        let note = '';
        if (src && src.startsWith('cache:')) {
            const ts = parseInt(src.split(':')[1], 10);
            const min = Math.round((Date.now() - ts) / 60000);
            note = ` _(cache de ${min} min atrás)_`;
        }
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const shown = sumCounts(counts);
        const total = (entry.total != null) ? entry.total : shown;
        let header = `*${title}* — <${allUrl}|${total} ticket${total !== 1 ? 's' : ''}>${note}`;
        if (total > shown) {
            header += `\n_⚠️ mostrando ${shown} de ${total} (fila paginada — abra a fila para ver todos)_`;
        }
        const lines = entries.map(([login, n]) => {
            const label = `${n} ticket${n !== 1 ? 's' : ''}`;
            return (login === 'Não atribuído')
                ? `• ${login} - ${label}`
                : `• <${loginUrl(tpl, login)}|${login}> - ${label}`;
        });
        if (!lines.length) lines.push('_Nenhum ticket._');
        return { header, lines };
    }

    // Empacota cabeçalho + linhas em blocos "section" de até ~2900 chars
    // (limite do Slack é 3000/bloco). Assim tudo cabe em UMA única mensagem.
    function packSection(blocks, header, lines) {
        let buf = header + '\n';
        for (const line of lines) {
            if ((buf + line + '\n').length > 2900) {
                blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf.trimEnd() } });
                buf = '';
            }
            buf += line + '\n';
        }
        if (buf.trim()) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf.trimEnd() } });
    }

    // ── Payload final (Block Kit — não sofre corte de 4000 chars) ────────
    function buildSlackPayload(pend, prog, srcP, srcG) {
        const now = new Date().toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const blocks = [{
            type: 'section',
            text: { type: 'mrkdwn', text: `🎫 *Atualização de Tickets — ${QUEUE_NAME}*\n_Atualizado em ${now}_` },
        }];
        blocks.push({ type: 'divider' });

        const P = buildSectionData(`Tickets Pendentes para ${QUEUE_NAME}`, URL_PEND, pend, TPL_PEND, srcP);
        packSection(blocks, '🟡 ' + P.header, P.lines);

        blocks.push({ type: 'divider' }); // espaço entre Pendentes e Em Progresso

        const G = buildSectionData(`Tickets em Progresso para ${QUEUE_NAME}`, URL_PROG, prog, TPL_PROG, srcG);
        packSection(blocks, '🔵 ' + G.header, G.lines);

        // 'text' é fallback (notificações); 'blocks' é o conteúdo visível.
        return { text: `Atualização de Tickets — ${QUEUE_NAME}`, blocks };
    }

    // ── Envio ao Slack ───────────────────────────────────────────────────
    function postToSlack(payload, onDone) {
        const wh = localStorage.getItem(WEBHOOK_KEY);
        if (!wh) { if (onDone) onDone(false, 'Webhook não configurado'); return; }
        GM_xmlhttpRequest({
            method: 'POST', url: wh,
            data: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
            onload: res => {
                const ok = res.status >= 200 && res.status < 300;
                if (onDone) onDone(ok, ok ? '' : `Erro ${res.status}`);
            },
            onerror: () => { if (onDone) onDone(false, 'Falha de conexão'); },
        });
    }

    // ── Coleta (2 iframes sequenciais) e envia ───────────────────────────
    let running = false;
    function sendReport(manual, onDone) {
        if (IS_WORKER) { if (onDone) onDone(false, 'Aba de coleta', 0); return; } // worker nunca envia
        if (running) { if (onDone) onDone(false, 'Coleta em andamento', 0); return; }
        running = true;
        localStorage.setItem(SENDLOCK_KEY, String(Date.now())); // trava outras abas

        let pendRes = null, progRes = null, done = 0, posted = false;
        const finish = () => {
            done++;
            if (done < 2 || posted) return;   // só envia quando as 2 filas chegarem, uma única vez
            posted = true;
            const payload = buildSlackPayload(pendRes.e, progRes.e, pendRes.s, progRes.s);
            postToSlack(payload, (ok, msg) => {
                running = false;
                if (ok) localStorage.setItem(LASTSENT_KEY, String(Date.now()));
                updateStatus();
                if (onDone) onDone(ok, msg, sumCounts(pendRes.e.counts) + sumCounts(progRes.e.counts));
            });
        };
        // Abre as duas filas em abas de fundo em paralelo.
        ensureQueue('pend', (e, s) => { if (!pendRes) { pendRes = { e, s }; finish(); } });
        ensureQueue('prog', (e, s) => { if (!progRes) { progRes = { e, s }; finish(); } });
    }

    // ── Agendamento ──────────────────────────────────────────────────────
    // Mantém o cache da fila desta aba e dispara o envio automático quando
    // o intervalo configurado é atingido (0 = automático desligado).
    // Sem envio automático: só mantém o cache da fila desta aba atualizado
    // para quando o envio manual for acionado.
    function heartbeat() {
        scrapeCurrentIfQueue();
        updateStatus();
    }

    // ── Painel flutuante ─────────────────────────────────────────────────
    let statusEl = null, coverageEl = null;

    function coverageText() {
        const p = loadCache('pend'), g = loadCache('prog');
        const fmt = (c) => c ? `${c.total != null ? c.total : sumCounts(c.counts)}` : '—';
        return `📂 Pendentes: ${fmt(p)} · Em progresso: ${fmt(g)}`;
    }

    function updateStatus() {
        if (coverageEl) coverageEl.textContent = coverageText();
        if (!statusEl) return;
        if (!localStorage.getItem(WEBHOOK_KEY)) { statusEl.textContent = '⚠️ Webhook não configurado'; statusEl.style.color = C.gold; return; }
        const last = parseInt(localStorage.getItem(LASTSENT_KEY) || '0', 10);
        if (!last) { statusEl.textContent = '✋ Envio manual — clique em "Enviar agora"'; statusEl.style.color = '#CFE8FF'; return; }
        const when = new Date(last).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        statusEl.textContent = `✅ Último envio: ${when}`;
        statusEl.style.color = '#CFE8FF';
    }

    function injectPanel() {
        if (document.getElementById('sim-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'sim-panel';
        panel.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:99998;background:${C.btnGrad};color:${C.white};border:2px solid ${C.accent};border-radius:14px;padding:14px 16px;font-family:'Amazon Ember',Arial,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,0.4);min-width:240px;animation:simPop .3s ease;`;

        const title = document.createElement('div');
        title.innerHTML = '<span style="cursor:move;opacity:.7;margin-right:6px;">⠿</span>' + SLACK_SVG + '<strong>Tickets → Slack</strong>';
        title.style.cssText = `font-size:13px;margin-bottom:4px;cursor:move;user-select:none;`;
        title.title = 'Arraste para mover';

        const sub = document.createElement('div');
        sub.textContent = QUEUE_NAME;
        sub.style.cssText = `font-size:10px;color:${C.gold};margin-bottom:8px;`;

        statusEl = document.createElement('div');
        statusEl.style.cssText = `font-size:11px;margin-bottom:4px;`;

        coverageEl = document.createElement('div');
        coverageEl.style.cssText = `font-size:10px;margin-bottom:10px;color:${C.gold};`;

        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = `display:flex;gap:6px;`;

        const btnSend = document.createElement('button');
        btnSend.innerHTML = '🚀 Enviar agora';
        btnSend.style.cssText = `flex:1;background:linear-gradient(145deg,#611f63,#4A154B);color:#fff;border:none;padding:8px 10px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;transition:all .15s ease;`;
        btnSend.onmouseenter = () => btnSend.style.transform = 'translateY(-1px)';
        btnSend.onmouseleave = () => btnSend.style.transform = 'none';
        btnSend.onclick = () => {
            if (!localStorage.getItem(WEBHOOK_KEY)) { showWebhookEditor(); return; }
            btnSend.disabled = true;
            btnSend.innerHTML = '⏳ Coletando…';
            sendReport(true, (ok, msg, n) => {
                btnSend.disabled = false;
                btnSend.innerHTML = ok ? `✅ ${n} ticket(s)` : `❌ ${msg}`;
                setTimeout(() => btnSend.innerHTML = '🚀 Enviar agora', 3000);
            });
        };

        const btnWh = document.createElement('button');
        btnWh.innerHTML = '🔗';
        btnWh.title = 'Configurar Webhook do Slack';
        btnWh.style.cssText = `background:rgba(255,255,255,0.08);color:#fff;border:1px solid ${C.accent};padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;transition:all .15s ease;`;
        btnWh.onmouseenter = () => btnWh.style.background = C.btnGradH;
        btnWh.onmouseleave = () => btnWh.style.background = 'rgba(255,255,255,0.08)';
        btnWh.onclick = showWebhookEditor;

        rowBtns.appendChild(btnSend);
        rowBtns.appendChild(btnWh);
        panel.appendChild(title);
        panel.appendChild(sub);
        panel.appendChild(statusEl);
        panel.appendChild(coverageEl);
        panel.appendChild(rowBtns);
        document.body.appendChild(panel);

        applySavedPos(panel);
        makeDraggable(panel, title);
        updateStatus();
    }

    // ── Posição salva + arrastar ─────────────────────────────────────────
    function applySavedPos(panel) {
        let pos = null;
        try { pos = JSON.parse(localStorage.getItem(POSKEY)); } catch (e) {}
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
            const maxL = Math.max(0, window.innerWidth  - panel.offsetWidth);
            const maxT = Math.max(0, window.innerHeight - panel.offsetHeight);
            panel.style.left   = Math.min(Math.max(0, pos.left), maxL) + 'px';
            panel.style.top    = Math.min(Math.max(0, pos.top),  maxT) + 'px';
            panel.style.right  = 'auto';
            panel.style.bottom = 'auto';
        }
    }

    function makeDraggable(panel, handle) {
        let dragging = false, offX = 0, offY = 0;
        handle.addEventListener('mousedown', e => {
            dragging = true;
            const r = panel.getBoundingClientRect();
            offX = e.clientX - r.left;
            offY = e.clientY - r.top;
            panel.style.transition = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            let l = e.clientX - offX, t = e.clientY - offY;
            l = Math.min(Math.max(0, l), window.innerWidth  - panel.offsetWidth);
            t = Math.min(Math.max(0, t), window.innerHeight - panel.offsetHeight);
            panel.style.left = l + 'px';
            panel.style.top  = t + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            const r = panel.getBoundingClientRect();
            localStorage.setItem(POSKEY, JSON.stringify({ left: r.left, top: r.top }));
        });
    }

    // ── Editor de Webhook ────────────────────────────────────────────────
    function showWebhookEditor() {
        document.getElementById('sim-webhook-editor')?.remove();
        const modal = document.createElement('div');
        modal.id = 'sim-webhook-editor';
        modal.style.cssText = `position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:'Amazon Ember',Arial,sans-serif;animation:simFade .18s ease;`;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        const box = document.createElement('div');
        box.style.cssText = `background:#fff;border-radius:16px;overflow:hidden;width:90%;max-width:520px;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:simPop .24s cubic-bezier(.18,.9,.32,1.2);`;

        const head = document.createElement('div');
        head.style.cssText = `background:${C.headerGrad};color:${C.white};padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${C.accent};`;
        head.innerHTML = `<div><div style="font-size:15px;font-weight:700;">${SLACK_SVG} Webhook do Slack</div><div style="font-size:11px;color:${C.gold};margin-top:3px;">URL do canal que receberá os tickets a cada 4h</div></div>`;
        const btnX = document.createElement('button');
        btnX.textContent = '✖';
        btnX.style.cssText = `background:rgba(255,255,255,0.08);color:${C.white};border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;transition:all .15s ease;`;
        btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
        btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
        btnX.onclick = () => modal.remove();
        head.appendChild(btnX);

        const body = document.createElement('div');
        body.style.cssText = `padding:20px;background:${C.bodyBg};`;
        const lbl = document.createElement('label');
        lbl.style.cssText = `display:block;font-size:12px;font-weight:700;color:${C.dark};margin-bottom:6px;`;
        lbl.textContent = 'URL do Incoming Webhook:';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = localStorage.getItem(WEBHOOK_KEY) || '';
        inp.placeholder = 'https://hooks.slack.com/services/...';
        inp.style.cssText = `width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #D5DBE0;border-radius:8px;font-size:12px;font-family:Consolas,monospace;color:${C.dark};background:#fff;outline:none;transition:all .15s ease;`;
        inp.addEventListener('focus', () => { inp.style.borderColor = C.accent; inp.style.boxShadow = '0 0 0 3px rgba(255,153,0,.18)'; });
        inp.addEventListener('blur',  () => { inp.style.borderColor = '#D5DBE0'; inp.style.boxShadow = 'none'; });

        const status = document.createElement('div');
        status.style.cssText = `font-size:11px;margin-top:8px;`;
        const hasWh = !!localStorage.getItem(WEBHOOK_KEY);
        status.style.color = hasWh ? C.green : C.amber;
        status.textContent = hasWh ? '✅ Webhook configurado' : '⚠️ Nenhum webhook configurado';

        body.appendChild(lbl); body.appendChild(inp); body.appendChild(status);

        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:12px 20px;display:flex;justify-content:space-between;align-items:center;`;

        const btnReset = document.createElement('button');
        btnReset.innerHTML = '🗑️ Resetar';
        btnReset.style.cssText = `background:rgba(204,0,0,0.06);color:${C.red};border:1px solid ${C.red};padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;transition:all .15s ease;`;
        btnReset.onclick = () => {
            localStorage.removeItem(WEBHOOK_KEY);
            inp.value = '';
            status.style.color = C.amber;
            status.textContent = '⚠️ Webhook removido';
            updateStatus();
        };

        const btnSave = document.createElement('button');
        btnSave.innerHTML = '💾 Salvar';
        btnSave.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};padding:9px 24px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;transition:all .15s ease;`;
        btnSave.onclick = () => {
            const url = inp.value.trim();
            if (!url) { alert('❌ Digite uma URL válida.'); return; }
            if (!url.startsWith('https://hooks.slack.com/') &&
                !confirm('⚠️ URL não parece um webhook Slack padrão.\nSalvar assim mesmo?')) return;
            localStorage.setItem(WEBHOOK_KEY, url);
            status.style.color = C.green;
            status.textContent = '✅ Webhook salvo!';
            updateStatus();
            setTimeout(() => modal.remove(), 800);
        };

        foot.appendChild(btnReset); foot.appendChild(btnSave);
        box.appendChild(head); box.appendChild(body); box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // ── Menu do Tampermonkey ─────────────────────────────────────────────
    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('🚀 Enviar tickets agora', () => {
            if (!localStorage.getItem(WEBHOOK_KEY)) { showWebhookEditor(); return; }
            sendReport(true);
        });
        GM_registerMenuCommand('🔗 Configurar Webhook do Slack', showWebhookEditor);
    }

    // ── Init ─────────────────────────────────────────────────────────────
    function init() {
        injectUICss();

        // Aba de coleta: só lê a fila e cacheia; o main tab fecha ela depois.
        if (IS_WORKER) {
            setTimeout(scrapeCurrentIfQueue, 2500);
            const iv = setInterval(scrapeCurrentIfQueue, 1500);
            setTimeout(() => clearInterval(iv), FETCH_TIMEOUT + 5000);
            return;
        }

        registerMenu();
        setTimeout(injectPanel, 1000);
        setInterval(injectPanel, 2500);          // auto-regenera o painel (SPA re-renderiza)
        setTimeout(scrapeCurrentIfQueue, 4000);  // primeira leitura da fila da aba
        setInterval(heartbeat, HEARTBEAT_MS);
        setTimeout(heartbeat, 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Reinjeta o painel e atualiza o cache quando a SPA re-renderiza (throttled).
    let moTimer = null;
    new MutationObserver(() => {
        if (moTimer) return;
        const delay = IS_WORKER ? 1200 : 3000;
        moTimer = setTimeout(() => { moTimer = null; scrapeCurrentIfQueue(); if (!IS_WORKER) injectPanel(); }, delay);
        if (!IS_WORKER) injectPanel();
    }).observe(document.body, { childList: true, subtree: true });
})();
