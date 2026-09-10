// ==UserScript==
// @name         AtoZ Timecard - Ajuste de Pontos
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Botão "Auto ajuste" por linha no Editor de cartão de ponto do AtoZ: cria os pares de campos que faltam pelo menu de 3 pontos e preenche as 6 (ou 4) batidas derivadas da Programação do dia. NUNCA altera data nem salva — as datas que precisam mudar ficam piscando com o alvo no tooltip. Mostra a escala 3x2 (azul/vermelha/ADM) de cada dia, tem engrenagem com edição de turnos e log visual + CSV.
// @author       ladislke
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='12' fill='%23232F3E'/%3E%3Ccircle cx='50' cy='52' r='30' fill='none' stroke='%23f59e0b' stroke-width='7'/%3E%3Cpath d='M50 34v20l14 9' fill='none' stroke='%23f59e0b' stroke-width='7' stroke-linecap='round'/%3E%3C/svg%3E
// @match        https://atoz.amazon.work/timecard/*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/AtoZ%20Timecard%20-%20Ajuste%20de%20Pontos-1.0.user.js
// @downloadURL  https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/AtoZ%20Timecard%20-%20Ajuste%20de%20Pontos-1.0.user.js
// ==/UserScript==
// v1.0 — Setup inicial. Modelo de offset desde o início do turno (resolve "Dia seguinte"
//        sem adivinhação), matchBestAssignment portado do PPA Attendance para descobrir
//        qual batida falta, prévia obrigatória com diff campo a campo, log CSV das
//        alterações e botão por linha + painel para a semana toda.
//        Datas: a página mistura dd/MM (coluna Programação) com MM/DD (botão da
//        batida). Em vez de assumir, a data real de cada linha é RESOLVIDA pelo dia
//        da semana exibido + semana em exibição, e o formato do botão é DETECTADO
//        dos valores já na tela. Rode __atzDebug.dates() para conferir.
//        Botão "Auto ajuste" por linha: cria os pares e preenche as horas, NUNCA
//        mexe em data (o calendário do AtoZ não aceita clique automático) — as
//        datas pendentes ficam piscando com o alvo no tooltip.
//        Engrenagem ⚙: edição de turnos (com adicionar turno novo) + log visual
//        com download em CSV.
//        Escalas 3x2: NR/DR azul, NS/DS vermelha, NE ADM (seg→sex). Ciclo de 10
//        dias (3 vermelhos, 3 azuis, 2 vermelhos, 2 azuis) ancorado em 01/jan/2026.
//        Conferido contra dado real e checado sozinho contra o cronograma da tela.
//        Rode __atzDebug.escala() para ver a semana dia a dia.
//        Dia de HOJE e dias futuros não entram no auto ajuste (turno em andamento
//        = qualquer sequência completa seria invenção). Ajuste manual nesses dias.
//        Dia com "Nenhum cronograma" mas COM batidas (Unscheduled work) passa a ser
//        ajustável: o padrão vem do código do turno em vez da coluna Programação.
//        Excesso de batidas resolvido pelo matchBestExcess, também do PPA.
//        Modo guiado: importa lista de logins + datas (xlsx/csv/colar), abre um
//        associado por vez, abre o Editor, ajusta SÓ as datas do arquivo e espera
//        você salvar. O reload depois do "Salvar alterações" é o sinal de que subiu
//        e avança para o próximo.
//
// COMO FUNCIONA (resumo)
//   0. Resolve a data real de cada linha (não confia no formato do rótulo)
//   1. Lê a coluna Programação de cada linha  → "06:00 PM - 05:00 AM"
//   2. Casa com um padrão de turno            → 6 batidas, 18:00/23:00/00:00/02:30/02:45/05:00
//   3. Converte cada batida em offset (min desde o início do turno)
//        offset >= (1440 - inicio)  ⇒  Dia seguinte
//   4. Se a linha já tem batidas, roda matchBestAssignment para preservar as reais
//      e só completar as que faltam
//   5. Mostra a prévia. Você confirma. Ele cria/remove pares, escreve horas e datas.
//   6. Para. O "Salvar alterações" é sempre seu.

