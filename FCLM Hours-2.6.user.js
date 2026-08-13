// ==UserScript==
// @name         FCLM Hours
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  Overlay na página functionRollup do FCLM (GRU5): mostra TODAS as horas logadas por função nas páginas listadas (ADM/RH/IT, ICQA, Pick, Pack, Ship, Stow, Transfer In, Receive, V-Returns, Prep, C-Returns, Sort). Sem limites: só visibilidade das horas totais por função, por processo e ghosted, com filtro de janela (Day/Week), filtro por gestor/processos e exportação CSV.
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/functionRollup*
// @run-at       document-idle
// @connect      fclm-portal.amazon.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @updateURL    https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20Hours-1.0.user.js
// @downloadURL  https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20Hours-1.0.user.js
// ==/UserScript==
//
// OBJETIVO: dar visibilidade de TODAS as horas logadas (por função) nas páginas
// de processo do FCLM. Derivado do "Learning Hours", mas sem Onboarding e sem
// nenhum limite/regra de negócio — traz tudo que aparecer nos relatórios.
//
(function () {
    'use strict';
    if (window.top !== window.self) return;          // não roda dentro de iframes
    if (document.getElementById('fh-bar')) return;    // evita dupla injeção

    const C = {
        dark: '#232F3E', darker: '#131921', hover: '#37475A', accent: '#FF9900',
        gold: '#FEBD69', blue: '#4A86C8', blueHours: '#0B4F8A', grey: '#607D8B', red: '#CC0000',
        amber: '#E88B00', green: '#27AE60', white: '#FFFFFF', light: '#F7F7F7', border: '#E8E8E8',
        headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
        btnGrad: 'linear-gradient(145deg,#37475A 0%,#232F3E 100%)',
        btnGradH: 'linear-gradient(145deg,#4A5D72 0%,#37475A 100%)',
        bodyBg: '#EEF1F4',
    };
    const FCLM_ORIGIN = 'https://fclm-portal.amazon.com';
    const WAREHOUSE = 'GRU5';

    function gmGet(k, d) { try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : (localStorage.getItem(k) ?? d); } catch (e) { return d; } }
    function gmSet(k, v) { try { (typeof GM_setValue === 'function') ? GM_setValue(k, v) : localStorage.setItem(k, v); } catch (e) {} }

    function onFclmReport() { return /^https?:\/\/fclm-portal\.amazon\.com\/reports\/functionRollup/i.test(location.href); }

    // ── Páginas (processos) buscadas ─────────────────────────────────────
    // Sem Onboarding. "Learning" (1002960) = ADM/RH/IT. Traz todas as funções de cada uma.
    const PROCESSES = [
        { key: 'adm',  name: 'ADM/RH/IT',   processId: '1002960' },
        { key: 'icqa', name: 'ICQA',        processId: '1003030' },
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
    ];
    function procOf(t) { return PROCESSES.find(p => p.key === (t && t.proc)) || PROCESSES[0]; }
    function procIdForTitle(r, title) { const t = r.trainings.find(x => x.title === title); const p = t ? procOf(t) : PROCESSES[0]; return p.processId; }

    // ── Funções "ghosted" (códigos que não deveriam receber horas) ───────
    const GHOSTED_LIST = [
        'TOM_YARD_SPECIALISTS', 'TOM_YARD_CHECKIN/OUT', 'TOM_ADMIN', 'TOM_YARD_JOCKEY', 'FAC_HOMEAREA_GHOST',
        'TOM_TRAINING', 'TOM_YARD_Trainee', 'TAP_training', 'TOM_BOXTRUCK_DRIVER', 'TOM_YARD_PERMIT', 'TOM_HOME',
        'TOM_LABOR_SHARING', 'TOM_AMAL_SUPPORT', 'TOM_AM2L_SUPPORT', 'TOM_SHUTTLE', 'TOM_DISPATCH', 'TOM_SOSY',
        'TOM_REGIONAL_DRIVER', 'TOM_LOG_SPEC', 'TOM_TOMY_LANE', 'TOM_DTT', 'OPS_SALARIED_ASSOC', 'POD Transfer In',
        'POD Transfer Out', 'OPS_PHOTO-EDITORIAL', 'OPS_REGIONAL/3P', 'OPS_REGIONALPROJECTS', 'WFS_STAFF',
        'IT_SUPPORT_STAFF_NA', 'IT_SUPPORT_STAFF_EU', 'TOM_YARD_PeerTrn', 'TOM_AMXL_SUPPORT', 'TOM_AMZL_SUPPORT',
        'POD_Transfer_In', 'POD_Transfer_Out',
    ];
    const normCode = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '_');
    const GHOSTED_SET = new Set(GHOSTED_LIST.map(normCode));
    function isGhosted(title) { return GHOSTED_SET.has(normCode(title)); }
    // Funções sem os ghosted (usado em "Horas totais" e "Processos").
    function nonGhosted(trainings) { return trainings.filter(t => !isGhosted(t.title)); }

    // ── Filtro de janela (Dia / Noite / 06→05 / Dia todo + data) ─────────
    const OPEN_KEY = 'fh_open';
    const ACTIVE_TAB_KEY = 'fh_active_tab';
    const FILTER_KEY = 'fh_window_filter';
    function pad2(n) { return String(n).padStart(2, '0'); }
    function ymdDash(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function loadFilter() { try { const s = gmGet(FILTER_KEY, ''); if (s) return JSON.parse(s); } catch (e) {} return { mode: 'day', date: ymdDash(new Date()) }; }
    function saveFilter(f) { gmSet(FILTER_KEY, JSON.stringify(f)); }
    let currentFilter = loadFilter();
    if (currentFilter.mode !== 'day' && currentFilter.mode !== 'week') currentFilter.mode = 'day'; // migra modos antigos (intraday)
    // Sempre começa em HOJE (dia atual e semana atual).
    (function () { const t = new Date(); currentFilter.date = ymdDash(t); currentFilter.year = t.getFullYear(); currentFilter.week = weekNumberOf(t); })();
    saveFilter(currentFilter);
    const modeLabel = m => m === 'week' ? '🗓️ Semana' : '☀️ Dia';
    // Semana Amazon: começa no DOMINGO e termina no SÁBADO.
    // Domingo que inicia a semana 1 do ano = Domingo em/antes de 1º de janeiro.
    function weekOneSunday(year) { const jan1 = new Date(year, 0, 1); const s = new Date(jan1); s.setDate(jan1.getDate() - jan1.getDay()); return s; }
    // Domingo (início) da semana N do ano informado.
    function sundayOfWeek(year, week) { const s = weekOneSunday(year); s.setDate(s.getDate() + (Math.max(1, week || 1) - 1) * 7); return s; }
    // Domingo da semana que contém a data.
    function sundayOf(d) { const s = new Date(d); s.setDate(d.getDate() - d.getDay()); return s; }
    // Número da semana (Dom–Sáb) da data.
    function weekNumberOf(d) { const w1 = weekOneSunday(d.getFullYear()); const sun = sundayOf(d); return Math.round((sun - w1) / (7 * 86400000)) + 1; }
    function buildWindowParams(f) {
        const p = new URLSearchParams();
        p.set('warehouseId', WAREHOUSE);
        if (f.mode === 'week') {                       // Semana: Domingo da week escolhida → Domingo seguinte
            const sun = sundayOfWeek(f.year, f.week);
            const nextSun = new Date(sun); nextSun.setDate(sun.getDate() + 7);
            p.set('spanType', 'Week');
            p.set('startDate', ymdDash(sun) + 'T00:00:00.000');   // FCLM: data de DOMINGO no campo Week
            p.set('endDate', ymdDash(nextSun) + 'T00:00:00.000');
        } else {                                       // Dia: 00:00 → 00:00 do dia seguinte
            const parts = String(f.date || '').split('-').map(Number);
            const base = (parts.length === 3 && !parts.some(isNaN)) ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
            const next = new Date(base); next.setDate(base.getDate() + 1);
            p.set('spanType', 'Day');
            p.set('startDate', ymdDash(base) + 'T00:00:00.000');
            p.set('endDate', ymdDash(next) + 'T00:00:00.000');
        }
        return p;
    }
    function windowPreviewText(f) {
        const dm = d => pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
        if (f.mode === 'week') {
            const sun = sundayOfWeek(f.year, f.week);
            const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
            return 'Week ' + (f.week || 1) + '/' + (f.year || sun.getFullYear()) + ' · ' + dm(sun) + ' (dom) → ' + dm(sat) + ' (sáb)';
        }
        const parts = String(f.date || '').split('-').map(Number);
        const base = (parts.length === 3 && !parts.some(isNaN)) ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
        return 'Dia ' + dm(base);
    }
    function reportUrl(processId) {
        const p = buildWindowParams(currentFilter);
        p.set('reportFormat', 'HTML');
        p.set('processId', processId || PROCESSES[0].processId);
        return FCLM_ORIGIN + '/reports/functionRollup?' + p.toString();
    }

    // ── Busca dos relatórios ─────────────────────────────────────────────
    function fetchOne(processId, cb) {
        GM_xmlhttpRequest({
            method: 'GET', url: reportUrl(processId),
            onload: res => { try { cb((res.status >= 200 && res.status < 300) ? new DOMParser().parseFromString(res.responseText, 'text/html') : null); } catch (e) { cb(null); } },
            onerror: () => cb(null),
        });
    }
    // Busca TODOS os processos listados, marca cada função com o processo de origem e combina.
    function fetchReport(cb) {
        const targets = PROCESSES.filter(p => p.processId);
        let done = 0, errs = 0, trainings = [];
        const finish = () => {
            if (done < targets.length) return;
            trainings = mergeTrainings(trainings);
            if (errs === targets.length) { cb(null, 'Falha de conexão'); return; }
            cb(buildReportFrom(trainings), null);
        };
        targets.forEach(pr => fetchOne(pr.processId, doc => {
            if (doc) { try { parseFunctionTables(doc).forEach(t => { t.proc = pr.key; trainings.push(t); }); } catch (e) {} }
            else errs++;
            done++; finish();
        }));
    }

    // ── Parse das tabelas de função (nome, ID, manager, horas) ───────────
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
                // As horas ficam na coluna "Paid Hours → Total" (1ª célula "size-total highlighted").
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
            if (!map.has(key)) map.set(key, { title: t.title, fnId: t.fnId, proc: t.proc, _p: new Map() });
            const agg = map.get(key);
            if (!agg.title || agg.title === 'Sem título') agg.title = t.title;
            if (!agg.proc && t.proc) agg.proc = t.proc;
            t.people.forEach(p => {
                const pk = p.id || p.name.toLowerCase();
                const prev = agg._p.get(pk);
                if (!prev || (p.total != null && (prev.total == null || p.total > prev.total))) agg._p.set(pk, p);
            });
        });
        return [...map.values()].map(a => ({ title: a.title, fnId: a.fnId, proc: a.proc, people: [...a._p.values()] }));
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

    // ── Agregações e filtros (sem limites) ───────────────────────────────
    function personKey(p) { return p.id || p.name.toLowerCase(); }
    function allManagers(trainings) { const s = new Set(); trainings.forEach(t => t.people.forEach(p => { if (p.manager) s.add(p.manager); })); return [...s].sort((a, b) => a.localeCompare(b)); }
    function filterByManager(r, mgr) {
        if (!mgr || mgr === '__all__') return r;
        const trainings = r.trainings.map(t => ({ ...t, people: t.people.filter(p => p.manager === mgr) })).filter(t => t.people.length);
        const fr = buildReportFrom(trainings); fr.manager = mgr; return fr;
    }
    // Total de horas por função (com dados), ordenado por horas desc.
    function totalsByFunction(trainings) {
        return trainings.map(t => ({ title: t.title, fnId: t.fnId, proc: t.proc, total: t.people.reduce((s, p) => s + (p.total || 0), 0), count: t.people.length }))
            .filter(x => x.count > 0 && x.total > 0)
            .sort((a, b) => b.total - a.total);
    }
    // Total de horas por PROCESSO (página puxada), somando todas as funções do processo.
    function totalsByProcess(trainings) {
        const map = {};
        trainings.forEach(t => {
            const pr = procOf(t);
            if (!map[pr.key]) map[pr.key] = { key: pr.key, name: pr.name, processId: pr.processId, total: 0, fns: 0, _people: new Set() };
            map[pr.key].total += t.people.reduce((s, p) => s + (p.total || 0), 0);
            map[pr.key].fns += 1;
            t.people.forEach(p => map[pr.key]._people.add(personKey(p)));
        });
        return Object.values(map)
            .map(x => ({ key: x.key, name: x.name, processId: x.processId, total: x.total, fns: x.fns, count: x._people.size }))
            .filter(x => x.total > 0)
            .sort((a, b) => b.total - a.total);
    }

    // ── Exportação CSV (formato longo: 1 linha por associado × função) ───
    // Evita a matriz esparsa (1 coluna por função) que deixava tudo vazio.
    function buildCsv(r) {
        const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const header = ['Nome', 'ID', 'Manager', 'Processo', 'Função', 'Ghosted', 'Horas'];
        const lines = [header.map(q).join(',')];
        const rows = [];
        r.trainings.forEach(t => {
            const procName = procOf(t).name;
            const ghost = isGhosted(t.title) ? 'Sim' : 'Não';
            t.people.forEach(p => {
                if (p.total == null) return;
                rows.push({ name: p.name, id: p.id, manager: p.manager, proc: procName, title: t.title, ghost: ghost, total: p.total });
            });
        });
        // Ordena por associado (nome) e, dentro dele, por horas desc.
        rows.sort((a, b) => a.name.localeCompare(b.name) || (b.total - a.total));
        rows.forEach(row => { lines.push([row.name, row.id, row.manager, row.proc, row.title, row.ghost, row.total.toFixed(2)].map(q).join(',')); });
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
        const dLbl = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
        const mgr = r.manager ? '_' + r.manager.replace(/[^\w.-]+/g, '-') : '';
        downloadCsv(buildCsv(r), 'fclm_hours' + mgr + '_' + dLbl + '.csv');
    }

    // ── Modais base ──────────────────────────────────────────────────────
    function makeModal(id, maxW) {
        document.getElementById(id) && document.getElementById(id).remove();
        const modal = document.createElement('div'); modal.id = id;
        modal.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:\'Amazon Ember\',Arial,sans-serif;animation:fhFade .18s ease;';
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:16px;overflow:hidden;width:94%;max-width:' + maxW + ';max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:fhPop .24s cubic-bezier(.18,.9,.32,1.2);';
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
    function injectUICss() {
        if (document.getElementById('fh-ui-css')) return;
        const st = document.createElement('style'); st.id = 'fh-ui-css';
        st.textContent = '@keyframes fhFade{from{opacity:0}to{opacity:1}}@keyframes fhPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}@keyframes fhRise{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:none}}'
            + '.fh-copybtn{transition:all .18s ease;}.fh-copybtn:hover{filter:brightness(1.12);transform:translateY(-1px);box-shadow:0 4px 12px rgba(255,153,0,.4)!important;}.fh-copybtn:active{transform:translateY(0);}';
        (document.head || document.documentElement).appendChild(st);
    }

    // ── Modal: pessoas de uma função ─────────────────────────────────────
    function showPeopleModal(training) {
        const { modal, box } = makeModal('fh-people', '620px');
        const totalH = training.people.reduce((s, p) => s + (p.total || 0), 0);
        modalHeader(box, '👥 ' + esc(training.title), training.people.length + ' associado(s) · ' + totalH.toFixed(2) + 'h no total');
        const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:18px 20px;background:' + C.bodyBg + ';';
        const people = training.people.slice().sort((a, b) => (b.total || 0) - (a.total || 0));
        // Barra com botão de copiar os dados desta função.
        let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap;"><span style="font-size:12px;color:' + C.grey + ';font-weight:700;">' + people.length + ' associado(s) · ' + totalH.toFixed(2) + 'h</span><span style="display:flex;gap:8px;align-items:center;"><button id="fh-openfclm" class="fh-copybtn" style="background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:800;font-size:13px;">🔗 Abrir no FCLM</button><button id="fh-copypeople" class="fh-copybtn" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:8px;padding:8px 20px;cursor:pointer;font-weight:800;font-size:13px;box-shadow:0 2px 8px rgba(255,153,0,.3);">Copiar dados</button></span></div>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid ' + C.border + ';"><thead><tr style="background:' + C.headerGrad + ';color:#fff;"><th style="padding:11px 14px;text-align:left;">Nome</th><th style="padding:11px 14px;text-align:left;">ID</th><th style="padding:11px 14px;text-align:left;">Manager</th><th style="padding:11px 14px;text-align:center;">Tempo logado</th></tr></thead><tbody>';
        people.forEach((p, i) => {
            const bg = i % 2 === 0 ? '#fff' : C.light;
            html += '<tr style="background:' + bg + ';border-bottom:1px solid ' + C.border + ';"><td style="padding:9px 14px;font-weight:600;color:' + C.dark + ';">' + esc(p.name) + '</td><td style="padding:9px 14px;color:' + C.grey + ';font-size:13px;">' + esc(p.id) + '</td><td style="padding:9px 14px;color:' + C.grey + ';font-size:13px;">' + esc(p.manager) + '</td><td style="padding:9px 14px;text-align:center;font-weight:700;color:' + C.blue + ';">' + (p.total != null ? p.total.toFixed(2) + 'h' : '—') + '</td></tr>';
        });
        html += '</tbody></table>'; body.innerHTML = html; box.appendChild(body); document.body.appendChild(modal);
        // Copia em formato de tabela (TSV) — cola direto em planilha.
        const copyText = [training.title].concat(['Nome\tID\tManager\tTempo logado (h)'])
            .concat(people.map(p => [p.name, p.id, p.manager, (p.total != null ? p.total.toFixed(2) : '')].join('\t')))
            .join('\n');
        const cbp = document.getElementById('fh-copypeople');
        if (cbp) cbp.onclick = () => { navigator.clipboard.writeText(copyText).then(() => { cbp.textContent = '✅ Copiado!'; setTimeout(() => { cbp.textContent = 'Copiar dados'; }, 1500); }); };
        const ofc = document.getElementById('fh-openfclm');
        if (ofc) ofc.onclick = () => { const u = reportUrl(procOf(training).processId); try { window.open(u, '_blank', 'noopener'); } catch (e) { location.href = u; } };
    }

    // ── Dashboard "Detalhes" ─────────────────────────────────────────────
    function sumHours(t) { return t.people.reduce((s, p) => s + (p.total || 0), 0); }
    function dashStats(trainings) { const ppl = new Set(); let hours = 0; trainings.forEach(t => t.people.forEach(p => { ppl.add(personKey(p)); hours += (p.total || 0); })); return { people: ppl.size, funcs: trainings.length, hours: hours }; }
    function statsCardsHTML(st) {
        return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px;">'
            + '<div style="background:linear-gradient(135deg,#37475A,#1a2530);color:#fff;padding:16px 20px;border-radius:14px;text-align:center;box-shadow:0 6px 18px rgba(35,47,62,.18);"><div style="font-size:11px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">Associados</div><div style="font-size:34px;font-weight:800;margin-top:2px;">' + st.people + '</div></div>'
            + '<div style="background:linear-gradient(135deg,#2C3E50,#131921);color:#fff;padding:16px 20px;border-radius:14px;text-align:center;box-shadow:0 6px 18px rgba(19,25,33,.2);"><div style="font-size:11px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">Funções</div><div style="font-size:34px;font-weight:800;margin-top:2px;">' + st.funcs + '</div></div>'
            + '<div style="background:linear-gradient(135deg,#0B4F8A,#062f52);color:#fff;padding:16px 20px;border-radius:14px;text-align:center;box-shadow:0 6px 18px rgba(11,79,138,.22);"><div style="font-size:11px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">Horas totais</div><div style="font-size:34px;font-weight:800;margin-top:2px;">' + st.hours.toFixed(1) + '</div></div></div>';
    }
    function buildCardsHTML(trainings, accent) {
        let html = statsCardsHTML(dashStats(trainings));
        html += '<div style="font-size:13px;font-weight:700;color:' + C.grey + ';text-transform:uppercase;letter-spacing:.06em;margin:4px 0 10px;">🎓 Funções (clique para ver quem está)</div>';
        if (!trainings.length) return html + '<div style="font-size:14px;color:' + C.grey + ';padding:8px;">Sem dados nesta seleção.</div>';
        const hClr = accent === C.red ? C.red : C.blue;
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;">';
        trainings.forEach((t, idx) => {
            const th = sumHours(t);
            html += '<div class="fh-train-card" data-idx="' + idx + '" style="background:#fff;border:1px solid ' + C.border + ';border-left:4px solid ' + (accent || C.accent) + ';border-radius:12px;padding:14px 16px;cursor:pointer;box-shadow:0 2px 8px rgba(35,47,62,0.06);transition:all .18s ease;"><div style="font-size:15px;font-weight:700;color:' + C.dark + ';">' + esc(t.title) + '</div><div style="font-size:22px;font-weight:800;color:' + hClr + ';margin-top:4px;">' + th.toFixed(2) + 'h <span style="font-size:13px;color:' + C.grey + ';font-weight:600;">· ' + t.people.length + ' AA\'s</span></div></div>';
        });
        html += '</div>';
        return html;
    }
    // Multi-seleção em dropdown (checkboxes) com "Todos".
    function makeMultiSelect(labelText, options, selected, onChange) {
        const wrap = document.createElement('div'); wrap.style.cssText = 'position:relative;';
        const btn = document.createElement('button');
        btn.style.cssText = 'padding:8px 12px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;color:' + C.dark + ';background:#fff;cursor:pointer;font-weight:700;transition:all .2s ease;white-space:nowrap;';
        btn.onmouseenter = () => { btn.style.borderColor = C.accent; btn.style.boxShadow = '0 2px 8px rgba(255,153,0,.22)'; };
        btn.onmouseleave = () => { btn.style.borderColor = '#CDD4DA'; btn.style.boxShadow = 'none'; };
        const panel = document.createElement('div'); panel.style.cssText = 'display:none;position:absolute;top:calc(100% + 5px);left:0;z-index:30;background:#fff;border:1px solid #CDD4DA;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:8px;max-height:300px;overflow:auto;min-width:240px;animation:fhFade .16s ease;';
        function refresh() { const n = options.filter(o => selected.has(o.value)).length; btn.innerHTML = labelText + ' <span style="color:' + C.accent + ';">(' + n + '/' + options.length + ')</span> ▾'; }
        const mkRow = (text, bold) => {
            const row = document.createElement('label'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:13px;color:' + C.dark + ';transition:background .15s ease;' + (bold ? 'font-weight:800;border-bottom:1px solid ' + C.border + ';margin-bottom:4px;' : 'font-weight:600;');
            row.onmouseenter = () => row.style.background = '#F2F6FF'; row.onmouseleave = () => row.style.background = 'transparent';
            const cbx = document.createElement('input'); cbx.type = 'checkbox'; cbx.style.cssText = 'width:15px;height:15px;accent-color:' + C.accent + ';cursor:pointer;flex:none;';
            const sp = document.createElement('span'); sp.textContent = text; sp.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            row.appendChild(cbx); row.appendChild(sp); return { row, cbx };
        };
        const allR = mkRow('Todos', true);
        const boxes = [];
        function syncAll() { allR.cbx.checked = options.length > 0 && options.every(o => selected.has(o.value)); }
        allR.cbx.onchange = () => { if (allR.cbx.checked) options.forEach(o => selected.add(o.value)); else selected.clear(); boxes.forEach(b => b.cbx.checked = selected.has(b.value)); refresh(); onChange(); };
        panel.appendChild(allR.row);
        options.forEach(o => { const r = mkRow(o.label); r.cbx.checked = selected.has(o.value); r.cbx.onchange = () => { if (r.cbx.checked) selected.add(o.value); else selected.delete(o.value); syncAll(); refresh(); onChange(); }; panel.appendChild(r.row); boxes.push({ value: o.value, cbx: r.cbx }); });
        syncAll();
        btn.onclick = (e) => { e.stopPropagation(); panel.style.display = (panel.style.display === 'none') ? 'block' : 'none'; };
        panel.addEventListener('click', e => e.stopPropagation());
        document.addEventListener('click', () => { panel.style.display = 'none'; });
        wrap.appendChild(btn); wrap.appendChild(panel); refresh();
        return { wrap, refresh };
    }
    // Filtro de janela (Day/Week) reutilizável — aplica em currentFilter e chama onChange().
    function makeWindowFilter(onChange) {
        const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px;padding:10px 12px;background:#fff;border:1px solid ' + C.border + ';border-radius:10px;';
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
        const selMode = document.createElement('select'); selMode.style.cssText = 'padding:7px 10px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;cursor:pointer;font-weight:700;transition:all .2s ease;';
        [['day', '☀️ Day (dia)'], ['week', '🗓️ Week (semana)']].forEach(function (o) { const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; if (currentFilter.mode === o[0]) op.selected = true; selMode.appendChild(op); });
        const inpDate = document.createElement('input'); inpDate.type = 'date'; inpDate.value = currentFilter.date; inpDate.style.cssText = 'padding:7px 10px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;';
        const weekWrap = document.createElement('span'); weekWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const wLbl = document.createElement('span'); wLbl.textContent = 'Wk'; wLbl.style.cssText = 'font-size:12px;font-weight:800;color:' + C.grey + ';';
        const inpWeek = document.createElement('input'); inpWeek.type = 'number'; inpWeek.min = '1'; inpWeek.max = '53'; inpWeek.value = currentFilter.week; inpWeek.style.cssText = 'width:60px;padding:7px 8px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;';
        const inpYear = document.createElement('input'); inpYear.type = 'number'; inpYear.min = '2020'; inpYear.max = '2100'; inpYear.value = currentFilter.year; inpYear.style.cssText = 'width:72px;padding:7px 8px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;';
        weekWrap.appendChild(wLbl); weekWrap.appendChild(inpWeek); weekWrap.appendChild(inpYear);
        const preview = document.createElement('div'); preview.style.cssText = 'font-size:11px;font-weight:700;color:' + C.blue + ';';
        function readFilter() { const mode = selMode.value; if (mode === 'week') return { mode: 'week', date: currentFilter.date, week: Math.max(1, parseInt(inpWeek.value, 10) || 1), year: parseInt(inpYear.value, 10) || new Date().getFullYear() }; return { mode: 'day', date: inpDate.value || ymdDash(new Date()), week: currentFilter.week, year: currentFilter.year }; }
        function syncVis() { const wk = selMode.value === 'week'; inpDate.style.display = wk ? 'none' : ''; weekWrap.style.display = wk ? 'flex' : 'none'; }
        function sync() { syncVis(); preview.textContent = '🗓️ ' + windowPreviewText(readFilter()) + ' — muda a janela e re-busca os dados'; }
        const apply = () => { currentFilter = readFilter(); saveFilter(currentFilter); sync(); onChange(); };
        selMode.onchange = apply; inpDate.onchange = apply; inpWeek.onchange = apply; inpYear.onchange = apply;
        row.appendChild(selMode); row.appendChild(inpDate); row.appendChild(weekWrap);
        wrap.appendChild(row); wrap.appendChild(preview); sync();
        return wrap;
    }
    function showDashboard(r) {
        const { modal, box } = makeModal('fh-dash', '1040px');
        modalHeader(box, '🔎 FCLM Hours — Detalhes', r.allPeople.length + ' associado(s) · ' + r.trainings.length + ' função(ões)');
        const procObj = k => PROCESSES.find(p => p.key === k) || PROCESSES[0];
        function procsWithData(baseTr) { const keys = new Set(nonGhosted(baseTr).map(t => procOf(t).key)); return PROCESSES.filter(p => keys.has(p.key)); }
        let mgr = '__all__', baseR = r, visibleTrainings = [];
        let availProcs = procsWithData(r.trainings);
        let selectedProcs = new Set(availProcs.map(p => p.key));   // filtro múltiplo de processos
        let currentTab = availProcs.length ? availProcs[0].key : 'ghost';
        const shownFuncs = new Set();                              // funções marcadas na aba de processo

        const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:20px 22px;background:' + C.bodyBg + ';';
        const winFilter = makeWindowFilter(() => reloadDash());    // filtro Day/Week com re-busca
        const filterBar = document.createElement('div'); filterBar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;';
        const tabsRow = document.createElement('div'); tabsRow.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;';
        const funcBar = document.createElement('div'); funcBar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px;';
        const funcLbl = document.createElement('span'); funcLbl.textContent = '🎯 Funções:'; funcLbl.style.cssText = 'font-size:12px;font-weight:700;color:' + C.dark + ';';
        const content = document.createElement('div');
        body.appendChild(winFilter); body.appendChild(filterBar); body.appendChild(tabsRow); body.appendChild(funcBar); body.appendChild(content); box.appendChild(body);

        // Barra de filtros (gestor + multi-processos), reconstruída ao re-buscar.
        function rebuildFilterBar() {
            filterBar.innerHTML = '';
            const lbl = document.createElement('span'); lbl.textContent = '👤'; lbl.style.cssText = 'font-size:16px;';
            const selMgr = document.createElement('select'); selMgr.style.cssText = 'padding:8px 12px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;color:' + C.dark + ';background:#fff;cursor:pointer;min-width:200px;transition:all .2s ease;';
            const managers = allManagers(r.trainings);
            if (mgr !== '__all__' && managers.indexOf(mgr) < 0) mgr = '__all__';
            selMgr.innerHTML = '<option value="__all__">Todos os gestores</option>' + managers.map(m => '<option value="' + esc(m) + '"' + (m === mgr ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
            selMgr.onmouseenter = () => selMgr.style.borderColor = C.accent; selMgr.onmouseleave = () => selMgr.style.borderColor = '#CDD4DA';
            selMgr.onchange = () => { mgr = selMgr.value; renderD(); };
            const procMulti = makeMultiSelect('🏭 Processos', availProcs.map(p => ({ value: p.key, label: p.name })), selectedProcs, () => { rebuildTabs(); rebuildFuncFilter(); renderContent(); });
            filterBar.appendChild(lbl); filterBar.appendChild(selMgr); filterBar.appendChild(procMulti.wrap);
        }
        // Re-busca o relatório na janela atual e reconstrói tudo.
        function reloadDash() {
            content.innerHTML = '<div style="padding:24px;text-align:center;color:' + C.grey + ';font-size:14px;">⏳ Buscando ' + esc(windowPreviewText(currentFilter)) + '…</div>';
            fetchReport((r2, err) => {
                if (err || !r2) { content.innerHTML = '<div style="padding:24px;text-align:center;color:' + C.red + ';font-size:14px;">⚠️ Falha ao buscar o relatório.</div>'; return; }
                r = r2;
                availProcs = procsWithData(r.trainings);
                const keep = new Set([...selectedProcs].filter(k => availProcs.some(p => p.key === k)));
                selectedProcs = keep.size ? keep : new Set(availProcs.map(p => p.key));
                if (currentTab !== 'ghost' && !availProcs.some(p => p.key === currentTab)) currentTab = availProcs.length ? availProcs[0].key : 'ghost';
                rebuildFilterBar(); renderD();
            });
        }

        function currentProcFuncs() { return nonGhosted(baseR.trainings).filter(t => procOf(t).key === currentTab).sort((a, b) => sumHours(b) - sumHours(a)); }
        function styleTab(btn, on, accent) { btn.style.cssText = 'border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font-weight:700;font-size:13px;transition:all .2s ease;' + (on ? 'background:' + (accent || C.dark) + ';color:#fff;box-shadow:0 3px 12px rgba(35,47,62,0.3);transform:translateY(-1px);' : 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;'); }
        function rebuildTabs() {
            tabsRow.innerHTML = '';
            const procs = availProcs.filter(p => selectedProcs.has(p.key));
            if (currentTab !== 'ghost' && !procs.some(p => p.key === currentTab)) currentTab = procs.length ? procs[0].key : 'ghost';
            procs.forEach(pr => {
                const b = document.createElement('button'); b.textContent = '🏭 ' + pr.name; styleTab(b, currentTab === pr.key);
                b.onmouseenter = () => { if (currentTab !== pr.key) { b.style.borderColor = C.accent; b.style.color = C.accent; } };
                b.onmouseleave = () => { if (currentTab !== pr.key) { b.style.borderColor = '#CDD4DA'; b.style.color = C.dark; } };
                b.onclick = () => { currentTab = pr.key; rebuildTabs(); rebuildFuncFilter(); renderContent(); };
                tabsRow.appendChild(b);
            });
            const g = document.createElement('button'); g.textContent = '👻 Ghosted'; styleTab(g, currentTab === 'ghost', C.red);
            g.onmouseenter = () => { if (currentTab !== 'ghost') { g.style.borderColor = C.red; g.style.color = C.red; } };
            g.onmouseleave = () => { if (currentTab !== 'ghost') { g.style.borderColor = '#CDD4DA'; g.style.color = C.dark; } };
            g.onclick = () => { currentTab = 'ghost'; rebuildTabs(); rebuildFuncFilter(); renderContent(); };
            tabsRow.appendChild(g);
        }
        function rebuildFuncFilter() {
            funcBar.innerHTML = '';
            if (currentTab === 'ghost') { funcBar.style.display = 'none'; return; }
            funcBar.style.display = 'flex';
            const fns = currentProcFuncs();
            shownFuncs.clear(); fns.forEach(t => shownFuncs.add(t.title));
            funcBar.appendChild(funcLbl);
            const fm = makeMultiSelect('Selecionar', fns.map(t => ({ value: t.title, label: t.title })), shownFuncs, () => renderContent());
            funcBar.appendChild(fm.wrap);
        }
        function renderContent() {
            if (currentTab === 'ghost') { visibleTrainings = baseR.trainings.filter(t => isGhosted(t.title)).sort((a, b) => sumHours(b) - sumHours(a)); content.innerHTML = buildCardsHTML(visibleTrainings, C.red); }
            else { visibleTrainings = currentProcFuncs().filter(t => shownFuncs.has(t.title)); content.innerHTML = buildCardsHTML(visibleTrainings, C.accent); }
            content.style.animation = 'none'; void content.offsetWidth; content.style.animation = 'fhFade .25s ease';
        }
        function renderD() { baseR = filterByManager(r, mgr); rebuildTabs(); rebuildFuncFilter(); renderContent(); }
        content.addEventListener('click', ev => { const card = ev.target.closest('.fh-train-card'); if (!card) return; showPeopleModal(visibleTrainings[+card.dataset.idx]); });
        content.addEventListener('mouseover', ev => { const card = ev.target.closest('.fh-train-card'); if (card) { card.style.transform = 'translateY(-3px)'; card.style.boxShadow = '0 8px 20px rgba(35,47,62,0.18)'; } });
        content.addEventListener('mouseout', ev => { const card = ev.target.closest('.fh-train-card'); if (card) { card.style.transform = 'none'; card.style.boxShadow = '0 2px 8px rgba(35,47,62,0.06)'; } });
        rebuildFilterBar();
        renderD();

        const foot = document.createElement('div'); foot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0;';
        const lblF = document.createElement('span'); lblF.textContent = 'Exporta/Envia respeitando o filtro de gestor'; lblF.style.cssText = 'font-size:12px;color:' + C.grey + ';';
        const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:8px;align-items:center;';
        function fx(btn) { btn.style.transition = 'all .2s ease'; btn.onmouseenter = () => { btn.style.filter = 'brightness(1.12)'; btn.style.transform = 'translateY(-1px)'; }; btn.onmouseleave = () => { btn.style.filter = 'none'; btn.style.transform = 'none'; }; }
        const btnCsv = document.createElement('button'); btnCsv.innerHTML = '� Extrair CSV'; btnCsv.style.cssText = 'background:linear-gradient(145deg,#1e8449,#14562f);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(30,132,73,0.35);'; btnCsv.onclick = () => exportCsv(baseR); fx(btnCsv);
        right.appendChild(btnCsv);
        foot.appendChild(lblF); foot.appendChild(right); box.appendChild(foot); document.body.appendChild(modal);
    }

    // ── Barra fixa + overlay ─────────────────────────────────────────────
    function injectBar() {
        if (!enabled) return;
        if (document.getElementById('fh-bar')) return;
        const bar = document.createElement('button'); bar.id = 'fh-bar';
        bar._label = '📊 FCLM Hours';
        bar.innerHTML = bar._label;
        bar.title = 'Clique para ver todas as horas logadas por função';
        bar.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9998;background:' + C.btnGrad + ';color:' + C.white + ';border:none;border-top:3px solid ' + C.accent + ';border-right:3px solid ' + C.accent + ';border-top-right-radius:12px;padding:12px 26px;font-size:14px;font-weight:800;letter-spacing:.03em;cursor:pointer;font-family:\'Amazon Ember\',Arial,sans-serif;box-shadow:0 -3px 14px rgba(0,0,0,0.3);';
        bar.onmouseenter = () => { bar.style.background = C.btnGradH; };
        bar.onmouseleave = () => { bar.style.background = C.btnGrad; };
        bar.onclick = openOverlay;
        document.body.appendChild(bar);
    }
    function openOverlay() {
        const bar = document.getElementById('fh-bar');
        if (bar) { bar.disabled = true; bar.innerHTML = '⏳ Buscando...'; }
        fetchReport((r, err) => {
            if (bar) { bar.disabled = false; bar.innerHTML = bar._label; }
            if (err) { alert('❌ ' + err + '\nNão consegui buscar o relatório.'); return; }
            injectOverlay(r || buildReportFrom([]));
        });
    }
    function injectOverlay(r) {
        document.getElementById('fh-overlay') && document.getElementById('fh-overlay').remove();
        gmSet(OPEN_KEY, '1');
        let curR = r, refreshing = false, activeTab = 'tot';
        function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
        const ov = document.createElement('div'); ov.id = 'fh-overlay';
        const savedW = parseInt(gmGet('fh_overlay_w', ''), 10);
        const savedH = parseInt(gmGet('fh_overlay_h', ''), 10);
        ov.style.cssText = 'position:fixed;left:16px;bottom:56px;z-index:9997;width:' + (savedW > 320 ? savedW + 'px' : '400px') + ';height:' + (savedH > 240 ? savedH + 'px' : '62vh') + ';min-width:320px;min-height:240px;max-width:calc(100vw - 32px);max-height:92vh;display:flex;flex-direction:column;background:#fff;border:2px solid ' + C.accent + ';border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,0.4);font-family:\'Amazon Ember\',Arial,sans-serif;overflow:hidden;resize:both;transform-origin:bottom left;animation:fhRise .3s cubic-bezier(.18,.9,.32,1.2);';
        try { new ResizeObserver(() => { gmSet('fh_overlay_w', String(ov.offsetWidth)); gmSet('fh_overlay_h', String(ov.offsetHeight)); }).observe(ov); } catch (e) {}
        const head = document.createElement('div'); head.style.cssText = 'background:' + C.headerGrad + ';color:#fff;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
        const headLeft = document.createElement('div');
        headLeft.innerHTML = '<div style="font-size:14px;font-weight:700;">' + modeLabel(currentFilter.mode) + ' FCLM Hours</div>';
        const updatedEl = document.createElement('div'); updatedEl.style.cssText = 'font-size:10px;font-weight:600;color:' + C.gold + ';margin-top:2px;'; updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
        headLeft.appendChild(updatedEl); head.appendChild(headLeft);
        const headBtns = document.createElement('div'); headBtns.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const btnRefresh = document.createElement('button'); btnRefresh.innerHTML = '🔄 Atualizar'; btnRefresh.title = 'Atualizar agora';
        btnRefresh.style.cssText = 'background:' + C.blue + ';color:#fff;border:none;border-radius:7px;padding:6px 12px;cursor:pointer;font-weight:700;font-size:12px;transition:all .2s ease;';
        btnRefresh.onmouseenter = () => { btnRefresh.style.background = '#3A6FA5'; btnRefresh.style.transform = 'translateY(-1px)'; btnRefresh.style.boxShadow = '0 4px 12px rgba(74,134,200,.45)'; };
        btnRefresh.onmouseleave = () => { btnRefresh.style.background = C.blue; btnRefresh.style.transform = 'none'; btnRefresh.style.boxShadow = 'none'; };
        btnRefresh.onclick = () => doRefresh(true);
        const btnDet = document.createElement('button');
        btnDet.innerHTML = '<span style="font-size:16px;line-height:1;">🔎</span><span style="font-size:9px;font-weight:800;color:#fff;letter-spacing:.06em;margin-top:1px;">Detalhes</span>';
        btnDet.title = 'Abrir detalhes';
        btnDet.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;background:linear-gradient(145deg,#FFB84D,#FF9900);color:#fff;border:none;border-radius:8px;padding:3px 12px;cursor:pointer;transition:all .2s ease;box-shadow:0 2px 8px rgba(255,153,0,.35);text-shadow:0 1px 2px rgba(0,0,0,.25);';
        btnDet.onmouseenter = () => { btnDet.style.background = 'linear-gradient(145deg,#FF9900,#E07D00)'; btnDet.style.transform = 'translateY(-1px)'; btnDet.style.boxShadow = '0 5px 16px rgba(255,153,0,.55)'; };
        btnDet.onmouseleave = () => { btnDet.style.background = 'linear-gradient(145deg,#FFB84D,#FF9900)'; btnDet.style.transform = 'none'; btnDet.style.boxShadow = '0 2px 8px rgba(255,153,0,.35)'; };
        btnDet.onclick = () => { ov.remove(); showDashboard(curR); };
        const x = document.createElement('button'); x.textContent = '✖'; x.style.cssText = 'background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;'; x.onclick = () => { ov.remove(); gmSet(OPEN_KEY, '0'); };
        headBtns.appendChild(btnRefresh); headBtns.appendChild(btnDet); headBtns.appendChild(x); head.appendChild(headBtns);
        const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid ' + C.border + ';background:#fff;';
        const tabTot = document.createElement('button'); const tabProcs = document.createElement('button'); const tabGhost = document.createElement('button');
        const tabBase = 'flex:1;border:none;padding:10px 6px;cursor:pointer;font-weight:700;font-size:12.5px;font-family:\'Amazon Ember\',Arial,sans-serif;background:#fff;transition:all .2s ease;';
        function updateTabLabels() { tabTot.innerHTML = '📊 Horas totais (' + nonGhosted(curR.trainings).length + ')'; tabProcs.innerHTML = '🏭 Processos (' + totalsByProcess(nonGhosted(curR.trainings)).length + ')'; tabGhost.innerHTML = '👻 Ghosted (' + totalsByFunction(curR.trainings).filter(x => isGhosted(x.title)).length + ')'; }
        const body = document.createElement('div'); body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:12px 14px;background:' + C.bodyBg + ';';
        function renderTotals() {
            const rows = totalsByFunction(nonGhosted(curR.trainings));
            if (!rows.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Sem dados nesta janela</div>'; return; }
            const grand = rows.reduce((s, r) => s + r.total, 0);
            const grandStr = grand.toFixed(2);
            const copyText = rows.map(r => r.title + ': ' + r.total.toFixed(2) + 'h (' + r.count + " AA's)").join('\n');
            let html = '<div style="display:flex;justify-content:center;margin-bottom:8px;"><button id="fh-copytot" class="fh-copybtn" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:6px 22px;cursor:pointer;font-weight:700;font-size:12px;">Copiar</button></div>';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:10px 12px;margin-bottom:8px;background:' + C.dark + ';color:#fff;border-radius:8px;"><span style="font-weight:800;">Horas totais: ' + grandStr + '</span><button id="fh-copytotal" title="Copiar somente o total" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-weight:700;font-size:12px;">📋</button></div>';
            rows.forEach(row => { html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:8px 10px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';"><span style="font-weight:700;"><a href="' + reportUrl(row.proc ? procOf(row).processId : PROCESSES[0].processId) + '" target="_blank" title="Abrir o relatório de onde veio esta informação" style="text-decoration:none;">🔗</a> ' + esc(row.title) + '</span><span style="font-weight:800;color:' + C.blue + ';">' + row.total.toFixed(2) + 'h</span></div>'; });
            body.innerHTML = html;
            const cb = document.getElementById('fh-copytot');
            if (cb) cb.onclick = () => { navigator.clipboard.writeText(copyText).then(() => { cb.textContent = '✅ Copiado!'; setTimeout(() => { cb.textContent = 'Copiar'; }, 1500); }); };
            const cbt = document.getElementById('fh-copytotal');
            if (cbt) cbt.onclick = () => { navigator.clipboard.writeText(grandStr).then(() => { cbt.textContent = '✅'; setTimeout(() => { cbt.textContent = '📋'; }, 1500); }); };
        }
        function renderProcs() {
            const rows = totalsByProcess(nonGhosted(curR.trainings));
            if (!rows.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Sem dados nesta janela</div>'; return; }
            const grand = rows.reduce((s, r) => s + r.total, 0);
            const grandStr = grand.toFixed(2);
            const copyText = rows.map(r => r.name + ': ' + r.total.toFixed(2) + 'h (' + r.count + " AA's · " + r.fns + ' func.)').join('\n');
            let html = '<div style="display:flex;justify-content:center;margin-bottom:8px;"><button id="fh-copyproc" class="fh-copybtn" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:6px 22px;cursor:pointer;font-weight:700;font-size:12px;">Copiar</button></div>';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:10px 12px;margin-bottom:8px;background:' + C.dark + ';color:#fff;border-radius:8px;"><span style="font-weight:800;">Processos: ' + rows.length + '</span><span style="display:flex;gap:8px;align-items:center;"><span style="font-weight:800;color:' + C.gold + ';">' + grandStr + 'h</span><button id="fh-copyproctotal" title="Copiar somente o total" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-weight:700;font-size:12px;">📋</button></span></div>';
            rows.forEach(row => { html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:8px 10px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';"><span style="font-weight:700;"><a href="' + reportUrl(row.processId) + '" target="_blank" title="Abrir o relatório deste processo" style="text-decoration:none;">🔗</a> ' + esc(row.name) + ' <span style="color:' + C.grey + ';font-size:12px;font-weight:600;">(' + row.fns + ' func.)</span></span><span style="font-weight:800;color:' + C.blue + ';">' + row.total.toFixed(2) + 'h</span></div>'; });
            body.innerHTML = html;
            const cb = document.getElementById('fh-copyproc');
            if (cb) cb.onclick = () => { navigator.clipboard.writeText(copyText).then(() => { cb.textContent = '✅ Copiado!'; setTimeout(() => { cb.textContent = 'Copiar'; }, 1500); }); };
            const cbt = document.getElementById('fh-copyproctotal');
            if (cbt) cbt.onclick = () => { navigator.clipboard.writeText(grandStr).then(() => { cbt.textContent = '✅'; setTimeout(() => { cbt.textContent = '📋'; }, 1500); }); };
        }
        function renderGhost() {
            const rows = totalsByFunction(curR.trainings).filter(x => isGhosted(x.title));
            if (!rows.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Nenhuma função ghosted nesta janela ✅</div>'; return; }
            const grand = rows.reduce((s, r) => s + r.total, 0);
            const grandStr = grand.toFixed(2);
            const copyText = rows.map(r => r.title + ': ' + r.total.toFixed(2) + "h (" + r.count + " AA's)").join('\n');
            let html = '<div style="display:flex;justify-content:center;margin-bottom:8px;"><button id="fh-copyghost" class="fh-copybtn" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:6px 22px;cursor:pointer;font-weight:700;font-size:12px;">Copiar</button></div>';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:10px 12px;margin-bottom:8px;background:' + C.red + ';color:#fff;border-radius:8px;"><span style="font-weight:800;">👻 Ghosted: ' + rows.length + '</span><span style="display:flex;gap:8px;align-items:center;"><span style="font-weight:800;">' + grandStr + 'h</span><button id="fh-copyghosttotal" title="Copiar somente o total" style="background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-weight:700;font-size:12px;">📋</button></span></div>';
            rows.forEach(row => { html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;padding:8px 10px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';"><span style="font-weight:700;"><a href="' + reportUrl(row.proc ? procOf(row).processId : PROCESSES[0].processId) + '" target="_blank" title="Abrir o relatório de onde veio esta informação" style="text-decoration:none;">🔗</a> ' + esc(row.title) + '</span><span style="font-weight:800;color:' + C.red + ';">' + row.total.toFixed(2) + 'h</span></div>'; });
            body.innerHTML = html;
            const cb = document.getElementById('fh-copyghost');
            if (cb) cb.onclick = () => { navigator.clipboard.writeText(copyText).then(() => { cb.textContent = '✅ Copiado!'; setTimeout(() => { cb.textContent = 'Copiar'; }, 1500); }); };
            const cbt = document.getElementById('fh-copyghosttotal');
            if (cbt) cbt.onclick = () => { navigator.clipboard.writeText(grandStr).then(() => { cbt.textContent = '✅'; setTimeout(() => { cbt.textContent = '📋'; }, 1500); }); };
        }
        function renderTab() { if (activeTab === 'procs') renderProcs(); else if (activeTab === 'ghost') renderGhost(); else renderTotals(); body.style.animation = 'none'; void body.offsetWidth; body.style.animation = 'fhFade .22s ease'; }
        function setActive(which) { activeTab = which; gmSet(ACTIVE_TAB_KEY, which); tabTot.style.cssText = tabBase + (which === 'tot' ? 'color:' + C.blue + ';border-bottom:3px solid ' + C.blue + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabProcs.style.cssText = tabBase + (which === 'procs' ? 'color:' + C.dark + ';border-bottom:3px solid ' + C.dark + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabGhost.style.cssText = tabBase + (which === 'ghost' ? 'color:' + C.red + ';border-bottom:3px solid ' + C.red + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); renderTab(); }
        function doRefresh() {
            if (refreshing || !document.body.contains(ov)) return;
            refreshing = true;
            if (btnRefresh) { btnRefresh.disabled = true; btnRefresh.style.opacity = '.5'; }
            updatedEl.textContent = 'atualizando…';
            fetchReport((r2, err) => {
                refreshing = false;
                if (btnRefresh) { btnRefresh.disabled = false; btnRefresh.style.opacity = '1'; }
                if (!document.body.contains(ov)) return;
                if (err || !r2) { updatedEl.textContent = '⚠️ falha ao atualizar ' + fmtTime(new Date()); return; }
                curR = r2; updateTabLabels();
                const st = body.scrollTop; renderTab(); body.scrollTop = st;
                updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
            });
        }
        tabTot.onclick = () => setActive('tot'); tabProcs.onclick = () => setActive('procs'); tabGhost.onclick = () => setActive('ghost');
        updateTabLabels();
        tabs.appendChild(tabTot); tabs.appendChild(tabProcs); tabs.appendChild(tabGhost);

        const fRow = document.createElement('div');
        fRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-shrink:0;padding:8px 14px;background:#fff;border-bottom:1px solid ' + C.border + ';';
        const selMode = document.createElement('select');
        selMode.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;cursor:pointer;';
        [['day', '☀️ Day (dia)'], ['week', '🗓️ Week (semana)']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (currentFilter.mode === v) o.selected = true; selMode.appendChild(o); });
        // Campo do DIA (date picker)
        const inpDate = document.createElement('input'); inpDate.type = 'date'; inpDate.value = currentFilter.date; inpDate.style.cssText = 'padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;';
        // Campos da SEMANA (número da week + ano)
        const weekWrap = document.createElement('span'); weekWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const wLbl = document.createElement('span'); wLbl.textContent = 'Wk'; wLbl.style.cssText = 'font-size:12px;font-weight:800;color:' + C.grey + ';';
        const inpWeek = document.createElement('input'); inpWeek.type = 'number'; inpWeek.min = '1'; inpWeek.max = '53'; inpWeek.value = currentFilter.week; inpWeek.title = 'Número da semana (Dom–Sáb)'; inpWeek.style.cssText = 'width:60px;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;';
        const inpYear = document.createElement('input'); inpYear.type = 'number'; inpYear.min = '2020'; inpYear.max = '2100'; inpYear.value = currentFilter.year; inpYear.title = 'Ano da semana'; inpYear.style.cssText = 'width:72px;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;';
        weekWrap.appendChild(wLbl); weekWrap.appendChild(inpWeek); weekWrap.appendChild(inpYear);
        const previewEl = document.createElement('div'); previewEl.style.cssText = 'flex-shrink:0;padding:2px 14px 2px;background:#fff;font-size:11px;font-weight:700;color:' + C.blue + ';';
        const hintEl = document.createElement('div'); hintEl.style.cssText = 'flex-shrink:0;padding:0 14px 8px;background:#fff;border-bottom:1px solid ' + C.border + ';font-size:10.5px;font-weight:600;color:' + C.grey + ';line-height:1.4;';
        function readFilter() {
            const mode = selMode.value;
            if (mode === 'week') return { mode: 'week', date: currentFilter.date, week: Math.max(1, parseInt(inpWeek.value, 10) || 1), year: parseInt(inpYear.value, 10) || new Date().getFullYear() };
            return { mode: 'day', date: inpDate.value || ymdDash(new Date()), week: currentFilter.week, year: currentFilter.year };
        }
        function syncVis() { const wk = selMode.value === 'week'; inpDate.style.display = wk ? 'none' : ''; weekWrap.style.display = wk ? 'flex' : 'none'; }
        const syncPreview = () => {
            const f = readFilter();
            previewEl.textContent = '🗓️ ' + windowPreviewText(f);
            const janela = f.mode === 'week' ? 'a semana inteira (domingo a sábado)' : 'o dia inteiro selecionado';
            hintEl.innerHTML = 'Somando as horas de ' + janela + '. 🔗 Clique no link ao lado de cada item para abrir o relatório desses dados no FCLM.';
        };
        const applyFilter = () => { currentFilter = readFilter(); saveFilter(currentFilter); syncVis(); syncPreview(); const t = headLeft.querySelector('div'); if (t) t.innerHTML = modeLabel(currentFilter.mode) + ' FCLM Hours'; doRefresh(true); };
        selMode.onchange = applyFilter; inpDate.onchange = applyFilter; inpWeek.onchange = applyFilter; inpYear.onchange = applyFilter;
        fRow.appendChild(selMode); fRow.appendChild(inpDate); fRow.appendChild(weekWrap);
        syncVis(); syncPreview();

        ov.appendChild(head); ov.appendChild(fRow); ov.appendChild(previewEl); ov.appendChild(hintEl); ov.appendChild(tabs); ov.appendChild(body); document.body.appendChild(ov);
        setActive(['procs', 'ghost'].includes(gmGet(ACTIVE_TAB_KEY, 'tot')) ? gmGet(ACTIVE_TAB_KEY, 'tot') : 'tot');
    }
    function removeAll() { ['fh-bar', 'fh-overlay', 'fh-dash', 'fh-people', 'fh-slack'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); }); }

    let enabled = false, mo = null;
    function enable() {
        if (enabled) { injectBar(); return; }
        enabled = true; injectUICss(); injectBar();
        // O overlay NÃO abre sozinho: só aparece ao clicar na barra 📊 FCLM Hours.
        if (!mo) {
            let moT = null;
            mo = new MutationObserver(() => { if (!enabled || moT) return; moT = setTimeout(() => { moT = null; if (enabled) injectBar(); }, 500); });
            try { mo.observe(document.body, { childList: true }); } catch (e) {}
        }
    }

    // ── Início ───────────────────────────────────────────────────────────
    function init() {
        if (!document.body) { setTimeout(init, 300); return; }
        if (!onFclmReport()) return;
        enable();
        window.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            const ids = ['fh-people', 'fh-slack', 'fh-dash', 'fh-overlay'];
            for (let i = 0; i < ids.length; i++) { const n = document.getElementById(ids[i]); if (n) { n.remove(); return; } }
        });
    }
    init();
})();
