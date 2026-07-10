// ==UserScript==
// @name         FCLM - PPA Attendance Export CSV
// @namespace    http://tampermonkey.net/
// @version      5.15
// @description  Exporta ppaAttendance — missed punch Day/Night + filtro Manager + table style + setas sort
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/ppaAttendance*
// @match        https://fclm-portal.amazon.com/reports/employeeAttendance*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
// v1.x — Setup: detecção punch, Day/Night Range, filtro Manager localStorage
// v2.x — Amazon table style, células ? missed, checkbox filtro, Gerar Ticket XLS
// v3.x — Ticket .xlsx, Roster name→login, matchBestAssignment por menor erro
// v4.0-4.1 — detectMissing par/ímpar; turno desconhecido âmbar; setas ▲▼ headers
// v4.2-4.3 — Fix getHeaderText(): setas não contaminam filtro/checkbox
// v4.4-4.5 — Botão ENVIAR TICKET; botões CAIXA ALTA; EXPORTAR DADOS cor suave
// v4.6 — Botão ❓ toggle painel de ajuda no overlay
// v4.7 — Changelog condensado; overlay compacto
// v4.8 — cellToCSV: texto puro, sem fórmula HYPERLINK no CSV (ID e Nome como texto)
// v4.9 — injectRangeButtons: separador + botão ⏱ TOT → ppaTimeOnTask
// v5.0 — Fix getInOutPairs: \s? (espaço opcional → "In 1" e "In1"); applyTableFilter: pair-level (fix 4-punch shifts)
// v5.1 — Fix: version bump
// v5.2 — applyRange(): seleciona radio Intraday via XPath + querySelector → preenche campos → submete form
//         (igual comportamento do script Intradays — radio visível + sem navegação direta por URL)
// v5.3 — matchBestExcess(): detecta batidas excedentes pelo menor erro de atribuição (inverso ao matchBestAssignment)
//         collectExcessData() + generateExcessXLSX() + botão 🗑️ GERAR EXCESSO no overlay
// v5.4 — highlightExcessCells(): marca células excedentes na tabela com ⚠ âmbar + strikethrough
//         CSS .ppa-cell-excess + .ppa-row-excess; resetExcessCell(); integrado em highlightMissingCells()
// v5.5 — Fix collectExcessData(): ⚠ no innerHTML contaminava textContent → to12h retornava 12:xx AM
//         getCleanCellTime() lê ppaOriginalText quando célula já foi marcada pelo highlight
// v5.6 — Renomeia botões: "GERAR TICKET" → "GERAR TICKET - MISSED PUNCH"
//                         "GERAR EXCESSO" → "GERAR TICKET DUPLICADO"
//         Justificação excesso: "Duplicated punch (batida duplicada)"
// v5.7 — Overlay compacto: padding 6px 9px, minWidth 195px; botões font 12px (+2px), padding reduzido
//         Help panel ❓ atualizado com novos nomes de botões + info destaque ⚠
// v5.8 — Overlay ultra-compacto: padding 4px 7px, botões font 14px (+2px), padding 1px 4px
//         Checkbox "⚠ Apenas Duplicated" no filtro Manager + persistência localStorage
//         applyTableFilter(): suporte duplicatedOnly via SHIFT_SCHEDULE + getCleanCellTime
// v5.11 — Fix detectMissing(): usa SHIFT_SCHEDULE max (6/4) em vez de pairs.length×2
//         Evita falso-positivo quando tabela tem 5 pares In/Out por linhas com excess
//         Botões: line-height:1.1 para corrigir altura inflada por herança do container (1.5)
// v5.12 — Botões: font-size 10px; border:1px solid transparent (base p/ hover sem layout shift)
//         addBtnHover(): hover inverte background ↔ cor do texto em todos os botões
// v5.13 — Filtro por Shift ao lado do Manager (ppa-shift-select); persistência SHIFT_KEY por warehouse
//         getTableData()/applyTableFilter(): match combinável manager + shift; counts respeitam shift
// v5.14 — Unifica filtros: checkbox único "⚠ Apenas Pendências" (missed OU duplicated)
//         ISSUES_KEY substitui MISSED_KEY/DUPLICATED_KEY; applyTableFilter() com OR combinado
//         Botões de extração (Missed / Duplicated) permanecem separados
// v5.15 — Overlay restaurado ao visual v5.12: minWidth 100px, padding botões 4px,
//         labels sem emoji e encurtados (EXPORTAR DADOS / GERAR MISSED PUNCH /
//         GERAR DUPLICATED PUNCH / ENVIAR TICKET) — features v5.14 mantidas