(function () {
    'use strict';

    if (window.top !== window.self) return;

    // ─────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────
    const CONFIG = {
        PANEL_ID:    'atz-panel',
        LAUNCHER_ID: 'atz-launcher',
        MODAL_ID:    'atz-modal',
        ROW_BTN_CLS: 'atz-row-btn',
        CSS_ID:      'atz-css',

        FIELD_WAIT:  4000,   // espera campos aparecerem/desaparecerem após ação de menu
        MENU_WAIT:   2500,   // espera o menu de 3 pontos abrir
        CAL_WAIT:    2500,   // espera o calendário abrir
        STEP_PAUSE:  140,    // pausa entre escritas (deixa o React reconciliar)
        DATE_PAUSE:  320,    // pausa após escolher data no calendário
        MAX_ROWS:    14,     // trava de segurança: nunca processa mais que isso de uma vez
        MAX_GUARD:   10,     // trava anti-loop no ajuste de quantidade de campos
        MAX_EXCESS_PUNCHES: 12,   // teto para o combinatório do matchBestExcess
        MAX_NAV_TRIES: 3,         // trava anti-loop de navegação no modo guiado
    };

    const C = {
        panel:  '#2b3440', panelAlt: '#1f2732', border: '#3a4654',
        accent: '#f59e0b', accentH: '#ffab2e',
        text:   '#dbe6f2', dim: '#9fb3c8',
        ok:     '#2e7d32', warn: '#e6a817', err: '#c62828', info: '#4A86C8',
        font:   "'Amazon Ember', Arial, sans-serif",
    };

    const STORE = {
        PATTERNS: 'atz_shift_patterns',
        CODES:    'atz_shift_codes',
        LOG:      'atz_change_log',
        ANCHOR:   'atz_escala_anchor',
        ESCALA_OPEN: 'atz_escala_open',
        GUIDED:   'atz_guided_state',
    };

    // ─────────────────────────────────────────────────────────────────────
    // TABELA DE TURNOS
    // ─────────────────────────────────────────────────────────────────────
    // Chaveada pelo horário da coluna Programação já em 24h ("inicio-fim"),
    // porque o AtoZ não expõe o código do turno (NSAZ1800 etc.), só os horários.
    //
    // 'times' é a sequência COMPLETA de batidas na ordem In1, Out1, In2, Out2, In3, Out3.
    // A data (dia D ou D+1) NÃO fica aqui — é derivada do offset. Ver toShiftOffset().
    //
    //   18:00-05:00  confirmado pela img 5 do fluxo (18:00 23:00 | 00:00 02:30 | 02:45 05:00)
    //                trabalha 9h45 + 1h15 de break  ✓ bate com as Acumulações do AtoZ
    //   06:00-18:00  derivado do SHIFT_SCHEDULE do "FCLM - PPA Attendance Export CSV"
    //                (DR-Z0600/DSAZ0600/DF-Z0600) — CONFIRMAR na prática
    //   08:00-18:00  NE-Z0800 — 4 batidas, só refeição
    //   14:00-23:00  DE-Z1400 — 4 batidas, só refeição
    const DEFAULT_PATTERNS = {
        '18:00-05:00': { label: 'Night 18:00 → 05:00', times: ['18:00', '23:00', '00:00', '02:30', '02:45', '05:00'] },
        '06:00-18:00': { label: 'Day 06:00 → 18:00',   times: ['06:00', '10:30', '11:30', '15:15', '15:30', '18:00'] },
        '08:00-18:00': { label: 'NE 08:00 → 18:00',    times: ['08:00', '10:30', '11:30', '18:00'] },
        '14:00-23:00': { label: 'DE 14:00 → 23:00',    times: ['14:00', '17:30', '18:30', '23:00'] },
    };

    // ── Código do turno ──────────────────────────────────────────────────
    // A página mostra o código do turno (ex: NR-Z1800) num StencilText. É a MESMA
    // chave do SHIFT_SCHEDULE do "FCLM - PPA Attendance Export CSV", então dá para
    // identificar o turno direto, sem inferir pelos horários da Programação.
    //
    // Leitura do prefixo (informada pelo usuário):
    //   NE...  → ADM        (4 batidas)
    //   N...   → Night
    //   D...   → Day
    const DEFAULT_SHIFT_CODES = {
        'NSAZ1800': '18:00-05:00',   // Night  · escala vermelha
        'NR-Z1800': '18:00-05:00',   // Night  · escala azul
        'NF0T1800': '18:00-05:00',   // Night  · escala não informada
        'DR-Z0600': '06:00-18:00',   // Day    · escala azul
        'DSAZ0600': '06:00-18:00',   // Day    · escala vermelha
        'DF-Z0600': '06:00-18:00',   // Day    · escala não informada
        'NE-Z0800': '08:00-18:00',   // ADM (4 batidas, seg→sex)
        'DE-Z1400': '14:00-23:00',   // 4 batidas · escala não informada
    };
    // Formato: 1 letra + 3 alfanuméricos/hífen + 4 dígitos (NSAZ1800, NR-Z1800, NE-Z0800…)
    const SHIFT_CODE_RE = /\b[A-Z][A-Z0-9-]{3}\d{4}\b/;

    // Classifica pelo prefixo. Usado só quando o código não está na tabela.
    function shiftFamily(code) {
        const c = String(code || '').toUpperCase();
        if (/^NE/.test(c)) return 'ADM';
        if (/^N/.test(c))  return 'Night';
        if (/^D/.test(c))  return 'Day';
        return '';
    }

    // ── Escalas 3x2 ──────────────────────────────────────────────────────
    // NR / DR → escala AZUL      NS / DS → escala VERMELHA      NE → ADM (seg→sex)
    //
    // O ciclo tem 10 dias e se repete: 3 vermelhos, 3 azuis, 2 vermelhos, 2 azuis.
    // Âncora: 01/jan/2026 é o 1º dia vermelho.
    //
    //   01,02,03 jan → vermelha        04,05,06 jan → azul
    //   07,08    jan → vermelha        09,10    jan → azul
    //
    // CONFERIDO contra dado real: o associado NR-Z1800 (azul) das telas tinha
    // cronograma em 06, 07, 11 e 12/set/2026 e "Nenhum cronograma" em 08, 09 e 10.
    // O ciclo reproduz os sete dias da semana exatamente.
    const ESCALA_CYCLE = ['V', 'V', 'V', 'A', 'A', 'A', 'V', 'V', 'A', 'A'];
    const DEFAULT_ANCHOR = '2026-01-01';

    function loadAnchor() {
        const raw = String(gmGet(STORE.ANCHOR, DEFAULT_ANCHOR) || DEFAULT_ANCHOR);
        const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const d = m ? mkDate(+m[1], +m[2], +m[3]) : null;
        return d || mkDate(2026, 1, 1);
    }
    function saveAnchor(iso) { gmSet(STORE.ANCHOR, iso); }

    const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

    // Data → 'vermelha' | 'azul'
    function escalaOf(date) {
        const days = Math.round((midnight(date) - midnight(loadAnchor())) / 86400000);
        const idx = ((days % ESCALA_CYCLE.length) + ESCALA_CYCLE.length) % ESCALA_CYCLE.length;
        return ESCALA_CYCLE[idx] === 'V' ? 'vermelha' : 'azul';
    }

    // Código do turno → escala do associado. '' quando o prefixo não foi informado.
    function shiftScale(code) {
        const c = String(code || '').toUpperCase();
        if (/^NE/.test(c))       return 'adm';
        if (/^(NR|DR)/.test(c))  return 'azul';
        if (/^(NS|DS)/.test(c))  return 'vermelha';
        return '';
    }
    function scaleLabel(scale) {
        if (scale === 'adm')      return 'ADM (seg→sex)';
        if (scale === 'azul')     return 'Escala azul 3x2';
        if (scale === 'vermelha') return 'Escala vermelha 3x2';
        return 'escala não identificada';
    }

    // O associado trabalha nessa data? null = não sei (prefixo não mapeado).
    function worksOn(code, date) {
        const s = shiftScale(code);
        if (s === 'adm') { const wd = date.getDay(); return wd >= 1 && wd <= 5; }
        if (s === 'azul' || s === 'vermelha') return escalaOf(date) === s;
        return null;
    }

    // Rótulos do menu de 3 pontos (PT-BR da img 3 + fallback EN)
    const MENU_LABELS = {
        insertAfter: [/^inserir os registros de ponto depois$/i, /^insert punches? after$/i],
        deletePair:  [/^excluir registros de ponto$/i, /^delete punches?$/i],
    };

    // ─────────────────────────────────────────────────────────────────────
    // PERSISTÊNCIA
    // ─────────────────────────────────────────────────────────────────────
    function gmGet(k, d) {
        try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : (localStorage.getItem(k) ?? d); }
        catch (e) { return d; }
    }
    function gmSet(k, v) {
        try { (typeof GM_setValue === 'function') ? GM_setValue(k, v) : localStorage.setItem(k, v); }
        catch (e) {}
    }

    // Defaults do código são a BASE; a config salva sobrescreve item a item.
    // Assim padrões novos adicionados aqui sempre aparecem (mesmo padrão do Permissions Tags v5.31).
    function loadPatterns() {
        const base = JSON.parse(JSON.stringify(DEFAULT_PATTERNS));
        try {
            const raw = gmGet(STORE.PATTERNS, '');
            if (raw) {
                const saved = JSON.parse(raw);
                for (const k in saved) base[k] = saved[k];
            }
        } catch (e) {}
        return base;
    }
    let PATTERNS = loadPatterns();
    function savePatterns() { gmSet(STORE.PATTERNS, JSON.stringify(PATTERNS)); }

    // Mesmo esquema para o mapa código→padrão, para dar pra adicionar turno novo.
    function loadCodes() {
        const base = JSON.parse(JSON.stringify(DEFAULT_SHIFT_CODES));
        try {
            const raw = gmGet(STORE.CODES, '');
            if (raw) {
                const saved = JSON.parse(raw);
                for (const k in saved) base[k] = saved[k];
            }
        } catch (e) {}
        return base;
    }
    let SHIFT_CODES = loadCodes();
    function saveCodes() { gmSet(STORE.CODES, JSON.stringify(SHIFT_CODES)); }

    function loadLog() {
        try { return JSON.parse(gmGet(STORE.LOG, '[]')) || []; } catch (e) { return []; }
    }
    function appendLog(entries) {
        if (!entries || !entries.length) return;
        const all = loadLog().concat(entries).slice(-4000);   // teto pra não estourar o storage
        gmSet(STORE.LOG, JSON.stringify(all));
    }

    // ─────────────────────────────────────────────────────────────────────
    // UTILITÁRIOS GERAIS
    // ─────────────────────────────────────────────────────────────────────
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function waitFor(fn, timeout, interval) {
        timeout  = timeout  || 3000;
        interval = interval || 100;
        return new Promise(resolve => {
            const t0 = Date.now();
            (function tick() {
                let r = null;
                try { r = fn(); } catch (e) { r = null; }
                if (r) { resolve(r); return; }
                if (Date.now() - t0 > timeout) { resolve(null); return; }
                setTimeout(tick, interval);
            })();
        });
    }

    const pad2 = n => String(n).padStart(2, '0');
    const esc  = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // "HH:MM" → minutos desde meia-noite (-1 se inválido)
    function timeToMins(t) {
        const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return -1;
        return (+m[1]) * 60 + (+m[2]);
    }
    // minutos → "HH:MM" (normaliza para 0..1439)
    function minsToTime(mins) {
        const v = ((mins % 1440) + 1440) % 1440;
        return pad2(Math.floor(v / 60)) + ':' + pad2(v % 60);
    }

    // "06:00 PM" → "18:00"   |   "05:00 AM" → "05:00"
    function to24h(txt) {
        const m = String(txt || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (!m) {
            const m24 = String(txt || '').trim().match(/^(\d{1,2}):(\d{2})$/);
            return m24 ? pad2(+m24[1]) + ':' + m24[2] : '';
        }
        let h = +m[1] % 12;
        if (/pm/i.test(m[3])) h += 12;
        return pad2(h) + ':' + m[2];
    }

    // ─────────────────────────────────────────────────────────────────────
    // DATAS — a página mistura DOIS formatos, então nada aqui assume um
    // ─────────────────────────────────────────────────────────────────────
    //   coluna Programação      → dd/MM  ("dom. 06/09" = 6 de setembro)
    //   botão de data da batida → MM/DD  ("09/07" = 7 de setembro)
    //
    // Assumir o formato errado escreveria ponto no dia errado sem dar erro, que
    // é o pior tipo de falha em folha. Por isso a data real de cada linha é
    // RESOLVIDA (dia da semana exibido + semana em exibição) em vez de deduzida
    // do rótulo, e o formato do botão é DETECTADO a partir dos valores já na tela.

    const MONTHS = {
        jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6,
        jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12,
    };
    const WEEKDAYS = {
        dom: 0, sun: 0, seg: 1, mon: 1, ter: 2, tue: 2, qua: 3, wed: 3,
        qui: 4, thu: 4, sex: 5, fri: 5, sab: 6, sat: 6,
    };

    function deaccent(s) {
        return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    // "sáb." → 6 | "dom." → 0 | desconhecido → null
    function weekdayIndex(txt) {
        const k = deaccent(txt).toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
        return (k in WEEKDAYS) ? WEEKDAYS[k] : null;
    }
    // Cria a data só se ela existir de verdade (rejeita 31/02, mês 13 etc.)
    function mkDate(year, month, day) {
        if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
        const d = new Date(year, month - 1, day);
        return (d.getMonth() === month - 1 && d.getDate() === day) ? d : null;
    }
    const dayDiff = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);
    function fmtMMDD(d) { return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()); }
    function fmtDDMM(d) { return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1); }

    // Cabeçalho "set 6, 2026 - set 12, 2026" → { start: Date, year }
    function readWeekRange() {
        const m = document.body.innerText.match(
            /([A-Za-zÀ-ÿ]{3,})\.?\s+(\d{1,2}),\s*(\d{4})\s*[-–—]\s*([A-Za-zÀ-ÿ]{3,})\.?\s+(\d{1,2}),\s*(\d{4})/);
        if (!m) return null;
        const mo = MONTHS[deaccent(m[1]).toLowerCase().slice(0, 3)];
        if (!mo) return null;
        const start = mkDate(+m[3], mo, +m[2]);
        return start ? { start: start, year: +m[3] } : null;
    }

    // Descobre a data real da linha a partir do rótulo "A/B", testando as DUAS
    // ordens e pontuando cada hipótese. O dia da semana exibido na própria linha
    // é o discriminador mais forte que existe: com ele, 06/09 só pode ser 6 de
    // setembro (domingo), nunca 9 de junho (terça).
    function resolveRowDate(a, b, weekdayTxt, year, weekStart, rowIndex) {
        const wd = weekdayIndex(weekdayTxt);
        const cands = [];
        [[a, b, 'dd/MM'], [b, a, 'MM/dd']].forEach(t => {
            const d = mkDate(year, t[1], t[0]);
            if (!d) return;
            let score = 0;
            if (wd !== null && d.getDay() === wd) score += 4;          // dia da semana confere
            if (weekStart) {
                const diff = dayDiff(d, weekStart);
                if (diff >= 0 && diff <= 6) score += 2;                // cai na semana exibida
                if (diff === rowIndex) score += 1;                     // e na posição certa
            }
            cands.push({ date: d, fmt: t[2], score: score });
        });

        if (!cands.length) {
            if (!weekStart) return null;
            const d = new Date(weekStart.getTime());
            d.setDate(d.getDate() + rowIndex);
            return { date: d, labelFmt: null, source: 'posição na semana' };
        }

        // As duas leituras coincidindo (ex: 09/09) não é ambiguidade nenhuma
        if (cands.length === 2 && dayDiff(cands[0].date, cands[1].date) === 0) {
            return { date: cands[0].date, labelFmt: 'ambos', source: 'rótulo' };
        }

        cands.sort((x, y) => y.score - x.score);
        if (cands[0].score > 0 && (cands.length === 1 || cands[0].score > cands[1].score)) {
            return { date: cands[0].date, labelFmt: cands[0].fmt, source: 'rótulo' };
        }
        // Empatou ou nenhuma hipótese pontuou: confia na posição da linha
        if (weekStart) {
            const d = new Date(weekStart.getTime());
            d.setDate(d.getDate() + rowIndex);
            return { date: d, labelFmt: null, source: 'posição na semana (rótulo ambíguo)' };
        }
        return { date: cands[0].date, labelFmt: cands[0].fmt, source: 'rótulo ambíguo' };
    }

    // Detecta se o botão de data usa MM/DD ou DD/MM comparando os valores que já
    // estão na tela com a data real da linha (uma batida só pode estar em D-1, D
    // ou D+1). Default MM/DD, que é o padrão confirmado do AtoZ.
    let BTN_FMT = 'MM/DD';
    function detectBtnDateFormat(rows) {
        let mmdd = 0, ddmm = 0;
        for (const r of rows) {
            if (!r.realDate || !r.dates.length) continue;
            const y = r.realDate.getFullYear();
            for (const txt of r.dates) {
                const m = String(txt).match(/^(\d{1,2})\/(\d{1,2})$/);
                if (!m) continue;
                const asMMDD = mkDate(y, +m[1], +m[2]);
                const asDDMM = mkDate(y, +m[2], +m[1]);
                if (asMMDD && Math.abs(dayDiff(asMMDD, r.realDate)) <= 1) mmdd++;
                if (asDDMM && Math.abs(dayDiff(asDDMM, r.realDate)) <= 1) ddmm++;
            }
        }
        if (mmdd > ddmm) return { fmt: 'MM/DD', votes: mmdd + '/' + ddmm };
        if (ddmm > mmdd) return { fmt: 'DD/MM', votes: mmdd + '/' + ddmm };
        return { fmt: null, votes: mmdd + '/' + ddmm };     // sem amostra ou empate
    }
    function fmtBtnDate(d) { return BTN_FMT === 'DD/MM' ? fmtDDMM(d) : fmtMMDD(d); }

    // Seta valor num input controlado pelo React (setter nativo + eventos sintéticos).
    // Portado de "EHS Inspection - Download CSV" (setReactValue).
    function setReactValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        input.focus();
        setter.call(input, value);
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
    }

    // ─────────────────────────────────────────────────────────────────────
    // MODELO DE OFFSET — o coração do "Dia seguinte"
    // ─────────────────────────────────────────────────────────────────────
    // Cada batida é representada como minutos desde o INÍCIO do turno, não desde
    // meia-noite. Com isso a data sai de graça e sem heurística de hora:
    //
    //   absoluto = inicioTurno + offset
    //   dia      = floor(absoluto / 1440)     (0 = dia da linha, 1 = dia seguinte)
    //   hora     = absoluto mod 1440
    //
    // Conferido contra o HTML real do turno night (início 18:00 = 1080, duração 660):
    //   18:00 → off    0 → 1080 → 18:00 dia D
    //   23:00 → off  300 → 1380 → 23:00 dia D
    //   00:00 → off  360 → 1440 → 00:00 dia D+1   ← vira aqui
    //   02:30 → off  510 → 1590 → 02:30 dia D+1
    //   02:45 → off  525 → 1605 → 02:45 dia D+1
    //   05:00 → off  660 → 1740 → 05:00 dia D+1
    // ...que é exatamente o padrão 09/06 09/06 | 09/07 09/07 | 09/07 09/07 da img 5.

    // Converte "HH:MM" no offset mais plausível dentro da janela do turno.
    // Resolve sozinho o caso da batida ANTECIPADA (ex: 17:50 num turno que
    // começa 18:00 → offset -10, ainda dia D) sem precisar de tolerância mágica.
    function toShiftOffset(hhmm, startMins, durMins) {
        const t = timeToMins(hhmm);
        if (t < 0) return null;
        const candA = t - startMins;            // hipótese: dia D
        const candB = t + 1440 - startMins;     // hipótese: dia D+1
        const dist = o => (o < 0 ? -o : (o > durMins ? o - durMins : 0));
        return dist(candB) < dist(candA) ? candB : candA;
    }

    // offset → { time:'HH:MM', dayOffset:0|1|-1 }
    function fromShiftOffset(offset, startMins) {
        const abs = startMins + offset;
        return { time: minsToTime(abs), dayOffset: Math.floor(abs / 1440) };
    }

    // ─────────────────────────────────────────────────────────────────────
    // MÍNIMO ERRO DE ATRIBUIÇÃO — portado do PPA Attendance (matchBestAssignment)
    // ─────────────────────────────────────────────────────────────────────
    // Descobre QUAL slot está faltando quando a linha tem menos batidas que o
    // turno espera, testando todas as C(totalSlots, N) hipóteses e escolhendo a
    // de menor erro total. Diferenças em relação ao original:
    //   • trabalha em offset (não em minutos desde meia-noite) → dispensa circularDiff
    //   • devolve também o índice do slot, necessário pra remontar a sequência
    //   • as durações de break saem do próprio padrão configurado, não hardcoded
    function getCombinations(n, k) {
        const out = [];
        (function combine(start, cur) {
            if (cur.length === k) { out.push(cur.slice()); return; }
            for (let i = start; i < n; i++) { cur.push(i); combine(i + 1, cur); cur.pop(); }
        })(0, []);
        return out;
    }

    function matchBestAssignment(actualOffsets, canonOffsets) {
        const total = canonOffsets.length;
        const N     = actualOffsets.length;
        if (!N || N >= total) return { present: null, missing: [] };

        const isFour    = total === 4;
        const slotTypes = isFour ? ['In', 'Out', 'In', 'Out'] : ['In', 'Out', 'In', 'Out', 'In', 'Out'];

        // Durações de break tiradas do padrão: refeição = In2-Out1, café = In3-Out2
        const gapMeal   = canonOffsets[2] - canonOffsets[1];
        const gapCoffee = isFour ? null : canonOffsets[4] - canonOffsets[3];

        // Slots dinâmicos: In2 = Out1_real + refeição, In3 = Out2_real + café.
        function slotOffsetsFor(present) {
            const t = canonOffsets.slice();
            if (present.includes(1)) t[2] = actualOffsets[present.indexOf(1)] + gapMeal;
            if (!isFour && present.includes(3)) t[4] = actualOffsets[present.indexOf(3)] + gapCoffee;
            return t;
        }

        let bestTotal = Infinity, bestPresent = null;
        for (const present of getCombinations(total, N)) {
            const slots = slotOffsetsFor(present);

            // Penalidade quando o Out "âncora" está ausente: aí In2/In3 é estimado
            // pelo padrão (incerto) e não deve vencer hipóteses mais sólidas.
            let score = 0;
            if (!present.includes(1)) score += 180;
            if (!isFour && !present.includes(3)) score += 60;

            for (let j = 0; j < N; j++) score += Math.abs(actualOffsets[j] - slots[present[j]]);

            if (score < bestTotal) { bestTotal = score; bestPresent = present; }
        }

        if (!bestPresent) return { present: null, missing: [] };
        const slots   = slotOffsetsFor(bestPresent);
        const missing = [];
        for (let i = 0; i < total; i++) {
            if (!bestPresent.includes(i)) missing.push({ slot: i, type: slotTypes[i], offset: slots[i] });
        }
        return { present: bestPresent, missing: missing, slotOffsets: slots };
    }

    // ─────────────────────────────────────────────────────────────────────
    // MÍNIMO ERRO DE EXCESSO — portado do PPA Attendance (matchBestExcess)
    // ─────────────────────────────────────────────────────────────────────
    // Inverso do matchBestAssignment. Quando a linha tem MAIS batidas que o turno
    // espera (badge duplicado, por exemplo), testa todas as C(N, slots) combinações
    // de batidas a MANTER e escolhe a de menor erro. As não escolhidas são o excesso.
    //
    // Exemplo real: 17:53 23:20 23:21 00:10 02:23 02:42 05:11 num turno de 6 slots
    //   descartar 23:21 → erro 59  ← vence
    //   descartar 23:20 → erro 61
    //   descartar 00:10 → erro 108 … e o resto muito acima
    // Resultado: 17:53-23:20, 00:10-02:23, 02:42-05:11
    //
    // POLÍTICA entre duplicatas adjacentes: vence a mais PRÓXIMA do horário
    // programado, não necessariamente a primeira leitura do badge.
    //   In1 programado 18:00 → entre 17:53 e 17:54 mantém 17:54 (mais tarde)
    //   Out1 programado 23:00 → entre 23:20 e 23:21 mantém 23:20 (mais cedo)
    // O efeito é de 1 minuto, sempre na direção da programação. Se a regra da
    // operação for outra (ex: manter sempre a primeira leitura, ou a mais
    // favorável ao associado), o ajuste é só no critério de score abaixo.
    // De qualquer forma a prévia SEMPRE mostra qual batida seria descartada.
    function matchBestExcess(actualOffsets, canonOffsets) {
        const total = canonOffsets.length;
        const N     = actualOffsets.length;
        if (N <= total) return null;
        if (N > CONFIG.MAX_EXCESS_PUNCHES) return { tooMany: true, n: N };

        const isFour    = total === 4;
        const gapMeal   = canonOffsets[2] - canonOffsets[1];
        const gapCoffee = isFour ? null : canonOffsets[4] - canonOffsets[3];

        // Slots dinâmicos, igual ao matchBestAssignment: In2 = Out1_real + refeição,
        // In3 = Out2_real + café. Aqui o "real" é a batida mantida naquele slot.
        function slotOffsetsFor(kept) {
            const t = canonOffsets.slice();
            t[2] = kept[1] + gapMeal;
            if (!isFour) t[4] = kept[3] + gapCoffee;
            return t;
        }

        let bestScore = Infinity, best = null;
        for (const idx of getCombinations(N, total)) {
            const kept = idx.map(i => actualOffsets[i]);
            const slots = slotOffsetsFor(kept);
            let score = 0;
            for (let k = 0; k < total; k++) score += Math.abs(kept[k] - slots[k]);
            if (score < bestScore) {
                bestScore = score;
                const drop = [];
                for (let m = 0; m < N; m++) if (idx.indexOf(m) === -1) drop.push(m);
                best = { keep: idx.slice(), drop: drop, score: score };
            }
        }
        return best;
    }

    // ─────────────────────────────────────────────────────────────────────
    // LEITURA DO DOM
    // ─────────────────────────────────────────────────────────────────────
    // Classes css-* do Stencil são geradas em build e trocam a cada deploy.
    // Tudo aqui é ancorado em data-testid / aria-label / texto semântico.

    function findEditorTable() {
        const tables = document.querySelectorAll('table');
        for (const t of tables) {
            const head = t.querySelector('thead');
            if (!head) continue;
            if (!/registros de ponto|punches/i.test(head.textContent)) continue;
            if (!t.querySelector('tbody tr')) continue;
            return t;
        }
        return null;
    }

    function findSaveButton() {
        for (const b of document.querySelectorAll('button')) {
            if (/^salvar altera|^save changes/i.test((b.textContent || '').trim())) return b;
        }
        return null;
    }

    // Lê o código do turno exibido na página (ex: NR-Z1800). Procura primeiro nos
    // StencilText, que é onde o usuário confirmou que aparece, e cai para o texto
    // inteiro da página se não achar.
    function readShiftCode() {
        for (const el of document.querySelectorAll('[data-test-component="StencilText"]')) {
            if (el.children.length) continue;
            const t = (el.textContent || '').trim().toUpperCase();
            if (SHIFT_CODE_RE.test(t) && t.length <= 12) {
                const m = t.match(SHIFT_CODE_RE);
                if (m) return m[0];
            }
        }
        const m = (document.body.innerText || '').toUpperCase().match(SHIFT_CODE_RE);
        return m ? m[0] : '';
    }

    // Login do associado (a URL não muda ao abrir o editor, então continua no path)
    function readLogin() {
        const m = location.pathname.match(/employeeDetails\/([^/?#]+)/i);
        return m ? decodeURIComponent(m[1]) : '';
    }

    // Lê os campos da célula de batidas de uma linha.
    // IMPORTANTE: o React remonta essa célula a cada alteração, então NUNCA
    // guarde o resultado disso entre ações — releia sempre.
    function readPunches(tr) {
        const empty = { cell: null, inputs: [], dateBtns: [], menus: [], addBtn: null };
        if (!tr) return empty;
        const cell = tr.querySelector('[data-testid="punches-cell-container"]');
        if (!cell) return empty;
        return {
            cell:     cell,
            inputs:   Array.from(cell.querySelectorAll('input[placeholder="--:--"]')),
            dateBtns: Array.from(cell.querySelectorAll('[aria-label="date change popover button"]')),
            // um ⋮ por PAR de batidas; o botão "+" não tem aria-expanded
            menus:    Array.from(cell.querySelectorAll('button[aria-expanded]'))
                           .filter(b => b.getAttribute('aria-label') !== 'Add punch entry'),
            addBtn:   cell.querySelector('[aria-label="Add punch entry"]'),
        };
    }

    // Rótulo cru da linha, exatamente como aparece na tela ("06/09").
    // Usado como CHAVE da linha: comparação textual não depende de formato.
    function rowLabelOf(tr) {
        const li = tr.querySelector('td li');
        const m = ((li ? li.innerText : tr.innerText) || '').match(/(\d{1,2}\/\d{1,2})/);
        return m ? m[1] : '';
    }

    // Interpreta uma linha da tabela.
    // `ctx` traz a semana em exibição e o índice da linha, necessários para
    // resolver a data sem chutar o formato do rótulo.
    function parseRow(tr, rowIndex, ctx) {
        const tds = tr.querySelectorAll('td');
        if (!tds.length) return null;

        const firstLi = tds[0].querySelector('li');
        const dm = ((firstLi ? firstLi.innerText : tds[0].innerText) || '').match(/(\d{1,2})\/(\d{1,2})/);
        if (!dm) return null;

        const weekday = (tds[0].innerText.match(/^\s*(\S+?)\.?\s/) || [, ''])[1];
        const week    = (ctx && ctx.week) || null;
        const year    = week ? week.year : new Date().getFullYear();
        const resolved = resolveRowDate(+dm[1], +dm[2], weekday, year,
                                        week ? week.start : null, rowIndex || 0);
        if (!resolved) return null;

        const schedLink = tds[0].querySelector('[data-testid="shift-breakdown-flyout-button"]');
        const schedRaw  = schedLink ? schedLink.innerText.replace(/\s+/g, ' ').trim() : '';
        const noSched   = !schedRaw || /nenhum cronograma|no schedule/i.test(tds[0].innerText);

        // Origem do padrão de batidas, da fonte mais específica para a mais fraca:
        //   1. horários da Programação DO DIA (per-day, o mais confiável)
        //   2. código do turno da página (NR-Z1800 → tabela do PPA)
        //   3. nada: linha fica sinalizada como não mapeada
        let key = '', pattern = null, patternSource = '';
        if (schedRaw) {
            const parts = schedRaw.split(/\s*[-–]\s*/);
            if (parts.length === 2) {
                key = to24h(parts[0]) + '-' + to24h(parts[1]);
                if (PATTERNS[key]) { pattern = PATTERNS[key]; patternSource = 'Programação do dia'; }
            }
        }
        const code = (ctx && ctx.shiftCode) || '';
        if (!pattern && code && SHIFT_CODES[code] && PATTERNS[SHIFT_CODES[code]]) {
            key = SHIFT_CODES[code];
            pattern = PATTERNS[key];
            patternSource = 'código do turno ' + code;
        }

        const p = readPunches(tr);
        return {
            tr:        tr,
            dateLabel: rowLabelOf(tr),        // rótulo cru da tela, só como chave/exibição
            realDate:  resolved.date,         // a data de verdade — é isso que o plano usa
            labelFmt:  resolved.labelFmt,     // 'dd/MM' | 'MM/dd' | 'ambos' | null
            dateSource: resolved.source,
            weekday:   weekday,
            schedRaw:  schedRaw,
            schedKey:  key,
            pattern:   pattern,
            patternSource: patternSource,
            shiftCode: code,
            shiftFamily: shiftFamily(code),
            noSched:   noSched,
            punches:   p.inputs.map(i => i.value.trim()),
            dates:     p.dateBtns.map(b => b.innerText.trim()),
            count:     p.inputs.length,
            canAdd:    !!p.addBtn,
        };
    }

    // Contexto compartilhado de uma leitura da tabela: semana em exibição +
    // formato detectado do botão de data.
    function readContext() {
        const week = readWeekRange();
        const code = readShiftCode();
        const ctx  = { week: week, shiftCode: code, shiftFamily: shiftFamily(code) };
        const table = findEditorTable();
        if (!table) return ctx;

        // 1ª passada só para ter as datas reais e poder detectar o formato do botão
        const trs = Array.from(table.querySelectorAll('tbody tr[data-test-component="StencilTableRow"]'));
        const probe = trs.map((tr, i) => parseRow(tr, i, ctx)).filter(Boolean);
        const det = detectBtnDateFormat(probe);
        ctx.btnFmt = det.fmt;
        ctx.btnVotes = det.votes;
        if (det.fmt) BTN_FMT = det.fmt;       // só sobrescreve o default com evidência
        return ctx;
    }

    function parseRows(ctx) {
        const table = findEditorTable();
        if (!table) return [];
        const c = ctx || readContext();
        return Array.from(table.querySelectorAll('tbody tr[data-test-component="StencilTableRow"]'))
                    .map((tr, i) => parseRow(tr, i, c))
                    .filter(Boolean);
    }

    // Reencontra a linha pelo rótulo cru. Usado depois de cada mutação, porque
    // referências de elemento morrem no re-render do React.
    function findRowByLabel(label) {
        const table = findEditorTable();
        if (!table) return null;
        for (const tr of table.querySelectorAll('tbody tr[data-test-component="StencilTableRow"]')) {
            if (rowLabelOf(tr) === label) return tr;
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────
    // PLANEJAMENTO — calcula o alvo de cada linha (sem tocar em nada)
    // ─────────────────────────────────────────────────────────────────────
    // Devolve { rows:[...], skipped:[...] }. Cada rowPlan tem a sequência
    // completa de batidas alvo, já com hora e data resolvidas.
    function planRow(row) {
        if (!row.realDate) return { skip: 'não consegui resolver a data da linha' };

        // Dia em andamento ou futuro NUNCA entra no auto ajuste: o turno não
        // terminou, então qualquer sequência "completa" que eu gerasse seria
        // invenção. Nesses dias o ajuste é manual.
        const hoje = midnight(new Date());
        const dia  = midnight(row.realDate);
        if (dia.getTime() === hoje.getTime()) return { skip: 'hoje — turno em andamento, ajuste manual' };
        if (dia.getTime() >   hoje.getTime()) return { skip: 'dia futuro' };

        // "Nenhum cronograma" COM batidas é trabalho não programado (o AtoZ marca
        // "Unscheduled work"). Aí o padrão vem do código do turno do associado,
        // não da coluna Programação — que nesse dia está vazia. Sem batidas, não
        // há o que ajustar.
        const hasPunches = row.punches.some(v => /^\d{1,2}:\d{2}$/.test(v));
        if (row.noSched && !hasPunches) return { skip: 'sem cronograma' };
        if (row.noSched && !row.shiftCode) {
            return { skip: 'sem cronograma e sem código de turno na página' };
        }

        if (!row.pattern)              return { skip: 'turno não mapeado (' + (row.schedKey || row.schedRaw) + ')' };
        if (!row.count && !row.canAdd) return { skip: 'sem campo para adicionar' };

        const canonTimes = row.pattern.times;
        const startMins  = timeToMins(canonTimes[0]);
        const lastOff    = (function () {
            // duração do turno = offset da última batida canônica
            const t = timeToMins(canonTimes[canonTimes.length - 1]);
            const a = t - startMins;
            return a <= 0 ? a + 1440 : a;
        })();
        const canonOffsets = canonTimes.map(t => toShiftOffset(t, startMins, lastOff));

        // Batidas reais existentes, na ordem do DOM (que é cronológica).
        // NÃO ordenar por hora de relógio: num turno night 00:14 viria antes de 17:50.
        //
        // `actualFieldIdx` guarda de qual CAMPO veio cada batida. Sem isso, achar a
        // data de uma batida por indexOf(hora) erraria justamente no caso de badge
        // duplicado, onde a mesma hora aparece duas vezes.
        const actualTimes = [], actualFieldIdx = [];
        row.punches.forEach((v, i) => {
            if (/^\d{1,2}:\d{2}$/.test(v)) { actualTimes.push(v); actualFieldIdx.push(i); }
        });
        const actualOffsets = actualTimes.map(t => toShiftOffset(t, startMins, lastOff));

        let targetOffsets, mode, kept = [], filled = [], dropped = [];

        if (!actualOffsets.length) {
            // Dia sem nenhuma batida → sequência canônica inteira (caso das img 1→5)
            mode = 'criar';
            targetOffsets = canonOffsets.slice();
            filled = canonOffsets.map((o, i) => i);
        } else if (actualOffsets.length > canonOffsets.length) {
            // EXCESSO (badge duplicado, por exemplo). matchBestExcess escolhe quais
            // batidas MANTER por menor erro; o resto é descartado. As mantidas são
            // reescritas em ordem de slot, o que faz os pontos "andarem" de In para
            // Out e vice-versa até bater — é o que resolve o card fora de fase.
            mode = 'excesso';
            const ex = matchBestExcess(actualOffsets, canonOffsets);
            if (!ex) return { skip: 'não consegui casar o excesso de batidas' };
            if (ex.tooMany) {
                return { skip: ex.n + ' batidas é muito para resolver com segurança — ' +
                               'exclua os pares duplicados pelo menu ⋮ e rode de novo' };
            }
            targetOffsets = ex.keep.map(i => actualOffsets[i]);
            kept = targetOffsets.map((o, i) => i);
            dropped = ex.drop.map(i => ({
                time:  actualTimes[i],
                date:  row.dates[actualFieldIdx[i]] || '',
                field: actualFieldIdx[i] + 1,      // nº do campo na tela
            }));
        } else if (actualOffsets.length === canonOffsets.length) {
            // Quantidade certa: preserva TODAS as horas reais e só corrige as datas.
            // Não invento correção em batida real que já existe.
            mode = 'só datas';
            targetOffsets = actualOffsets.slice();
            kept = targetOffsets.map((o, i) => i);
        } else {
            // Faltam batidas → descobre quais slots e completa preservando as reais
            mode = 'completar';
            const match = matchBestAssignment(actualOffsets, canonOffsets);
            if (!match.present) return { skip: 'não consegui casar as batidas com o turno' };
            targetOffsets = new Array(canonOffsets.length).fill(null);
            match.present.forEach((slot, j) => { targetOffsets[slot] = actualOffsets[j]; kept.push(slot); });
            match.missing.forEach(m => { targetOffsets[m.slot] = m.offset; filled.push(m.slot); });
        }

        // offset → hora + data. Parte da data REAL resolvida da linha e formata
        // no padrão detectado do botão (MM/DD no AtoZ), nunca o contrário.
        const target = targetOffsets.map((off, i) => {
            const r = fromShiftOffset(off, startMins);
            const d = new Date(row.realDate.getTime());
            d.setDate(d.getDate() + r.dayOffset);
            return {
                slot:      i,
                type:      i % 2 === 0 ? 'In' : 'Out',
                time:      r.time,
                dayOffset: r.dayOffset,
                date:      d,                  // a data real, sem formato nenhum
                dateText:  fmtBtnDate(d),      // como o botão exibe (MM/DD no AtoZ)
                dayNumber: d.getDate(),        // número que se clica no calendário
                isFilled:  filled.indexOf(i) !== -1,
            };
        });

        // Diff campo a campo contra o estado atual
        const changes = [];
        for (let i = 0; i < target.length; i++) {
            const curTime = row.punches[i] || '';
            const curDate = row.dates[i] || '';
            if (curTime !== target[i].time) changes.push({ slot: i, kind: 'hora', from: curTime || '(vazio)', to: target[i].time });
            if (curDate && curDate !== target[i].dateText) changes.push({ slot: i, kind: 'data', from: curDate, to: target[i].dateText });
            if (!curDate) changes.push({ slot: i, kind: 'data', from: '(novo)', to: target[i].dateText });
        }

        return {
            row:       row,
            dateLabel: row.dateLabel,
            mode:      mode,
            target:    target,
            dropped:   dropped,                      // batidas reais que serão descartadas
            fieldDelta: target.length - row.count,   // >0 inserir pares, <0 excluir
            changes:   changes,
        };
    }

    // onlyLabel: restringe a uma linha pelo rótulo da tela
    // onlyIso:   restringe a um conjunto de datas ISO (usado pelo modo guiado)
    function buildPlan(onlyLabel, onlyIso) {
        const ctx  = readContext();
        const rows = parseRows(ctx);
        const out  = {
            rows: [], skipped: [],
            year:   ctx.week ? ctx.week.year : new Date().getFullYear(),
            week:   ctx.week,
            btnFmt: BTN_FMT,
            btnDetected: ctx.btnFmt,
            shiftCode: ctx.shiftCode,
            shiftFamily: ctx.shiftFamily,
        };
        for (const row of rows) {
            if (onlyLabel && row.dateLabel !== onlyLabel) continue;
            if (onlyIso && !(row.realDate && onlyIso[isoOf(row.realDate)])) continue;
            const p = planRow(row);
            if (p.skip) { out.skipped.push({ dateLabel: row.dateLabel, reason: p.skip }); continue; }
            if (!p.changes.length && p.fieldDelta === 0) { out.skipped.push({ dateLabel: row.dateLabel, reason: 'já está correto' }); continue; }
            out.rows.push(p);
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // AÇÕES NO DOM
    // ─────────────────────────────────────────────────────────────────────

    // Do texto do item até o elemento que realmente recebe o clique.
    // Sobe no máximo alguns níveis e NUNCA usa parentElement cego: se o item não
    // tem ancestral clicável, o alvo é a própria folha de texto. Antes o fallback
    // era `el.parentElement`, que clicava no container do menu em vez do item.
    function menuItemTarget(leaf, bound) {
        let n = leaf, hops = 0;
        while (n && n !== bound && hops < 4) {
            if (n.matches && n.matches('button,[role="menuitem"],[role="option"],li,a')) return n;
            n = n.parentElement; hops++;
        }
        return leaf;
    }

    // Procura um item de menu visível pelo texto, num escopo.
    //
    // Os regexes são ancorados (^...$), então é seguro aceitar elementos COM
    // filhos: um item "ícone + texto" tem textContent igual ao rótulo, já que o
    // <svg> não contribui texto. Entre os candidatos vence o mais interno.
    function findMenuItem(regexes, scope) {
        const root = scope || document;
        let best = null, bestSize = Infinity;
        for (const el of root.querySelectorAll('div,span,li,button,a,p,[role="menuitem"]')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 70) continue;
            if (!regexes.some(re => re.test(t))) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            const size = el.querySelectorAll('*').length;
            if (size < bestSize) { bestSize = size; best = el; }
        }
        return best ? menuItemTarget(best, root === document ? null : root) : null;
    }

    // Procura o item olhando PRIMEIRO na popper que acabou de abrir e depois na
    // página inteira. Escopar só na popper foi um erro: há várias na página e a
    // que ganha conteúdo primeiro não é necessariamente a do menu.
    function findMenuItemAnywhere(regexes, before) {
        const pop = findNewlyOpenedPopper(before);
        return (pop && findMenuItem(regexes, pop)) || findMenuItem(regexes, document);
    }

    async function clickPairMenuItem(menuBtn, regexes) {
        const before = popperState();

        // Ordem deliberada: o .click() nativo é o caminho comprovado na página
        // real. A sequência completa de pointer/mouse é só escalonamento.
        const opens = [
            () => { try { menuBtn.click(); } catch (e) {} },
            () => realClick(menuBtn),
        ];

        for (let i = 0; i < opens.length; i++) {
            opens[i]();
            const item = await waitFor(() => findMenuItemAnywhere(regexes, before), CONFIG.MENU_WAIT);
            if (item) {
                try { item.click(); } catch (e) {}
                await sleep(CONFIG.STEP_PAUSE);
                // Menu ainda aberto com o item à vista = o clique não pegou.
                if (findMenuItemAnywhere(regexes, before)) {
                    realClick(item);
                    await sleep(CONFIG.STEP_PAUSE);
                }
                await closeAnyPopover();
                return true;
            }
            await closeAnyPopover();
        }
        return false;
    }

    // Garante que a linha tenha exatamente `wanted` campos de hora.
    async function ensureFieldCount(label, wanted, onStatus) {
        for (let guard = 0; guard < CONFIG.MAX_GUARD; guard++) {
            const tr = findRowByLabel(label);
            if (!tr) return { ok: false, reason: 'linha não encontrada' };
            const p = readPunches(tr);

            if (p.inputs.length === wanted) return { ok: true };

            if (p.inputs.length === 0) {
                if (!p.addBtn) return { ok: false, reason: 'sem botão + nesta linha' };
                onStatus && onStatus(label + ': criando campos (+)');
                p.addBtn.click();
                await waitFor(() => readPunches(findRowByLabel(label)).inputs.length > 0, CONFIG.FIELD_WAIT);
                continue;
            }

            const lastMenu = p.menus[p.menus.length - 1];
            if (!lastMenu) return { ok: false, reason: 'menu de 3 pontos não encontrado' };
            const before = p.inputs.length;

            if (p.inputs.length < wanted) {
                onStatus && onStatus(label + ': inserindo par (' + before + '→' + (before + 2) + ')');
                if (!await clickPairMenuItem(lastMenu, MENU_LABELS.insertAfter)) {
                    return { ok: false, reason: 'opção "Inserir os registros de ponto depois" não encontrada' };
                }
                await waitFor(() => readPunches(findRowByLabel(label)).inputs.length > before, CONFIG.FIELD_WAIT);
            } else {
                onStatus && onStatus(label + ': excluindo par (' + before + '→' + (before - 2) + ')');
                if (!await clickPairMenuItem(lastMenu, MENU_LABELS.deletePair)) {
                    return { ok: false, reason: 'opção "Excluir registros de ponto" não encontrada' };
                }
                await waitFor(() => readPunches(findRowByLabel(label)).inputs.length < before, CONFIG.FIELD_WAIT);
            }
        }
        const n = readPunches(findRowByLabel(label)).inputs.length;
        return n === wanted ? { ok: true } : { ok: false, reason: 'não cheguei em ' + wanted + ' campos (ficou ' + n + ')' };
    }

    // NOTA: a automação do calendário foi REMOVIDA. No AtoZ real o popover abre
    // mas o clique na célula do dia não altera o valor — provavelmente o handler
    // exige um gesto real do usuário. Em vez de carregar código que não funciona,
    // o script preenche as horas e MARCA as datas para você clicar (ver
    // markDatesForManualFix). Os helpers de popover abaixo ficaram porque o menu
    // de 3 pontos usa o mesmo mecanismo.

    // Clique "de verdade" num ÚNICO elemento. Popovers React costumam ignorar
    // .click() puro e só reagir a mousedown/pointerdown.
    //
    // CUIDADO: nunca disparar em dois elementos na mesma tentativa. O popover do
    // AtoZ alterna (abre/fecha), então clicar no <div> interno E no <button>
    // ancestral abria e fechava na sequência — era esse o "calendário não abriu".
    function realClick(el) {
        if (!el) return;
        const opts = { bubbles: true, cancelable: true, view: window };
        try { el.focus && el.focus(); } catch (e) {}
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            const Ctor = /pointer/.test(type) && window.PointerEvent ? PointerEvent : MouseEvent;
            try { el.dispatchEvent(new Ctor(type, opts)); }
            catch (e) { try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (e2) {} }
        });
    }

    // ── Popovers do Popper ───────────────────────────────────────────────
    // O AtoZ deixa uma div [data-popper-placement] VAZIA ao lado de cada botão de
    // data e injeta o calendário dentro dela no clique. Então "qual popover é o
    // calendário" não precisa de heurística: é a que acabou de ganhar conteúdo.
    function popperState() {
        const m = new Map();
        document.querySelectorAll('[data-popper-placement]').forEach(el => m.set(el, el.childElementCount));
        return m;
    }
    function findNewlyOpenedPopper(before) {
        for (const el of document.querySelectorAll('[data-popper-placement]')) {
            if (el.childElementCount > 0 && el.childElementCount > (before.get(el) || 0)) return el;
        }
        return null;
    }
    function anyOpenPopper() {
        for (const el of document.querySelectorAll('[data-popper-placement]')) {
            if (el.childElementCount > 0) return el;
        }
        return null;
    }
    async function closeAnyPopover() {
        if (!anyOpenPopper()) return;
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(120);
        if (!anyOpenPopper()) return;
        realClick(document.body);
        await sleep(120);
    }

    // ─────────────────────────────────────────────────────────────────────
    // EXECUÇÃO
    // ─────────────────────────────────────────────────────────────────────
    let RUNNING = false;

    async function applyPlan(plan, onStatus) {
        if (RUNNING) return null;
        RUNNING = true;
        const login  = readLogin();
        const stamp  = new Date().toISOString();
        const logRows = [];
        const report  = { done: 0, failed: 0, errors: [], manualDates: 0, rowsWithManual: [] };
        clearDateMarks();

        try {
            for (const rp of plan.rows.slice(0, CONFIG.MAX_ROWS)) {
                // 0) registra no log as batidas reais que serão descartadas.
                // Fica ANTES de mexer na página: se algo falhar no meio, o log já
                // mostra o que estava previsto sair.
                (rp.dropped || []).forEach(d => {
                    logRows.push([stamp, login, rp.dateLabel, '-', 'excesso', 'descartada',
                                  d.time + (d.date ? ' (' + d.date + ')' : ''), '(removida)']);
                });

                // 1) quantidade de campos
                const fc = await ensureFieldCount(rp.dateLabel, rp.target.length, onStatus);
                if (!fc.ok) {
                    report.failed++; report.errors.push(rp.dateLabel + ': ' + fc.reason);
                    logRows.push([stamp, login, rp.dateLabel, '-', '-', '-', '-', 'ERRO: ' + fc.reason]);
                    continue;
                }

                // 2) horas, na ordem dos slots
                let rowErr = null;
                for (let i = 0; i < rp.target.length; i++) {
                    const tr = findRowByLabel(rp.dateLabel);
                    const p  = readPunches(tr);
                    const inp = p.inputs[i];
                    if (!inp) { rowErr = 'campo de hora #' + (i + 1) + ' desapareceu'; break; }
                    const from = inp.value.trim();
                    const to   = rp.target[i].time;
                    if (from === to) continue;
                    onStatus && onStatus(rp.dateLabel + ': hora do ponto ' + (i + 1) + ' → ' + to);
                    setReactValue(inp, to);
                    logRows.push([stamp, login, rp.dateLabel, i + 1, rp.target[i].type, 'hora', from || '(vazio)', to]);
                    await sleep(CONFIG.STEP_PAUSE);
                }
                if (rowErr) {
                    report.failed++; report.errors.push(rp.dateLabel + ': ' + rowErr);
                    continue;
                }

                // 3) datas: o script NUNCA as altera. Marca quais precisam de
                // ajuste manual, com o alvo no tooltip, e a marca some quando
                // você corrige. Ver a nota sobre o calendário mais acima.
                const pend = markDatesForManualFix(rp);
                report.manualDates += pend;
                if (pend) report.rowsWithManual.push(rp.dateLabel + ' (' + pend + ')');
                report.done++;
            }
        } finally {
            RUNNING = false;
        }

        appendLog(logRows);
        highlightSave();
        return report;
    }

    // ─────────────────────────────────────────────────────────────────────
    // MARCAÇÃO DAS DATAS PENDENTES
    // ─────────────────────────────────────────────────────────────────────
    // O clique no calendário não funciona no AtoZ real, então em vez de tentar,
    // o script marca EXATAMENTE quais botões de data você precisa clicar e para
    // qual dia. Some sozinho quando a data fica correta.
    const DATE_MARK_ATTR = 'data-atz-want';

    function clearDateMarks() {
        document.querySelectorAll('[' + DATE_MARK_ATTR + ']').forEach(btn => {
            btn.removeAttribute(DATE_MARK_ATTR);
            btn.style.outline = '';
            btn.style.outlineOffset = '';
            btn.style.animation = '';
            btn.style.borderRadius = '';
            btn.title = '';
        });
    }

    // Marca os botões de data da linha que estão diferentes do alvo.
    // Devolve quantos ficaram pendentes.
    function markDatesForManualFix(rowPlan) {
        const tr = findRowByLabel(rowPlan.dateLabel);
        if (!tr) return 0;
        const p = readPunches(tr);
        let pending = 0;
        for (let i = 0; i < rowPlan.target.length; i++) {
            const btn = p.dateBtns[i];
            if (!btn) continue;
            const want = rowPlan.target[i].dateText;
            const got  = btn.innerText.trim();
            if (got === want) continue;
            pending++;
            btn.setAttribute(DATE_MARK_ATTR, want);
            btn.style.outline = '2px solid ' + C.accent;
            btn.style.outlineOffset = '2px';
            btn.style.borderRadius = '4px';
            btn.style.animation = 'atzPulse 1.4s ease-in-out infinite';
            btn.title = 'Ajuste manual: ponto ' + (i + 1) + ' deve ficar ' + want +
                        ' (hoje está ' + (got || 'vazio') + ')';
        }
        return pending;
    }

    // Reavalia todas as marcas e apaga as que já foram resolvidas.
    function refreshDateMarks() {
        document.querySelectorAll('[' + DATE_MARK_ATTR + ']').forEach(btn => {
            const want = btn.getAttribute(DATE_MARK_ATTR);
            if (btn.innerText.trim() === want) {
                btn.removeAttribute(DATE_MARK_ATTR);
                btn.style.outline = '';
                btn.style.outlineOffset = '';
                btn.style.animation = '';
                btn.style.borderRadius = '';
                btn.title = '';
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // AUTO AJUSTE — o caminho de um clique, por linha
    // ─────────────────────────────────────────────────────────────────────
    // Faz a parte chata e determinística: cria/remove os pares de campos e
    // preenche as 6 (ou 4) horas. NÃO mexe em data. Ao final, marca as datas
    // que precisam de ajuste manual.
    async function autoAdjustRow(label, onStatus) {
        const plan = buildPlan(label);
        if (!plan.rows.length) {
            const why = plan.skipped.length ? plan.skipped[0].reason : 'nada a ajustar';
            // Mesmo sem mudança de hora, ainda vale remarcar as datas pendentes
            const ctx  = readContext();
            const rows = parseRows(ctx);
            const row  = rows.filter(r => r.dateLabel === label)[0];
            if (row) {
                const rp = planRow(row);
                if (!rp.skip) {
                    clearDateMarks();
                    const pend = markDatesForManualFix(rp);
                    if (pend) return { ok: true, times: 0, manual: pend, msg: pend + ' data(s) para ajustar à mão' };
                }
            }
            return { ok: false, msg: why };
        }
        const rep = await applyPlan(plan, onStatus);
        if (!rep) return { ok: false, msg: 'já está rodando' };
        return {
            ok: rep.failed === 0,
            manual: rep.manualDates,
            msg: rep.failed
                ? ('erro: ' + rep.errors.join(' | '))
                : ('horas preenchidas' + (rep.manualDates ? ' · ' + rep.manualDates + ' data(s) para ajustar à mão' : '')),
        };
    }

    // Pulsa o botão de salvar. Nunca clica — a decisão é do usuário.
    function highlightSave() {
        const b = findSaveButton();
        if (!b) return;
        b.style.outline = '3px solid ' + C.accent;
        b.style.outlineOffset = '3px';
        b.style.animation = 'atzPulse 1.1s ease-in-out 6';
        b.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => { b.style.animation = ''; }, 8000);
    }

    // ─────────────────────────────────────────────────────────────────────
    // CSS
    // ─────────────────────────────────────────────────────────────────────
    function injectCss() {
        if (document.getElementById(CONFIG.CSS_ID)) return;
        const st = document.createElement('style');
        st.id = CONFIG.CSS_ID;
        st.textContent =
            '@keyframes atzFade{from{opacity:0}to{opacity:1}}' +
            '@keyframes atzPop{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}' +
            '@keyframes atzPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,.7)}50%{box-shadow:0 0 0 10px rgba(245,158,11,0)}}' +
            '.atz-btn{border:none;border-radius:8px;cursor:pointer;font-weight:800;font-size:12px;' +
                'font-family:' + C.font + ';padding:8px 14px;transition:filter .15s,transform .15s;}' +
            '.atz-btn:hover{filter:brightness(1.12);transform:translateY(-1px);}' +
            '.atz-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}' +
            '.' + CONFIG.ROW_BTN_CLS + '{background:transparent;border:1px solid ' + C.accent + ';color:' + C.accent + ';' +
                'border-radius:6px;min-width:26px;height:24px;cursor:pointer;font-size:11px;font-weight:800;' +
                'line-height:1;padding:0 8px;margin-top:6px;white-space:nowrap;transition:all .15s;' +
                "font-family:" + C.font + ';}' +
            '.' + CONFIG.ROW_BTN_CLS + ':hover:not(:disabled){background:' + C.accent + ';color:#231f20;}' +
            '#atz-toast{position:fixed;bottom:92px;left:24px;z-index:2147483600;max-width:340px;' +
                'padding:10px 14px;border-radius:10px;font-family:' + C.font + ';font-size:12px;font-weight:700;' +
                'color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.5);animation:atzPop .2s ease;}' +
            '.atz-tbl{width:100%;border-collapse:collapse;font-size:12px;}' +
            '.atz-tbl th{text-align:left;padding:6px 8px;color:' + C.dim + ';border-bottom:1px solid ' + C.border + ';' +
                'font-size:10px;text-transform:uppercase;letter-spacing:.06em;}' +
            '.atz-tbl td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.06);color:' + C.text + ';}' +
            '.atz-new{color:#7ee08a;font-weight:700;}.atz-old{color:' + C.dim + ';text-decoration:line-through;}' +
            '.atz-tab{border:none;border-radius:8px 8px 0 0;cursor:pointer;font-weight:800;font-size:12px;' +
                'font-family:' + C.font + ';padding:8px 16px;background:transparent;color:' + C.dim + ';' +
                'border-bottom:2px solid transparent;transition:all .15s;}' +
            '.atz-tab:hover{color:' + C.text + ';}' +
            '.atz-tab[data-active="1"]{color:' + C.accent + ';border-bottom-color:' + C.accent + ';background:' + C.panelAlt + ';}' +
            '#atz-guided{position:fixed;top:0;left:0;right:0;z-index:2147483500;background:' + C.panel + ';' +
                'border-bottom:2px solid ' + C.accent + ';padding:9px 16px;font-family:' + C.font + ';' +
                'color:' + C.text + ';box-shadow:0 6px 20px rgba(0,0,0,.45);animation:atzFade .18s ease;}';
        (document.head || document.documentElement).appendChild(st);
    }

    // Aviso rápido no canto. Some sozinho.
    let _toastTimer = null;
    function toast(msg, kind) {
        injectCss();
        let el = document.getElementById('atz-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'atz-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.background = kind === 'err' ? C.err : (kind === 'warn' ? C.warn : C.ok);
        if (_toastTimer) clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { if (el) el.remove(); }, 6000);
    }

    // ─────────────────────────────────────────────────────────────────────
    // MODAL DE PRÉVIA
    // ─────────────────────────────────────────────────────────────────────
    function closeModal() {
        const m = document.getElementById(CONFIG.MODAL_ID);
        if (m) m.remove();
    }

    function showPreview(plan) {
        closeModal();
        injectCss();

        const totalChanges = plan.rows.reduce((s, r) => s + r.changes.length, 0);

        const modal = document.createElement('div');
        modal.id = CONFIG.MODAL_ID;
        modal.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;' +
            'justify-content:center;background:rgba(13,19,26,.66);backdrop-filter:blur(3px);' +
            'font-family:' + C.font + ';animation:atzFade .16s ease;';
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

        const box = document.createElement('div');
        box.style.cssText = 'background:' + C.panel + ';border:2px solid ' + C.accent + ';border-radius:16px;' +
            'width:94%;max-width:720px;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;' +
            'box-shadow:0 24px 70px rgba(0,0,0,.6);animation:atzPop .22s cubic-bezier(.18,.9,.32,1.2);';

        const nTimes = plan.rows.reduce((s, r) => s + r.changes.filter(c => c.kind === 'hora').length, 0);
        const nDates = plan.rows.reduce((s, r) => s + r.changes.filter(c => c.kind === 'data').length, 0);
        const manualMode = true;   // o script nunca altera data; só marca

        let html = '<div style="padding:14px 18px;border-bottom:1px solid ' + C.border + ';">' +
            '<div style="font-size:15px;font-weight:800;color:' + C.text + ';">Prévia das alterações</div>' +
            '<div style="font-size:11px;color:' + C.dim + ';margin-top:3px;">' +
            plan.rows.length + ' dia(s) · ' + nTimes + ' hora(s)' +
            (nDates ? ' · ' + nDates + ' data(s)' : '') +
            (plan.shiftCode ? ' · turno ' + esc(plan.shiftCode) : '') +
            ' · nada é salvo automaticamente</div>' +
            (manualMode && nDates
                ? '<div style="font-size:11px;color:' + C.accent + ';margin-top:6px;line-height:1.4;">' +
                  'O script preenche só as <b>horas</b>. As ' + nDates + ' data(s) marcadas abaixo ficam ' +
                  '<b>piscando na tabela</b> para você clicar — o calendário do AtoZ não aceita clique automático.</div>'
                : '') +
            '</div>' +
            '<div style="flex:1;overflow-y:auto;padding:14px 18px;background:' + C.panelAlt + ';">';

        if (!plan.rows.length) {
            html += '<div style="color:' + C.dim + ';font-size:13px;">Nenhum dia para ajustar.</div>';
        }

        for (const rp of plan.rows) {
            const deltaTxt = rp.fieldDelta === 0 ? ''
                : (rp.fieldDelta > 0 ? ' · inserir ' + (rp.fieldDelta / 2) + ' par(es)'
                                     : ' · excluir ' + (-rp.fieldDelta / 2) + ' par(es)');
            html += '<div style="margin-bottom:14px;background:' + C.panel + ';border:1px solid ' + C.border + ';' +
                'border-left:3px solid ' + C.accent + ';border-radius:10px;padding:10px 12px;">' +
                '<div style="font-size:13px;font-weight:800;color:' + C.text + ';">' + esc(rp.row.weekday) + ' ' + esc(rp.dateLabel) +
                ' <span style="font-weight:600;color:' + (escalaOf(rp.row.realDate) === 'azul' ? '#6aa9e0' : '#e06a6a') +
                ';font-size:10px;">escala ' + escalaOf(rp.row.realDate) + '</span>' +
                ' <span style="font-weight:600;color:' + C.dim + ';font-size:11px;">' + esc(rp.row.schedRaw) +
                ' · ' + esc(rp.mode) + ' · ' + rp.row.count + '→' + rp.target.length + ' campos' + deltaTxt + '</span></div>' +
                // Descartar batida real é a operação mais sensível do script, então
                // ela nunca fica escondida no meio do diff.
                (rp.dropped && rp.dropped.length
                    ? '<div style="margin:0 0 7px;padding:6px 9px;border-radius:7px;background:rgba(198,40,40,.16);' +
                      'border:1px solid ' + C.err + ';color:#ffb4b4;font-size:11px;line-height:1.45;">' +
                      '<b>Vai DESCARTAR ' + rp.dropped.length + ' batida real:</b> ' +
                      rp.dropped.map(d => esc(d.time) + (d.date ? ' (' + esc(d.date) + ')' : '')).join(', ') +
                      '<br>As demais são reposicionadas em ordem, então os pontos mudam de In para Out e vice-versa.' +
                      '</div>'
                    : '') +
                '<table class="atz-tbl"><thead><tr><th>#</th><th>Tipo</th><th>Hora</th><th>Data</th><th>Origem</th></tr></thead><tbody>';

            for (let i = 0; i < rp.target.length; i++) {
                const t       = rp.target[i];
                const curTime = rp.row.punches[i] || '';
                const curDate = rp.row.dates[i] || '';
                const timeCell = curTime === t.time
                    ? '<span>' + esc(t.time) + '</span>'
                    : (curTime ? '<span class="atz-old">' + esc(curTime) + '</span> <span class="atz-new">' + esc(t.time) + '</span>'
                               : '<span class="atz-new">' + esc(t.time) + '</span>');
                const dateCell = curDate === t.dateText
                    ? '<span>' + esc(t.dateText) + '</span>'
                    : (curDate ? '<span class="atz-old">' + esc(curDate) + '</span> <span class="atz-new">' + esc(t.dateText) + '</span>'
                               : '<span class="atz-new">' + esc(t.dateText) + '</span>');
                html += '<tr><td>' + (i + 1) + '</td><td>' + t.type + '</td><td>' + timeCell + '</td><td>' + dateCell +
                    (t.dayOffset === 1 ? ' <span style="color:#7ee08a;font-size:10px;">Dia seguinte</span>' : '') + '</td>' +
                    '<td style="color:' + C.dim + ';font-size:11px;">' + (t.isFilled ? 'calculado' : 'batida real') + '</td></tr>';
            }
            html += '</tbody></table></div>';
        }

        if (plan.skipped.length) {
            html += '<div style="font-size:11px;color:' + C.dim + ';border-top:1px solid ' + C.border + ';padding-top:10px;">' +
                '<b>Ignorados:</b> ' + plan.skipped.map(s => esc(s.dateLabel) + ' (' + esc(s.reason) + ')').join(' · ') + '</div>';
        }

        html += '</div><div id="atz-status" style="padding:8px 18px;font-size:11px;color:' + C.dim + ';' +
            'border-top:1px solid ' + C.border + ';min-height:18px;"></div>' +
            '<div style="padding:12px 18px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid ' + C.border + ';">' +
            '<button id="atz-cancel" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Cancelar</button>' +
            '<button id="atz-apply" class="atz-btn" style="background:' + C.accent + ';color:#231f20;"' +
            (plan.rows.length ? '' : ' disabled') + '>' +
            (manualMode ? 'Preencher ' + nTimes + ' hora(s)' : 'Aplicar ' + totalChanges + ' alteração(ões)') +
            '</button></div>';

        box.innerHTML = html;
        modal.appendChild(box);
        document.body.appendChild(modal);

        const status = box.querySelector('#atz-status');
        const apply  = box.querySelector('#atz-apply');
        const cancel = box.querySelector('#atz-cancel');
        const setStatus = txt => { if (status) status.textContent = txt || ''; };

        cancel.onclick = closeModal;
        apply.onclick = async () => {
            apply.disabled = true; cancel.disabled = true;
            apply.textContent = 'Aplicando...';
            const rep = await applyPlan(plan, setStatus);
            cancel.disabled = false;
            cancel.textContent = 'Fechar';
            if (!rep) { apply.textContent = 'Já rodando'; return; }
            apply.textContent = rep.failed ? 'Concluído com erros' : 'Concluído';
            apply.style.background = rep.failed ? C.warn : C.ok;
            apply.style.color = '#fff';
            const msg = [rep.done + ' dia(s) ok'];
            if (rep.failed) msg.push(rep.failed + ' com erro: ' + rep.errors.join(' | '));
            if (rep.manualDates) msg.push(rep.manualDates + ' data(s) piscando na tabela para você clicar (' + rep.rowsWithManual.join(', ') + ')');
            else if (!rep.failed) msg.push('revise e clique em "Salvar alterações"');
            setStatus(msg.join(' · '));
            runInjections();
            // No modo guiado, aplicar significa "agora é a vez do Salvar"
            if (loadGuided()) { closeModal(); guidedAfterApply(); }
        };
    }
    // ─────────────────────────────────────────────────────────────────────
    // ENGRENAGEM — Turnos + Log
    // ─────────────────────────────────────────────────────────────────────
    let _settingsTab = 'turnos';

    function showSettings(tab) {
        _settingsTab = tab || _settingsTab || 'turnos';
        closeModal();
        injectCss();

        const modal = document.createElement('div');
        modal.id = CONFIG.MODAL_ID;
        modal.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;' +
            'justify-content:center;background:rgba(13,19,26,.66);backdrop-filter:blur(3px);' +
            'font-family:' + C.font + ';animation:atzFade .16s ease;';
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

        const box = document.createElement('div');
        box.style.cssText = 'background:' + C.panel + ';border:2px solid ' + C.accent + ';border-radius:16px;' +
            'width:95%;max-width:820px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;' +
            'box-shadow:0 24px 70px rgba(0,0,0,.6);animation:atzPop .22s cubic-bezier(.18,.9,.32,1.2);';

        const tabBtn = (id, label) =>
            '<button id="' + id + '" class="atz-tab" data-active="' + (_settingsTab === id.replace('atz-tab-', '') ? '1' : '0') + '">' +
            label + '</button>';

        box.innerHTML =
            '<div style="padding:12px 18px;border-bottom:1px solid ' + C.border + ';display:flex;align-items:center;gap:10px;">' +
                '<div style="flex:1;font-size:15px;font-weight:800;color:' + C.text + ';">⚙ Configuração</div>' +
                '<button id="atz-set-close" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Fechar</button>' +
            '</div>' +
            '<div style="display:flex;gap:6px;padding:10px 18px 0;">' +
                tabBtn('atz-tab-turnos', 'Turnos') + tabBtn('atz-tab-log', 'Log') +
            '</div>' +
            '<div id="atz-set-body" style="flex:1;overflow-y:auto;padding:14px 18px;background:' + C.panelAlt + ';"></div>' +
            '<div id="atz-set-foot" style="padding:12px 18px;display:flex;gap:10px;justify-content:flex-end;' +
                'border-top:1px solid ' + C.border + ';"></div>';

        modal.appendChild(box);
        document.body.appendChild(modal);

        box.querySelector('#atz-set-close').onclick = closeModal;
        box.querySelector('#atz-tab-turnos').onclick = () => { _settingsTab = 'turnos'; showSettings('turnos'); };
        box.querySelector('#atz-tab-log').onclick    = () => { _settingsTab = 'log'; showSettings('log'); };

        if (_settingsTab === 'log') renderLogTab(box);
        else renderTurnosTab(box);
    }

    // ── Aba Turnos ───────────────────────────────────────────────────────
    function renderTurnosTab(box) {
        const body = box.querySelector('#atz-set-body');
        const foot = box.querySelector('#atz-set-foot');
        const anchorIso = (function (d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
        })(loadAnchor());

        let html =
            // ── Escala ──
            '<div style="background:' + C.panel + ';border:1px solid ' + C.border + ';border-radius:10px;padding:11px 13px;margin-bottom:14px;">' +
              '<div style="font-size:12px;font-weight:800;color:' + C.text + ';margin-bottom:5px;">Escalas 3x2</div>' +
              '<div style="font-size:11px;color:' + C.dim + ';line-height:1.55;">' +
                '<b>NR</b> e <b>DR</b> → escala <b style="color:#6aa9e0;">azul</b> · ' +
                '<b>NS</b> e <b>DS</b> → escala <b style="color:#e06a6a;">vermelha</b> · ' +
                '<b>NE</b> → <b>ADM</b> (seg→sex)<br>' +
                'Ciclo de 10 dias que se repete: 3 vermelhos, 3 azuis, 2 vermelhos, 2 azuis.' +
              '</div>' +
              '<div style="display:flex;align-items:center;gap:8px;margin-top:9px;">' +
                '<span style="font-size:11px;color:' + C.dim + ';">1º dia vermelho do ciclo:</span>' +
                '<input type="date" id="atz-anchor" value="' + anchorIso + '" ' +
                  'style="background:' + C.panelAlt + ';color:' + C.text + ';border:1px solid ' + C.border + ';' +
                  'border-radius:6px;padding:5px 8px;font-family:' + C.font + ';font-size:12px;">' +
              '</div>' +
              '<div id="atz-anchor-check" style="font-size:10px;color:' + C.dim + ';margin-top:7px;line-height:1.5;"></div>' +
            '</div>' +

            // ── Padrões de batida ──
            '<div style="font-size:11px;font-weight:800;color:' + C.dim + ';text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px;">' +
              'Padrões de batida</div>' +
            '<div style="font-size:10px;color:' + C.dim + ';margin-bottom:9px;line-height:1.5;">' +
              'Sequência In1, Out1, In2, Out2, In3, Out3 em 24h (4 ou 6 horários). ' +
              'A data de cada batida é calculada pelo script, não configurada aqui.</div>';

        for (const key in PATTERNS) {
            const pt = PATTERNS[key];
            const w  = computeWorked(pt.times);
            const usedBy = Object.keys(SHIFT_CODES).filter(c => SHIFT_CODES[c] === key);
            html += '<div style="margin-bottom:10px;background:' + C.panel + ';border:1px solid ' + C.border + ';border-radius:10px;padding:9px 11px;">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                  '<div style="flex:1;font-size:12px;font-weight:800;color:' + C.text + ';">' + esc(pt.label) +
                    ' <span style="font-weight:600;color:' + C.dim + ';">· ' + pt.times.length + ' batidas</span></div>' +
                  '<button class="atz-btn atz-pat-del" data-key="' + esc(key) + '" ' +
                    'style="background:' + C.border + ';color:' + C.text + ';padding:4px 9px;font-size:10px;">Remover</button>' +
                '</div>' +
                '<input class="atz-pat" data-key="' + esc(key) + '" value="' + esc(pt.times.join(' ')) + '" ' +
                  'style="width:100%;box-sizing:border-box;background:' + C.panelAlt + ';color:' + C.text + ';' +
                  'border:1px solid ' + C.border + ';border-radius:7px;padding:7px 9px;font-family:monospace;font-size:13px;">' +
                '<div style="font-size:10px;color:' + C.dim + ';margin-top:5px;">trabalhado ' + w.workLabel +
                  ' · break ' + w.breakLabel + ' · usado por: ' + (usedBy.length ? esc(usedBy.join(', ')) : '<i>nenhum código</i>') + '</div>' +
            '</div>';
        }

        // ── Códigos de turno ──
        html += '<div style="font-size:11px;font-weight:800;color:' + C.dim + ';text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px;">' +
                  'Códigos de turno</div>';
        const patKeys = Object.keys(PATTERNS);
        const codes = Object.keys(SHIFT_CODES).sort();
        html += '<table class="atz-tbl"><thead><tr><th>Código</th><th>Escala</th><th>Padrão de batida</th><th></th></tr></thead><tbody>';
        for (const code of codes) {
            const sc = shiftScale(code);
            const scTxt = sc === 'azul' ? '<span style="color:#6aa9e0;font-weight:700;">azul</span>'
                        : sc === 'vermelha' ? '<span style="color:#e06a6a;font-weight:700;">vermelha</span>'
                        : sc === 'adm' ? '<span style="color:#7ee08a;font-weight:700;">ADM</span>'
                        : '<span style="color:' + C.warn + ';">não informada</span>';
            html += '<tr><td style="font-family:monospace;font-weight:700;">' + esc(code) + '</td><td>' + scTxt + '</td><td>' +
                '<select class="atz-code-pat" data-code="' + esc(code) + '" ' +
                  'style="background:' + C.panelAlt + ';color:' + C.text + ';border:1px solid ' + C.border + ';' +
                  'border-radius:6px;padding:4px 6px;font-size:11px;font-family:' + C.font + ';">' +
                patKeys.map(k => '<option value="' + esc(k) + '"' + (SHIFT_CODES[code] === k ? ' selected' : '') + '>' +
                                 esc(PATTERNS[k].label) + '</option>').join('') +
                '</select></td><td><button class="atz-btn atz-code-del" data-code="' + esc(code) + '" ' +
                  'style="background:' + C.border + ';color:' + C.text + ';padding:3px 8px;font-size:10px;">Remover</button></td></tr>';
        }
        html += '</tbody></table>';

        // ── Adicionar turno ──
        html += '<div style="margin-top:14px;background:' + C.panel + ';border:1px dashed ' + C.accent + ';border-radius:10px;padding:11px 13px;">' +
            '<div style="font-size:12px;font-weight:800;color:' + C.text + ';margin-bottom:7px;">Adicionar turno</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
              '<div><div style="font-size:10px;color:' + C.dim + ';margin-bottom:3px;">Código (ex: NF0T1800)</div>' +
                '<input id="atz-new-code" placeholder="NF0T1800" style="width:130px;background:' + C.panelAlt + ';color:' + C.text +
                ';border:1px solid ' + C.border + ';border-radius:6px;padding:6px 8px;font-family:monospace;font-size:12px;"></div>' +
              '<div style="flex:1;min-width:230px;"><div style="font-size:10px;color:' + C.dim + ';margin-bottom:3px;">' +
                'Horários (4 ou 6, separados por espaço)</div>' +
                '<input id="atz-new-times" placeholder="18:00 23:00 00:00 02:30 02:45 05:00" ' +
                'style="width:100%;box-sizing:border-box;background:' + C.panelAlt + ';color:' + C.text +
                ';border:1px solid ' + C.border + ';border-radius:6px;padding:6px 8px;font-family:monospace;font-size:12px;"></div>' +
              '<button id="atz-new-add" class="atz-btn" style="background:' + C.accent + ';color:#231f20;">Adicionar</button>' +
            '</div>' +
            '<div style="font-size:10px;color:' + C.dim + ';margin-top:7px;line-height:1.5;">' +
              'A escala sai do prefixo do código (NR/DR azul, NS/DS vermelha, NE ADM). ' +
              'Se os horários coincidirem com um padrão existente, o código é ligado a ele.</div>' +
          '</div>';

        body.innerHTML = html;
        foot.innerHTML =
            '<button id="atz-set-reset" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Restaurar padrões</button>' +
            '<button id="atz-set-save" class="atz-btn" style="background:' + C.accent + ';color:#231f20;">Salvar</button>';

        // Confere a âncora contra o cronograma da página assim que abre e ao mudar
        const anchorInput = body.querySelector('#atz-anchor');
        const checkEl = body.querySelector('#atz-anchor-check');
        function runAnchorCheck() {
            const m = String(anchorInput.value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) { checkEl.innerHTML = ''; return; }
            // Testa com a âncora digitada e SEMPRE volta ao valor salvo. O finally
            // importa: sem ele, uma exceção aqui deixaria a âncora de teste gravada.
            const prev = gmGet(STORE.ANCHOR, DEFAULT_ANCHOR);
            let res = null;
            try {
                saveAnchor(anchorInput.value);
                res = escalaCheck();
            } finally {
                saveAnchor(prev);
            }
            if (!res) { checkEl.innerHTML = '<span style="color:' + C.dim + ';">sem tabela na tela para conferir</span>'; return; }
            checkEl.innerHTML = res.code
                ? ('Conferência com a semana na tela (' + esc(res.code) + ', ' + esc(scaleLabel(res.scale)) + '): ' +
                   (res.unknown ? '<span style="color:' + C.dim + ';">escala do prefixo não informada</span>'
                    : res.diverge
                      ? '<span style="color:' + C.err + ';font-weight:700;">' + res.diverge + ' dia(s) divergindo</span> — ' + esc(res.detail)
                      : '<span style="color:#7ee08a;font-weight:700;">bate nos ' + res.total + ' dias</span>'))
                : '<span style="color:' + C.warn + ';">código do turno não encontrado na página</span>';
        }
        anchorInput.onchange = runAnchorCheck;
        runAnchorCheck();

        // Remover padrão / código
        body.querySelectorAll('.atz-pat-del').forEach(b => {
            b.onclick = () => {
                const k = b.getAttribute('data-key');
                const usedBy = Object.keys(SHIFT_CODES).filter(c => SHIFT_CODES[c] === k);
                if (usedBy.length && !confirm('O padrão "' + k + '" é usado por: ' + usedBy.join(', ') +
                    '.\nRemover também esses códigos?')) return;
                usedBy.forEach(c => { delete SHIFT_CODES[c]; });
                delete PATTERNS[k];
                savePatterns(); saveCodes(); showSettings('turnos');
            };
        });
        body.querySelectorAll('.atz-code-del').forEach(b => {
            b.onclick = () => {
                delete SHIFT_CODES[b.getAttribute('data-code')];
                saveCodes(); showSettings('turnos');
            };
        });

        // Adicionar turno
        body.querySelector('#atz-new-add').onclick = () => {
            const code = (body.querySelector('#atz-new-code').value || '').trim().toUpperCase();
            const times = (body.querySelector('#atz-new-times').value || '').trim()
                            .split(/[\s,;|]+/).filter(Boolean).map(t => to24h(t));
            if (!code) { alert('Informe o código do turno.'); return; }
            if (times.length !== 4 && times.length !== 6) { alert('Informe 4 ou 6 horários.'); return; }
            if (times.some(t => timeToMins(t) < 0)) { alert('Há horário inválido. Use HH:MM em 24h.'); return; }

            const key = times[0] + '-' + times[times.length - 1];
            const fam = shiftFamily(code) || '?';
            if (!PATTERNS[key]) {
                PATTERNS[key] = { label: fam + ' ' + times[0] + ' → ' + times[times.length - 1], times: times };
            } else {
                PATTERNS[key].times = times;   // atualiza o padrão existente
            }
            SHIFT_CODES[code] = key;
            savePatterns(); saveCodes();
            toast('Turno ' + code + ' adicionado (' + scaleLabel(shiftScale(code)) + ')', 'ok');
            showSettings('turnos');
        };

        // Salvar (horários dos padrões + mapeamento código→padrão + âncora)
        foot.querySelector('#atz-set-save').onclick = () => {
            let bad = null;
            body.querySelectorAll('.atz-pat').forEach(inp => {
                if (bad) return;
                const key = inp.getAttribute('data-key');
                const times = inp.value.trim().split(/[\s,;|]+/).filter(Boolean).map(t => to24h(t));
                if (times.length !== 4 && times.length !== 6) { bad = key + ': precisa de 4 ou 6 horários'; return; }
                if (times.some(t => timeToMins(t) < 0)) { bad = key + ': horário inválido'; return; }
                if (PATTERNS[key]) PATTERNS[key].times = times;
            });
            if (bad) { alert('⚠ ' + bad); return; }
            body.querySelectorAll('.atz-code-pat').forEach(sel => {
                SHIFT_CODES[sel.getAttribute('data-code')] = sel.value;
            });
            if (/^\d{4}-\d{2}-\d{2}$/.test(anchorInput.value)) saveAnchor(anchorInput.value);
            savePatterns(); saveCodes();
            toast('Configuração salva', 'ok');
            closeModal();
            runInjections();
        };

        foot.querySelector('#atz-set-reset').onclick = () => {
            if (!confirm('Restaurar turnos, códigos e âncora do ciclo aos valores padrão?')) return;
            PATTERNS = JSON.parse(JSON.stringify(DEFAULT_PATTERNS));
            SHIFT_CODES = JSON.parse(JSON.stringify(DEFAULT_SHIFT_CODES));
            savePatterns(); saveCodes(); saveAnchor(DEFAULT_ANCHOR);
            showSettings('turnos');
        };
    }

    // ── Aba Log ──────────────────────────────────────────────────────────
    function renderLogTab(box) {
        const body = box.querySelector('#atz-set-body');
        const foot = box.querySelector('#atz-set-foot');
        const rows = loadLog().slice().reverse();       // mais recente primeiro

        if (!rows.length) {
            body.innerHTML = '<div style="font-size:12px;color:' + C.dim + ';padding:8px;">' +
                'Nenhuma alteração registrada ainda. O log grava toda hora e data que o script escreve.</div>';
        } else {
            let html = '<div style="font-size:11px;color:' + C.dim + ';margin-bottom:9px;">' +
                rows.length + ' alteração(ões) · mais recente primeiro</div>' +
                '<table class="atz-tbl"><thead><tr>' +
                '<th>Quando</th><th>Login</th><th>Dia</th><th>#</th><th>Tipo</th><th>Campo</th><th>De</th><th>Para</th>' +
                '</tr></thead><tbody>';
            rows.forEach(r => {
                const when = (function (iso) {
                    const d = new Date(iso);
                    return isNaN(d.getTime()) ? String(iso)
                        : (pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()));
                })(r[0]);
                const para = String(r[7] == null ? '' : r[7]);
                const isErr = /^ERRO/i.test(para);
                html += '<tr>' +
                    '<td style="color:' + C.dim + ';white-space:nowrap;">' + esc(when) + '</td>' +
                    '<td>' + esc(r[1]) + '</td>' +
                    '<td style="white-space:nowrap;">' + esc(r[2]) + '</td>' +
                    '<td>' + esc(r[3]) + '</td>' +
                    '<td>' + esc(r[4]) + '</td>' +
                    '<td>' + esc(r[5]) + '</td>' +
                    '<td class="atz-old">' + esc(r[6]) + '</td>' +
                    '<td class="' + (isErr ? '' : 'atz-new') + '"' + (isErr ? ' style="color:' + C.err + ';font-weight:700;"' : '') + '>' +
                        esc(para) + '</td>' +
                '</tr>';
            });
            body.innerHTML = html + '</tbody></table>';
        }

        foot.innerHTML =
            '<button id="atz-log-clear" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Limpar log</button>' +
            '<button id="atz-log-csv" class="atz-btn" style="background:' + C.accent + ';color:#231f20;">Baixar CSV</button>';
        foot.querySelector('#atz-log-csv').onclick = downloadLogCsv;
        foot.querySelector('#atz-log-clear').onclick = () => {
            if (!confirm('Apagar todo o log de alterações? Isso não desfaz nada na página.')) return;
            gmSet(STORE.LOG, '[]');
            showSettings('log');
        };
    }

    // Confere a escala calculada contra os dias que a página diz ter cronograma.
    // Devolve null quando não há tabela na tela.
    function escalaCheck() {
        const ctx = readContext();
        if (!findEditorTable()) return null;
        const code = ctx.shiftCode;
        const scale = shiftScale(code);
        const rows = parseRows(ctx);
        if (!code || !scale) return { code: code, scale: scale, unknown: true, total: rows.length };

        let diverge = 0;
        const detail = [];
        for (const r of rows) {
            const should = worksOn(code, r.realDate);
            if (should === null) continue;
            const has = !r.noSched && !!r.schedRaw;
            if (should !== has) {
                diverge++;
                detail.push(r.dateLabel + (should ? ' (escala diz trabalha, página não tem cronograma)'
                                                 : ' (escala diz folga, página tem cronograma)'));
            }
        }
        return { code: code, scale: scale, unknown: false, total: rows.length, diverge: diverge, detail: detail.join('; ') };
    }

    // Soma trabalhada e break de uma sequência (para exibir na config e validar)
    function computeWorked(times) {
        const start = timeToMins(times[0]);
        const last  = timeToMins(times[times.length - 1]);
        const dur   = (last - start) <= 0 ? (last - start + 1440) : (last - start);
        const offs  = times.map(t => toShiftOffset(t, start, dur));
        let work = 0, brk = 0;
        for (let i = 0; i + 1 < offs.length; i += 2) work += offs[i + 1] - offs[i];
        for (let i = 1; i + 1 < offs.length; i += 2) brk  += offs[i + 1] - offs[i];
        const fmt = m => Math.floor(m / 60) + 'h' + pad2(m % 60);
        return { work: work, break: brk, workLabel: fmt(work), breakLabel: fmt(brk) };
    }

    // ─────────────────────────────────────────────────────────────────────
    // LOG CSV
    // ─────────────────────────────────────────────────────────────────────
    function downloadLogCsv() {
        const rows = loadLog();
        if (!rows.length) { alert('Nenhuma alteração registrada ainda.'); return; }
        const escCsv = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const header = ['Timestamp', 'Login', 'Dia', 'Ponto', 'Tipo', 'Campo', 'De', 'Para'].map(escCsv).join(',');
        const csv = [header].concat(rows.map(r => r.map(escCsv).join(','))).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), {
            href: url,
            download: 'atoz_pontos_' + new Date().toISOString().slice(0, 10) + '.csv',
        });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    }

    // ─────────────────────────────────────────────────────────────────────
    // MODO GUIADO
    // ─────────────────────────────────────────────────────────────────────
    // Você importa uma lista de logins + datas e o script conduz um por um:
    //   navigate → editor → range → adjust → save → (recarrega) → próximo
    //
    // O estado vive em GM storage porque o fluxo ATRAVESSA recarregamentos de
    // página: o próprio reload depois de "Salvar alterações" é o sinal de que o
    // ajuste subiu, e é ele que avança para o próximo login.
    const GUIDED_STEPS = {
        navigate: 'Abrindo a página do associado',
        editor:   'Abrindo o Editor de cartão de ponto',
        range:    'Selecione o intervalo de datas no AtoZ',
        adjust:   'Rode o Auto Ajuste Guiado',
        save:     'Clique em Salvar alterações',
    };

    function loadGuided() {
        try {
            const s = JSON.parse(gmGet(STORE.GUIDED, 'null'));
            if (s && s.active && Array.isArray(s.items) && s.items.length) return s;
        } catch (e) {}
        return null;
    }
    function saveGuided(s) { gmSet(STORE.GUIDED, s ? JSON.stringify(s) : 'null'); }
    function endGuided() { saveGuided(null); removeGuidedBar(); }

    const isoOf = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const brOf  = iso => { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] : iso; };

    // Interpreta data de arquivo. Prefere dd/MM (padrão BR) e usa o dia > 12 para
    // desambiguar quando possível. Serial do Excel também é aceito.
    function parseFileDate(v, fallbackYear) {
        if (v == null || v === '') return null;
        if (v instanceof Date && !isNaN(v.getTime())) return midnight(v);

        const s = String(v).trim();
        // serial do Excel (dias desde 30/12/1899)
        if (/^\d{5}(\.\d+)?$/.test(s)) {
            const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
            return mkDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        }
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return mkDate(+m[1], +m[2], +m[3]);
        m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
        if (m) {
            let a = +m[1], b = +m[2], y = +m[3];
            if (y < 100) y += 2000;
            if (a > 12 && b <= 12) return mkDate(y, b, a);       // só pode ser dd/MM
            if (b > 12 && a <= 12) return mkDate(y, a, b);       // só pode ser MM/dd
            return mkDate(y, b, a);                              // ambíguo → dd/MM
        }
        m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})$/);              // sem ano
        if (m) {
            let a = +m[1], b = +m[2];
            const y = fallbackYear || new Date().getFullYear();
            if (a > 12 && b <= 12) return mkDate(y, b, a);
            if (b > 12 && a <= 12) return mkDate(y, a, b);
            return mkDate(y, b, a);
        }
        return null;
    }

    // Matriz (array de arrays) → itens { login, dates:[iso] }, agrupando por login.
    function rowsToGuidedItems(matrix, fallbackYear) {
        if (!matrix || !matrix.length) return { items: [], warnings: ['arquivo vazio'] };
        const warnings = [];

        // Descobre as colunas de login e data pelo cabeçalho; sem cabeçalho usa A e B.
        let start = 0, cLogin = 0, cDate = 1;
        const head = matrix[0].map(x => String(x == null ? '' : x).trim().toLowerCase());
        const findCol = names => head.findIndex(h => names.indexOf(h) !== -1);
        const li = findCol(['login', 'user', 'usuario', 'usuário', 'alias', 'employee', 'id']);
        const di = findCol(['data', 'date', 'dia', 'datas']);
        if (li !== -1 && di !== -1) { cLogin = li; cDate = di; start = 1; }
        else if (head.some(h => /login|data|date/.test(h))) { start = 1; }

        const byLogin = {}, order = [];
        for (let r = start; r < matrix.length; r++) {
            const row = matrix[r] || [];
            const login = String(row[cLogin] == null ? '' : row[cLogin]).trim();
            if (!login) continue;
            // a célula de data pode ter várias datas separadas
            const raw = row[cDate];
            const parts = (raw instanceof Date) ? [raw] : String(raw == null ? '' : raw).split(/[;,|]+/);
            const isos = [];
            parts.forEach(p => {
                const d = parseFileDate(typeof p === 'string' ? p.trim() : p, fallbackYear);
                if (d) isos.push(isoOf(d));
                else if (String(p).trim()) warnings.push('linha ' + (r + 1) + ': data "' + String(p).trim() + '" não reconhecida');
            });
            if (!isos.length) { warnings.push('linha ' + (r + 1) + ': ' + login + ' sem data válida'); continue; }
            const key = login.toLowerCase();
            if (!byLogin[key]) { byLogin[key] = { login: login, dates: [] }; order.push(key); }
            isos.forEach(iso => { if (byLogin[key].dates.indexOf(iso) === -1) byLogin[key].dates.push(iso); });
        }
        const items = order.map(k => {
            byLogin[k].dates.sort();
            byLogin[k].status = 'pending';
            return byLogin[k];
        });
        return { items: items, warnings: warnings };
    }

    function parseCsvText(txt) {
        const out = [];
        String(txt).replace(/\r/g, '').split('\n').forEach(line => {
            if (!line.trim()) return;
            // separador: ; se aparecer mais que , (padrão BR do Excel), senão tab ou ,
            const sep = (line.split(';').length > line.split(',').length) ? ';'
                      : (line.indexOf('\t') !== -1 ? '\t' : ',');
            out.push(line.split(sep).map(c => c.trim().replace(/^"|"$/g, '')));
        });
        return out;
    }

    // ── Barra do guiado ──────────────────────────────────────────────────
    function removeGuidedBar() {
        const b = document.getElementById('atz-guided');
        if (b) b.remove();
        document.body.style.paddingTop = '';    // devolve o espaço que a barra ocupava
    }

    function renderGuidedBar(st) {
        injectCss();
        let bar = document.getElementById('atz-guided');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'atz-guided';
            document.body.appendChild(bar);
        }
        const item = st.items[st.idx];
        const total = st.items.length;
        const done = st.items.filter(x => x.status === 'done').length;
        const datasBr = item.dates.map(brOf).join(', ');

        // Quais datas pedidas estão visíveis na tabela agora
        const rows = findEditorTable() ? parseRows() : [];
        const visible = {};
        rows.forEach(r => { if (r.realDate) visible[isoOf(r.realDate)] = r.dateLabel; });
        const missing = item.dates.filter(iso => !visible[iso]);
        const ready = findEditorTable() && missing.length === 0;

        bar.innerHTML =
            '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
              '<div style="font-weight:800;font-size:13px;color:' + C.accent + ';white-space:nowrap;">' +
                'Guiado ' + (st.idx + 1) + '/' + total + '</div>' +
              '<div style="flex:1;min-width:200px;line-height:1.45;">' +
                '<div style="font-weight:800;font-size:13px;">' + esc(item.login) + '</div>' +
                '<div style="font-size:11px;color:' + C.dim + ';">datas: ' + esc(datasBr) +
                  (missing.length ? ' · <span style="color:' + C.warn + ';">' + missing.length +
                                    ' fora do intervalo exibido</span>' : '') + '</div>' +
              '</div>' +
              '<div style="font-size:11px;color:' + C.dim + ';max-width:260px;line-height:1.4;">' +
                '<b style="color:' + C.text + ';">' + esc(GUIDED_STEPS[st.step] || st.step) + '</b></div>' +
              '<button id="atz-g-run" class="atz-btn" style="background:' + (ready ? C.accent : C.border) +
                ';color:' + (ready ? '#231f20' : C.dim) + ';"' + (ready ? '' : ' disabled') + '>Auto Ajuste Guiado</button>' +
              '<button id="atz-g-saved" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Já salvei</button>' +
              '<button id="atz-g-skip" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Pular</button>' +
              '<button id="atz-g-end" class="atz-btn" style="background:' + C.err + ';color:#fff;">Encerrar</button>' +
            '</div>' +
            '<div style="margin-top:6px;height:4px;background:' + C.border + ';border-radius:3px;overflow:hidden;">' +
              '<div style="width:' + Math.round(done / total * 100) + '%;height:100%;background:' + C.accent + ';"></div></div>';

        // Empurra o conteúdo da página para baixo, senão a barra cobre o cabeçalho
        // do AtoZ (inclusive o seletor de intervalo, que você precisa usar).
        document.body.style.paddingTop = bar.offsetHeight + 'px';

        bar.querySelector('#atz-g-run').onclick   = () => runGuidedAdjust();
        bar.querySelector('#atz-g-saved').onclick = () => advanceGuided('done');
        bar.querySelector('#atz-g-skip').onclick  = () => advanceGuided('skipped');
        bar.querySelector('#atz-g-end').onclick   = () => {
            if (confirm('Encerrar o modo guiado? O progresso é descartado.')) endGuided();
        };
    }

    function advanceGuided(status) {
        const st = loadGuided();
        if (!st) return;
        if (st.items[st.idx]) st.items[st.idx].status = status || 'done';
        st.idx++;
        st.step = 'navigate';
        st.saveClicked = false;
        if (st.idx >= st.items.length) {
            const ok = st.items.filter(x => x.status === 'done').length;
            saveGuided(null);
            removeGuidedBar();
            toast('Modo guiado concluído: ' + ok + '/' + st.items.length + ' salvos', 'ok');
            return;
        }
        saveGuided(st);
        guidedTick();
    }

    // Aplica o plano SOMENTE nas datas do arquivo.
    async function runGuidedAdjust() {
        const st = loadGuided();
        if (!st) return;
        const item = st.items[st.idx];
        const iso = {};
        item.dates.forEach(d => { iso[d] = true; });

        const plan = buildPlan(null, iso);
        if (!plan.rows.length) {
            const why = plan.skipped.length
                ? plan.skipped.map(s => s.dateLabel + ': ' + s.reason).join(' · ')
                : 'nenhuma das datas do arquivo precisa de ajuste';
            toast(item.login + ' — nada a ajustar. ' + why, 'warn');
            st.step = 'save';
            saveGuided(st);
            renderGuidedBar(st);
            return;
        }

        showPreview(plan);      // prévia obrigatória, igual ao fluxo normal
    }

    // Depois de aplicar, o guiado passa a esperar o Salvar
    function guidedAfterApply() {
        const st = loadGuided();
        if (!st) return;
        st.step = 'save';
        saveGuided(st);
        renderGuidedBar(st);
        toast('Revise e clique em "Salvar alterações". Quando a página recarregar, eu abro o próximo.', 'ok');
    }

    // Marca que o Salvar foi clicado. O reload seguinte confirma que subiu.
    function hookSaveButton() {
        const st = loadGuided();
        if (!st) return;
        const b = findSaveButton();
        if (!b || b.dataset.atzHooked) return;
        b.dataset.atzHooked = '1';
        b.addEventListener('click', () => {
            const s = loadGuided();
            if (!s) return;
            s.saveClicked = true;
            s.step = 'save';
            saveGuided(s);
        }, true);
    }

    let _guidedBusy = false;
    function guidedTick() {
        const st = loadGuided();
        if (!st) { removeGuidedBar(); return; }
        if (_guidedBusy) return;

        const item = st.items[st.idx];
        if (!item) { advanceGuided('done'); return; }

        // O reload depois do Salvar é a confirmação de que o ajuste subiu.
        if (st.step === 'save' && st.saveClicked) {
            _guidedBusy = true;
            advanceGuided('done');
            _guidedBusy = false;
            return;
        }

        const urlLogin = readLogin();
        if (!urlLogin || urlLogin.toLowerCase() !== item.login.toLowerCase()) {
            // Trava anti-loop: se a URL nunca casar com o login (login errado, ou a
            // rota usa outro identificador), navegar em círculo recarregaria a
            // página para sempre. Depois de algumas tentativas, pula o item.
            st.navTries = (st.navTries || 0) + 1;
            if (st.navTries > CONFIG.MAX_NAV_TRIES) {
                st.items[st.idx].note = 'não consegui abrir a página deste login';
                st.navTries = 0;
                saveGuided(st);
                toast('Pulei ' + item.login + ': não consegui abrir a página dele', 'err');
                advanceGuided('error');
                return;
            }
            st.step = 'navigate';
            saveGuided(st);
            renderGuidedBar(st);
            _guidedBusy = true;
            location.href = 'https://atoz.amazon.work/timecard/managerView/employeeDetails/' +
                            encodeURIComponent(item.login);
            return;
        }
        if (st.navTries) { st.navTries = 0; saveGuided(st); }   // chegou: zera a trava

        if (!findEditorTable()) {
            st.step = 'editor';
            saveGuided(st);
            renderGuidedBar(st);
            const link = findTimecardEditorLink();
            if (link) link.click();
            return;
        }

        st.step = (st.step === 'save') ? 'save' : (guidedDatesReady(item) ? 'adjust' : 'range');
        saveGuided(st);
        renderGuidedBar(st);
        hookSaveButton();
    }

    function guidedDatesReady(item) {
        const rows = parseRows();
        const visible = {};
        rows.forEach(r => { if (r.realDate) visible[isoOf(r.realDate)] = true; });
        return item.dates.every(iso => visible[iso]);
    }

    // Acha o link "Editor de cartão de ponto" por texto, não por XPath.
    function findTimecardEditorLink() {
        for (const a of document.querySelectorAll('a,button')) {
            const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^editor de cart[ãa]o de ponto$/i.test(t) || /^timecard editor$/i.test(t)) return a;
        }
        return null;
    }

    // ── Modal de importação ──────────────────────────────────────────────
    function showGuidedImport() {
        closeModal();
        injectCss();

        const modal = document.createElement('div');
        modal.id = CONFIG.MODAL_ID;
        modal.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;' +
            'justify-content:center;background:rgba(13,19,26,.66);backdrop-filter:blur(3px);' +
            'font-family:' + C.font + ';animation:atzFade .16s ease;';
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

        const box = document.createElement('div');
        box.style.cssText = 'background:' + C.panel + ';border:2px solid ' + C.accent + ';border-radius:16px;' +
            'width:95%;max-width:700px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;' +
            'box-shadow:0 24px 70px rgba(0,0,0,.6);animation:atzPop .22s cubic-bezier(.18,.9,.32,1.2);';

        box.innerHTML =
            '<div style="padding:13px 18px;border-bottom:1px solid ' + C.border + ';">' +
              '<div style="font-size:15px;font-weight:800;color:' + C.text + ';">Modo guiado</div>' +
              '<div style="font-size:11px;color:' + C.dim + ';margin-top:3px;line-height:1.5;">' +
                'Importe a lista de logins e datas. O script abre um associado por vez, abre o Editor, ' +
                'ajusta só as datas do arquivo e espera você salvar.</div></div>' +
            '<div style="flex:1;overflow-y:auto;padding:14px 18px;background:' + C.panelAlt + ';">' +
              '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">' +
                '<input type="file" id="atz-g-file" accept=".csv,.xlsx,.xls,.txt" ' +
                  'style="color:' + C.text + ';font-size:11px;font-family:' + C.font + ';">' +
              '</div>' +
              '<div style="font-size:10px;color:' + C.dim + ';margin-bottom:5px;">' +
                'ou cole aqui (login e data por linha, separados por vírgula, ponto e vírgula ou tab):</div>' +
              '<textarea id="atz-g-text" rows="7" placeholder="login,data&#10;jdoe,07/09/2026&#10;jdoe,08/09/2026&#10;msilva,08/09/2026" ' +
                'style="width:100%;box-sizing:border-box;background:' + C.panel + ';color:' + C.text + ';' +
                'border:1px solid ' + C.border + ';border-radius:8px;padding:8px 10px;font-family:monospace;font-size:12px;"></textarea>' +
              '<button id="atz-g-parse" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';margin-top:9px;">' +
                'Interpretar</button>' +
              '<div id="atz-g-preview" style="margin-top:12px;"></div>' +
            '</div>' +
            '<div style="padding:12px 18px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid ' + C.border + ';">' +
              '<button id="atz-g-cancel" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Cancelar</button>' +
              '<button id="atz-g-start" class="atz-btn" style="background:' + C.accent + ';color:#231f20;" disabled>Iniciar</button>' +
            '</div>';

        modal.appendChild(box);
        document.body.appendChild(modal);

        let parsed = null;
        const prev = box.querySelector('#atz-g-preview');
        const startBtn = box.querySelector('#atz-g-start');
        const year = (readWeekRange() || {}).year || new Date().getFullYear();

        function render(res) {
            parsed = res;
            const n = res.items.length;
            const totalDates = res.items.reduce((s, x) => s + x.dates.length, 0);
            let html = '<div style="font-size:11px;color:' + C.text + ';font-weight:700;margin-bottom:7px;">' +
                n + ' associado(s) · ' + totalDates + ' data(s)</div>';
            if (n) {
                html += '<table class="atz-tbl"><thead><tr><th>#</th><th>Login</th><th>Datas (dd/MM)</th></tr></thead><tbody>';
                res.items.forEach((it, i) => {
                    html += '<tr><td>' + (i + 1) + '</td><td style="font-family:monospace;">' + esc(it.login) + '</td><td>' +
                            esc(it.dates.map(brOf).join(', ')) + '</td></tr>';
                });
                html += '</tbody></table>' +
                    '<div style="font-size:10px;color:' + C.dim + ';margin-top:7px;line-height:1.5;">' +
                    'Datas ambíguas foram lidas como <b>dd/MM</b>. Confira acima antes de iniciar.</div>';
            }
            if (res.warnings.length) {
                html += '<div style="margin-top:9px;padding:7px 9px;border-radius:7px;background:rgba(230,168,23,.14);' +
                    'border:1px solid ' + C.warn + ';color:#ffd98a;font-size:10px;line-height:1.5;">' +
                    res.warnings.slice(0, 10).map(esc).join('<br>') +
                    (res.warnings.length > 10 ? '<br>… e mais ' + (res.warnings.length - 10) : '') + '</div>';
            }
            prev.innerHTML = html;
            startBtn.disabled = !n;
        }

        box.querySelector('#atz-g-parse').onclick = () => {
            const txt = box.querySelector('#atz-g-text').value;
            if (!txt.trim()) { toast('Cole a lista ou escolha um arquivo', 'warn'); return; }
            render(rowsToGuidedItems(parseCsvText(txt), year));
        };

        box.querySelector('#atz-g-file').onchange = ev => {
            const f = ev.target.files && ev.target.files[0];
            if (!f) return;
            const isXlsx = /\.xlsx?$/i.test(f.name);
            const rd = new FileReader();
            rd.onload = () => {
                try {
                    if (isXlsx) {
                        if (typeof XLSX === 'undefined') {
                            toast('Biblioteca XLSX não carregou. Salve o arquivo como CSV.', 'err');
                            return;
                        }
                        const wb = XLSX.read(new Uint8Array(rd.result), { type: 'array', cellDates: true });
                        const ws = wb.Sheets[wb.SheetNames[0]];
                        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
                        render(rowsToGuidedItems(matrix, year));
                    } else {
                        render(rowsToGuidedItems(parseCsvText(rd.result), year));
                    }
                } catch (e) {
                    toast('Não consegui ler o arquivo: ' + e.message, 'err');
                }
            };
            if (isXlsx) rd.readAsArrayBuffer(f); else rd.readAsText(f, 'UTF-8');
        };

        box.querySelector('#atz-g-cancel').onclick = closeModal;
        startBtn.onclick = () => {
            if (!parsed || !parsed.items.length) return;
            saveGuided({ active: true, items: parsed.items, idx: 0, step: 'navigate', saveClicked: false });
            closeModal();
            guidedTick();
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // PAINEL + BOTÕES POR LINHA
    // ─────────────────────────────────────────────────────────────────────
    function injectPanel() {
        if (document.getElementById(CONFIG.PANEL_ID)) return;
        injectCss();

        const panel = document.createElement('div');
        panel.id = CONFIG.PANEL_ID;
        panel.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147482000;background:' + C.panel + ';' +
            'border:2px solid ' + C.accent + ';border-radius:18px;padding:14px;display:none;flex-direction:column;gap:9px;' +
            'box-shadow:0 14px 36px rgba(0,0,0,.55);font-family:' + C.font + ';width:250px;' +
            'transition:transform .26s cubic-bezier(.18,.9,.32,1.2),opacity .2s ease;transform-origin:bottom left;';

        panel.innerHTML =
            '<div style="display:flex;align-items:center;gap:6px;">' +
                '<div style="flex:1;font-size:13px;font-weight:800;color:' + C.text + ';">Ajuste de Pontos</div>' +
                '<button id="atz-gear" class="atz-btn" title="Turnos e log" ' +
                    'style="background:' + C.border + ';color:' + C.text + ';padding:4px 8px;font-size:14px;">⚙</button>' +
                '<button id="atz-min" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';padding:4px 9px;">–</button>' +
            '</div>' +
            '<div id="atz-summary" style="background:' + C.panelAlt + ';border:1px solid ' + C.border + ';border-radius:10px;' +
                'padding:8px 10px;font-size:11px;color:' + C.dim + ';line-height:1.5;">lendo a tabela...</div>' +
            '<button id="atz-escala-toggle" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';' +
                'text-align:left;font-size:10px;padding:5px 9px;">▸ Escalas da semana</button>' +
            '<div id="atz-escala" style="display:none;background:' + C.panelAlt + ';border:1px solid ' + C.border + ';' +
                'border-radius:10px;padding:8px 10px;font-size:10px;color:' + C.dim + ';line-height:1.5;"></div>' +
            '<button id="atz-auto" class="atz-btn" style="background:' + C.accent + ';color:#231f20;">Auto ajuste da semana</button>' +
            '<button id="atz-week" class="atz-btn" style="background:' + C.border + ';color:' + C.text + ';">Analisar semana (prévia)</button>' +
            '<button id="atz-guide" class="atz-btn" style="background:' + C.info + ';color:#fff;">Modo guiado (lista)</button>' +
            '<div style="font-size:10px;color:' + C.dim + ';line-height:1.45;border-top:1px solid ' + C.border + ';padding-top:7px;">' +
                'As datas que precisam mudar ficam <b style="color:' + C.accent + ';">piscando</b> na tabela. ' +
                'Nunca clica em <b style="color:' + C.accent + ';">Salvar alterações</b>.</div>';

        const launcher = document.createElement('button');
        launcher.id = CONFIG.LAUNCHER_ID;
        launcher.title = 'Ajuste de Pontos — abrir painel';
        launcher.innerHTML = '⏱';
        launcher.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147482000;width:54px;height:54px;' +
            'border-radius:50%;background:linear-gradient(180deg,' + C.accentH + ' 0%,' + C.accent + ' 100%);color:#fff;' +
            'border:2px solid #fff;cursor:pointer;font-size:23px;display:flex;align-items:center;justify-content:center;' +
            'box-shadow:0 6px 18px rgba(0,0,0,.45);transition:transform .2s,opacity .2s;transform-origin:bottom left;';

        const show = () => {
            launcher.style.opacity = '0'; launcher.style.transform = 'scale(.35)';
            setTimeout(() => { launcher.style.display = 'none'; }, 170);
            panel.style.display = 'flex'; panel.style.opacity = '0'; panel.style.transform = 'scale(.2)';
            requestAnimationFrame(() => { panel.style.opacity = '1'; panel.style.transform = 'scale(1)'; });
            refreshSummary();
        };
        const hide = () => {
            panel.style.opacity = '0'; panel.style.transform = 'scale(.2)';
            setTimeout(() => { panel.style.display = 'none'; }, 230);
            launcher.style.display = 'flex'; launcher.style.opacity = '0'; launcher.style.transform = 'scale(.35)';
            requestAnimationFrame(() => { launcher.style.opacity = '1'; launcher.style.transform = 'scale(1)'; });
        };

        document.body.appendChild(panel);
        document.body.appendChild(launcher);

        launcher.onclick = show;
        panel.querySelector('#atz-min').onclick  = hide;
        panel.querySelector('#atz-gear').onclick = () => showSettings('turnos');
        panel.querySelector('#atz-week').onclick = () => showPreview(buildPlan(null));
        panel.querySelector('#atz-guide').onclick = () => {
            const st = loadGuided();
            if (st) {
                if (confirm('Já existe um guiado em andamento (' + (st.idx + 1) + '/' + st.items.length +
                            ').\nOK = continuar de onde parou · Cancelar = começar outro')) { guidedTick(); return; }
                endGuided();
            }
            showGuidedImport();
        };

        // Caixa de escalas fica RECOLHIDA por padrão; só abre se você pedir.
        const escToggle = panel.querySelector('#atz-escala-toggle');
        const escBox    = panel.querySelector('#atz-escala');
        escToggle.onclick = () => {
            const open = escBox.style.display === 'none';
            escBox.style.display = open ? 'block' : 'none';
            escToggle.textContent = (open ? '▾' : '▸') + ' Escalas da semana';
            gmSet(STORE.ESCALA_OPEN, open ? '1' : '0');
            if (open) refreshSummary();
        };
        if (gmGet(STORE.ESCALA_OPEN, '0') === '1') escToggle.onclick();

        // Auto ajuste de toda a semana, uma linha por vez.
        const autoBtn = panel.querySelector('#atz-auto');
        autoBtn.onclick = async () => {
            if (RUNNING) { toast('Já está rodando', 'warn'); return; }
            const plan = buildPlan(null);
            if (!plan.rows.length) {
                toast('Nenhum dia para ajustar. ' + plan.skipped.map(s => s.dateLabel + ': ' + s.reason).join(' · '), 'warn');
                return;
            }
            autoBtn.disabled = true;
            const label0 = autoBtn.textContent;
            autoBtn.textContent = 'Ajustando...';
            const rep = await applyPlan(plan, txt => { const s = document.getElementById('atz-summary'); if (s) s.textContent = txt; });
            autoBtn.disabled = false;
            autoBtn.textContent = label0;
            if (!rep) { toast('Já está rodando', 'warn'); return; }
            const parts = [rep.done + ' dia(s) com horas preenchidas'];
            if (rep.manualDates) parts.push(rep.manualDates + ' data(s) para clicar à mão (' + rep.rowsWithManual.join(', ') + ')');
            if (rep.failed) parts.push(rep.failed + ' com erro: ' + rep.errors.join(' | '));
            toast(parts.join(' · '), rep.failed ? 'err' : 'ok');
            runInjections();
        };
    }

    function refreshSummary() {
        const el = document.getElementById('atz-summary');
        if (!el) return;
        const rows = parseRows();
        if (!rows.length) { el.innerHTML = 'Editor de cartão de ponto não detectado nesta tela.'; return; }
        const plan = buildPlan(null);
        const unknown = plan.skipped.filter(s => /não mapeado/.test(s.reason)).length;
        const code = readShiftCode();
        const fam  = shiftFamily(code);
        const pend = document.querySelectorAll('[' + DATE_MARK_ATTR + ']').length;
        el.innerHTML =
            (code
                ? 'Turno <b style="color:' + C.accent + ';">' + esc(code) + '</b>' +
                  (fam ? ' <span style="color:' + C.dim + ';">(' + fam + ')</span>' : '') +
                  (SHIFT_CODES[code] ? '' : ' <span style="color:' + C.warn + ';">não mapeado</span>') + '<br>'
                : '<span style="color:' + C.warn + ';">código do turno não encontrado</span><br>') +
            '<b style="color:' + C.text + ';">' + rows.length + '</b> linha(s) · ' +
            '<b style="color:' + C.accent + ';">' + plan.rows.length + '</b> para ajustar · ' +
            plan.skipped.length + ' ignorada(s)' +
            (pend ? '<br><span style="color:' + C.accent + ';">' + pend + ' data(s) piscando para ajuste manual</span>' : '') +
            (unknown ? '<br><span style="color:' + C.warn + ';">' + unknown + ' turno(s) sem padrão — veja ⚙ Turnos</span>' : '');

        refreshEscalaBox(plan, code);
    }

    // Caixa da escala: diz QUAIS dias o Auto ajuste vai mexer, com a escala do dia.
    function refreshEscalaBox(plan, code) {
        const el = document.getElementById('atz-escala');
        if (!el || el.style.display === 'none') return;   // recolhida: não gasta trabalho
        const scale = shiftScale(code);
        const rows = parseRows();
        if (!rows.length) { el.innerHTML = ''; return; }

        const willTouch = {};
        (plan.rows || []).forEach(rp => { willTouch[rp.dateLabel] = rp; });

        const chip = (txt, color) => '<span style="display:inline-block;padding:1px 5px;border-radius:4px;' +
            'background:' + color + '22;color:' + color + ';font-weight:700;font-size:9px;">' + txt + '</span>';

        let html = '<div style="color:' + C.text + ';font-weight:700;margin-bottom:5px;">' +
            esc(scaleLabel(scale)) + '</div>';

        html += '<table style="width:100%;border-collapse:collapse;font-size:10px;">';
        for (const r of rows) {
            const e = escalaOf(r.realDate);
            const should = worksOn(code, r.realDate);
            const has = !r.noSched && !!r.schedRaw;
            const rp = willTouch[r.dateLabel];
            const nDates = rp ? rp.changes.filter(c => c.kind === 'data').length : 0;
            const nTimes = rp ? rp.changes.filter(c => c.kind === 'hora').length : 0;

            const escChip = e === 'azul' ? chip('azul', '#6aa9e0') : chip('vermelha', '#e06a6a');
            let acao;
            if (rp) acao = '<span style="color:' + C.accent + ';font-weight:700;">' + nTimes + 'h' +
                           (nDates ? ' +' + nDates + 'd' : '') + '</span>';
            else if (!has) acao = '<span style="color:' + C.dim + ';">folga</span>';
            else acao = '<span style="color:#7ee08a;">ok</span>';

            const alerta = (should !== null && should !== has)
                ? ' <span style="color:' + C.err + ';font-weight:700;" title="A escala e o cronograma da página discordam neste dia">!</span>'
                : '';

            html += '<tr>' +
                '<td style="color:' + C.text + ';white-space:nowrap;padding:1px 0;">' + esc(r.weekday || '') + ' ' + esc(r.dateLabel) + '</td>' +
                '<td style="padding:1px 4px;">' + escChip + '</td>' +
                '<td style="text-align:right;padding:1px 0;">' + acao + alerta + '</td>' +
            '</tr>';
        }
        html += '</table>';

        const diverge = rows.filter(r => {
            const s = worksOn(code, r.realDate);
            return s !== null && s !== (!r.noSched && !!r.schedRaw);
        }).length;
        html += '<div style="margin-top:5px;color:' + (diverge ? C.err : C.dim) + ';line-height:1.4;">' +
            (diverge ? diverge + ' dia(s) com escala divergindo do cronograma — ajuste a âncora em ⚙ Turnos'
                     : 'escala coerente com o cronograma da página') + '</div>';
        el.innerHTML = html;
    }

    // Botão por linha, na coluna Ações
    function injectRowButtons() {
        const table = findEditorTable();
        if (!table) return;
        const ctx = readContext();

        const trs = Array.from(table.querySelectorAll('tbody tr[data-test-component="StencilTableRow"]'));
        for (let idx = 0; idx < trs.length; idx++) {
            const tr  = trs[idx];
            const tds = tr.querySelectorAll('td');
            if (!tds.length) continue;
            const host = tds[tds.length - 1].querySelector('div') || tds[tds.length - 1];

            const row = parseRow(tr, idx, ctx);
            if (!row) continue;
            const p = planRow(row);

            // Cria ou ATUALIZA. Atualizar importa: você edita à mão, o estado da
            // linha muda, e um tooltip velho passaria informação errada.
            let btn = host.querySelector('.' + CONFIG.ROW_BTN_CLS);
            if (!btn) {
                btn = document.createElement('button');
                btn.className = CONFIG.ROW_BTN_CLS;
                btn.type = 'button';
                host.appendChild(btn);
            }

            // "Nada a fazer" também é estado inativo — sem isso o botão convidava
            // a abrir uma prévia vazia em dia que já está correto.
            const nothingToDo = !p.skip && !p.changes.length && p.fieldDelta === 0;

            // Quantas horas realmente mudam, e quantas datas ficarão manuais.
            const timeChanges = p.skip ? 0 : p.changes.filter(c => c.kind === 'hora').length;
            const dateChanges = p.skip ? 0 : p.changes.filter(c => c.kind === 'data').length;
            const nada = !p.skip && !timeChanges && p.fieldDelta === 0 && !dateChanges;

            if (p.skip || nada) {
                btn.textContent = '—';
                btn.title = p.skip ? ('Ignorado: ' + p.skip) : (row.dateLabel + ' já está correto');
                btn.disabled = true;
                btn.style.opacity = '.35';
                btn.style.cursor = 'not-allowed';
                btn.onclick = null;
            } else {
                btn.textContent = 'Auto ajuste';
                btn.disabled = false;
                btn.style.opacity = '';
                btn.style.cursor = 'pointer';
                btn.title = 'Preenche as horas de ' + row.dateLabel +
                            ' (' + p.mode + (row.patternSource ? ', ' + row.patternSource : '') + ')' +
                            (p.fieldDelta ? ' · ' + (p.fieldDelta > 0 ? 'insere ' : 'exclui ') + Math.abs(p.fieldDelta) / 2 + ' par(es)' : '') +
                            (p.dropped && p.dropped.length
                                ? ' · DESCARTA ' + p.dropped.map(d => d.time).join(', ') : '') +
                            (dateChanges ? ' · ' + dateChanges + ' data(s) ficam marcadas para você clicar' : '');
                btn.onclick = async e => {
                    e.preventDefault(); e.stopPropagation();
                    if (btn.disabled) return;
                    const label = row.dateLabel;
                    btn.disabled = true;
                    const original = btn.textContent;
                    btn.textContent = '...';
                    const r = await autoAdjustRow(label, txt => { btn.title = txt || ''; });
                    btn.textContent = r.ok ? 'OK' : 'Erro';
                    btn.title = r.msg || '';
                    toast((r.ok ? '' : 'Falhou em ') + label + ': ' + (r.msg || ''), r.ok ? 'ok' : 'err');
                    setTimeout(() => { btn.textContent = original; btn.disabled = false; runInjections(); }, 1800);
                };
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // DEBUG — para mandar o DOM quando algo não for encontrado
    // ─────────────────────────────────────────────────────────────────────
    // Valida os turnos configurados. Rode depois de editar horários em "Turnos":
    // pega typo, sequência fora de ordem e total que não fecha.
    function checkPatterns() {
        const out = [];
        for (const key in PATTERNS) {
            const p = PATTERNS[key];
            const t = p.times;
            const errs = [];

            if (t.length !== 4 && t.length !== 6) errs.push('precisa de 4 ou 6 horários, tem ' + t.length);
            if (t.some(x => timeToMins(x) < 0)) errs.push('horário inválido');

            let w = null;
            if (!errs.length) {
                const start = timeToMins(t[0]);
                const last  = timeToMins(t[t.length - 1]);
                const dur   = (last - start) <= 0 ? (last - start + 1440) : (last - start);
                const offs  = t.map(x => toShiftOffset(x, start, dur));

                // offsets têm de ser estritamente crescentes
                for (let i = 1; i < offs.length; i++) {
                    if (offs[i] <= offs[i - 1]) errs.push('offset não cresce em ' + t[i]);
                }
                // ida e volta hora → offset → hora precisa ser identidade
                offs.forEach((o, i) => {
                    const back = fromShiftOffset(o, start).time;
                    if (back !== t[i]) errs.push('ida-e-volta quebrou: ' + t[i] + ' → ' + back);
                });
                // a chave da Programação tem de casar com o primeiro/último horário
                const expectKey = t[0] + '-' + t[t.length - 1];
                if (expectKey !== key) errs.push('chave deveria ser ' + expectKey);

                w = computeWorked(t);
                const days = offs.map(o => fromShiftOffset(o, start).dayOffset);
                out.push({
                    turno: key, label: p.label, batidas: t.length,
                    trabalhado: w.workLabel, break: w.breakLabel,
                    diaSeguinte: days.filter(d => d === 1).length + ' de ' + days.length,
                    erros: errs.length ? errs.join('; ') : 'ok',
                });
                continue;
            }
            out.push({ turno: key, label: p.label, batidas: t.length, trabalhado: '-', break: '-', diaSeguinte: '-', erros: errs.join('; ') });
        }
        const bad = out.filter(r => r.erros !== 'ok');
        console.table(out);
        console.log(bad.length ? '[atz] ' + bad.length + ' turno(s) com problema' : '[atz] todos os turnos consistentes');
        return { rows: out, problems: bad.length };
    }

    window.__atzDebug = {
        check:    checkPatterns,
        rows:     () => { const r = parseRows(); console.table(r.map(x => ({
                      rotulo: x.dateLabel, dataReal: x.realDate ? x.realDate.toDateString() : '?',
                      fmtRotulo: x.labelFmt || '-', origem: x.dateSource,
                      turno: x.schedRaw, chave: x.schedKey, mapeado: !!x.pattern,
                      campos: x.count, horas: x.punches.join(' '),
                      datas: x.dates.join(' '), temMais: x.canAdd }))); return r; },

        // Mostra como os DOIS formatos de data da página foram resolvidos.
        // Use isto para confirmar que o script leu a semana certa.
        dates: () => {
            const ctx = readContext();
            const info = {
                semana: ctx.week ? (ctx.week.start.toDateString() + '  ano ' + ctx.week.year) : 'NAO ENCONTRADA (usando ano atual)',
                formatoBotao: BTN_FMT,
                botaoDetectado: ctx.btnFmt || 'sem evidência — usando default',
                votos_MMDD_vs_DDMM: ctx.btnVotes,
            };
            console.table(info);
            console.table(parseRows(ctx).map(r => ({
                rotulo: r.dateLabel,
                lidoComo: r.labelFmt || '-',
                dataReal: r.realDate ? r.realDate.toDateString() : '?',
                diaSemanaTela: r.weekday,
                confere: r.realDate && weekdayIndex(r.weekday) !== null
                         ? (r.realDate.getDay() === weekdayIndex(r.weekday) ? 'ok' : 'DIVERGE')
                         : 'sem dia da semana',
                origem: r.dateSource,
            })));
            return info;
        },
        plan:     (label) => { const p = buildPlan(label || null); console.log(p); return p; },
        patterns: () => PATTERNS,
        codes:    () => SHIFT_CODES,

        // Mostra a escala calculada para a semana em exibição e CONFERE contra os
        // dias que a página diz ter cronograma. Divergência aqui significa que a
        // âncora do ciclo precisa de ajuste (engrenagem → Turnos).
        escala: () => {
            const ctx  = readContext();
            const code = ctx.shiftCode;
            const scale = shiftScale(code);
            console.log('[atz] turno', code || '(não encontrado)', '·', scaleLabel(scale),
                        '· âncora do ciclo', loadAnchor().toDateString());
            const rows = parseRows(ctx);
            const tbl = rows.map(r => {
                const should = worksOn(code, r.realDate);
                const has = !r.noSched && !!r.schedRaw;
                return {
                    dia: r.dateLabel,
                    semana: r.weekday,
                    escalaDoDia: escalaOf(r.realDate),
                    deveTrabalhar: should === null ? '?' : (should ? 'sim' : 'não'),
                    temCronograma: has ? 'sim' : 'não',
                    confere: should === null ? '?' : (should === has ? 'ok' : 'DIVERGE'),
                };
            });
            console.table(tbl);
            const bad = tbl.filter(r => r.confere === 'DIVERGE').length;
            console.log(bad ? '[atz] ' + bad + ' dia(s) divergindo — confira a âncora do ciclo'
                            : '[atz] escala coerente com o cronograma da página');
            return tbl;
        },

        dumpMenu: () => {
            const found = [];
            document.querySelectorAll('div,span,li,button,a,p').forEach(el => {
                if (el.children.length) return;
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!t || t.length > 70) return;
                if (el.getBoundingClientRect().width < 4) return;
                if (/registros de ponto|registros intermedi|registros aproxim|punch/i.test(t)) found.push(t);
            });
            console.log('[atz] itens de menu visíveis:', found);
            return found;
        },
        log: loadLog,
    };

    // ─────────────────────────────────────────────────────────────────────
    // INIT — o URL não muda ao abrir o editor, então a detecção é por DOM
    // ─────────────────────────────────────────────────────────────────────
    let _obs = null, _debounce = null;

    function runInjections() {
        // O guiado roda ANTES da checagem da tabela: nas etapas de navegar e de
        // abrir o Editor a tabela ainda não existe, e é justamente aí que ele age.
        if (loadGuided()) guidedTick();
        if (!findEditorTable()) return;
        injectPanel();
        injectRowButtons();
        refreshDateMarks();   // apaga o destaque das datas que você já corrigiu
        if (document.getElementById(CONFIG.PANEL_ID) &&
            document.getElementById(CONFIG.PANEL_ID).style.display === 'flex') refreshSummary();
    }

    function startObserver() {
        if (_obs) return;
        const target = document.querySelector('main') || document.body;
        _obs = new MutationObserver(() => {
            if (RUNNING) return;               // não reinjeta no meio de uma aplicação
            if (_debounce) return;
            _debounce = setTimeout(() => { _debounce = null; runInjections(); }, 400);
        });
        _obs.observe(target, { childList: true, subtree: true });
    }

    // Detecção de rota SPA (padrão do Factorum v6): patch em history + popstate.
    // Ao trocar de associado, remove o que foi injetado e reinjeta.
    (function patchHistory() {
        if (window._atzHistoryPatched) return;
        window._atzHistoryPatched = true;
        const push = history.pushState, replace = history.replaceState;
        history.pushState = function () { const r = push.apply(this, arguments); window.dispatchEvent(new Event('atz:locationchange')); return r; };
        history.replaceState = function () { const r = replace.apply(this, arguments); window.dispatchEvent(new Event('atz:locationchange')); return r; };
        window.addEventListener('popstate', () => window.dispatchEvent(new Event('atz:locationchange')));
    })();

    let lastUrl = location.href;
    window.addEventListener('atz:locationchange', () => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        closeModal();
        document.querySelectorAll('#' + CONFIG.PANEL_ID + ', #' + CONFIG.LAUNCHER_ID + ', .' + CONFIG.ROW_BTN_CLS)
                .forEach(el => el.remove());
        setTimeout(runInjections, 600);
    });

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });

    function init() {
        if (!document.body) { setTimeout(init, 300); return; }
        PATTERNS = loadPatterns();
        SHIFT_CODES = loadCodes();
        runInjections();
        startObserver();
        // O guiado depende do reload pós-Salvar, então é reavaliado a cada carga
        // e também um pouco depois, quando a SPA termina de montar a tela.
        if (loadGuided()) { setTimeout(guidedTick, 1200); setTimeout(guidedTick, 3000); }
        console.log('[atz] AtoZ Timecard — Ajuste de Pontos v1.0 ativo. Debug: window.__atzDebug');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
