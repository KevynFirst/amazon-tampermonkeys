// ==UserScript==
// @name         Learning Hours - FCLM Overlay
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Overlay fixo na página functionRollup do FCLM (GRU5): mostra as horas de Learning/Onboarding por associado — quem está acima do limite de horas e quem precisa ser logado em outra função. Filtro por horas, por gestor, exportação CSV e envio ao Slack. Versão só-visibilidade (sem checklist), para quem não é do time de Learning.
// @author       caramigo
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/functionRollup*
// @run-at       document-idle
// @connect      fclm-portal.amazon.com
// @connect      hooks.slack.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==
//
// OBJETIVO: dar visibilidade das horas de Learning/Onboarding a QUALQUER pessoa
// (não só ao time de Learning). É a extração do "overlay fixo do function" do
// userscript "Minichecklist Learning", sem o mini-checklist do turno.
//
(function () {
    'use strict';
    if (window.top !== window.self) return;          // não roda dentro de iframes
    if (document.getElementById('lh-bar')) return;    // evita dupla injeção

    const C = {
        dark: '#232F3E', darker: '#131921', hover: '#37475A', accent: '#FF9900',
        gold: '#FEBD69', blue: '#4A86C8', blueHours: '#0B4F8A', grey: '#607D8B', red: '#CC0000',
        amber: '#E88B00', green: '#27AE60', white: '#FFFFFF', light: '#F7F7F7', border: '#E8E8E8',
        headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
        btnGrad: 'linear-gradient(145deg,#37475A 0%,#232F3E 100%)',
        btnGradH: 'linear-gradient(145deg,#4A5D72 0%,#37475A 100%)',
        bodyBg: '#EEF1F4',
    };
    const POSKEY = 'lh_panel_pos';
    const FCLM_ORIGIN = 'https://fclm-portal.amazon.com';

    function gmGet(k, d) { try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : (localStorage.getItem(k) ?? d); } catch (e) { return d; } }
    function gmSet(k, v) { try { (typeof GM_setValue === 'function') ? GM_setValue(k, v) : localStorage.setItem(k, v); } catch (e) {} }

    const WAREHOUSE = 'GRU5';
    const ONB_PROCESS = '1002986';     // relatório de Onboarding
    const LEARN_PROCESS = '1002960';   // relatório de Learning
    const ICQA_PROCESS = '1003030';    // relatório de ICQA (ICQA Ambassador + ICQA Training)
    const LEARN_FN = '4300006689';     // função "Learning"
    const REPORT_LINK = 'https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=HTML&warehouseId=GRU5&processId=1002986';
    // Funções permitidas e limites saem de TRAININGS (fonte única, definida mais abaixo).
    function isAllowedTraining(t) { return !!cfgOf(t); }
    function isLearning(t) { return t.fnId === LEARN_FN; }
    // Filtro de funções: SEMPRE só as funções que precisamos.
    function passFilter(t) { return isAllowedTraining(t); }
    // Está na página do relatório functionRollup do FCLM?
    function onFclmReport() { return /^https?:\/\/fclm-portal\.amazon\.com\/reports\/functionRollup/i.test(location.href); }

    // Único filtro alternável: limitar por horas OU mostrar todos.
    const LIMIT_KEY = 'lh_limit_by_hours';
    let limitByHours = gmGet(LIMIT_KEY, '0') === '1';   // padrão: mostrar tudo
    function setLimitByHours(on) { limitByHours = !!on; gmSet(LIMIT_KEY, limitByHours ? '1' : '0'); }
    function limitLabel() { return limitByHours ? '⏱️ Limitar por horas' : '📋 Mostrar todos'; }
    function listTitle() { return limitByHours ? 'Acima em hora' : 'Todos (horas logadas)'; }

    // Lê o filtro atual do formulário "Function Rollup" da página (Report Date Range,
    // Warehouse, spanType Day/Week/Month/Intraday + datas/horas) e devolve os params.
    // Assim o overlay respeita exatamente o que o usuário selecionou na tela.
    function pageFilterParams() {
        const form = document.querySelector('form.cp-form') || document.querySelector('form[action*="functionRollup"]');
        if (!form) return null;
        let p;
        try { p = new URLSearchParams(new FormData(form)); } catch (e) { return null; }
        // spanType precisa estar definido para a busca fazer sentido.
        if (!p.get('spanType')) return null;
        return p;
    }
    // Janela padrão (fallback): intraday do turno atual, caso o formulário não seja lido.
    function fallbackParams(processId) {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const fmt = d => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
        let startD, endD, sH, sM, eH, eM;
        if (mins >= 330 && mins < 1080) {          // DIA: hoje 05:30 → hoje 18:00
            startD = day0; endD = day0; sH = 5; sM = 30; eH = 18; eM = 0;
        } else if (mins >= 1080) {                 // NOITE (começou hoje): hoje 18:00 → amanhã 05:30
            startD = day0; endD = new Date(day0); endD.setDate(day0.getDate() + 1); sH = 18; sM = 0; eH = 5; eM = 30;
        } else {                                   // MADRUGADA (<05:30): ontem 18:00 → hoje 05:30
            startD = new Date(day0); startD.setDate(day0.getDate() - 1); endD = day0; sH = 18; sM = 0; eH = 5; eM = 30;
        }
        const dayDiff = Math.round((endD - startD) / 86400000);
        const p = new URLSearchParams();
        p.set('warehouseId', WAREHOUSE);
        p.set('maxIntradayDays', String(dayDiff + 1)); p.set('spanType', 'Intraday');
        p.set('startDateIntraday', fmt(startD)); p.set('startHourIntraday', String(sH)); p.set('startMinuteIntraday', String(sM));
        p.set('endDateIntraday', fmt(endD)); p.set('endHourIntraday', String(eH)); p.set('endMinuteIntraday', String(eM));
        return p;
    }
    // ── Estado lembrado ──────────────────────────────────────────────────
    const OPEN_KEY = 'lh_open';            // painel aberto/fechado
    const ACTIVE_TAB_KEY = 'lh_active_tab';// aba ativa (hora/tot)
    // ── Filtro de janela selecionável (Dia / Noite / Dia todo + data) ────
    const FILTER_KEY = 'lh_window_filter';
    function pad2(n) { return String(n).padStart(2, '0'); }
    function ymdSlash(d) { return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()); }
    function ymdDash(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function loadFilter() { try { const s = gmGet(FILTER_KEY, ''); if (s) return JSON.parse(s); } catch (e) {} return { mode: 'day', date: ymdDash(new Date()) }; }
    function saveFilter(f) { gmSet(FILTER_KEY, JSON.stringify(f)); }
    let currentFilter = loadFilter();
    const modeLabel = m => m === 'night' ? '🌙 Noite' : (m === 'full' ? '🗓️ Dia todo' : (m === 'd6to5' ? '🕕 06→05' : '☀️ Dia'));
    function buildWindowParams(f) {
        const parts = String(f.date || '').split('-').map(Number);
        const base = (parts.length === 3 && !parts.some(isNaN)) ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
        const next = new Date(base); next.setDate(base.getDate() + 1);
        const p = new URLSearchParams();
        p.set('warehouseId', WAREHOUSE);
        if (f.mode === 'full') {                       // Dia todo: 00:00 → 00:00 (spanType=Day)
            p.set('spanType', 'Day');
            p.set('startDate', ymdDash(base) + 'T00:00:00.000');
            p.set('endDate', ymdDash(next) + 'T00:00:00.000');
        } else if (f.mode === 'night') {               // Noite: 18:00 → 05:30 do dia seguinte
            p.set('maxIntradayDays', '2'); p.set('spanType', 'Intraday');
            p.set('startDateIntraday', ymdSlash(base)); p.set('startHourIntraday', '18'); p.set('startMinuteIntraday', '0');
            p.set('endDateIntraday', ymdSlash(next)); p.set('endHourIntraday', '5'); p.set('endMinuteIntraday', '30');
        } else if (f.mode === 'd6to5') {               // 06:00 do dia ANTERIOR → 05:00 do dia selecionado
            const prev = new Date(base); prev.setDate(base.getDate() - 1);
            p.set('maxIntradayDays', '2'); p.set('spanType', 'Intraday');
            p.set('startDateIntraday', ymdSlash(prev)); p.set('startHourIntraday', '6'); p.set('startMinuteIntraday', '0');
            p.set('endDateIntraday', ymdSlash(base)); p.set('endHourIntraday', '5'); p.set('endMinuteIntraday', '0');
        } else {                                       // Dia: 05:30 → 18:00
            p.set('maxIntradayDays', '1'); p.set('spanType', 'Intraday');
            p.set('startDateIntraday', ymdSlash(base)); p.set('startHourIntraday', '5'); p.set('startMinuteIntraday', '30');
            p.set('endDateIntraday', ymdSlash(base)); p.set('endHourIntraday', '18'); p.set('endMinuteIntraday', '0');
        }
        return p;
    }
    // Texto de pré-visualização da janela resultante (ex.: "19/07 06:00 → 20/07 05:00").
    function windowPreviewText(f) {
        const parts = String(f.date || '').split('-').map(Number);
        const base = (parts.length === 3 && !parts.some(isNaN)) ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
        const next = new Date(base); next.setDate(base.getDate() + 1);
        const prev = new Date(base); prev.setDate(base.getDate() - 1);
        const dm = d => pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
        const hm = (h, m) => pad2(h) + ':' + pad2(m);
        let sD, sH, sM, eD, eH, eM;
        if (f.mode === 'full') { sD = base; sH = 0; sM = 0; eD = next; eH = 0; eM = 0; }
        else if (f.mode === 'night') { sD = base; sH = 18; sM = 0; eD = next; eH = 5; eM = 30; }
        else if (f.mode === 'd6to5') { sD = prev; sH = 6; sM = 0; eD = base; eH = 5; eM = 0; }
        else { sD = base; sH = 5; sM = 30; eD = base; eH = 18; eM = 0; }
        return dm(sD) + ' ' + hm(sH, sM) + ' → ' + dm(eD) + ' ' + hm(eH, eM);
    }
    function reportUrl(processId) {
        const p = buildWindowParams(currentFilter);
        p.set('reportFormat', 'HTML');
        p.set('processId', processId || ONB_PROCESS);
        return FCLM_ORIGIN + '/reports/functionRollup?' + p.toString();
    }
    // Qual relatório contém o treinamento (Learning tem processId próprio).
    function processForTitle(title) { return procOf(title).processId; }
    function fetchOne(processId, cb) {
        GM_xmlhttpRequest({
            method: 'GET', url: reportUrl(processId),
            onload: res => { try { cb((res.status >= 200 && res.status < 300) ? new DOMParser().parseFromString(res.responseText, 'text/html') : null); } catch (e) { cb(null); } },
            onerror: () => cb(null),
        });
    }
    // Busca os relatórios de Onboarding e Learning, combinando, e também lê a tela atual.
    function fetchReport(cb) {
        const targets = PROCESSES.filter(p => p.processId).map(p => p.processId);
        let done = 0, errs = 0, trainings = [];
        const finish = () => {
            if (done < targets.length) return;
            // NÃO mistura a tabela da própria página: usa só a janela buscada (filtro).
            trainings = mergeTrainings(trainings);
            if (errs === targets.length) { cb(null, 'Falha de conexão'); return; }
            cb(buildReportFrom(trainings), null);   // pode vir vazio → tratado como 0
        };
        targets.forEach(pid => fetchOne(pid, doc => {
            if (doc) { try { trainings = trainings.concat(parseFunctionTables(doc).filter(passFilter)); } catch (e) {} }
            else errs++;
            done++; finish();
        }));
    }
    function injectUICss() {
        if (document.getElementById('lh-ui-css')) return;
        const st = document.createElement('style'); st.id = 'lh-ui-css';
        st.textContent = '@keyframes lhFade{from{opacity:0}to{opacity:1}}@keyframes lhPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}@keyframes lhRise{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:none}}';
        (document.head || document.documentElement).appendChild(st);
    }
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function nameLink(name, link) { return link ? '<a href="' + esc(link) + '" target="_blank" style="color:' + C.blue + ';text-decoration:none;font-weight:700;">' + esc(name) + '</a>' : '<strong>' + esc(name) + '</strong>'; }
    function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

    function findTitleForTable(table, rows, headerIdx) {
        for (let i = 0; i < headerIdx; i++) { const m = clean(rows[i].textContent).match(/(.+?)\s*\[(\d{4,})\]/); if (m) return { title: clean(m[1]), fnId: m[2] }; }
        if (table.caption) { const m = clean(table.caption.textContent).match(/(.+?)\s*\[(\d{4,})\]/); if (m) return { title: clean(m[1]), fnId: m[2] }; }
        let el2 = table;
        for (let i = 0; i < 4 && el2; i++) { el2 = el2.previousElementSibling; if (el2) { const m = clean(el2.textContent).match(/(.+?)\s*\[(\d{4,})\]/); if (m) return { title: clean(m[1]), fnId: m[2] }; } }
        return null;
    }
    function parseFunctionTables(doc) {
        const out = [];
        doc.querySelectorAll('table').forEach(table => {
            const rows = [...table.querySelectorAll('tr')];
            let headerIdx = -1; const cols = {};
            for (let i = 0; i < rows.length; i++) {
                const cells = [...rows[i].querySelectorAll('th,td')];
                const texts = cells.map(c => clean(c.textContent).toLowerCase());
                const nameI = texts.indexOf('name');
                const mgrI = texts.findIndex(t => t.startsWith('manager'));
                if (nameI >= 0 && mgrI >= 0) {
                    headerIdx = i;
                    texts.forEach((t, idx) => {
                        if (t === 'name') cols.name = idx;
                        else if (t.startsWith('manager')) cols.manager = idx;
                        else if (t === 'id') cols.id = idx;
                        else if (t === 'type') cols.type = idx;
                        else if (t === 'total') cols.total = idx;
                    });
                    break;
                }
            }
            if (headerIdx < 0) return;
            const info = findTitleForTable(table, rows, headerIdx) || { title: 'Sem título', fnId: '' };
            const people = [];
            for (let i = headerIdx + 1; i < rows.length; i++) {
                const cells = [...rows[i].querySelectorAll('td,th')];
                if (cells.length < 3) continue;
                const name = cols.name != null ? clean(cells[cols.name] && cells[cols.name].textContent) : '';
                if (!name || /^(total|small|medium|large|heavybulky)$/i.test(name)) continue;
                const id = cols.id != null ? clean(cells[cols.id] && cells[cols.id].textContent) : '';
                if (cols.id != null && !/^\d+$/.test(id)) continue;
                const manager = cols.manager != null ? clean(cells[cols.manager] && cells[cols.manager].textContent) : '';
                // As horas ficam na coluna "Paid Hours → Total" (1ª célula com classe
                // "size-total highlighted"). A última célula pode ser UPH de produção, não a hora.
                let totalCell = cells.find(c => c.classList && c.classList.contains('size-total') && c.classList.contains('highlighted'));
                if (!totalCell) totalCell = cells[cells.length - 1];
                const total = parseFloat(((totalCell && totalCell.textContent) || '').replace(',', '.'));
                const aEl = (cols.name != null && cells[cols.name] && cells[cols.name].querySelector('a[href]'))
                    || (cols.id != null && cells[cols.id] && cells[cols.id].querySelector('a[href]'));
                let link = aEl ? (aEl.getAttribute('href') || '') : '';
                if (link && link.startsWith('/')) link = FCLM_ORIGIN + link;
                people.push({ name, id, manager, total: isNaN(total) ? null : total, link });
            }
            if (people.length) out.push({ title: info.title, fnId: info.fnId, people });
        });
        return out;
    }
    function mergeTrainings(trainings) {
        const map = new Map();
        trainings.forEach(t => {
            const key = t.fnId || t.title;
            if (!map.has(key)) map.set(key, { title: t.title, fnId: t.fnId, _p: new Map() });
            const agg = map.get(key);
            if (!agg.title || agg.title === 'Sem título') agg.title = t.title;
            t.people.forEach(p => {
                const pk = p.id || p.name.toLowerCase();
                const prev = agg._p.get(pk);
                if (!prev || (p.total != null && (prev.total == null || p.total > prev.total))) agg._p.set(pk, p);
            });
        });
        return [...map.values()].map(a => ({ title: a.title, fnId: a.fnId, people: [...a._p.values()] }));
    }
    function buildReportFrom(trainings) {
        const titles = trainings.map(t => t.title);
        const peopleMap = {};
        trainings.forEach(t => t.people.forEach(p => {
            const key = p.id || p.name.toLowerCase();
            if (!peopleMap[key]) peopleMap[key] = { name: p.name, id: p.id, manager: p.manager, link: p.link, inset: new Set() };
            peopleMap[key].inset.add(t.title);
        }));
        const allPeople = Object.values(peopleMap).sort((a, b) => a.name.localeCompare(b.name));
        return { trainings, titles, allPeople };
    }
    const DEFAULT_LIMIT = 1;
    // Processos (abas de "Mais detalhes"): agrupam os treinamentos.
    const PROCESSES = [
        { key: 'onb',  name: 'On Boarding', processId: ONB_PROCESS },
        { key: 'adm',  name: 'Admin/HR/IT', processId: LEARN_PROCESS },
        { key: 'icqa', name: 'ICQA',        processId: ICQA_PROCESS },
        { key: 'cret', name: 'C-Returns',   processId: '1003058' },
        { key: 'sort', name: 'Sort',        processId: '1003050' },
        { key: 'pick', name: 'Pick',        processId: '1003049' },
        { key: 'pack', name: 'Pack',        processId: '1002994' },
        { key: 'ship', name: 'Ship',        processId: '1720696536911' },
        { key: 'stow', name: 'Stow',        processId: '1003017' },
        { key: 'tin',  name: 'Transfer In', processId: '1003020' },
        { key: 'recv', name: 'Receive',     processId: '1003033' },
        { key: 'vret', name: 'V-Returns',   processId: '1003059' },
        { key: 'prep', name: 'Prep',        processId: '1003048' },
        { key: 'badge', name: 'Ajuste de Badge', virtual: true },   // derivado (>12h), sem processId próprio
    ];
    function procOf(t) { const c = cfgOf(t); const key = c ? c.proc : 'onb'; return PROCESSES.find(p => p.key === key) || PROCESSES[0]; }
    // Limite de horas POR TREINAMENTO (negócio). Cada um é configurável e salvo separadamente.
    // On Boarding = FC Safety Tour + General FC Training + Safety School · Admin/HR/IT = Learning.
    const TRAININGS = [
        { fnId: '4300018945', re: /fc safety tour/i, name: 'FC Safety Tour', proc: 'onb', limitKey: 'lh_lim_fcsafetytour', defLimit: 1 },
        { fnId: '4300006671', re: /general fc training|fc training/i, name: 'General FC Training', proc: 'onb', limitKey: 'lh_lim_fctraining', defLimit: 9 },
        { fnId: '4300018942', re: /safety school/i, name: 'Safety School', proc: 'onb', limitKey: 'lh_lim_safetyschool', defLimit: 2 },
        { re: /ambassador coaching/i, name: 'Ambassador Coaching', proc: 'onb', limitKey: 'lh_lim_ambassador', defLimit: 1 },
        { re: /icqa ambassador/i, name: 'ICQA Ambassador', proc: 'icqa', limitKey: 'lh_lim_icqaamb', defLimit: 11 },
        { re: /icqa training/i, name: 'ICQA Training', proc: 'icqa', limitKey: 'lh_lim_icqatrn', defLimit: 4 },
        { re: /c-?returns ambassador/i, name: 'C-Returns Ambassador', proc: 'cret', limitKey: 'lh_lim_cretamb', defLimit: 11 },
        { re: /c-?returns training/i, name: 'C-Returns Training', proc: 'cret', limitKey: 'lh_lim_crettrn', defLimit: 4 },
        { re: /sort ambassador/i, name: 'Sort Ambassador', proc: 'sort', limitKey: 'lh_lim_sortamb', defLimit: 11 },
        { re: /sort training/i, name: 'Sort Training', proc: 'sort', limitKey: 'lh_lim_sorttrn', defLimit: 4 },
        { re: /pick ambassador/i, name: 'Pick Ambassador', proc: 'pick', limitKey: 'lh_lim_pickamb', defLimit: 11 },
        { re: /pick training/i, name: 'Pick Training', proc: 'pick', limitKey: 'lh_lim_picktrn', defLimit: 4 },
        { re: /pack ambassador/i, name: 'Pack Ambassador', proc: 'pack', limitKey: 'lh_lim_packamb', defLimit: 11 },
        { re: /pack training/i, name: 'Pack Training', proc: 'pack', limitKey: 'lh_lim_packtrn', defLimit: 4 },
        { re: /ship ambassador/i, name: 'Ship Ambassador', proc: 'ship', limitKey: 'lh_lim_shipamb', defLimit: 11 },
        { re: /ship training/i, name: 'Ship Training', proc: 'ship', limitKey: 'lh_lim_shiptrn', defLimit: 4 },
        { re: /stow ambassador/i, name: 'Stow Ambassador', proc: 'stow', limitKey: 'lh_lim_stowamb', defLimit: 11 },
        { re: /stow prime training|stow training/i, name: 'Stow Prime Training', proc: 'stow', limitKey: 'lh_lim_stowtrn', defLimit: 4 },
        { re: /transfer in amb/i, name: 'Transfer In Ambssdr', proc: 'tin', limitKey: 'lh_lim_tinamb', defLimit: 11 },
        { re: /transfer in training/i, name: 'Transfer In Training', proc: 'tin', limitKey: 'lh_lim_tintrn', defLimit: 4 },
        { re: /ib dock ambassador/i, name: 'IB Dock Ambassador', proc: 'recv', limitKey: 'lh_lim_ibdockamb', defLimit: 11 },
        { re: /receive ambassador/i, name: 'Receive Ambassador', proc: 'recv', limitKey: 'lh_lim_recvamb', defLimit: 11 },
        { re: /receive training/i, name: 'Receive Training', proc: 'recv', limitKey: 'lh_lim_recvtrn', defLimit: 4 },
        { re: /v-?returns ambassador/i, name: 'V-Returns Ambassador', proc: 'vret', limitKey: 'lh_lim_vretamb', defLimit: 11 },
        { re: /v-?returns training/i, name: 'V-Returns Training', proc: 'vret', limitKey: 'lh_lim_vrettrn', defLimit: 4 },
        { re: /prep ambassador/i, name: 'Prep Ambassador', proc: 'prep', limitKey: 'lh_lim_prepamb', defLimit: 11 },
        { re: /prep training/i, name: 'Prep Training', proc: 'prep', limitKey: 'lh_lim_preptrn', defLimit: 4 },
        { fnId: LEARN_FN, exact: true, name: 'Learning', proc: 'adm', limitKey: 'lh_lim_learning', defLimit: 1 },  // só pelo fnId exato
    ];
    // Casa por fnId exato (quando definido) ou por regex do título (a menos que exact:true).
    function cfgOf(t) { const fnId = t && t.fnId; const title = (t && t.title) || (typeof t === 'string' ? t : ''); return TRAININGS.find(c => (c.fnId && fnId && fnId === c.fnId) || (!c.exact && c.re && c.re.test(title)) || (c.exact && title && title.toLowerCase() === c.name.toLowerCase())) || null; }
    function trainingLimit(c) { const v = parseFloat(String(gmGet(c.limitKey, String(c.defLimit))).replace(',', '.')); return isNaN(v) ? c.defLimit : v; }
    function setTrainingLimit(c, v) { gmSet(c.limitKey, String(v)); }
    // Treinamentos esperados para a aba "Horas totais" (mostra 0 se não vier no relatório).
    const procIdOf = key => { const p = PROCESSES.find(x => x.key === key); return p ? p.processId : ONB_PROCESS; };
    // Treinamentos esperados na aba "Horas totais" (derivados da fonte única; zerados somem).
    const EXPECTED_TOTALS = TRAININGS.map(c => ({ re: c.exact ? new RegExp('^' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') : c.re, name: c.name, process: procIdOf(c.proc) }));
    function getLimit(t) { const c = cfgOf(t); return c ? trainingLimit(c) : DEFAULT_LIMIT; }
    function limitsDesc() { return TRAININGS.map(c => c.name + ' > ' + trainingLimit(c) + 'h').join(' · '); }
    // ── Ajuste de Badge: quem passou do limite (padrão 12h), derivado dos dados ──
    const BADGE_KEY = 'lh_lim_badge';
    function badgeLimit() { const v = parseFloat(String(gmGet(BADGE_KEY, '12')).replace(',', '.')); return isNaN(v) ? 12 : v; }
    function setBadgeLimit(v) { gmSet(BADGE_KEY, String(v)); }
    function badgeEntries(r) {
        const byP = {};
        r.trainings.forEach(t => { const pr = procOf(t); t.people.forEach(p => { if (p.total != null && p.total > badgeLimit()) { const k = p.id || p.name.toLowerCase(); if (!byP[k] || p.total > byP[k].total) byP[k] = { name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, procName: pr.name, total: p.total }; } }); });
        return Object.values(byP).sort((a, b) => b.total - a.total);
    }
    function badgeTag(total) { return (total != null && total > badgeLimit()) ? ' <span style="background:' + C.red + ';color:#fff;font-size:11px;font-weight:800;padding:1px 7px;border-radius:10px;margin-left:4px;">🪪 ajuste de badge</span>' : ''; }
    // Registra no menu do Tampermonkey um comando por treinamento para configurar o limite de horas.
    let _menuRegistered = false;
    function registerMenu() {
        if (_menuRegistered || typeof GM_registerMenuCommand !== 'function') return;
        _menuRegistered = true;
        TRAININGS.forEach(c => {
            GM_registerMenuCommand('⏱️ Limite ' + c.name + ' (atual: ' + trainingLimit(c) + 'h)', () => {
                const cur = trainingLimit(c);
                const ans = prompt('Limite de horas para "' + c.name + '"\n(acima desse valor o associado é sinalizado):', String(cur));
                if (ans == null) return;
                const n = parseFloat(String(ans).replace(',', '.'));
                if (isNaN(n) || n < 0) { alert('❌ Valor inválido. Use um número, ex.: 2 ou 1.5'); return; }
                setTrainingLimit(c, n);
                alert('✅ Limite de "' + c.name + '" definido para ' + n + 'h.\nAtualize/reabra o painel para refletir.');
            });
        });
        GM_registerMenuCommand('🪪 Limite Ajuste de Badge (atual: ' + badgeLimit() + 'h)', () => {
            const ans = prompt('Ajuste de Badge — acima de quantas horas sinalizar:', String(badgeLimit()));
            if (ans == null) return;
            const n = parseFloat(String(ans).replace(',', '.'));
            if (isNaN(n) || n < 0) { alert('❌ Valor inválido.'); return; }
            setBadgeLimit(n);
            alert('✅ Ajuste de Badge definido para ' + n + 'h.\nAtualize/reabra o painel para refletir.');
        });
    }
    function computeExceeding(trainings) {
        const list = [];
        trainings.forEach(t => { const lim = getLimit(t); t.people.forEach(p => { if (p.total != null && (!limitByHours || p.total > lim)) list.push({ name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, total: p.total, limit: lim }); }); });
        return list.sort((a, b) => (b.total - b.limit) - (a.total - a.limit));
    }
    function allManagers(trainings) { const s = new Set(); trainings.forEach(t => t.people.forEach(p => { if (p.manager) s.add(p.manager); })); return [...s].sort((a, b) => a.localeCompare(b)); }
    function filterByManager(r, mgr) {
        if (!mgr || mgr === '__all__') return r;
        const trainings = r.trainings.map(t => ({ ...t, people: t.people.filter(p => p.manager === mgr) }));
        const peopleMap = {};
        trainings.forEach(t => t.people.forEach(p => { const key = p.id || p.name.toLowerCase(); if (!peopleMap[key]) peopleMap[key] = { name: p.name, id: p.id, manager: p.manager, link: p.link, inset: new Set() }; peopleMap[key].inset.add(t.title); }));
        const allPeople = Object.values(peopleMap).sort((a, b) => a.name.localeCompare(b.name));
        return { trainings, titles: r.titles, allPeople, manager: mgr };
    }
    function groupByManager(items, getMgr) { const by = {}; items.forEach(it => { const m = getMgr(it) || 'Sem gestor'; (by[m] = by[m] || []).push(it); }); return by; }
    // Filtra o relatório por processo (aba do "Mais detalhes").
    function filterByProcess(r, procKey) {
        const trainings = r.trainings.filter(t => procOf(t).key === procKey);
        const fr = buildReportFrom(trainings);
        fr.manager = r.manager;
        return fr;
    }
    function compareTitles(r) {
        const learn = new Set(r.trainings.filter(t => t.fnId === LEARN_FN || isLearning(t)).map(t => t.title));
        return r.titles.filter(tt => !learn.has(tt));
    }

    // ── Exportação CSV (1 linha por associado) ───────────────────────────
    function personKey(p) { return p.id || p.name.toLowerCase(); }
    function buildCsv(r) {
        const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const titles = r.titles;
        const header = ['Nome', 'ID', 'Manager'].concat(titles).concat(['Acima do limite']);
        const lines = [header.map(q).join(',')];
        r.allPeople.forEach(p => {
            const key = personKey(p);
            const hoursByTitle = {}; const acima = [];
            r.trainings.forEach(t => {
                const pp = t.people.find(x => personKey(x) === key);
                if (pp) { hoursByTitle[t.title] = pp.total; if (pp.total != null && pp.total > getLimit(t)) acima.push(t.title + ' (' + pp.total.toFixed(2) + 'h)'); }
            });
            const row = [p.name, p.id, p.manager]
                .concat(titles.map(tt => hoursByTitle[tt] != null ? hoursByTitle[tt].toFixed(2) : ''))
                .concat([acima.join('; ')]);
            lines.push(row.map(q).join(','));
        });
        return lines.join('\r\n');
    }
    function downloadCsv(csv, filename) {
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }
    function exportCsv(r) {
        const d = new Date();
        const dLbl = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const mgr = r.manager ? '_' + r.manager.replace(/[^\w.-]+/g, '-') : '';
        downloadCsv(buildCsv(r), 'learning_hours' + mgr + '_' + dLbl + '.csv');
    }

    // ── Envio para o Slack ───────────────────────────────────────────────
    const SLACK_KEY = 'lh_slack_webhook';
    function slackName(name, link) { return link ? '<' + link + '|' + name + '>' : '*' + name + '*'; }
    // Categorias "amigáveis" p/ dividir as horas.
    function slackCat(title) {
        if (/general fc training/i.test(title)) return 'Horas de onboarding';
        if (/fc safety tour/i.test(title)) return 'Tour';
        if (/ambassador/i.test(title)) return 'Embaixadores';
        if (/training/i.test(title)) return 'Em treinamento';
        return title;
    }
    function slackObs() {
        const lim = name => { const c = TRAININGS.find(x => x.name === name); return c ? trainingLimit(c) : '?'; };
        const trnCfg = TRAININGS.find(c => c.proc !== 'onb' && /training/i.test(c.name));
        const ambCfg = TRAININGS.find(c => /ambassador/i.test(c.name));
        const parts = [];
        parts.push('Horas de onboarding (General FC Training) = ' + lim('General FC Training') + 'h');
        parts.push('Tour (FC Safety Tour) = ' + lim('FC Safety Tour') + 'h');
        if (trnCfg) parts.push('Em treinamento (todos com Training) = ' + trainingLimit(trnCfg) + 'h');
        if (ambCfg) parts.push('Embaixadores (todos com Ambassador) = ' + trainingLimit(ambCfg) + 'h');
        return parts.join(' · ');
    }
    function buildSlackText(r) {
        // Acima do limite: SEMPRE só quem passou (ignora "mostrar todos").
        const exceeding = [];
        r.trainings.forEach(t => { const lim = getLimit(t); t.people.forEach(p => { if (p.total != null && p.total > lim) exceeding.push({ name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, total: p.total, limit: lim }); }); });
        exceeding.sort((a, b) => (b.total - b.limit) - (a.total - a.limit));
        const badges = badgeEntries(r);
        // Cabeçalho reflete a JANELA SELECIONADA no filtro (não a hora atual).
        let msg = modeLabel(currentFilter.mode) + ' *Learning Hours*\n:calendar: _' + windowPreviewText(currentFilter) + '_\n';
        // Cada seção só aparece quando TEM dados.
        if (exceeding.length) {
            msg += '\n⏰ *Acima da hora limite (' + exceeding.length + ')*\n';
            const CAT_ORDER = ['Horas de onboarding', 'Tour', 'Em treinamento', 'Embaixadores'];
            const by = groupByManager(exceeding, e => slackCat(e.title));
            const cats = Object.keys(by).sort((a, b) => { const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
            cats.forEach(cat => { msg += '> *' + cat + '*\n'; by[cat].sort((a, b) => (b.total || 0) - (a.total || 0)).forEach(e => { msg += '>  • ' + slackName(e.name, e.link) + ' — *' + e.total.toFixed(2) + 'h*' + (e.manager ? ' (' + e.manager + ')' : '') + '\n'; }); });
        }
        if (badges.length) {
            msg += '\n🪪 *Ajuste de Badge (' + badges.length + ')*\n';
            const by = groupByManager(badges, e => e.manager);
            Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { msg += '> *' + mgr + '*\n'; by[mgr].forEach(e => { msg += '>  • ' + slackName(e.name, e.link) + ' — *' + (e.total || 0).toFixed(2) + 'h* (' + e.title + ')\n'; }); });
        }
        msg += '\n_Obs.: ' + slackObs() + '_';
        return msg;
    }
    function sendSlack(r) {
        const { modal, box } = makeModal('lh-slack', '520px');
        modalHeader(box, '📤 Enviar para o Slack', 'confira/ajuste o webhook e clique em enviar', '#4A154B');
        const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:18px 20px;background:' + C.bodyBg + ';';
        body.innerHTML = '<div style="font-size:12px;font-weight:800;color:' + C.dark + ';margin-bottom:6px;">🔗 Webhook do Slack (Incoming Webhook)</div>';
        const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'https://hooks.slack.com/services/...'; inp.value = gmGet(SLACK_KEY, '');
        inp.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;';
        body.appendChild(inp);
        const hint = document.createElement('div'); hint.style.cssText = 'font-size:11px;color:' + C.grey + ';margin-top:8px;line-height:1.5;'; hint.textContent = 'A URL é salva para os próximos envios. É enviado só quem passou do limite + o Ajuste de Badge, subdividido por processo.';
        body.appendChild(hint);
        box.appendChild(body);
        const foot = document.createElement('div'); foot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:14px 20px;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;';
        const bSend = document.createElement('button'); bSend.innerHTML = '📤 Enviar'; bSend.style.cssText = 'background:linear-gradient(145deg,#4A154B,#611f69);color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(74,21,75,0.35);';
        const reset = () => { bSend.disabled = false; bSend.innerHTML = '📤 Enviar'; };
        bSend.onclick = () => {
            const wh = (inp.value || '').trim();
            if (!/^https:\/\/hooks\.slack\.com\//i.test(wh)) { alert('❌ Informe uma URL de webhook válida (https://hooks.slack.com/...).'); return; }
            gmSet(SLACK_KEY, wh);
            bSend.disabled = true; bSend.innerHTML = '⏳ Enviando...';
            try {
                GM_xmlhttpRequest({
                    method: 'POST', url: wh,
                    data: JSON.stringify({ text: buildSlackText(r) }),
                    headers: { 'Content-Type': 'application/json' },
                    onload: res => { if (res.status >= 200 && res.status < 300) { modal.remove(); alert('✅ Enviado para o Slack!'); } else { reset(); alert('❌ Erro ' + res.status + ' ao enviar. Verifique o webhook.'); } },
                    onerror: () => { reset(); alert('❌ Falha de conexão ao enviar para o Slack.'); },
                });
            } catch (e) { reset(); alert('❌ Não foi possível enviar para o Slack.'); }
        };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') bSend.click(); });
        foot.appendChild(bSend); box.appendChild(foot); document.body.appendChild(modal);
    }
    function makeModal(id, maxW) {
        document.getElementById(id) && document.getElementById(id).remove();
        const modal = document.createElement('div'); modal.id = id;
        modal.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:\'Amazon Ember\',Arial,sans-serif;animation:lhFade .18s ease;';
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:16px;overflow:hidden;width:94%;max-width:' + maxW + ';max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:lhPop .24s cubic-bezier(.18,.9,.32,1.2);';
        modal.appendChild(box);
        return { modal, box };
    }
    function modalHeader(box, title, sub, accent) {
        const head = document.createElement('div');
        head.style.cssText = 'background:' + C.headerGrad + ';color:' + C.white + ';padding:16px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ' + (accent || C.accent) + ';flex-shrink:0;';
        head.innerHTML = '<div><div style="font-size:16px;font-weight:700;">' + title + '</div>' + (sub ? '<div style="font-size:11px;color:' + C.gold + ';margin-top:3px;">' + sub + '</div>' : '') + '</div>';
        const btnX = document.createElement('button'); btnX.textContent = '✖';
        btnX.style.cssText = 'background:rgba(255,255,255,0.08);color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;transition:all .15s ease;';
        btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
        btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
        btnX.onclick = () => box.closest('[id]').remove();
        head.appendChild(btnX); box.appendChild(head); return head;
    }
    function showPeopleModal(training) {
        const lim = getLimit(training);
        const { modal, box } = makeModal('lh-people', '620px');
        modalHeader(box, '👥 ' + esc(training.title), training.people.length + ' associado(s) · limite ' + lim + 'h');
        const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:18px 20px;background:' + C.bodyBg + ';';
        let html = '<table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ' + C.border + ';"><thead><tr style="background:' + C.headerGrad + ';color:#fff;"><th style="padding:11px 14px;text-align:left;">Nome</th><th style="padding:11px 14px;text-align:left;">ID</th><th style="padding:11px 14px;text-align:left;">Manager</th><th style="padding:11px 14px;text-align:center;">Tempo logado</th><th style="padding:11px 14px;text-align:center;">Status</th></tr></thead><tbody>';
        training.people.slice().sort((a, b) => (b.total || 0) - (a.total || 0)).forEach((p, i) => {
            const bg = i % 2 === 0 ? '#fff' : C.light; const over = p.total != null && p.total > lim;
            const status = p.total == null ? '<span style="color:#bbb;">—</span>' : (over ? '<span style="color:' + C.red + ';font-weight:700;">⏰ passou</span>' : '<span style="color:' + C.green + ';font-weight:700;">✓ ok</span>');
            html += '<tr style="background:' + bg + ';border-bottom:1px solid ' + C.border + ';"><td style="padding:9px 14px;font-weight:600;color:' + C.dark + ';">' + esc(p.name) + '</td><td style="padding:9px 14px;color:' + C.grey + ';font-size:13px;">' + esc(p.id) + '</td><td style="padding:9px 14px;color:' + C.grey + ';font-size:13px;">' + esc(p.manager) + '</td><td style="padding:9px 14px;text-align:center;font-weight:700;color:' + (over ? C.red : C.blue) + ';">' + (p.total != null ? p.total.toFixed(2) + 'h' : '—') + '</td><td style="padding:9px 14px;text-align:center;">' + status + '</td></tr>';
        });
        html += '</tbody></table>'; body.innerHTML = html; box.appendChild(body); document.body.appendChild(modal);
    }
    function buildDashHTML(fr) {
        const exceeding = computeExceeding(fr.trainings);
        let html = '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:20px;"><div style="background:linear-gradient(135deg,#37475A,#1a2530);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">Associados</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + fr.allPeople.length + '</div></div><div style="background:linear-gradient(135deg,#E74C3C,#991010);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">' + esc(listTitle()) + '</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + exceeding.length + '</div></div></div>';
        html += '<div style="font-size:13px;font-weight:700;color:' + C.grey + ';text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">🎓 Treinamentos (clique para ver quem está)</div>';
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:22px;">';
        fr.trainings.forEach((t, i) => { html += '<div class="lh-train-card" data-idx="' + i + '" style="background:#fff;border:1px solid ' + C.border + ';border-left:4px solid ' + C.accent + ';border-radius:10px;padding:14px 16px;cursor:pointer;box-shadow:0 2px 8px rgba(35,47,62,0.06);transition:all .15s ease;"><div style="font-size:15px;font-weight:700;color:' + C.dark + ';">' + esc(t.title) + '</div><div style="font-size:26px;font-weight:800;color:' + C.blue + ';margin-top:4px;">' + t.people.length + ' <span style="font-size:13px;color:' + C.grey + ';font-weight:600;">associado(s)</span></div></div>'; });
        html += '</div>';
        html += '<div style="background:rgba(204,0,0,0.06);border:1px solid ' + C.red + ';border-radius:12px;padding:14px 16px;margin-bottom:18px;"><div style="font-size:15px;font-weight:800;color:' + C.red + ';margin-bottom:8px;">' + (limitByHours ? '⏰' : '📋') + ' ' + esc(listTitle()) + ' (' + exceeding.length + ')' + (limitByHours ? ' <span style="font-weight:600;color:' + C.grey + ';font-size:12px;">— ' + esc(fr.trainings.map(t => t.title + ' > ' + getLimit(t) + 'h').join(' · ')) + '</span>' : '') + '</div>';
        if (exceeding.length) { const hClr = limitByHours ? C.red : C.blueHours; const by = groupByManager(exceeding, e => e.title || 'Sem função'); Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(fn => { html += '<div style="margin:10px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 12px;border-radius:6px;border-left:4px solid ' + C.accent + ';">🎓 ' + esc(fn) + '</div>'; by[fn].forEach(e => { html += '<div style="font-size:15px;color:' + C.dark + ';padding:3px 0 3px 10px;">' + nameLink(e.name, e.link) + ' — <span style="color:' + hClr + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span>' + (e.manager ? ' <span style="color:' + C.grey + ';font-size:13px;">(' + esc(e.manager) + ')</span>' : '') + badgeTag(e.total) + '</div>'; }); }); } else { html += '<div style="font-size:14px;color:' + C.grey + ';">' + (limitByHours ? 'Ninguém acima do limite ✅' : 'Nenhum associado nas funções que precisamos ✅') + '</div>'; }
        html += '</div>';
        return html;
    }
    function buildBadgeHTML(fr) {
        const list = badgeEntries(fr);
        let html = '<div style="margin-bottom:20px;"><div style="background:linear-gradient(135deg,#E74C3C,#991010);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">🪪 Ajuste de Badge (acima de ' + badgeLimit() + 'h)</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + list.length + '</div></div></div>';
        html += '<div style="background:rgba(204,0,0,0.06);border:1px solid ' + C.red + ';border-radius:12px;padding:14px 16px;">';
        html += '<div style="font-size:15px;font-weight:800;color:' + C.red + ';margin-bottom:8px;">🪪 Passaram de ' + badgeLimit() + 'h (' + list.length + ')</div>';
        if (list.length) {
            const by = groupByManager(list, e => e.procName || 'Sem processo');
            const order = PROCESSES.map(p => p.name);
            Object.keys(by).sort((a, b) => order.indexOf(a) - order.indexOf(b)).forEach(pn => {
                html += '<div style="margin:10px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 12px;border-radius:6px;border-left:4px solid ' + C.accent + ';">🎓 ' + esc(pn) + '</div>';
                by[pn].forEach(e => { html += '<div style="font-size:15px;color:' + C.dark + ';padding:3px 0 3px 10px;">' + nameLink(e.name, e.link) + ' — <span style="color:' + C.red + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span> <span style="color:' + C.grey + ';font-size:13px;">(' + esc(e.title) + (e.manager ? ' · ' + esc(e.manager) : '') + ')</span></div>'; });
            });
        } else { html += '<div style="font-size:14px;color:' + C.grey + ';">Ninguém acima de ' + badgeLimit() + 'h ✅</div>'; }
        html += '</div>';
        return html;
    }
    function showDashboard(r) {
        const { modal, box } = makeModal('lh-dash', '1040px');
        const head = modalHeader(box, '📊 Learning Hours — Associados por Função', r.allPeople.length + ' associado(s) · ' + r.trainings.length + ' função(ões)');
        let currentR = r;                        // relatório filtrado por gestor (base das abas)
        let currentProc = PROCESSES[0].key;      // aba de processo ativa
        let viewR = r;                           // visão exibida (gestor + processo)
        const btnFlt = document.createElement('button'); btnFlt.innerHTML = limitLabel(); btnFlt.title = 'Alterna entre limitar por horas (só quem passou do limite) e mostrar todos os associados das funções que precisamos';
        btnFlt.style.cssText = 'background:' + (limitByHours ? C.green : C.grey) + ';color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;';
        btnFlt.onclick = () => { setLimitByHours(!limitByHours); btnFlt.innerHTML = limitLabel(); btnFlt.style.background = limitByHours ? C.green : C.grey; renderD(); };
        const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:22px;background:' + C.bodyBg + ';';
        const filterBar = document.createElement('div'); filterBar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;';
        const lbl = document.createElement('span'); lbl.textContent = '👤 Filtrar por gestor:'; lbl.style.cssText = 'font-size:12px;font-weight:700;color:' + C.dark + ';';
        const sel = document.createElement('select'); sel.style.cssText = 'padding:8px 12px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;color:' + C.dark + ';background:#fff;cursor:pointer;min-width:220px;';
        sel.innerHTML = '<option value="__all__">Todos os gestores</option>' + allManagers(r.trainings).map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
        filterBar.appendChild(lbl); filterBar.appendChild(sel); filterBar.appendChild(btnFlt);
        // Barra de abas por processo (On Boarding / Admin-HR-IT).
        const procObj = k => PROCESSES.find(p => p.key === k) || PROCESSES[0];
        const procTabs = document.createElement('div'); procTabs.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;';
        const procBtns = PROCESSES.map(pr => { const b = document.createElement('button'); b.dataset.proc = pr.key; b.onclick = () => { currentProc = pr.key; renderD(); }; procTabs.appendChild(b); return b; });
        function procHasData(key) { return key === 'badge' ? badgeEntries(currentR).length > 0 : currentR.trainings.some(t => procOf(t).key === key && t.people.length > 0); }
        function styleProcBtns() { procBtns.forEach(b => { const pr = procObj(b.dataset.proc); const on = b.dataset.proc === currentProc; const hasData = procHasData(b.dataset.proc); b.innerHTML = '🎓 ' + esc(pr.name); b.style.cssText = 'border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font-weight:700;font-size:13px;transition:all .15s ease;' + (on ? 'background:' + C.dark + ';color:#fff;box-shadow:0 3px 10px rgba(35,47,62,0.3);' : (hasData ? 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;' : 'background:#F2F4F6;color:#B5BDC5;border:1px solid #E6EAEE;opacity:.55;')); }); }
        // Editor de limites POR TREINAMENTO do processo ativo (decidido aqui, salvo e persistente).
        // Botão que abre a telinha para alterar os limites de horas do processo ativo.
        const btnLimits = document.createElement('button'); btnLimits.innerHTML = '⏱️ Alterar limites de horas';
        btnLimits.style.cssText = 'background:' + C.blue + ';color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:700;font-size:13px;';
        btnLimits.onclick = () => openLimitsPopup();
        function openLimitsPopup() {
            const pr = procObj(currentProc);
            const { modal, box: pbox } = makeModal('lh-limits', '460px');
            modalHeader(pbox, '⏱️ Limites — ' + esc(pr.name), 'acima disso o associado é sinalizado em "Acima em hora"');
            const pbody = document.createElement('div'); pbody.style.cssText = 'flex:1;overflow-y:auto;padding:16px 18px;background:' + C.bodyBg + ';';
            let h = '<div style="display:flex;flex-direction:column;gap:10px;">';
            if (currentProc === 'badge') {
                h += '<div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ' + C.border + ';border-radius:8px;padding:9px 11px;"><span style="flex:1;font-size:13px;font-weight:700;color:' + C.dark + ';">🪪 Ajuste de Badge</span><input type="number" min="0" step="0.5" data-lim="__badge__" value="' + badgeLimit() + '" style="width:90px;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:13px;"><span style="font-size:13px;font-weight:700;color:' + C.grey + ';">h</span></div>';
            } else {
                const list = TRAININGS.filter(c => c.proc === currentProc);
                list.forEach(c => { h += '<div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ' + C.border + ';border-radius:8px;padding:9px 11px;"><span style="flex:1;font-size:13px;font-weight:700;color:' + C.dark + ';">🎓 ' + esc(c.name) + '</span><input type="number" min="0" step="0.5" data-lim="' + c.limitKey + '" value="' + trainingLimit(c) + '" style="width:90px;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:13px;"><span style="font-size:13px;font-weight:700;color:' + C.grey + ';">h</span></div>'; });
            }
            h += '</div>'; pbody.innerHTML = h; pbox.appendChild(pbody);
            const pfoot = document.createElement('div'); pfoot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:12px 18px;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;';
            const bSave = document.createElement('button'); bSave.innerHTML = '💾 Salvar'; bSave.style.cssText = 'background:linear-gradient(145deg,#1e8449,#14562f);color:#fff;border:none;padding:9px 20px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;';
            bSave.onclick = () => {
                let bad = false;
                pbody.querySelectorAll('input[data-lim]').forEach(inp => { const n = parseFloat(String(inp.value).replace(',', '.')); if (isNaN(n) || n < 0) { bad = true; return; } if (inp.dataset.lim === '__badge__') { setBadgeLimit(n); return; } const c = TRAININGS.find(x => x.limitKey === inp.dataset.lim); if (c) setTrainingLimit(c, n); });
                if (bad) { alert('❌ Algum valor é inválido. Use números, ex.: 2 ou 1.5'); return; }
                modal.remove(); renderD();
            };
            pfoot.appendChild(bSave); pbox.appendChild(pfoot); document.body.appendChild(modal);
        }
        filterBar.appendChild(btnLimits);   // ao lado do "Mostrar todos"
        const content = document.createElement('div'); body.appendChild(filterBar); body.appendChild(procTabs); body.appendChild(content); box.appendChild(body);
        function renderD() {
            currentR = filterByManager(r, sel.value); styleProcBtns();
            if (currentProc === 'badge') { viewR = currentR; content.innerHTML = buildBadgeHTML(currentR); }
            else { viewR = filterByProcess(currentR, currentProc); content.innerHTML = buildDashHTML(viewR); }
        }
        renderD();
        sel.onchange = renderD;
        content.addEventListener('click', ev => { const card = ev.target.closest('.lh-train-card'); if (!card) return; showPeopleModal(viewR.trainings[+card.dataset.idx]); });
        content.addEventListener('mouseover', ev => { const card = ev.target.closest('.lh-train-card'); if (card) { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 6px 16px rgba(35,47,62,0.15)'; } });
        content.addEventListener('mouseout', ev => { const card = ev.target.closest('.lh-train-card'); if (card) { card.style.transform = 'none'; card.style.boxShadow = '0 2px 8px rgba(35,47,62,0.06)'; } });
        const foot = document.createElement('div'); foot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0;';
        const lblF = document.createElement('span'); lblF.textContent = 'Exporta a visão atual (respeita o filtro de gestor)'; lblF.style.cssText = 'font-size:12px;color:' + C.grey + ';';
        const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:8px;align-items:center;';
        const btnFclm = document.createElement('button'); btnFclm.innerHTML = '🔗 Abrir no FCLM'; btnFclm.style.cssText = 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;'; btnFclm.onclick = () => { try { window.open(REPORT_LINK, '_blank', 'noopener'); } catch (e) { location.href = REPORT_LINK; } };
        const btnCsv = document.createElement('button'); btnCsv.innerHTML = '📥 Extrair CSV'; btnCsv.style.cssText = 'background:linear-gradient(145deg,#1e8449,#14562f);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(30,132,73,0.35);'; btnCsv.onclick = () => exportCsv(viewR);
        const btnSlack = document.createElement('button'); btnSlack.innerHTML = '📤 Enviar para o Slack'; btnSlack.style.cssText = 'background:linear-gradient(145deg,#4A154B,#611f69);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(74,21,75,0.35);'; btnSlack.onclick = () => sendSlack(currentR, btnSlack);   // todos os processos (subdividido no Slack)
        right.appendChild(btnFclm); right.appendChild(btnSlack); right.appendChild(btnCsv);
        foot.appendChild(lblF); foot.appendChild(right); box.appendChild(foot); document.body.appendChild(modal);
    }

    function injectBar() {
        if (!enabled) return;
        if (document.getElementById('lh-bar')) return;
        const bar = document.createElement('button'); bar.id = 'lh-bar';
        bar._label = '📊 Learning Hours';
        bar.innerHTML = bar._label;
        bar.title = 'Clique para ver as horas de Learning/Onboarding';
        bar.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9998;background:' + C.btnGrad + ';color:' + C.white + ';border:none;border-top:3px solid ' + C.accent + ';border-right:3px solid ' + C.accent + ';border-top-right-radius:12px;padding:12px 26px;font-size:14px;font-weight:800;letter-spacing:.03em;cursor:pointer;font-family:\'Amazon Ember\',Arial,sans-serif;box-shadow:0 -3px 14px rgba(0,0,0,0.3);';
        bar.onmouseenter = () => { bar.style.background = C.btnGradH; };
        bar.onmouseleave = () => { bar.style.background = C.btnGrad; };
        bar.onclick = openOverlay;
        document.body.appendChild(bar);
    }
    function openOverlay() {
        const bar = document.getElementById('lh-bar');
        if (bar) { bar.disabled = true; bar.innerHTML = '⏳ Buscando...'; }
        fetchReport((r, err) => {
            if (bar) { bar.disabled = false; bar.innerHTML = bar._label; }
            if (err) { alert('❌ ' + err + '\nNão consegui buscar o relatório.'); return; }
            injectOverlay(r || buildReportFrom([]));   // abre mesmo vazio (mostra 0)
        });
    }
    // Auto-atualização do painel: enquanto o overlay estiver aberto, re-busca o relatório
    // do FCLM a cada OVERLAY_REFRESH_MS e atualiza os números sozinho (preserva aba e scroll).
    const OVERLAY_REFRESH_MS = 120000;   // 2 min
    function injectOverlay(r) {
        document.getElementById('lh-overlay') && document.getElementById('lh-overlay').remove();
        gmSet(OPEN_KEY, '1');   // lembra que ficou aberto
        let curR = r;
        let exceeding = [], faltantes = [], lastSig = '', refreshing = false, activeTab = 'hora';
        function recompute() {
            exceeding = computeExceeding(curR.trainings);
            const cmpTitles = compareTitles(curR);
            faltantes = curR.allPeople.map(p => ({ p, falta: cmpTitles.filter(tt => !p.inset.has(tt)) })).filter(x => x.falta.length > 0);
        }
        function sig() { return 'H|' + exceeding.map(e => (e.id || e.name) + ':' + e.total).join(',') + '||L|' + faltantes.map(x => (x.p.id || x.p.name) + ':' + x.falta.join('/')).join(','); }
        function fmtTime(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); }
        function fmtCountdown(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m > 0 ? (m + 'm' + String(s % 60).padStart(2, '0') + 's') : (s + 's'); }
        const REFRESH_LABEL = Math.round(OVERLAY_REFRESH_MS / 60000) + ' min';
        let nextAt = Date.now() + OVERLAY_REFRESH_MS;
        recompute();
        const ov = document.createElement('div'); ov.id = 'lh-overlay';
        const savedW = parseInt(gmGet('lh_overlay_w', ''), 10);
        const savedH = parseInt(gmGet('lh_overlay_h', ''), 10);
        ov.style.cssText = 'position:fixed;left:16px;bottom:56px;z-index:9997;width:' + (savedW > 320 ? savedW + 'px' : '390px') + ';height:' + (savedH > 240 ? savedH + 'px' : '60vh') + ';min-width:320px;min-height:240px;max-width:calc(100vw - 32px);max-height:92vh;display:flex;flex-direction:column;background:#fff;border:2px solid ' + C.accent + ';border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,0.4);font-family:\'Amazon Ember\',Arial,sans-serif;overflow:hidden;resize:both;transform-origin:bottom left;animation:lhRise .3s cubic-bezier(.18,.9,.32,1.2);';
        // salva o tamanho ao redimensionar
        try { new ResizeObserver(() => { gmSet('lh_overlay_w', String(ov.offsetWidth)); gmSet('lh_overlay_h', String(ov.offsetHeight)); }).observe(ov); } catch (e) {}
        const head = document.createElement('div'); head.style.cssText = 'background:' + C.headerGrad + ';color:#fff;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
        const headLeft = document.createElement('div');
        headLeft.innerHTML = '<div style="font-size:14px;font-weight:700;">' + modeLabel(currentFilter.mode) + ' Learning Hours</div>';
        const updatedEl = document.createElement('div'); updatedEl.style.cssText = 'font-size:10px;font-weight:600;color:' + C.gold + ';margin-top:2px;'; updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
        const nextEl = document.createElement('div'); nextEl.style.cssText = 'font-size:10px;font-weight:600;color:#9fb3c8;margin-top:1px;';
        headLeft.appendChild(updatedEl); headLeft.appendChild(nextEl); head.appendChild(headLeft);
        const headBtns = document.createElement('div'); headBtns.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const btnFlt = document.createElement('button'); btnFlt.innerHTML = limitLabel(); btnFlt.title = 'Alterna entre limitar por horas (só quem passou do limite) e mostrar todos os associados das funções que precisamos';
        btnFlt.style.cssText = 'background:' + (limitByHours ? C.green : C.grey) + ';color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:700;font-size:12px;';
        btnFlt.onclick = () => { setLimitByHours(!limitByHours); ov.remove(); injectOverlay(curR); };
        const btnRefresh = document.createElement('button'); btnRefresh.innerHTML = '🔄 Atualizar'; btnRefresh.title = 'Atualizar agora';
        btnRefresh.style.cssText = 'background:' + C.blue + ';color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:700;font-size:12px;';
        btnRefresh.onclick = () => doRefresh(true);
        const btnDet = document.createElement('button'); btnDet.innerHTML = '🔎 Mais detalhes'; btnDet.style.cssText = 'background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:700;font-size:12px;'; btnDet.onclick = () => { ov.remove(); showDashboard(curR); };
        const x = document.createElement('button'); x.textContent = '✖'; x.style.cssText = 'background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;'; x.onclick = () => { ov.remove(); gmSet(OPEN_KEY, '0'); };
        headBtns.appendChild(btnFlt); headBtns.appendChild(btnRefresh); headBtns.appendChild(btnDet); headBtns.appendChild(x); head.appendChild(headBtns);
        const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid ' + C.border + ';background:#fff;';
        const tabHora = document.createElement('button'); const tabLog = document.createElement('button'); const tabTot = document.createElement('button');
        const tabBase = 'flex:1;border:none;padding:10px 8px;cursor:pointer;font-weight:700;font-size:13px;font-family:\'Amazon Ember\',Arial,sans-serif;background:#fff;';
        function updateTabLabels() { tabHora.innerHTML = (limitByHours ? '⏰ ' : '📋 ') + listTitle() + ' (' + exceeding.length + ')'; tabLog.innerHTML = '🔁 Precisa logar (' + faltantes.length + ')'; tabTot.innerHTML = '📊 Horas totais (' + curR.trainings.length + ')'; }
        updateTabLabels();
        const body = document.createElement('div'); body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:12px 14px;background:' + C.bodyBg + ';';
        const mgrHeader = (mgr) => '<div style="margin:12px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 10px;border-radius:6px;border-left:4px solid ' + C.accent + ';">👤 ' + esc(mgr) + '</div>';
        const fnHeader = (fn) => '<div style="margin:12px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 10px;border-radius:6px;border-left:4px solid ' + C.accent + ';"><a href="' + reportUrl(processForTitle(fn)) + '" target="_blank" title="Abrir o relatório de onde veio esta informação" style="text-decoration:none;">🎓</a> ' + esc(fn) + '</div>';
        function renderHora() { if (!exceeding.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">' + (limitByHours ? 'Ninguém acima do limite ✅' : 'Nenhum associado nas funções que precisamos ✅') + '</div>'; return; } const hClr = limitByHours ? C.red : C.blue; const by = groupByManager(exceeding, e => e.title || 'Sem função'); let html = ''; Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(fn => { html += fnHeader(fn); by[fn].forEach(e => { html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(e.name, e.link) + ' — <span style="color:' + hClr + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span>' + (e.manager ? ' <span style="color:' + C.grey + ';font-size:12px;">(' + esc(e.manager) + ')</span>' : '') + '</div>'; }); }); body.innerHTML = html; }
        function renderLog() { if (!faltantes.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Todos presentes em todos ✅</div>'; return; } const byT = {}; faltantes.forEach(({ p, falta }) => falta.forEach(t => { (byT[t] = byT[t] || []).push(p); })); let html = ''; Object.keys(byT).sort((a, b) => a.localeCompare(b)).forEach(t => { html += fnHeader(t); byT[t].forEach(p => { html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(p.name, p.link) + (p.manager ? ' <span style="color:' + C.grey + ';font-size:12px;">(' + esc(p.manager) + ')</span>' : '') + '</div>'; }); }); body.innerHTML = html; }
        function renderTotals() {
            // Lista os treinamentos com dados; os zerados somem.
            const rows = EXPECTED_TOTALS.map(exp => {
                const t = curR.trainings.find(tr => exp.re.test(tr.title));
                const total = t ? t.people.reduce((s, p) => s + (p.total || 0), 0) : 0;
                const count = t ? t.people.length : 0;
                return { name: exp.name, total, count, process: exp.process };
            }).filter(r => r.total > 0 && r.count > 0);   // some os zerados
            if (!rows.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Sem dados nesta janela</div>'; return; }
            const grand = rows.reduce((s, r) => s + r.total, 0);
            const grandStr = grand.toFixed(2);
            const copyText = rows.map(r => r.name + ': ' + r.total.toFixed(2) + 'h (' + r.count + ' AA\'s)').join('\n');
            let html = '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button id="lh-copytot" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-weight:700;font-size:12px;">📋 Copiar</button></div>';
            // Total geral acima de todos, com botão pequeno que copia só o número.
            html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:10px 12px;margin-bottom:8px;background:' + C.dark + ';color:#fff;border-radius:8px;"><span style="font-weight:800;">Horas totais: ' + grandStr + '</span><button id="lh-copytotal" title="Copiar somente o total" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-weight:700;font-size:12px;">📋</button></div>';
            rows.forEach(row => { html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:8px 10px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';"><span style="font-weight:700;"><a href="' + reportUrl(row.process) + '" target="_blank" title="Abrir o relatório de onde veio esta informação" style="text-decoration:none;">🎓</a> ' + esc(row.name) + '</span><span style="font-weight:800;color:' + C.blue + ';">' + row.total.toFixed(2) + 'h <span style="color:' + C.grey + ';font-size:12px;font-weight:600;">(' + row.count + ' AA\'s)</span></span></div>'; });
            body.innerHTML = html;
            const cb = document.getElementById('lh-copytot');
            if (cb) cb.onclick = () => { navigator.clipboard.writeText(copyText).then(() => { cb.textContent = '✅ Copiado!'; setTimeout(() => { cb.textContent = '📋 Copiar'; }, 1500); }); };
            const cbt = document.getElementById('lh-copytotal');
            if (cbt) cbt.onclick = () => { navigator.clipboard.writeText(grandStr).then(() => { cbt.textContent = '✅'; setTimeout(() => { cbt.textContent = '📋'; }, 1500); }); };
        }
        function renderTab() { if (activeTab === 'hora') renderHora(); else if (activeTab === 'tot') renderTotals(); else renderLog(); }
        function setActive(which) { activeTab = which; gmSet(ACTIVE_TAB_KEY, which); btnFlt.style.display = (which === 'hora') ? '' : 'none'; tabHora.style.cssText = tabBase + (which === 'hora' ? 'color:' + C.red + ';border-bottom:3px solid ' + C.red + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabLog.style.cssText = tabBase + (which === 'log' ? 'color:' + C.amber + ';border-bottom:3px solid ' + C.amber + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabTot.style.cssText = tabBase + (which === 'tot' ? 'color:' + C.blue + ';border-bottom:3px solid ' + C.blue + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); renderTab(); }
        // Re-busca o relatório e atualiza os números sem fechar o painel.
        function doRefresh(manual) {
            if (refreshing || !document.body.contains(ov)) return;
            refreshing = true;
            nextAt = Date.now() + OVERLAY_REFRESH_MS;
            if (btnRefresh) { btnRefresh.disabled = true; btnRefresh.style.opacity = '.5'; }
            updatedEl.textContent = 'atualizando…';
            fetchReport((r2, err) => {
                refreshing = false;
                if (btnRefresh) { btnRefresh.disabled = false; btnRefresh.style.opacity = '1'; }
                if (!document.body.contains(ov)) return;
                if (err || !r2) { updatedEl.textContent = '⚠️ falha ao atualizar ' + fmtTime(new Date()); return; }
                curR = r2; recompute(); updateTabLabels();
                lastSig = sig();
                const st = body.scrollTop; renderTab(); body.scrollTop = st; // sempre re-renderiza (bate os dados)
                updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
                nextAt = Date.now() + OVERLAY_REFRESH_MS;
            });
        }
        tabHora.onclick = () => setActive('hora'); tabLog.onclick = () => setActive('log'); tabTot.onclick = () => setActive('tot');
        tabs.appendChild(tabHora); tabs.appendChild(tabTot); // "Precisa logar" fora; "Horas totais" no lugar

        // Linha de filtro: Dia / Noite / Dia todo + data selecionável
        const fRow = document.createElement('div');
        fRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-shrink:0;padding:8px 14px;background:#fff;border-bottom:1px solid ' + C.border + ';';
        const selMode = document.createElement('select');
        selMode.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;cursor:pointer;';
        [['day', '☀️ Dia (05:30–18:00)'], ['night', '🌙 Noite (18:00–05:30)'], ['d6to5', '🕕 (D-1)06:00–05:00 '], ['full', '🗓️ Dia todo (00:00–00:00)']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (currentFilter.mode === v) o.selected = true; selMode.appendChild(o); });
        const inpDate = document.createElement('input'); inpDate.type = 'date'; inpDate.value = currentFilter.date; inpDate.style.cssText = 'padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;';
        // Pré-visualização da janela resultante.
        const previewEl = document.createElement('div'); previewEl.style.cssText = 'flex-shrink:0;padding:2px 14px 8px;background:#fff;border-bottom:1px solid ' + C.border + ';font-size:11px;font-weight:700;color:' + C.blue + ';';
        const syncPreview = () => { previewEl.textContent = '🗓️ ' + windowPreviewText({ mode: selMode.value, date: inpDate.value || ymdDash(new Date()) }); };
        const applyFilter = () => { currentFilter = { mode: selMode.value, date: inpDate.value || ymdDash(new Date()) }; saveFilter(currentFilter); syncPreview(); const t = headLeft.querySelector('div'); if (t) t.innerHTML = modeLabel(currentFilter.mode) + ' Learning Hours'; doRefresh(true); };
        selMode.onchange = applyFilter; inpDate.onchange = applyFilter;
        fRow.appendChild(selMode); fRow.appendChild(inpDate);
        syncPreview();

        ov.appendChild(head); ov.appendChild(fRow); ov.appendChild(previewEl); ov.appendChild(tabs); ov.appendChild(body); document.body.appendChild(ov);
        setActive(gmGet(ACTIVE_TAB_KEY, 'hora') === 'tot' ? 'tot' : 'hora');   // restaura última aba
        lastSig = sig();
        // Sem auto-refresh: atualização só manual pelo botão "🔄 Atualizar".
    }
    function removeAll() { ['lh-bar', 'lh-overlay', 'lh-dash', 'lh-people'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); }); }

    let enabled = false, mo = null;
    function enable() {
        if (enabled) { injectBar(); return; }
        enabled = true; injectUICss(); injectBar();
        // Reabre o painel automaticamente se estava aberto na última vez.
        if (gmGet(OPEN_KEY, '0') === '1') setTimeout(() => { if (!document.getElementById('lh-overlay')) openOverlay(); }, 400);
        if (!mo) {
            let moT = null;
            mo = new MutationObserver(() => { if (!enabled || moT) return; moT = setTimeout(() => { moT = null; if (enabled) injectBar(); }, 500); });
            try { mo.observe(document.body, { childList: true }); } catch (e) {}
        }
    }

    // ── Início ───────────────────────────────────────────────────────────
    function init() {
        if (!document.body) { setTimeout(init, 300); return; }
        registerMenu();                // comandos de limite no menu do Tampermonkey
        if (!onFclmReport()) return;   // só na página do relatório functionRollup
        enable();
        window.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            const ids = ['lh-people', 'lh-dash', 'lh-overlay'];
            for (let i = 0; i < ids.length; i++) { const n = document.getElementById(ids[i]); if (n) { n.remove(); return; } }
        });
    }
    init();
})();