(function() {
    'use strict';


    const OVERLAY_ID    = 'ppa-export-overlay';
    const POLL_INTERVAL = 1500;


    // ── Parâmetros da URL ──────────────────────────────────────────────────
    const urlParams   = new URLSearchParams(window.location.search);
    const warehouseId = urlParams.get('warehouseId') || 'UNKNOWN';
    const startDate   = (urlParams.get('startDateIntraday') || urlParams.get('startDateDay') || new Date().toISOString().slice(0,10)).replace(/\//g, '-');
    const endDate     = (urlParams.get('endDateIntraday') || '').replace(/\//g, '-');


    // Chave de persistência — específica por warehouse (ex: "ppa_manager_GRU5")
    const FILTER_KEY  = `ppa_manager_${warehouseId}`;
    const SHIFT_KEY       = `ppa_shift_${warehouseId}`;       // v5.13 filtro por turno
    const ISSUES_KEY      = `ppa_issues_${warehouseId}`;      // v5.14 checkbox unificado (missed OU duplicated)
    const ROSTER_KEY = `ppa_roster_${warehouseId}`;        // cache mapa name→login do Roster
    const ROSTER_TTL = 24 * 60 * 60 * 1000;               // TTL: 1 dia em ms


    // Tabela de turnos — horários fixos usados no ticket
    // In2 = Out1 real + 60min  (Retorno Refeição — dinâmico)
    // In3 = Out2 real + 15min  (Retorno Café     — dinâmico)
    const SHIFT_SCHEDULE = {
        'NSAZ1800': { in1: '18:00', out1: '23:00', out2: '02:15', out3: '05:00' },
        'NR-Z1800': { in1: '18:00', out1: '23:00', out2: '02:15', out3: '05:00' },
        'NF0T1800': { in1: '18:00', out1: '23:00', out2: '02:15', out3: '05:00' },
        'DR-Z0600': { in1: '06:00', out1: '10:30', out2: '15:15', out3: '18:00' },
        'DSAZ0600': { in1: '06:00', out1: '10:30', out2: '15:15', out3: '18:00' },
        'DF-Z0600': { in1: '06:00', out1: '10:30', out2: '15:15', out3: '18:00' },
        'NE-Z0800': { in1: '08:00', out1: '10:30', out2: null,    out3: '18:00' },
        'DE-Z1400': { in1: '14:00', out1: '17:30', out2: null,    out3: '23:00' },
    };


    // Adiciona N minutos a "HH:MM" → "HH:MM" (suporta virada de meia-noite)
    function addMinutes(time24, mins) {
        if (!time24 || !time24.includes(':')) return '?';
        const [h, m] = time24.split(':').map(Number);
        const total  = h * 60 + m + mins;
        return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }


    // Normaliza nome para comparação consistente (case, espaços, vírgula, \u00A0)
    // "Silva , Camila" → "SILVA,CAMILA"  |  "DA SILVA,LUCAS HENRIQUE" → "DA SILVA,LUCAS HENRIQUE"
    function normalizeRosterName(name) {
        return (name || '')
            .replace(/\u00A0/g, ' ')   // non-breaking space → espaço normal
            .trim()
            .toUpperCase()
            .replace(/\s*,\s*/g, ',')  // "Silva , Camila" → "SILVA,CAMILA"
            .replace(/\s+/g, ' ');     // múltiplos espaços → simples
    }


    // "HH:MM" → minutos desde meia-noite
    function timeToMins(t) {
        if (!t || !t.includes(':')) return -1;
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    }


    // Diferença circular entre dois valores em minutos (lida com virada de meia-noite)
    function circularDiff(a, b) {
        const d = Math.abs(a - b);
        return Math.min(d, 1440 - d);
    }


    // Gera todas as C(n, k) combinações de índices 0..n-1
    function getCombinations(n, k) {
        const result = [];
        function combine(start, current) {
            if (current.length === k) { result.push([...current]); return; }
            for (let i = start; i < n; i++) {
                current.push(i);
                combine(i + 1, current);
                current.pop();
            }
        }
        combine(0, []);
        return result;
    }


    // ── Mínimo Erro de Atribuição (v3.6) ──────────────────────────────────
    // Testa todas as C(totalSlots, N) formas de atribuir N punches reais a
    // N slots do turno — os M = totalSlots-N restantes são "faltando".
    // Escolhe a atribuição com MENOR erro total de horário, usando:
    //   In2 = punch_Out1 + 60min   (dinâmico — retorno refeição)
    //   In3 = punch_Out2 + 15min   (dinâmico — retorno café)
    //
    // Exemplo: 5 punches com In2 esquecido
    //   Hipótese "falta In2": atribui 03:07→Out2 e 03:22→In3 (diff=0) → total="258" ✓
    //   Hipótese "falta Out3": In2="03:07" (diff=113 de 01:14)             → total="455" ✗
    //   → vencedor: In2 faltando, expected="Out1_real+60=01:14" ✓
    function matchBestAssignment(actualTimes, schedule) {
        if (!schedule || !actualTimes.length) return [];


        const isFour     = !schedule.out2;
        const totalSlots = isFour ? 4 : 6;
        const N          = Math.min(actualTimes.length, totalSlots);
        const M          = totalSlots - N;
        if (M <= 0) return [];


        const pMins     = actualTimes.map(timeToMins);
        const slotTypes = isFour
            ? ['In', 'Out', 'In', 'Out']
            : ['In', 'Out', 'In', 'Out', 'In', 'Out'];


        // Horários esperados para cada slot — slots dinâmicos usam o punch
        // real do Out anterior para maior precisão na comparação
        function getSlotTimes(presentIndices) {
            let times;
            if (isFour) {
                times = [schedule.in1, schedule.out1, null, schedule.out3];
                // In2 = punch no slot Out1 + 60min
                times[2] = presentIndices.includes(1)
                    ? addMinutes(actualTimes[presentIndices.indexOf(1)], 60)
                    : addMinutes(schedule.out1, 60);
            } else {
                times = [schedule.in1, schedule.out1, null, schedule.out2, null, schedule.out3];
                // In2 = punch no slot Out1 + 60min
                times[2] = presentIndices.includes(1)
                    ? addMinutes(actualTimes[presentIndices.indexOf(1)], 60)
                    : addMinutes(schedule.out1, 60);
                // In3 = punch no slot Out2 + 15min
                times[4] = presentIndices.includes(3)
                    ? addMinutes(actualTimes[presentIndices.indexOf(3)], 15)
                    : (schedule.out2 ? addMinutes(schedule.out2, 15) : schedule.out3);
            }
            return times;
        }


        const combos    = getCombinations(totalSlots, N);
        let bestTotal   = Infinity;
        let bestMissing = null;


        for (const presentIndices of combos) {
            const slotTimes = getSlotTimes(presentIndices);


            // Penalidade por slot dinâmico com fallback de schedule:
            // quando o Out "âncora" está ausente, In2/In3 é estimado por schedule
            // (incerto) → penaliza para não vencer sobre hipóteses mais sólidas.
            // Ex: Out1 ausente → In2 = schedule.out1+60 = 00:00 → batida 00:14
            //     tem diff="14" (artificialmente bom) → +180 corrige o viés.
            let dynamicPenalty = 0;
            if (!presentIndices.includes(1))            dynamicPenalty += 180; // Out1 ausente → In2 incerto
            if (!isFour && !presentIndices.includes(3)) dynamicPenalty +=  60; // Out2 ausente → In3 incerto


            let total = dynamicPenalty;
            for (let j = 0; j < N; j++) {
                const sMins = timeToMins(slotTimes[presentIndices[j]]);
                if (pMins[j] < 0 || sMins < 0) continue;
                total += circularDiff(pMins[j], sMins);
            }
            if (total < bestTotal) {
                bestTotal = total;
                const missingIdx = [];
                for (let i = 0; i < totalSlots; i++) {
                    if (!presentIndices.includes(i)) missingIdx.push(i);
                }
                bestMissing = missingIdx.map(i => ({
                    type:         slotTypes[i],
                    expectedTime: slotTimes[i] || schedule.out3
                }));
            }
        }


        return bestMissing || [];
    }


    // ── Mínimo Erro de Excesso (v5.3) ──────────────────────────────────────
    // Inverso do matchBestAssignment: quando há MAIS punches que slots esperados,
    // testa todas as C(N, totalSlots) combinações de punches a MANTER nos slots.
    // A combinação com MENOR erro total de horário é a correta — os punches
    // NÃO escolhidos são os excedentes (devem ser removidos).
    //
    // Exemplo: 9 punches, turno de 6 slots
    //   Melhor combinação: [18:00, 23:27, 0:27, 2:53, 3:19, 5:06] → erro mínimo
    //   Excesso: [19:21, 19:28, 5:03] ← devem ser deletados
    function matchBestExcess(actualTimes, schedule) {
        if (!schedule || !actualTimes.length) return [];


        const isFour     = !schedule.out2;
        const totalSlots = isFour ? 4 : 6;
        const N          = actualTimes.length;


        if (N <= totalSlots) return []; // sem excesso


        const slotTypes = isFour
            ? ['In', 'Out', 'In', 'Out']
            : ['In', 'Out', 'In', 'Out', 'In', 'Out'];


        // Calcula tempos esperados para os slots dado um conjunto de punches mantidos
        function getExpectedTimes(kt) {
            let times;
            if (isFour) {
                times = [schedule.in1, schedule.out1, null, schedule.out3];
                times[2] = addMinutes(kt[1] || schedule.out1, 60);
            } else {
                times = [schedule.in1, schedule.out1, null, schedule.out2, null, schedule.out3];
                times[2] = addMinutes(kt[1] || schedule.out1, 60);
                times[4] = addMinutes(kt[3] || schedule.out2 || schedule.out1, 15);
            }
            return times;
        }


        const combos   = getCombinations(N, totalSlots);
        let bestTotal  = Infinity;
        let bestExcess = null;


        for (const keptIndices of combos) {
            const keptTimes = keptIndices.map(i => actualTimes[i]);
            const slotTimes = getExpectedTimes(keptTimes);


            let total = 0;
            for (let j = 0; j < totalSlots; j++) {
                const sMins = timeToMins(slotTimes[j]);
                const pMins = timeToMins(keptTimes[j]);
                if (pMins < 0 || sMins < 0) continue;
                total += circularDiff(pMins, sMins);
            }


            if (total < bestTotal) {
                bestTotal = total;
                const excessIndices = [];
                for (let i = 0; i < N; i++) {
                    if (!keptIndices.includes(i)) excessIndices.push(i);
                }
                // Tipo de cada punch excedente: slot mais próximo em tempo
                bestExcess = excessIndices.map(exIdx => {
                    const eMins = timeToMins(actualTimes[exIdx]);
                    let closestDiff = Infinity, closestType = 'In';
                    for (let j = 0; j < totalSlots; j++) {
                        const sMins = timeToMins(slotTimes[j]);
                        if (sMins < 0) continue;
                        const diff = circularDiff(eMins, sMins);
                        if (diff < closestDiff) { closestDiff = diff; closestType = slotTypes[j]; }
                    }
                    return { type: closestType, time: actualTimes[exIdx] };
                });
            }
        }


        return bestExcess || [];
    }


    // ── FCLM Roster — mapa Employee Name → User ID (login) ───────────────
    // Busca o Roster do warehouse via GM_xmlhttpRequest, extrai as colunas
    // "Employee Name" e "User ID", e constrói { "NOME UPPER": "login" }.
    // Cache local por 1 dia (TTL) via GM_setValue.
    function fetchRosterMap(callback) {
        // Verifica cache — ignora se mapa estiver vazio (evita cache de falha)
        try {
            const cached = JSON.parse(GM_getValue(ROSTER_KEY, 'null'));
            if (cached && Object.keys(cached.map).length> 0 && (Date.now() - cached.timestamp) < ROSTER_TTL) {
                console.log('[Roster] Cache válido —', Object.keys(cached.map).length, 'entradas');
                callback(cached.map);
                return;
            }
        } catch(e) {}


        const url = 'https://fclm-portal.amazon.com/employee/employeeRoster'
            + '?reportFormat=HTML'
            + '&employeeStatusActive=true&_employeeStatusActive=on'
            + '&employeeStatusLeaveOfAbsence=true&_employeeStatusLeaveOfAbsence=on'
            + '&employeeStatusExempt=true&_employeeStatusExempt=on'
            + '&employeeTypeAmzn=true&_employeeTypeAmzn=on'
            + '&employeeTypeTemp=true&_employeeTypeTemp=on'
            + '&employeeType3Pty=true&_employeeType3Pty=on'
            + '&Employee+ID=Employee+ID&User+ID=User+ID&Employee+Name=Employee+Name'
            + '&Badge+Barcode+ID=Badge+Barcode+ID&Department+ID=Department+ID'
            + '&Employment+Start+Date=Employment+Start+Date'
            + '&Employment+Type=Employment+Type&Employee+Status=Employee+Status'
            + '&Manager+Name=Manager+Name&Temp+Agency+Code=Temp+Agency+Code'
            + '&Job+Title=Job+Title&Management+Area+ID=Management+Area+ID'
            + '&Shift+Pattern=Shift+Pattern&Badge+RFID=Badge+RFID&Exempt=Exempt'
            + '&hideColumns=Photo&submit=true'
            + '&warehouseId=' + warehouseId;


        console.log('[Roster] Buscando roster de', warehouseId, '...');
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            onload: function(res) {
                try {
                    console.log('[Roster] HTTP', res.status, '—', res.responseText.length, 'chars recebidos');
                    const parser = new DOMParser();
                    const doc    = parser.parseFromString(res.responseText, 'text/html');


                    const table = doc.querySelector('table.employeeList')
                                || doc.querySelector('table.result-table')
                                || doc.querySelector('#content-panel table')
                                || doc.querySelector('table');


                    if (!table) {
                        console.warn('[Roster] Tabela não encontrada. Preview HTML:', res.responseText.slice(0, 400));
                        callback({});
                        return;
                    }


                    // ── Detecta headers: tenta <thead> primeiro, cai na 1ª linha ──
                    let headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
                    if (!headerCells.length) {
                        const firstRow = table.querySelector('tr');
                        if (firstRow) headerCells = Array.from(firstRow.querySelectorAll('th, td'));
                        console.log('[Roster] <thead> ausente — usando 1ª linha da tabela');
                    }
                    const headers  = headerCells.map(th => th.textContent.trim().toLowerCase());
                    console.log('[Roster] Headers:', headers);


                    const nameIdx  = headers.findIndex(h => h.includes('employee name'));
                    const loginIdx = headers.findIndex(h => h.includes('user id'));


                    if (nameIdx === -1 || loginIdx === -1) {
                        console.warn('[Roster] nameIdx=' + nameIdx + ' loginIdx=' + loginIdx);
                        callback({});
                        return;
                    }


                    // Constrói mapa com nome normalizado
                    const map = {};
                    table.querySelectorAll('tbody tr').forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (!cells[nameIdx] || !cells[loginIdx]) return;
                        const name  = normalizeRosterName(cells[nameIdx].textContent);
                        const login = cells[loginIdx].textContent.trim();
                        if (name && login) map[name] = login;
                    });


                    console.log('[Roster] Mapa construído:', Object.keys(map).length, 'funcionários');
                    if (Object.keys(map).length > 0) {
                        console.log('[Roster] Primeiras 5 entradas:', Object.entries(map).slice(0, 5));
                        GM_setValue(ROSTER_KEY, JSON.stringify({ map, timestamp: Date.now() }));
                    } else {
                        console.warn('[Roster] Mapa VAZIO — não será cacheado. Verifique URL/permissões.');
                    }
                    callback(map);
                } catch(e) {
                    console.warn('[Roster] Erro ao processar:', e);
                    callback({});
                }
            },
            onerror: function() {
                console.warn('[Roster] Erro na requisição HTTP');
                callback({});
            }
        });
    }


    // ── Debug helpers — acessíveis pelo console do browser ────────────────
    window.__ppaDebug = {
        clearRosterCache: function() {
            GM_setValue(ROSTER_KEY, 'null');
            console.log('[ppaDebug] Cache do Roster limpo! Clique em "Gerar Ticket" para rebuscar.');
        },
        showRosterCache: function() {
            const c = JSON.parse(GM_getValue(ROSTER_KEY, 'null'));
            if (!c) { console.log('[ppaDebug] Cache vazio'); return null; }
            const age = Math.round((Date.now() - c.timestamp) / 60000);
            console.log('[ppaDebug] Roster:', Object.keys(c.map).length, 'funcionários, age:', age, 'min');
            console.table(Object.entries(c.map).slice(0, 20).map(([name, login]) => ({ name, login })));
            return c.map;
        },
        findManager: function(name) {
            const c = JSON.parse(GM_getValue(ROSTER_KEY, 'null'));
            if (!c || !c.map) { console.log('[ppaDebug] Cache vazio — rode Gerar Ticket primeiro'); return null; }
            const key = (name || '').replace(/\u00A0/g, ' ').trim().toUpperCase()
                                    .replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
            const result = c.map[key];
            console.log('[ppaDebug] Key buscada:', JSON.stringify(key));
            console.log('[ppaDebug] Resultado:', result || '❌ NÃO ENCONTRADO');
            if (!result) {
                const sobrenome = key.split(',')[0];
                const similar = Object.keys(c.map).filter(k => k.startsWith(sobrenome)).slice(0, 5);
                console.log('[ppaDebug] Chaves com mesmo sobrenome:', similar.length ? similar : 'nenhuma');
            }
            return result || null;
        }
    };


    // ── 1. Localiza tabela ────────────────────────────────────────────────
    function findTable() {
        let t = document.querySelector('#content> table');
        if (t && t.querySelector('tr')) return t;
        t = document.querySelector('table.attendance');
        if (t && t.querySelector('tr')) return t;
        t = document.querySelector('table.result-table');
        if (t && t.querySelector('tr')) return t;
        for (const table of document.querySelectorAll('table')) {
            const firstRow = table.querySelector('tr');
            if (firstRow && firstRow.textContent.includes('Employee ID')) return table;
        }
        return null;
    }


    // ── 2. Numera headers duplicados ──────────────────────────────────────
    function getNumberedHeaders(rawHeaders) {
        const count = {};
        return rawHeaders.map(h => {
            const k = h.toLowerCase();
            if (k === 'in' || k === 'out') {
                count[h] = (count[h] || 0) + 1;
                return `${h} ${count[h]}`;
            }
            return h;
        });
    }


    // ── 3. Identifica pares In N ↔ Out N ─────────────────────────────────
    function getInOutPairs(numberedHeaders) {
        const pairs = [];
        numberedHeaders.forEach((h, i) => {
            const m = h.match(/^In\s?(\d+)$/i);   // \s? — "In 1" e "In1" ambos válidos
            if (m) {
                const num    = m[1];
                const outIdx = numberedHeaders.findIndex(x => new RegExp(`^Out\\s?${num}$`, 'i').test(x));
                if (outIdx !== -1) pairs.push({ inIdx: i, outIdx, num });
            }
        });
        return pairs;
    }


    // ── 3b. Lê texto de header sem contaminar com setas ▲▼ (v4.3) ────────
    // As setas .ppa-sort-arrows adicionam texto ao textContent da célula,
    // corrompendo getNumberedHeaders/getInOutPairs nas chamadas subsequentes.
    function getHeaderText(cell) {
        const clone  = cell.cloneNode(true);
        const arrows = clone.querySelector('.ppa-sort-arrows');
        if (arrows) arrows.remove();
        return clone.textContent.trim();
    }


    // ── 4. Detecta punch faltando ─────────────────────────────────────────
    // v5.11 — shiftCode opcional: quando conhecido, usa max do SHIFT_SCHEDULE (6 ou 4)
    // em vez de pairs.length×2, evitando falso-positivo quando a tabela tem mais pares
    // In/Out do que o turno espera (ex: 5 pares por linhas com excess de punches).
    function detectMissing(cells, pairs, shiftCode) {
        let filled = 0;
        pairs.forEach(({ inIdx, outIdx }) => {
            // Ignora células modificadas pelo script ("?" não conta como punch)
            if (cells[inIdx]  && !cells[inIdx].dataset.ppaModified  && cells[inIdx].textContent.trim())  filled++;
            if (cells[outIdx] && !cells[outIdx].dataset.ppaModified && cells[outIdx].textContent.trim()) filled++;
        });
        // maxFilled: usa SHIFT_SCHEDULE quando o turno é conhecido (evita falso-positivo)
        // fallback para pairs.length×2 quando turno ausente/desconhecido
        let maxFilled;
        if (shiftCode && SHIFT_SCHEDULE[shiftCode]) {
            maxFilled = ['NE-Z0800', 'DE-Z1400'].includes(shiftCode) ? 4 : 6;
        } else {
            maxFilled = pairs.length * 2;
        }
        if (filled === 0 || filled >= maxFilled) return null;
        return String(filled);
    }


    // ── 5. CSV helpers ────────────────────────────────────────────────────
    function escCSV(v) {
        const s = (v || '').toString().trim();
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }


    function cellToCSV(cell) {
        // v4.8 — texto puro, sem fórmula HYPERLINK (ID e Nome exportados como texto)
        return escCSV(cell.textContent.trim());
    }


    // ── 6. Manager selecionado ────────────────────────────────────────────
    function getSelectedManager() {
        const sel = document.getElementById('ppa-manager-select');
        return sel ? sel.value : '';
    }


    // v5.13 — Shift selecionado
    function getSelectedShift() {
        const sel = document.getElementById('ppa-shift-select');
        return sel ? sel.value : '';
    }


    // ── 7. Coleta dados ───────────────────────────────────────────────────
    function getTableData() {
        const table = findTable();
        if (!table) return { headers: [], headersWithTag: [], allRows: [], dayMissingRows: [], nightMissingRows: [], count: 0, dayMissing: 0, nightMissing: 0, managers: [], shifts: [] };


        const rawCells   = table.querySelectorAll('thead th, thead td');
        const rawHeaders = rawCells.length
            ? Array.from(rawCells).map(getHeaderText)
            : Array.from((table.querySelector('tr') || { querySelectorAll: () => [] }).querySelectorAll('th, td')).map(getHeaderText);


        const numberedHeaders = getNumberedHeaders(rawHeaders);
        const pairs           = getInOutPairs(numberedHeaders);
        const headers         = numberedHeaders.map(h => escCSV(h));
        const shiftIdx        = numberedHeaders.findIndex(h => h.toLowerCase() === 'shift');
        const managerIdx      = numberedHeaders.findIndex(h => h.toLowerCase() === 'manager');
        const DAY_EXCEPTIONS  = ['NE-Z0800'];


        const bodyRows = table.querySelectorAll('tbody tr');
        const dataRows = bodyRows.length
            ? Array.from(bodyRows)
            : Array.from(table.querySelectorAll('tr')).slice(1);


        const rowEntries = [];
        dataRows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;
            const csvRow    = Array.from(cells).map(c => cellToCSV(c));
            const shiftCode = (shiftIdx   >= 0 && cells[shiftIdx])   ? cells[shiftIdx].textContent.trim().toUpperCase() : '';
            const missing   = detectMissing(cells, pairs, shiftCode); // v5.11
            const manager   = (managerIdx >= 0 && cells[managerIdx]) ? cells[managerIdx].textContent.trim()              : '';
            const isDay     = shiftCode.startsWith('D') || DAY_EXCEPTIONS.includes(shiftCode);
            const isNight   = shiftCode.startsWith('N') && !DAY_EXCEPTIONS.includes(shiftCode);
            rowEntries.push({ csvRow, manager, missing, isDay, isNight, shiftCode });
        });


        const managers = [...new Set(rowEntries.map(r => r.manager).filter(m => m))].sort();
        const shifts   = [...new Set(rowEntries.map(r => r.shiftCode).filter(s => s))].sort(); // v5.13


        const sel      = getSelectedManager();
        const selShift = getSelectedShift(); // v5.13
        const filtered = rowEntries.filter(r =>
            (!sel || r.manager === sel) && (!selShift || r.shiftCode === selShift));


        const allRows        = filtered.map(r => r.csvRow);
        const dayMissingRows = filtered
            .filter(r => r.missing && (r.isDay   || (!r.isDay && !r.isNight)))
            .map(r => [...r.csvRow, escCSV(r.missing)]);
        const nightMissingRows = filtered
            .filter(r => r.missing && (r.isNight || (!r.isDay && !r.isNight)))
            .map(r => [...r.csvRow, escCSV(r.missing)]);


        return { headers, headersWithTag: [...headers, escCSV('Missed Punch')], allRows, dayMissingRows, nightMissingRows, count: allRows.length, dayMissing: dayMissingRows.length, nightMissing: nightMissingRows.length, managers, shifts };
    }


    // ── 8. Download CSV ───────────────────────────────────────────────────
    function downloadCSV(headers, rows, suffix) {
        const dateStr  = startDate + (endDate ? '_' + endDate : '');
        const filename = `ppa_attendance_${warehouseId}_${dateStr}${suffix}.csv`;
        const csv      = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
        const blob     = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url      = URL.createObjectURL(blob);
        const a        = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
        return { count: rows.length };
    }


    // ── 20. Ticket XLS ────────────────────────────────────────────────────
    // Converte código de turno → "HH:MM - HH:MM" (turno dura 12h)
    // Ex: NSAZ1800 → "18:00 - 06:00" | DR-Z0600 → "06:00 - 18:00"
    function getShiftRange(shiftCode) {
        const match = shiftCode.match(/(\d{2})(\d{2})$/);
        if (match) {
            const startH = match[1], startM = match[2];
            const endH   = ((parseInt(startH) + 12) % 24).toString().padStart(2, '0');
            return `${startH}:${startM} - ${endH}:${startM}`;
        }
        return shiftCode;
    }


    // Converte "17:47" → "5:47 PM"
    function to12h(time24) {
        if (!time24 || !time24.includes(':')) return time24;
        const [h, m] = time24.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const h12    = h % 12 || 12;
        return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
    }


    // Converte "2026-05-19" → "5/19/2026"
    function fmtDateTicket(dateStr) {
        const parts = dateStr.replace(/\//g, '-').split('-');
        if (parts.length !== 3) return dateStr;
        return `${parseInt(parts[1])}/${parseInt(parts[2])}/${parts[0]}`;
    }


    // ── Coleta linhas para o ticket (v3.6) ───────────────────────────────
    // Usa matchBestAssignment para identificar QUAL punch está faltando,
    // não apenas qual coluna está vazia. Gera exatamente M = maxSlots-N linhas.
    function collectTicketData(rosterMap) {
        rosterMap = rosterMap || {};
        const table = findTable();
        if (!table) return [];


        const rawH    = Array.from(table.querySelectorAll('thead th, thead td')).map(getHeaderText);
        const numH    = getNumberedHeaders(rawH);
        const pairs   = getInOutPairs(numH);
        const empIdx  = numH.findIndex(h => /employee\s*id/i.test(h));
        const nameIdx = numH.findIndex(h => /employee\s*name/i.test(h));
        const mgrIdx  = numH.findIndex(h => h.toLowerCase() === 'manager');
        const sIdx    = numH.findIndex(h => h.toLowerCase() === 'shift');


        const FOUR_SHIFTS = ['NE-Z0800', 'DE-Z1400'];
        const bodyRows    = table.querySelectorAll('tbody tr');
        const rows        = bodyRows.length ? Array.from(bodyRows) : Array.from(table.querySelectorAll('tr')).slice(1);
        const ticketRows  = [];
        const reportDate  = fmtDateTicket(startDate);
        let   skippedShifts = 0; // #3 — conta linhas ignoradas por turno não reconhecido


        rows.forEach(row => {
            if (row.style.display === 'none') return;
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;


            // v5.11 — shiftCode hoisted: detectMissing usa SHIFT_SCHEDULE max (evita falso-positivo)
            const shiftCode = (sIdx >= 0 && cells[sIdx]) ? cells[sIdx].textContent.trim().toUpperCase() : '';
            if (!detectMissing(cells, pairs, shiftCode)) return;


            const empId     = (empIdx  >= 0 && cells[empIdx])  ? cells[empIdx].textContent.trim()  : '';
            const empName   = (nameIdx >= 0 && cells[nameIdx]) ? cells[nameIdx].textContent.trim() : '';
            const mgrName   = (mgrIdx  >= 0 && cells[mgrIdx])  ? cells[mgrIdx].textContent.trim()  : '';
            const manager   = rosterMap[normalizeRosterName(mgrName)] || mgrName;
            const schedule  = SHIFT_SCHEDULE[shiftCode] || null;
            if (!schedule) { skippedShifts++; return; } // turno desconhecido — conta e pula


            const shiftRange = getShiftRange(shiftCode);
            const effPairs   = FOUR_SHIFTS.includes(shiftCode) ? pairs.slice(0, 2) : pairs;


            // Coleta punches reais em ordem (ignora "?" injetado pelo script)
            const actualTimes = [];
            effPairs.forEach(({ inIdx, outIdx }) => {
                const ic = cells[inIdx], oc = cells[outIdx];
                if (ic && !ic.dataset.ppaModified && ic.textContent.trim()) actualTimes.push(ic.textContent.trim());
                if (oc && !oc.dataset.ppaModified && oc.textContent.trim()) actualTimes.push(oc.textContent.trim());
            });


            // Atribuição de menor erro → identifica exatamente quais slots estão faltando
            const missingSlots = matchBestAssignment(actualTimes, schedule);
            missingSlots.forEach(slot => {
                ticketRows.push([reportDate, empId, empName, manager, shiftRange,
                    to12h(slot.expectedTime), slot.type,
                    'Missed punch (esquecimento de marca\u00E7\u00E3o)']);
            });
        });


        return { rows: ticketRows, skippedShifts };
    }


    // ── Coleta linhas de EXCESSO para ticket (v5.3) ──────────────────────
    // Para cada linha visível com mais punches que o esperado (>6 ou >4),
    // usa matchBestExcess() para identificar quais punches devem ser removidos.
    function collectExcessData(rosterMap) {
        rosterMap = rosterMap || {};
        const table = findTable();
        if (!table) return { rows: [], skippedShifts: 0 };


        const rawH    = Array.from(table.querySelectorAll('thead th, thead td')).map(getHeaderText);
        const numH    = getNumberedHeaders(rawH);
        const pairs   = getInOutPairs(numH);
        const empIdx  = numH.findIndex(h => /employee\s*id/i.test(h));
        const nameIdx = numH.findIndex(h => /employee\s*name/i.test(h));
        const mgrIdx  = numH.findIndex(h => h.toLowerCase() === 'manager');
        const sIdx    = numH.findIndex(h => h.toLowerCase() === 'shift');


        const FOUR_SHIFTS = ['NE-Z0800', 'DE-Z1400'];
        const bodyRows    = table.querySelectorAll('tbody tr');
        const rows        = bodyRows.length ? Array.from(bodyRows) : Array.from(table.querySelectorAll('tr')).slice(1);
        const ticketRows  = [];
        const reportDate  = fmtDateTicket(startDate);
        let   skippedShifts = 0;


        rows.forEach(row => {
            if (row.style.display === 'none') return;
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;


            const shiftCode = (sIdx >= 0 && cells[sIdx]) ? cells[sIdx].textContent.trim().toUpperCase() : '';
            const schedule  = SHIFT_SCHEDULE[shiftCode] || null;
            if (!schedule) {
                // Conta como skipped apenas se há punches na linha
                const hasPunches = pairs.some(({ inIdx, outIdx }) =>
                    (cells[inIdx] && cells[inIdx].textContent.trim()) ||
                    (cells[outIdx] && cells[outIdx].textContent.trim())
                );
                if (hasPunches) skippedShifts++;
                return;
            }


            const isFour     = FOUR_SHIFTS.includes(shiftCode);
            const totalSlots = isFour ? 4 : 6;


            // Coleta TODOS os punches (todos os pares — para capturar extras em colunas adicionais)
            // v5.5: usa getCleanCellTime() para não capturar o prefixo ⚠ do highlight
            const actualTimes = [];
            pairs.forEach(({ inIdx, outIdx }) => {
                const ic = cells[inIdx], oc = cells[outIdx];
                const icTime = getCleanCellTime(ic);
                const ocTime = getCleanCellTime(oc);
                if (ic && !ic.dataset.ppaModified && icTime) actualTimes.push(icTime);
                if (oc && !oc.dataset.ppaModified && ocTime) actualTimes.push(ocTime);
            });


            if (actualTimes.length <= totalSlots) return; // sem excesso nesta linha


            const empId    = (empIdx  >= 0 && cells[empIdx])  ? cells[empIdx].textContent.trim()  : '';
            const empName  = (nameIdx >= 0 && cells[nameIdx]) ? cells[nameIdx].textContent.trim() : '';
            const mgrName  = (mgrIdx  >= 0 && cells[mgrIdx])  ? cells[mgrIdx].textContent.trim()  : '';
            const manager  = rosterMap[normalizeRosterName(mgrName)] || mgrName;
            const shiftRange = getShiftRange(shiftCode);


            const excessSlots = matchBestExcess(actualTimes, schedule);
            excessSlots.forEach(slot => {
                ticketRows.push([reportDate, empId, empName, manager, shiftRange,
                    to12h(slot.time), slot.type,
                    'Duplicated punch (batida duplicada)']);
            });
        });


        return { rows: ticketRows, skippedShifts };
    }


    // Gera ticket de EXCESSO .xlsx (v5.3)
    function generateExcessXLSX() {
        showFeedback('\u23F3 Buscando roster...');
        fetchRosterMap(function(rosterMap) {
            const { rows: data, skippedShifts } = collectExcessData(rosterMap);
            if (!data.length) {
                const msg = skippedShifts > 0
                    ? `[Gerar Excesso] Nenhuma batida excedente!\n\u26A0 ${skippedShifts} linha(s) ignorada(s) — turno n\u00E3o reconhecido em SHIFT_SCHEDULE.`
                    : '[Gerar Excesso] Nenhuma batida excedente encontrada nos filtros ativos!';
                alert(msg);
                return;
            }
            buildAndDownloadExcessXLSX(data, skippedShifts);
        });
    }


    function buildAndDownloadExcessXLSX(data, skippedShifts = 0) {
        const hdrs = ['Date','Employee ID','Employee Name','Manager Login',
                      'Shift (HH:MM to HH:MM)','Punch Time (HH:MM)','In or Out?','Justification'];


        const ws = XLSX.utils.aoa_to_sheet([hdrs, ...data]);


        const hStyle = {
            fill: { fgColor: { rgb: '7D2B0E' } },
            font: { color: { rgb: 'FFFFFF' }, bold: true, sz: 11, name: 'Arial' },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: {
                top:    { style: 'thin', color: { rgb: '5C1E08' } },
                bottom: { style: 'thin', color: { rgb: '5C1E08' } },
                left:   { style: 'thin', color: { rgb: '5C1E08' } },
                right:  { style: 'thin', color: { rgb: '5C1E08' } }
            }
        };


        const dStyle = {
            font: { sz: 10, name: 'Arial' },
            border: {
                top:    { style: 'thin', color: { rgb: 'DDDDDD' } },
                bottom: { style: 'thin', color: { rgb: 'DDDDDD' } },
                left:   { style: 'thin', color: { rgb: 'DDDDDD' } },
                right:  { style: 'thin', color: { rgb: 'DDDDDD' } }
            }
        };


        for (let c = 0; c < hdrs.length; c++) {
            const ref = XLSX.utils.encode_cell({ r: 0, c });
            if (ws[ref]) ws[ref].s = hStyle;
        }
        for (let r = 1; r <= data.length; r++) {
            for (let c = 0; c < hdrs.length; c++) {
                const ref = XLSX.utils.encode_cell({ r, c });
                if (ws[ref]) ws[ref].s = dStyle;
            }
        }


        ws['!cols'] = [
            { wch: 12 }, { wch: 14 }, { wch: 30 }, { wch: 25 },
            { wch: 20 }, { wch: 15 }, { wch: 12 }, { wch: 45 },
        ];


        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Extra Punches');


        const dateStr = startDate + (endDate ? '_' + endDate : '');
        XLSX.writeFile(wb, `ticket_excess_${warehouseId}_${dateStr}.xlsx`);


        showFeedback(`\uD83D\uDDD1 Excesso: ${data.length} linha(s) geradas${skippedShifts > 0 ? ` \u00B7 \u26A0 ${skippedShifts} turno(s) desconhecido(s)` : ''}`);
    }


    // Gera ticket .xlsx — v3.3: resolve manager login via FCLM Roster (name → User ID)
    function generateTicketXLSX() {
        showFeedback('\u23F3 Buscando roster...');
        fetchRosterMap(function(rosterMap) {
            const { rows: data, skippedShifts } = collectTicketData(rosterMap);
            if (!data.length) {
                const msg = skippedShifts > 0
                    ? `[Gerar Ticket] Nenhum missed punch encontrado!\n\u26A0 ${skippedShifts} linha(s) ignorada(s) — turno n\u00E3o reconhecido em SHIFT_SCHEDULE.`
                    : '[Gerar Ticket] Nenhum missed punch encontrado nos filtros ativos!';
                alert(msg);
                return;
            }
            buildAndDownloadXLSX(data, skippedShifts);
        });
    }


    // Constrói e baixa o arquivo .xlsx (separado para reutilização)
    function buildAndDownloadXLSX(data, skippedShifts = 0) {
        const hdrs = ['Date','Employee ID','Employee Name','Manager Login',
                      'Shift (HH:MM to HH:MM)','Punch Time (HH:MM)','In or Out?','Justification'];


        const ws = XLSX.utils.aoa_to_sheet([hdrs, ...data]);


        const hStyle = {
            fill: { fgColor: { rgb: '2E6D78' } },
            font: { color: { rgb: 'FFFFFF' }, bold: true, sz: 11, name: 'Arial' },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: {
                top:    { style: 'thin', color: { rgb: '1E5560' } },
                bottom: { style: 'thin', color: { rgb: '1E5560' } },
                left:   { style: 'thin', color: { rgb: '1E5560' } },
                right:  { style: 'thin', color: { rgb: '1E5560' } }
            }
        };


        const dStyle = {
            font: { sz: 10, name: 'Arial' },
            border: {
                top:    { style: 'thin', color: { rgb: 'DDDDDD' } },
                bottom: { style: 'thin', color: { rgb: 'DDDDDD' } },
                left:   { style: 'thin', color: { rgb: 'DDDDDD' } },
                right:  { style: 'thin', color: { rgb: 'DDDDDD' } }
            }
        };


        for (let c = 0; c < hdrs.length; c++) {
            const ref = XLSX.utils.encode_cell({ r: 0, c });
            if (ws[ref]) ws[ref].s = hStyle;
        }
        for (let r = 1; r <= data.length; r++) {
            for (let c = 0; c < hdrs.length; c++) {
                const ref = XLSX.utils.encode_cell({ r, c });
                if (ws[ref]) ws[ref].s = dStyle;
            }
        }


        ws['!cols'] = [
            { wch: 12 }, { wch: 14 }, { wch: 30 }, { wch: 25 },
            { wch: 20 }, { wch: 15 }, { wch: 12 }, { wch: 45 },
        ];


        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Missed Punches');


        const dateStr = startDate + (endDate ? '_' + endDate : '');
        XLSX.writeFile(wb, `ticket_missed_${warehouseId}_${dateStr}.xlsx`);


        showFeedback(`\uD83C\uDFAB Ticket: ${data.length} linha(s) geradas${skippedShifts > 0 ? ` \u00B7 \u26A0 ${skippedShifts} turno(s) desconhecido(s)` : ''}`);
    }


    // ── 9. Feedback visual ────────────────────────────────────────────────
    function showFeedback(msg) {
        const overlay   = document.getElementById(OVERLAY_ID);
        const countLine = document.getElementById('ppa-count-line');
        if (!overlay || !countLine) return;
        const prevBg = overlay.style.backgroundColor, prevText = countLine.innerHTML;
        overlay.style.backgroundColor = '#067D62';
        countLine.innerHTML = msg;
        setTimeout(() => { overlay.style.backgroundColor = prevBg; countLine.innerHTML = prevText; }, 3500);
    }


    // ── 10. Export handlers ───────────────────────────────────────────────
    function exportAll() {
        const d = getTableData();
        if (!d.count) { alert('[PPA Export] Nenhum dado encontrado!'); return; }
        showFeedback(`\u2705 ${downloadCSV(d.headers, d.allRows, '').count} linha(s) exportada(s)`);
    }
    function exportDayMissing() {
        const d = getTableData();
        if (!d.dayMissing) { alert('[PPA Export] Nenhum Day Shift missed punch! \uD83C\uDF89'); return; }
        showFeedback(`\u2600 Day: ${downloadCSV(d.headersWithTag, d.dayMissingRows, '_missing_day').count} exportados`);
    }
    function exportNightMissing() {
        const d = getTableData();
        if (!d.nightMissing) { alert('[PPA Export] Nenhum Night Shift missed punch! \uD83C\uDF89'); return; }
        showFeedback(`\uD83C\uDF19 Night: ${downloadCSV(d.headersWithTag, d.nightMissingRows, '_missing_night').count} exportados`);
    }


    // ── v5.12 — Hover invert: ao passar o mouse, inverte background ↔ cor do texto ─
    // border:1px solid transparent na base evita layout shift ao aparecer borda no hover.
    function addBtnHover(btn, bgColor) {
        btn.addEventListener('mouseenter', () => {
            btn.style.background  = '#FFFFFF';
            btn.style.color       = bgColor;
            btn.style.borderColor = bgColor;
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background  = bgColor;
            btn.style.color       = '#FFFFFF';
            btn.style.borderColor = 'transparent';
        });
    }


    // ── 11. Overlay ───────────────────────────────────────────────────────
    function createOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;
        const o = document.createElement('div');
        o.id = OVERLAY_ID;
        Object.assign(o.style, { position:'fixed', bottom:'20px', right:'20px', backgroundColor:'#232F3E', color:'#FFFFFF', padding:'4px 7px', borderRadius:'8px', boxShadow:'0 4px 14px rgba(0,0,0,0.3)', zIndex:'9999', fontFamily:"'Amazon Ember',Arial,sans-serif", fontSize:'12px', fontWeight:'bold', borderLeft:'4px solid #FF9900', userSelect:'none', minWidth:'100px' });
        o.innerHTML = `<span style="display:flex;justify-content:space-between;align-items:center;line-height:1.5;">\uD83D\uDCCB PPA ATTENDANCE \u2014 ${warehouseId}<button id="ppa-help-btn" style="background:none;border:none;cursor:pointer;font-size:12px;padding:0 0 0 8px;color:#FEBD69;line-height:1;flex-shrink:0;" title="Ajuda">\u2753</button></span><div id="ppa-count-line" style="font-size:12px;font-weight:normal;color:#FEBD69;margin:1px 0 3px 0;">Aguardando tabela...</div>`;


        // v4.6 — Painel de ajuda (oculto por padrão, toggle ao clicar ❓)
        const helpPanel = document.createElement('div');
        helpPanel.style.cssText = 'display:none;font-size:9px;font-weight:normal;color:#E0E0E0;background:#2E4257;border-radius:4px;padding:6px 8px;margin:0 0 6px 0;line-height:1.6;border-left:2px solid #FF9900;';
        helpPanel.innerHTML =
            '<b>\uD83D\uDCE5 EXPORTAR DADOS</b><br />CSV com todos os dados vis\u00EDveis na tabela.<br /><br />' +
            '<b>\uD83C\uDFAB GERAR TICKET - MISSED PUNCH</b><br />Planilha .xlsx com batidas faltando para ticket SIM.<br /><br />' +
            '<b>\uD83D\uDDD1 GERAR TICKET - DUPLICATED PUNCH</b><br />Planilha .xlsx com batidas excedentes a remover.<br />\u26A0 C\u00E9lulas \u00E2mbar na tabela indicam as batidas duplicadas.<br /><br />' +
            '<b>\uD83C\uDFAB ENVIAR TICKET</b><br />Template T.Corp para ticket de missed punch.';
        o.appendChild(helpPanel);


        o.querySelector('#ppa-help-btn').addEventListener('click', e => {
            e.stopPropagation();
            helpPanel.style.display = helpPanel.style.display === 'none' ? 'block' : 'none';
        });


        const btnAll = document.createElement('button');
        btnAll.textContent = 'EXPORTAR DADOS';
        btnAll.style.cssText = 'width:100%;padding:4px 4px;border:1px solid transparent;border-radius:5px;background:#546E7A;color:#fff;font-weight:bold;font-size:10px;line-height:1.1;cursor:pointer;font-family:inherit;margin-bottom:3px;';
        btnAll.addEventListener('click', e => { e.stopPropagation(); exportAll(); });


        // Botões Day Missed / Night Missed removidos do overlay (v3.8) — lógica mantida no código
        o.appendChild(btnAll);
        addBtnHover(btnAll, '#546E7A');


        const btnTicket = document.createElement('button');
        btnTicket.textContent = 'GERAR MISSED PUNCH';
        btnTicket.style.cssText = 'width:100%;padding:4px 4px;border:1px solid transparent;border-radius:5px;background:#C0392B;color:#fff;font-weight:bold;font-size:10px;line-height:1.1;cursor:pointer;font-family:inherit;margin-top:3px;';
        btnTicket.addEventListener('click', e => { e.stopPropagation(); generateTicketXLSX(); });
        o.appendChild(btnTicket);
        addBtnHover(btnTicket, '#C0392B');


        // v5.3 — Botão GERAR TICKET DUPLICADO → detecta e exporta batidas excedentes
        const btnExcess = document.createElement('button');
        btnExcess.textContent = 'GERAR DUPLICATED PUNCH ';
        btnExcess.style.cssText = 'width:100%;padding:4px 4px;border:1px solid transparent;border-radius:5px;background:#E67E22;color:#fff;font-weight:bold;font-size:10px;line-height:1.1;cursor:pointer;font-family:inherit;margin-top:3px;';
        btnExcess.addEventListener('click', e => { e.stopPropagation(); generateExcessXLSX(); });
        o.appendChild(btnExcess);
        addBtnHover(btnExcess, '#E67E22');


        // v4.4 — Botão ENVIAR TICKET → abre template T.Corp em aba nova
        const btnSim = document.createElement('button');
        btnSim.textContent = 'ENVIAR TICKET';
        btnSim.style.cssText = 'width:100%;padding:4px 4px;border:1px solid transparent;border-radius:5px;background:#1A73E8;color:#fff;font-weight:bold;font-size:10px;line-height:1.1;cursor:pointer;font-family:inherit;margin-top:3px;';
        btnSim.addEventListener('click', e => {
            e.stopPropagation();
            window.open('https://t.corp.amazon.com/create/templates/7fa630b6-a40d-46a3-91bd-b2152dbc9920', '_blank');
        });
        o.appendChild(btnSim);
        addBtnHover(btnSim, '#1A73E8');


        o.addEventListener('mouseenter', () => { o.style.backgroundColor='#37475A'; o.style.boxShadow='0 6px 20px rgba(0,0,0,0.4)'; });
        o.addEventListener('mouseleave', () => { o.style.backgroundColor='#232F3E'; o.style.boxShadow='0 4px 14px rgba(0,0,0,0.3)'; });
        document.body.appendChild(o);
    }


    function updateOverlay(total, dayMissing, nightMissing) {
        const c = document.getElementById('ppa-count-line');
        if (!c) { createOverlay(); return; }
        c.textContent = total > 0
            ? `${total} total  \u00B7  \u2600 D:${dayMissing}  \uD83C\uDF19 N:${nightMissing}`
            : 'Aguardando tabela...';
        c.style.color = (total > 0 && (dayMissing + nightMissing) > 0) ? '#FF6B6B' : '#FEBD69';
    }


    // ── 12. Popula managers ───────────────────────────────────────────────
    function populateManagerSelect(managers) {
        const sel = document.getElementById('ppa-manager-select');
        if (!sel || managers.length === 0 || sel.options.length > 1) return;
        managers.forEach(m => {
            const o = document.createElement('option');
            o.value = o.textContent = m;
            sel.appendChild(o);
        });
        // Restaura o último filtro salvo para este warehouse
        const saved = localStorage.getItem(FILTER_KEY);
        if (saved && sel.querySelector(`option[value="${saved}"]`)) {
            sel.value = saved;
            if (sel.value === saved) {
                const { count, dayMissing, nightMissing } = getTableData();
                updateOverlay(count, dayMissing, nightMissing);
                applyTableFilter(saved);
                applyTableStyle();
                highlightMissingCells();
            }
        }
        // v5.14 — Restaura estado do checkbox unificado "Apenas Pendências"
        const chk = document.getElementById('ppa-issues-only');
        if (chk && localStorage.getItem(ISSUES_KEY) === 'true') {
            chk.checked = true;
            const { count, dayMissing, nightMissing } = getTableData();
            updateOverlay(count, dayMissing, nightMissing);
            applyTableFilter(sel.value);
            applyTableStyle();
            highlightMissingCells();
        }
    }


    // ── 12b. Popula shifts (v5.13) ───────────────────────────────────────
    function populateShiftSelect(shifts) {
        const sel = document.getElementById('ppa-shift-select');
        if (!sel || shifts.length === 0 || sel.options.length > 1) return;
        shifts.forEach(s => {
            const o = document.createElement('option');
            o.value = o.textContent = s;
            sel.appendChild(o);
        });
        // Restaura o último turno salvo para este warehouse
        const saved = localStorage.getItem(SHIFT_KEY);
        if (saved && sel.querySelector(`option[value="${saved}"]`)) {
            sel.value = saved;
            if (sel.value === saved) {
                const { count, dayMissing, nightMissing } = getTableData();
                updateOverlay(count, dayMissing, nightMissing);
                applyTableFilter(getSelectedManager());
                applyTableStyle();
                highlightMissingCells();
            }
        }
    }


    // ── 13. Helpers de célula ─────────────────────────────────────────────
    function highlightCell(cell) {
        cell.dataset.ppaModified   = 'true';
        cell.style.backgroundColor = '#FFCCCC';
        cell.style.color           = '#CC0000';
        cell.style.fontWeight      = 'bold';
        cell.style.textAlign       = 'center';
        cell.style.fontSize        = '11px';
        cell.textContent           = '?';
    }


    function resetCell(cell) {
        if (!cell.dataset.ppaModified) return;
        cell.style.backgroundColor = '';
        cell.style.color           = '';
        cell.style.fontWeight      = '';
        cell.style.textAlign       = '';
        cell.style.fontSize        = '';
        if (cell.textContent === '?') cell.textContent = '';
        delete cell.dataset.ppaModified;
    }


    // ── Helpers de célula — excesso (v5.4) ───────────────────────────────
    function highlightExcessCell(cell) {
        if (cell.dataset.ppaExcess) return; // já marcado
        cell.dataset.ppaExcess       = 'true';
        cell.dataset.ppaOriginalText = cell.textContent.trim();
        cell.classList.add('ppa-cell-excess');
        cell.title    = 'Batida excedente — remover';
        cell.innerHTML = '\u26A0 ' + cell.dataset.ppaOriginalText;
    }


    function resetExcessCell(cell) {
        if (!cell.dataset.ppaExcess) return;
        cell.classList.remove('ppa-cell-excess');
        cell.title       = '';
        cell.textContent = cell.dataset.ppaOriginalText || '';
        delete cell.dataset.ppaExcess;
        delete cell.dataset.ppaOriginalText;
    }


    // ── v5.5 — Retorna o tempo original da célula sem o prefixo ⚠ ────────
    // highlightExcessCell() seta innerHTML = '⚠ 19:21', logo textContent
    // vira '⚠ 19:21'. to12h('⚠ 19:21') → Number('⚠ 19') = NaN → 12:xx AM.
    // Fix: usa ppaOriginalText se a célula já foi marcada, senão strip de ⚠.
    function getCleanCellTime(cell) {
        if (!cell) return '';
        if (cell.dataset.ppaExcess && cell.dataset.ppaOriginalText)
            return cell.dataset.ppaOriginalText;
        return cell.textContent.trim().replace(/^\u26A0\s*/, '');
    }


    // ── Highlight células excedentes na tabela (v5.4) ────────────────────
    // Usa matchBestExcess() para identificar quais cells têm punches a mais,
    // e aplica .ppa-cell-excess (⚠ âmbar + strikethrough + tooltip).
    // Chamado automaticamente ao final de highlightMissingCells().
    function highlightExcessCells() {
        const table = findTable();
        if (!table) return;


        const rawH  = Array.from(table.querySelectorAll('thead th, thead td')).map(getHeaderText);
        const numH  = getNumberedHeaders(rawH);
        const pairs = getInOutPairs(numH);
        const sIdx  = numH.findIndex(h => h.toLowerCase() === 'shift');
        const FOUR  = ['NE-Z0800', 'DE-Z1400'];


        const bodyRows = table.querySelectorAll('tbody tr');
        const rows = bodyRows.length ? Array.from(bodyRows) : Array.from(table.querySelectorAll('tr')).slice(1);


        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;


            // Reset highlights anteriores de excesso
            pairs.forEach(({ inIdx, outIdx }) => {
                if (cells[inIdx])  resetExcessCell(cells[inIdx]);
                if (cells[outIdx]) resetExcessCell(cells[outIdx]);
            });


            if (row.style.display === 'none') return;


            const shiftCode = (sIdx >= 0 && cells[sIdx]) ? cells[sIdx].textContent.trim().toUpperCase() : '';
            const schedule  = SHIFT_SCHEDULE[shiftCode] || null;
            if (!schedule) return;


            const totalSlots = FOUR.includes(shiftCode) ? 4 : 6;


            // Coleta punches com referência à célula (todos os pares)
            const punchData = [];
            pairs.forEach(({ inIdx, outIdx }) => {
                const ic = cells[inIdx], oc = cells[outIdx];
                if (ic && !ic.dataset.ppaModified && ic.textContent.trim())
                    punchData.push({ time: ic.textContent.trim(), cell: ic });
                if (oc && !oc.dataset.ppaModified && oc.textContent.trim())
                    punchData.push({ time: oc.textContent.trim(), cell: oc });
            });


            if (punchData.length <= totalSlots) return; // sem excesso nesta linha


            const excessSlots = matchBestExcess(punchData.map(p => p.time), schedule);


            // Mapeia excesso de volta às células (primeiro match não usado)
            const usedIndices = new Set();
            excessSlots.forEach(({ time }) => {
                const idx = punchData.findIndex((p, i) => p.time === time && !usedIndices.has(i));
                if (idx !== -1) {
                    usedIndices.add(idx);
                    highlightExcessCell(punchData[idx].cell);
                }
            });
        });
    }


    // ── 14. Filtra linhas por manager + missed-only ───────────────────────
    function applyTableFilter(selectedManager) {
        const table = findTable();
        if (!table) return;
        const rawH     = Array.from(table.querySelectorAll('thead th, thead td')).map(getHeaderText);
        const numH     = getNumberedHeaders(rawH);
        const mIdx     = numH.findIndex(h => h.toLowerCase() === 'manager');
        const sIdx     = numH.findIndex(h => h.toLowerCase() === 'shift'); // v5.8
        const pairs    = getInOutPairs(numH);
        const issuesOnly     = document.getElementById('ppa-issues-only')?.checked || false; // v5.14
        const selectedShift  = getSelectedShift(); // v5.13


        const bodyRows = table.querySelectorAll('tbody tr');
        const rows  = bodyRows.length ? Array.from(bodyRows) : Array.from(table.querySelectorAll('tr')).slice(1);
        rows.forEach(row => {
            const cells        = row.querySelectorAll('td');
            const manager      = (mIdx >= 0 && cells[mIdx]) ? cells[mIdx].textContent.trim() : '';
            const managerMatch = !selectedManager || manager === selectedManager;


            // v5.13 — match por turno (código exato da coluna Shift)
            const shiftCode  = (sIdx >= 0 && cells[sIdx]) ? cells[sIdx].textContent.trim().toUpperCase() : '';
            const shiftMatch = !selectedShift || shiftCode === selectedShift;


            // v5.14 — checkbox unificado: linha visível se tem missed OU duplicated
            let issuesMatch = true;
            if (issuesOnly) {
                // (a) missed punch — par incompleto (XOR)
                let hasAnyPunch     = false;
                let hasMissingPunch = false;
                pairs.forEach(({ inIdx, outIdx }) => {
                    const ic = cells[inIdx];
                    const oc = cells[outIdx];
                    const icData = ic && !ic.dataset.ppaModified && ic.textContent.trim();
                    const ocData = oc && !oc.dataset.ppaModified && oc.textContent.trim();
                    if (icData || ocData)      hasAnyPunch     = true;
                    if (!!icData !== !!ocData) hasMissingPunch = true; // XOR — par incompleto
                });
                const hasMissed = hasAnyPunch && hasMissingPunch;


                // (b) duplicated punch — mais batidas que o turno espera
                let hasDuplicated = false;
                const sch = SHIFT_SCHEDULE[shiftCode] || null;
                if (sch) {
                    const expMax = ['NE-Z0800', 'DE-Z1400'].includes(shiftCode) ? 4 : 6;
                    let filled = 0;
                    pairs.forEach(({ inIdx, outIdx }) => {
                        if (cells[inIdx]  && !cells[inIdx].dataset.ppaModified  && getCleanCellTime(cells[inIdx]))  filled++;
                        if (cells[outIdx] && !cells[outIdx].dataset.ppaModified && getCleanCellTime(cells[outIdx])) filled++;
                    });
                    hasDuplicated = filled > expMax;
                }


                issuesMatch = hasMissed || hasDuplicated;
            }


            row.style.display = (managerMatch && shiftMatch && issuesMatch) ? '' : 'none';
        });
    }


    // ── 15. Highlight células In/Out vazias com ? ─────────────────────────
    // Só marca se filled < 6 (>=6 pode ser overlap de turno)
    function highlightMissingCells() {
        const table = findTable();
        if (!table) return;
        const rawH   = Array.from(table.querySelectorAll('thead th, thead td')).map(getHeaderText);
        const numH   = getNumberedHeaders(rawH);
        const pairs  = getInOutPairs(numH);
        const sIdx   = numH.findIndex(h => h.toLowerCase() === 'shift');
        const FOUR   = ['NE-Z0800', 'DE-Z1400'];
        const bodyRows = table.querySelectorAll('tbody tr');
        const rows   = bodyRows.length ? Array.from(bodyRows) : Array.from(table.querySelectorAll('tr')).slice(1);


        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;
            pairs.forEach(({ inIdx, outIdx }) => {
                if (cells[inIdx])  resetCell(cells[inIdx]);
                if (cells[outIdx]) resetCell(cells[outIdx]);
            });
            if (row.style.display === 'none') return;


            // Conta punches da linha
            let filled = 0;
            pairs.forEach(({ inIdx, outIdx }) => {
                if (cells[inIdx]  && !cells[inIdx].dataset.ppaModified  && cells[inIdx].textContent.trim())  filled++;
                if (cells[outIdx] && !cells[outIdx].dataset.ppaModified && cells[outIdx].textContent.trim()) filled++;
            });
            // Só marca se filled < 6 (>=6 = possível overlap, não marca)
            if (filled >= 6) return;


            const shift  = (sIdx >= 0 && cells[sIdx]) ? cells[sIdx].textContent.trim().toUpperCase() : '';
            const effPairs = FOUR.includes(shift) ? pairs.slice(0, 2) : pairs;


            effPairs.forEach(({ inIdx, outIdx }) => {
                const ic = cells[inIdx], oc = cells[outIdx];
                if (!ic || !oc) return;
                if (ic.textContent.trim() && !oc.textContent.trim()) highlightCell(oc);
                if (!ic.textContent.trim() && oc.textContent.trim()) highlightCell(ic);
            });
        });


        // v5.4 — executa junto: excess sempre re-avaliado após missing
        highlightExcessCells();
    }


    // ── 16. Estilo Amazon na tabela (igual WHO_EDITED ganttChart) ─────────
    (function injectTableStyle() {
        const s = document.createElement('style');
        s.innerHTML = `
            /* ── Wrapper horizontal scroll ── */
            #content {
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                max-width: 100%;
            }


            /* ── Tabela principal ── */
            table.ppa-attendance-table {
                font-family: 'Amazon Ember', Arial, sans-serif;
                font-size: 11px;
                border-collapse: collapse;
                box-shadow: 0 2px 8px rgba(0,0,0,0.12);
                width: auto;
                max-width: 100%;
                margin: 0 auto;
            }


            /* ── Header — #232F3E + orange border (igual WHO_EDITED) ── */
            table.ppa-attendance-table thead th,
            table.ppa-attendance-table thead td {
                background-color: #232F3E !important;
                color: #FFFFFF !important;
                font-family: 'Amazon Ember', Arial, sans-serif;
                font-size: 11px;
                font-weight: bold;
                padding: 7px 10px;
                box-shadow: inset 0 -2px 0 0 #FF9900;
                white-space: nowrap;
            }
            /* Sort links no header */
            table.ppa-attendance-table thead th a,
            table.ppa-attendance-table thead td a {
                color: #FEBD69 !important;
                text-decoration: none;
            }
            table.ppa-attendance-table thead th a:hover,
            table.ppa-attendance-table thead td a:hover {
                color: #FF9900 !important;
                text-decoration: underline;
            }


            /* ── Tablesorter sticky clone — Amazon style ── */
            /* Tablesorter cria .tablesorter-sticky-wrapper ao scrollar  */
            /* Estilizamos o clone para manter o visual Amazon            */
            .tablesorter-sticky-wrapper {
                z-index: 10;
            }
            .tablesorter-sticky-wrapper th {
                background-color: #232F3E !important;
                color: #FFFFFF !important;
                font-family: 'Amazon Ember', Arial, sans-serif;
                font-size: 11px;
                font-weight: bold;
                padding: 7px 10px;
                box-shadow: inset 0 -2px 0 0 #FF9900;
                white-space: nowrap;
            }
            .tablesorter-sticky-wrapper th a {
                color: #FEBD69 !important;
                text-decoration: none;
            }
            .tablesorter-sticky-wrapper th a:hover {
                color: #FF9900 !important;
                text-decoration: underline;
            }


            /* ── Linhas alternadas ── */
            table.ppa-attendance-table tbody tr:nth-child(odd)  { background-color: #FFFFFF; }
            table.ppa-attendance-table tbody tr:nth-child(even) { background-color: #F7F7F7; }
            table.ppa-attendance-table tbody tr {
                border-bottom: 1px solid #E8E8E8;
                transition: background-color 0.1s ease;
            }
            table.ppa-attendance-table tbody tr:hover { background-color: #FFF3CD !important; }


            /* ── Células ── */
            table.ppa-attendance-table tbody td {
                padding: 4px 8px;
                vertical-align: middle;
                white-space: nowrap;
            }


            /* ── Linha com missed punch — borda esquerda vermelha ── */
            table.ppa-attendance-table tbody tr.ppa-row-missed {
                border-left: 3px solid #CC0000 !important;
            }
            table.ppa-attendance-table tbody tr.ppa-row-missed:hover {
                background-color: #FFF0F0 !important;
            }


            /* ── Célula de turno desconhecido — âmbar (v4.1) ── */
            table.ppa-attendance-table tbody td.ppa-cell-unknown-shift {
                background-color: #FFF3CD !important;
                color: #856404 !important;
                font-weight: bold;
                border-left:  2px solid #FFC107 !important;
                border-right: 2px solid #FFC107 !important;
            }


            /* ── Linha com excesso de punches — borda esquerda laranja (v5.4) ── */
            table.ppa-attendance-table tbody tr.ppa-row-excess {
                border-left: 3px solid #FF9900 !important;
            }
            table.ppa-attendance-table tbody tr.ppa-row-excess:hover {
                background-color: #FFFBF0 !important;
            }


            /* ── Célula com punch excedente — âmbar + strikethrough (v5.4) ── */
            table.ppa-attendance-table tbody td.ppa-cell-excess {
                background-color: #FFF3CD !important;
                color: #7D4E00 !important;
                font-weight: bold !important;
                text-decoration: line-through !important;
                border-left:  2px solid #FF9900 !important;
                border-right: 2px solid #FF9900 !important;
                text-align: center !important;
                font-size: 11px !important;
            }


            /* ── Sort arrows ▲▼ nos headers (v4.2) ── */
            .ppa-sort-arrows {
                display: inline-flex;
                flex-direction: column;
                margin-left: 3px;
                gap: 0px;
                vertical-align: middle;
                line-height: 1;
            }
            .ppa-arrow-up,
            .ppa-arrow-down {
                display: block;
                font-size: 6px;
                color: rgba(255,153,0,0.65);
                line-height: 1;
                font-weight: normal;
                font-style: normal;
            }
            /* Ascending — ▲ laranja vivo */
            table.ppa-attendance-table thead th.tablesorter-headerAsc .ppa-arrow-up,
            .tablesorter-sticky-wrapper th.tablesorter-headerAsc .ppa-arrow-up {
                color: #FF9900;
                font-size: 7px;
            }
            /* Descending — ▼ laranja vivo */
            table.ppa-attendance-table thead th.tablesorter-headerDesc .ppa-arrow-down,
            .tablesorter-sticky-wrapper th.tablesorter-headerDesc .ppa-arrow-down {
                color: #FF9900;
                font-size: 7px;
            }
        `;
        document.head.appendChild(s);
    })();


    function applyTableStyle() {
        const table = findTable();
        if (!table) return;


        // Adiciona classe uma vez só
        table.classList.add('ppa-attendance-table');


        const rawH  = Array.from(table.querySelectorAll('thead th, thead td')).map(getHeaderText);
        const numH  = getNumberedHeaders(rawH);
        const pairs = getInOutPairs(numH);
        const sIdx  = numH.findIndex(h => h.toLowerCase() === 'shift'); // v4.1


        const bodyRows = table.querySelectorAll('tbody tr');
        const rows = bodyRows.length ? Array.from(bodyRows) : Array.from(table.querySelectorAll('tr')).slice(1);


        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (!cells.length) return;


            let filled = 0;
            pairs.forEach(({ inIdx, outIdx }) => {
                if (cells[inIdx]  && cells[inIdx].textContent.trim())  filled++;
                if (cells[outIdx] && cells[outIdx].textContent.trim()) filled++;
            });


            // v5.11 — sc hoisted: detectMissing usa SHIFT_SCHEDULE max em vez de pairs.length×2
            const sc  = (sIdx >= 0 && cells[sIdx]) ? cells[sIdx].textContent.trim().toUpperCase() : '';
            const sch = SHIFT_SCHEDULE[sc] || null;


            row.classList.remove('ppa-row-missed');
            if (detectMissing(cells, pairs, sc)) {
                row.classList.add('ppa-row-missed');
            }


            // v5.4 — ppa-row-excess: linha tem mais punches que o esperado para o turno
            row.classList.remove('ppa-row-excess');
            if (sch) {
                const expMax = ['NE-Z0800', 'DE-Z1400'].includes(sc) ? 4 : 6;
                if (filled > expMax) row.classList.add('ppa-row-excess');
            }


            // v4.1 — Destaca célula Shift quando turno não reconhecido em SHIFT_SCHEDULE
            if (sIdx >= 0 && cells[sIdx]) {
                if (sc && !sch) {
                    cells[sIdx].classList.add('ppa-cell-unknown-shift');
                } else {
                    cells[sIdx].classList.remove('ppa-cell-unknown-shift');
                }
            }
        });


        // v4.2 — Injeta setas ▲▼ nos headers dentro de .tablesorter-header-inner (idempotente)
        const allHeaderCells = table.querySelectorAll('thead th, thead td');
        const headerCells = allHeaderCells.length
            ? Array.from(allHeaderCells)
            : Array.from((table.querySelector('tr') || document.createElement('tr')).querySelectorAll('th, td'));
        headerCells.forEach(th => {
            if (th.querySelector('.ppa-sort-arrows')) return; // já injetado


            const arrows = document.createElement('span');
            arrows.className = 'ppa-sort-arrows';


            const up = document.createElement('span');
            up.className   = 'ppa-arrow-up';
            up.textContent = '▲';


            const down = document.createElement('span');
            down.className   = 'ppa-arrow-down';
            down.textContent = '▼';


            arrows.appendChild(up);
            arrows.appendChild(down);


            // FCLM usa div.tablesorter-header-inner — injeta dentro para ficar inline com o texto
            const target = th.querySelector('.tablesorter-header-inner')
                        || th.querySelector('a')
                        || th;
            target.appendChild(arrows);
        });
    }


    // ── 17. Poll ──────────────────────────────────────────────────────────
    createOverlay();


    let lastCount = -1, stableCount = 0, managersPopulated = false;
    const poller = setInterval(() => {
        const { count, dayMissing, nightMissing, managers, shifts } = getTableData();
        if (count !== lastCount) {
            lastCount = count; stableCount = 0;
            updateOverlay(count, dayMissing, nightMissing);
            if (count > 0 && !managersPopulated) {
                populateManagerSelect(managers);
                populateShiftSelect(shifts); // v5.13
                managersPopulated = true;
                applyTableStyle();
                highlightMissingCells();
            }
        } else if (count > 0) {
            stableCount++;
            if (stableCount >= 2) {
                clearInterval(poller);
                applyTableStyle();
                highlightMissingCells();
            }
        }
    }, POLL_INTERVAL);


    // ── 18. Filtro Manager — centralizado entre form e tabela ────────────
    (function injectManagerFilter() {
        const s = document.createElement('style');
        s.innerHTML = `
            #ppa-manager-filter { text-align:center; padding:6px 0 8px 0; font-family:'Amazon Ember',Arial,sans-serif; }
            #ppa-manager-filter label { font-size:12px; font-weight:bold; color:#232F3E; margin-right:8px; }
            #ppa-manager-select {
                border:1px solid #A9A9A9; border-radius:4px; padding:4px 8px;
                font-family:Arial,sans-serif; font-size:11px; background:#FFFFFF;
                min-width:220px; cursor:pointer;
                transition:border-color 0.15s ease, box-shadow 0.15s ease;
            }
            #ppa-manager-select:hover { border-color:#FF9900; }
            #ppa-manager-select:focus { outline:none; border-color:#FF9900; box-shadow:0 0 0 2px rgba(255,153,0,0.25); }
            #ppa-shift-label { font-size:12px; font-weight:bold; color:#232F3E; margin:0 8px 0 16px; }
            #ppa-shift-select {
                border:1px solid #A9A9A9; border-radius:4px; padding:4px 8px;
                font-family:Arial,sans-serif; font-size:11px; background:#FFFFFF;
                min-width:140px; cursor:pointer;
                transition:border-color 0.15s ease, box-shadow 0.15s ease;
            }
            #ppa-shift-select:hover { border-color:#FF9900; }
            #ppa-shift-select:focus { outline:none; border-color:#FF9900; box-shadow:0 0 0 2px rgba(255,153,0,0.25); }
            #ppa-issues-only { accent-color:#FF9900; cursor:pointer; margin-left:16px; margin-right:4px; }
            #ppa-issues-label { font-size:11px; font-weight:bold; color:#CC0000; cursor:pointer; }
        `;
        document.head.appendChild(s);


        const fp = setInterval(() => {
            const content = document.getElementById('content');
            const table   = content ? content.querySelector('table') : findTable();
            if (!table || document.getElementById('ppa-manager-filter')) return;
            clearInterval(fp);


            const div = document.createElement('div');
            div.id = 'ppa-manager-filter';


            const label = document.createElement('label');
            label.textContent = 'Manager:';
            label.htmlFor = 'ppa-manager-select';


            const select = document.createElement('select');
            select.id = 'ppa-manager-select';


            const def = document.createElement('option');
            def.value = ''; def.textContent = '\u2014 Todos os Managers \u2014';
            select.appendChild(def);


            select.addEventListener('change', () => {
                if (select.value) {
                    localStorage.setItem(FILTER_KEY, select.value);
                } else {
                    localStorage.removeItem(FILTER_KEY);
                }
                const { count, dayMissing, nightMissing } = getTableData();
                updateOverlay(count, dayMissing, nightMissing);
                applyTableFilter(select.value);
                applyTableStyle();
                highlightMissingCells();
            });


            // ── v5.14 — Checkbox único: Apenas Pendências (missed OU duplicated) ──
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.id   = 'ppa-issues-only';


            const chkLabel = document.createElement('label');
            chkLabel.id          = 'ppa-issues-label';
            chkLabel.htmlFor     = 'ppa-issues-only';
            chkLabel.textContent = '\u26A0 Apenas Pend\u00EAncias';


            chk.addEventListener('change', () => {
                localStorage.setItem(ISSUES_KEY, chk.checked);
                const { count, dayMissing, nightMissing } = getTableData();
                updateOverlay(count, dayMissing, nightMissing);
                applyTableFilter(select.value);
                applyTableStyle();
                highlightMissingCells();
            });


            div.appendChild(label);
            div.appendChild(select);


            // v5.13 — Dropdown de Shift ao lado do Manager
            const shiftLabel = document.createElement('label');
            shiftLabel.id          = 'ppa-shift-label';
            shiftLabel.htmlFor     = 'ppa-shift-select';
            shiftLabel.textContent = 'Shift:';


            const shiftSelect = document.createElement('select');
            shiftSelect.id = 'ppa-shift-select';


            const shiftDef = document.createElement('option');
            shiftDef.value = ''; shiftDef.textContent = '\u2014 Todos os Turnos \u2014';
            shiftSelect.appendChild(shiftDef);


            shiftSelect.addEventListener('change', () => {
                if (shiftSelect.value) {
                    localStorage.setItem(SHIFT_KEY, shiftSelect.value);
                } else {
                    localStorage.removeItem(SHIFT_KEY);
                }
                const { count, dayMissing, nightMissing } = getTableData();
                updateOverlay(count, dayMissing, nightMissing);
                applyTableFilter(select.value);
                applyTableStyle();
                highlightMissingCells();
            });


            div.appendChild(shiftLabel);
            div.appendChild(shiftSelect);


            div.appendChild(chk);
            div.appendChild(chkLabel);
            if (content) content.insertBefore(div, table);
        }, 500);
    })();


    // ── 19. Botões de range rápido ────────────────────────────────────────
    (function injectRangeButtons() {
        function fmtDate(d) {
            return d.getFullYear() + '/' + ('0'+(d.getMonth()+1)).slice(-2) + '/' + ('0'+d.getDate()).slice(-2);
        }
        function applyRange(sD, sH, sM, eD, eH, eM) {
            // 1 — Seleciona radio "Intraday" (XPath confirmado pelo usuário + fallback querySelector)
            var radio = null;
            try {
                radio = document.evaluate(
                    '/html/body/div[2]/div/div[1]/span/form/table/tbody/tr[3]/td[2]/div/span[3]/span/label/input',
                    document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
            } catch(e) {}
            if (!radio)
                radio = document.querySelector('input[name="spanType"][value="Intraday"]') ||
                        document.querySelector('input[value="Intraday"]');
            if (radio && !radio.checked) {
                radio.click();
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }


            // 2 — Preenche campos do form (150ms: aguarda FCLM JS mostrar seção Intraday)
            function setField(name, val) {
                var el = document.querySelector('[name="' + name + '"]');
                if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
            }
            setTimeout(function() {
                setField('startDateIntraday', fmtDate(sD));
                setField('startHourIntraday',   String(sH));
                setField('startMinuteIntraday', String(sM));
                setField('endDateIntraday',   fmtDate(eD));
                setField('endHourIntraday',     String(eH));
                setField('endMinuteIntraday',   String(eM));
                // 3 — Submete o formulário
                var btn = document.querySelector('.cp-submit-row input[type="submit"]')
                       || document.querySelector('form input[type="submit"]')
                       || document.querySelector('input[value="Show Report"]')
                       || document.querySelector('input[type="submit"]');
                if (btn) btn.click();
            }, 150);
        }
        function setDayRange() {
            const t = new Date(), y = new Date(t); y.setDate(y.getDate()-1);
            applyRange(y, 5, 0, t, 0, 0);
        }
        function setNightRange() {
            const t = new Date(), y = new Date(t); y.setDate(y.getDate()-1);
            applyRange(y, 17, 0, t, 7, 0);
        }


        const s = document.createElement('style');
        s.innerHTML = `
            #ppa_day_range, #ppa_night_range {
                transition:all 0.15s ease; border-radius:6px; padding:5px 10px 5px 26px;
                font-family:'Amazon Ember',Arial,sans-serif; font-weight:bold; font-size:11px;
                cursor:pointer; margin-right:8px; box-shadow:0 2px 5px rgba(0,0,0,0.2);
                background-repeat:no-repeat; background-position:7px center; background-size:13px 13px;
                line-height:1.4; float:left;
            }
            #ppa_day_range { background-color:#FFE0A3; color:#111; border:1px solid #FFBB44; background-image:url(https://ob-clock.000webhostapp.com/sun-2-24.png); }
            #ppa_day_range:hover { background-color:#FFCC6E; box-shadow:0 4px 10px rgba(0,0,0,0.2); transform:translateY(-1px); outline:2px solid #E88B00; outline-offset:2px; }
            #ppa_night_range { background-color:#232F3E; color:#fff; border:1px solid #131921; background-image:url(https://ob-clock.000webhostapp.com/moon-4-24.png); }
            #ppa_night_range:hover { background-color:#37475A; box-shadow:0 4px 10px rgba(0,0,0,0.35); transform:translateY(-1px); outline:2px solid #6B8EAE; outline-offset:2px; }
            /* ── Separador + botão TOT ── */
            #ppa-range-sep {
                display: inline-block; width: 1px; height: 22px;
                background: rgba(0,0,0,0.18); margin: 0 10px;
                vertical-align: middle; float: left;
            }
            #ppa_btn_tot {
                transition: all 0.15s ease; border-radius: 6px; padding: 5px 12px;
                font-family: 'Amazon Ember', Arial, sans-serif; font-weight: bold;
                font-size: 11px; cursor: pointer; margin-right: 8px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.2); line-height: 1.4; float: left;
                border: 1px solid #4A6572; background-color: #607D8B; color: #FFFFFF;
            }
            #ppa_btn_tot:hover {
                background-color: #4A6572; box-shadow: 0 4px 10px rgba(0,0,0,0.25);
                transform: translateY(-1px); outline: 2px solid #37474F; outline-offset: 2px;
            }
        `;
        document.head.appendChild(s);


        const fp = setInterval(() => {
            const row = document.getElementsByClassName('cp-submit-row')[0];
            if (!row || document.getElementById('ppa-range-div')) return;
            clearInterval(fp);


            const div = document.createElement('div');
            div.id = 'ppa-range-div'; div.style.cssText = 'display:contents;';


            const bD = document.createElement('input');
            bD.type='button'; bD.id='ppa_day_range'; bD.value='\u2600 Day Range';
            bD.addEventListener('click', setDayRange);


            const bN = document.createElement('input');
            bN.type='button'; bN.id='ppa_night_range'; bN.value='\uD83C\uDF19 Night Range';
            bN.addEventListener('click', setNightRange);


            const sep = document.createElement('span');
            sep.id = 'ppa-range-sep';


            const bT = document.createElement('input');
            bT.type  = 'button';
            bT.id    = 'ppa_btn_tot';
            bT.value = 'Time On Task';
            bT.addEventListener('click', () => {
                const wh = new URLSearchParams(window.location.search).get('warehouseId') || '';
                window.location.href = 'https://fclm-portal.amazon.com/reports/ppaTimeOnTask'
                                     + (wh ? '?warehouseId=' + encodeURIComponent(wh) : '');
            });


            div.appendChild(bD); div.appendChild(bN);
            div.appendChild(sep); div.appendChild(bT);
            row.insertBefore(div, row.firstChild);
        }, 500);
    })();


})();

