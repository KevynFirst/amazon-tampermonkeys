// ==UserScript==
// @name         Minichecklist Mecanismos
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Mini-checklist flutuante do turno (Mecanismos GRU5). Após o Startup (06:10 Day / 18:10 Night) pergunta o gestor (lista do FCLM ppaTimeOnTask → login pelo Roster) e o cargo (PA, OPS ou AM); a lista de tarefas muda por cargo. Botão fixo "Time On Task" (OPS/AM) abre painel estilo Learning Hours com 2 abas: Inferred Time > 0.75 e Time Off Task, filtrando os associados do gestor. Em cada associado: link ao ppaTimeDetails, ✔ resolver, 🚫 desconsiderar e 📋 Apollo (Seek to Understand) com login/métrica/valores pré-preenchidos. Alertas: pílula/badge quando há Inferred > 0.75, "Meta concluída" aos 5 resolvidos, e overlay agressivo por degrau (1.75, 2.75, ...) com adiar de 1h. Prefetch do Roster à tarde. Estado via Tampermonkey; CSSOM para CSP restrito.
// @author       ladislke
// @match        *://*/*
// @match        file:///*
// @run-at       document-idle
// @connect      fclm-portal.amazon.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==
//
// OBJETIVO: ajudar a NÃO esquecer as tarefas de maior impacto do turno (Mecanismos).
//  • Após o Startup (06:10 no Day / 18:10 no Night) pergunta o GESTOR (lista puxada do FCLM
//    ppaTimeOnTask) e o CARGO (PA, OPS ou AM). A escolha e o turno ficam salvos até o próximo dia.
//  • Turno: day = 05:30–18:00; night = 18:00–05:30. Definido na 1ª abertura e NÃO muda no meio
//    (ex.: quem abriu de dia continua com a lista do dia mesmo às 18:10).
//  • Alertas usam a HORA ATUAL (horários day/night por tarefa). Modo Alerta trava a tela e toca
//    um bip 1 min antes; modo Silencioso não trava.
//  • Estado via GM_setValue (mesmo em qualquer site e após reiniciar o navegador).
//
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (document.getElementById('chkmec-fab')) return;

    // ── URLs reutilizadas ────────────────────────────────────────────────
    const WAREHOUSE = 'GRU5';
    const PPA_TOT_URL = 'https://fclm-portal.amazon.com/reports/ppaTimeOnTask?reportFormat=HTML&warehouseId=' + WAREHOUSE;
    const U = {
        guided:      'https://guided-coaching.corp.amazon.com/#/opportunities',
        ppaTot:      PPA_TOT_URL,
        apollo21572: 'https://apollo-audit.corp.amazon.com/audits/new?audit_type_id=21572',
        apolloBin:   'https://apollo-audit.corp.amazon.com/audits/new?audit_type_id=26240',
        apolloHome:  'https://apollo-audit.corp.amazon.com/',
        ehs:         'https://na.ehs-amazon.com/compliance-execution/inspection/adhoc/list',
    };
    // Métricas do Benchmarking (Seek to Understand) pré-selecionadas no Apollo.
    const M_IDLE = 'Unknown Idle Time (Tempo Ocioso Desconhecido)';
    const M_FAST = 'Fast Start (Início Rápido)';

    // Horário (min do dia) em que a pergunta de gestor/cargo pode aparecer, por turno.
    // Só após o Startup: Day 06:10 (=370) e Night 18:10 (=1090; segue válido na madrugada).
    const SETUP_DAY_MIN = 370, SETUP_NIGHT_MIN = 1090;
    // Prefetch do Roster: baixa 1x por dia numa janela da tarde p/ acelerar a manhã seguinte.
    const PREFETCH_START_MIN = 780, PREFETCH_END_MIN = 1020;   // 13:00–17:00
    const ROSTER_TTL_MS = 24 * 60 * 60 * 1000;                 // Roster vale por 24h (uso instantâneo)
    const PREFETCH_RETRY_MS = 5 * 60 * 1000;                   // tenta no máx. a cada 5 min

    // ── Lista de tarefas do turno ─────────────────────────────────────────
    // t=título, d=subdescrição (string ou fn(cargo)), url=link, roles=cargos (ausente=todos),
    // day/night='HH:MM' de alerta, apolloMetric=métrica no Apollo,
    // periodKey/periodType='week'|'biweek' → check persiste por semana/quinzena.
    const MASTER = [
        { t: 'Atlas Checklist', d: 'Um por dia', day: '06:15', night: '18:15' },  // link: em aguardo
        { t: 'GCA', d: 'Fechar todos gerados no turno', url: U.guided, day: '16:00', night: '03:00' },
        { t: 'Apollo Behavior', d: (sel) => 'Meta: ' + (sel === 'pa' ? 4 : 2) + " STU's", url: U.apolloHome },
        { t: 'Time Off Task', d: 'Corrigir todos os ajustes da semana', url: U.ppaTot, roles: ['ops', 'am'], day: '16:30', night: '03:30' },
        { t: 'Time On Task', d: "Meta: 5 STU's de Inferred Time por dia", url: U.apollo21572, apolloMetric: M_IDLE, roles: ['ops', 'am'], day: '17:00', night: '04:00' },
        { t: 'Fast Start', d: "Meta: 4 STU's de Fast Start por dia", url: U.apollo21572, apolloMetric: M_FAST, roles: ['pa'] },
        { t: 'Bin Etiquette', d: "Meta: 5 STU's de violação de Bin Etiquette", url: U.apolloBin },
        { t: 'FSI', d: '2 inspeções por semana (Dom–Sáb)', url: U.ehs, periodKey: 'fsi', periodType: 'week' },
        { t: 'Area Organization', d: '1 inspeção a cada 2 semanas', url: U.ehs, periodKey: 'ao', periodType: 'biweek' },
    ];
    // Itens visíveis para o cargo selecionado.
    function checklistFor(sel) { return MASTER.filter(it => !it.roles || it.roles.indexOf(sel) >= 0); }
    const SEL_LABEL = { pa: 'PA', ops: 'OPS', am: 'AM' };

    const WARN_SEC = 120;         // abre o menu 2 min antes do alerta
    const SOUND_LEAD_SEC = 60;    // bip 1 min antes do alerta
    const FAB_SIZE = 72;          // círculo um pouco maior

    // ── Armazenamento (GM compartilhado; fallback localStorage) ──────────
    const nowMs = () => Date.now();
    const hasGM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');
    const store = {
        get(k, d) {
            try {
                if (hasGM) { const v = GM_getValue(k); return (v === undefined || v === null) ? d : v; }
                const v = localStorage.getItem(k); return v == null ? d : v;
            } catch (e) { return d; }
        },
        set(k, v) { try { if (hasGM) GM_setValue(k, v); else localStorage.setItem(k, v); } catch (e) {} },
    };
    const K_CYCLE = 'chkmec_cycle';   // { opDate, shift, manager, selection, done }
    const K_CUSTOM = 'chkmec_custom'; // [{ id, t }] — itens pessoais adicionados pelo usuário
    const K_POS   = 'chkmec_pos';
    const K_MODE  = 'chkmec_mode';
    const K_PERIODIC = 'chkmec_periodic';  // { 'fsi|W..':true, 'ao|BW..':true } — checks semanais/quinzenais
    const K_MGRS   = 'chkmec_mgrs';        // { opDate, names:[...] } — cache diário de nomes de gestores (TOT)
    const K_MGRS_LAST = 'chkmec_mgrs_last'; // { names:[...] } — última lista boa (fallback quando sem login)
    const K_ROSTER = 'chkmec_roster';      // { ts, direct:{}, sorted:{}, loose:{} } — mapa nome→login (Roster)
    const K_PREFETCH     = 'chkmec_prefetch';     // opDate em que o prefetch da tarde já rodou
    const K_PREFETCH_TRY = 'chkmec_prefetch_try'; // ts da última tentativa de prefetch (throttle)

    function getPos() { try { return JSON.parse(store.get(K_POS, 'null')); } catch (e) { return null; } }
    function setPos(p) { store.set(K_POS, JSON.stringify(p)); }
    function getMode() { return store.get(K_MODE, 'alert') === 'silent' ? 'silent' : 'alert'; }
    function setMode(m) { store.set(K_MODE, m === 'silent' ? 'silent' : 'alert'); }

    // ── Turno & dia operacional ──────────────────────────────────────────
    // Dia operacional vira às 05:30 (antes disso conta como o dia anterior),
    // agrupando a madrugada do night com a noite que começou na véspera.
    function pad(n) { return String(n).padStart(2, '0'); }
    function minsOf(d) { return d.getHours() * 60 + d.getMinutes(); }
    function shiftFromTime(d) { const m = minsOf(d); return (m >= 330 && m < 1080) ? 'day' : 'night'; } // 330=05:30, 1080=18:00
    function operationalDate(d) {
        const x = new Date(d);
        if (minsOf(x) < 330) x.setDate(x.getDate() - 1);
        return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
    }
    // ── Períodos (semana Dom–Sáb / quinzena) para checks persistentes ────
    function opDateObj() { const p = operationalDate(new Date()).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
    function sundayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - x.getDay()); return x; } // getDay(): 0=Domingo
    function periodIdFor(type) {
        const s = sundayOf(opDateObj());
        const wid = s.getFullYear() + '-' + pad(s.getMonth() + 1) + '-' + pad(s.getDate());
        if (type === 'biweek') { const weeks = Math.floor(s.getTime() / (7 * 24 * 3600 * 1000)); return 'BW' + Math.floor(weeks / 2); }
        return 'W' + wid;
    }
    function getPeriodic() { try { return JSON.parse(store.get(K_PERIODIC, '{}')) || {}; } catch (e) { return {}; } }
    function periodicIsDone(key, periodId) { return !!getPeriodic()[key + '|' + periodId]; }
    function togglePeriodic(key, periodId) {
        const p = getPeriodic(), k = key + '|' + periodId;
        if (p[k]) delete p[k]; else p[k] = true;
        store.set(K_PERIODIC, JSON.stringify(p));
    }
    // ── Itens pessoais (aba "Adicionar") ─────────────────────────────────
    function getCustom() { try { const v = JSON.parse(store.get(K_CUSTOM, '[]')); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
    function setCustom(a) { store.set(K_CUSTOM, JSON.stringify(a)); }
    function addCustomItem(t, alert, url) { const a = getCustom(); a.push({ id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000), t: t, alert: alert || null, url: url || null }); setCustom(a); }
    function removeCustomItem(id) { setCustom(getCustom().filter(x => x.id !== id)); }

    // Timestamp do alerta (HH:MM) ancorado no dia operacional e no turno.
    function alertTs(opDate, shift, hhmm) {
        if (!hhmm) return null;
        const p = opDate.split('-').map(Number);
        const hm = hhmm.split(':').map(Number);
        const base = new Date(p[0], p[1] - 1, p[2], hm[0], hm[1], 0, 0);
        if (shift === 'night' && hm[0] < 12) base.setDate(base.getDate() + 1); // madrugada = dia seguinte
        return base.getTime();
    }

    // ── Ciclo (fluxo + turno + checks do dia) ────────────────────────────
    // Cache em memória (3s) para não fazer GM_getValue + JSON.parse a cada tick.
    let _cyc = null, _cycTs = 0;
    function getCycle() {
        const t = nowMs();
        if (_cyc && (t - _cycTs) < 3000) return _cyc;
        try { _cyc = JSON.parse(store.get(K_CYCLE, 'null')); } catch (e) { _cyc = null; }
        _cycTs = t;
        return _cyc;
    }
    function setCycle(c) { _cyc = c; _cycTs = nowMs(); store.set(K_CYCLE, JSON.stringify(c)); }
    // Garante um ciclo válido para o dia operacional atual (recria se virou o dia).
    function ensureCycle() {
        const now = new Date();
        const opd = operationalDate(now);
        let c = getCycle();
        if (!c || c.opDate !== opd) {
            c = { opDate: opd, shift: shiftFromTime(now), shiftManual: false, selection: null, done: {} };
            setCycle(c);
            warnedIds = {}; beepedIds = {};
        }
        return c;
    }
    // Guarda nome (p/ filtrar a coluna Manager do relatório) e login (p/ exibir no overlay).
    function setManager(name, login) { const c = ensureCycle(); c.managerName = name || null; c.managerLogin = login || null; c.manager = login || name || null; setCycle(c); }
    function setSelection(sel) { const c = ensureCycle(); c.selection = sel; c.done = {}; setCycle(c); warnedIds = {}; beepedIds = {}; }
    function toggleDone(id) { const c = ensureCycle(); if (c.done[id]) delete c.done[id]; else c.done[id] = true; setCycle(c); }
    function reAsk() { const c = ensureCycle(); c.selection = null; c.manager = null; c.managerName = null; c.managerLogin = null; c.done = {}; setCycle(c); warnedIds = {}; beepedIds = {}; }
    const SNOOZE_MS = 5 * 60 * 1000;   // adiar no máximo 5 minutos
    function snoozeItem(id) { const c = ensureCycle(); if (!c.snooze) c.snooze = {}; c.snooze[id] = nowMs() + SNOOZE_MS; setCycle(c); }
    // Turno: automático pela hora atual (day 05:30–18:00 / night 18:00–05:30),
    // a menos que o usuário tenha trocado manualmente (fica fixo até o próximo dia operacional).
    function currentShift(c) { c = c || getCycle(); return (c && c.shiftManual) ? (c.shift || shiftFromTime(new Date())) : shiftFromTime(new Date()); }
    // Override manual do turno (trava a escolha até virar o dia operacional).
    function toggleShift() { const c = ensureCycle(); const cur = currentShift(c); c.shift = (cur === 'day') ? 'night' : 'day'; c.shiftManual = true; setCycle(c); warnedIds = {}; beepedIds = {}; }

    // ── Gate de horário: a pergunta só aparece após o Startup ────────────
    // Day: a partir de 06:10. Night: a partir de 18:10 (e segue valendo na madrugada, <05:30).
    function setupAllowedNow(shift) {
        const m = minsOf(new Date());
        if (shift === 'night') return (m >= SETUP_NIGHT_MIN) || (m < 330);
        return m >= SETUP_DAY_MIN;
    }
    function setupOpenTimeLabel(shift) { return shift === 'night' ? '18:10 (Night)' : '06:10 (Day)'; }

    // ── Gestores (nomes do ppaTimeOnTask → login do employeeRoster) ──────
    // Cache diário em GM. entries: { name, login, display }. display = login || name.
    // Roster completo (todos os status/tipos) → garante que TODO gestor apareça como employee.
    const ROSTER_URL = 'https://fclm-portal.amazon.com/employee/employeeRoster?reportFormat=HTML&warehouseId=' + WAREHOUSE
        + '&employeeStatusActive=true&_employeeStatusActive=on&employeeStatusLeaveOfAbsence=true&_employeeStatusLeaveOfAbsence=on'
        + '&employeeStatusExempt=true&_employeeStatusExempt=on&employeeTypeAmzn=true&_employeeTypeAmzn=on'
        + '&employeeTypeTemp=true&_employeeTypeTemp=on&employeeType3Pty=true&_employeeType3Pty=on'
        + '&Employee+ID=Employee+ID&User+ID=User+ID&Employee+Name=Employee+Name&Badge+Barcode+ID=Badge+Barcode+ID'
        + '&Department+ID=Department+ID&Employment+Start+Date=Employment+Start+Date&Employment+Type=Employment+Type'
        + '&Employee+Status=Employee+Status&Manager+Name=Manager+Name&Temp+Agency+Code=Temp+Agency+Code'
        + '&Job+Title=Job+Title&Management+Area+ID=Management+Area+ID&Shift+Pattern=Shift+Pattern'
        + '&Badge+RFID=Badge+RFID&Exempt=Exempt&hideColumns=Photo&submit=true';
    let mgrState = { status: 'idle', entries: [], error: '' }; // idle|loading|ok|error
    let mgrListeners = [];
    function onMgr(cb) { mgrListeners.push(cb); }
    function emitMgr() { mgrListeners.forEach(cb => { try { cb(mgrState); } catch (e) {} }); }

    // Normalização de nomes p/ casar "Sobrenome, Nome" x "Nome Sobrenome" (sem acento/caixa).
    function stripAccents(s) { try { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { return s; } }
    function normDirect(s) { return stripAccents((s || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
    function normSorted(s) { return normDirect(s).split(' ').filter(Boolean).sort().join(' '); }
    // Fallback: só 1º + último nome (ignora nomes do meio divergentes entre relatórios).
    function normLoose(s) { const t = normDirect(s).split(' ').filter(Boolean); if (t.length < 2) return t.join(' '); return [t[0], t[t.length - 1]].sort().join(' '); }

    function getNamesCache() { try { return JSON.parse(store.get(K_MGRS, 'null')); } catch (e) { return null; } }
    function setNamesCache(names) { store.set(K_MGRS, JSON.stringify({ opDate: operationalDate(new Date()), names })); store.set(K_MGRS_LAST, JSON.stringify({ names })); }
    function getLastNames() { try { const v = JSON.parse(store.get(K_MGRS_LAST, 'null')); return (v && Array.isArray(v.names)) ? v.names : []; } catch (e) { return []; } }
    function getRosterCache() { try { return JSON.parse(store.get(K_ROSTER, 'null')); } catch (e) { return null; } }
    function setRosterCache(r) { store.set(K_ROSTER, JSON.stringify({ ts: nowMs(), direct: r.direct, sorted: r.sorted, loose: r.loose })); }
    function rosterFresh(rc) { return rc && rc.direct && (nowMs() - (rc.ts || 0) < ROSTER_TTL_MS); }

    // Nomes de gestores do ppaTimeOnTask (select#managerNameFilter OU coluna "Manager").
    function extractManagerNames(doc) {
        const out = [];
        const seen = {};
        const push = (raw) => {
            const v = (raw || '').replace(/\s+/g, ' ').trim();
            if (!v) return;
            if (/^(all|todos|manager|gerente|--|select)/i.test(v)) return;
            if (/^\(?none\)?$/i.test(v)) return;   // remove "(None)" / "None"
            const k = v.toLowerCase();
            if (seen[k]) return; seen[k] = true; out.push(v);
        };
        const sel = doc.getElementById && doc.getElementById('managerNameFilter');
        if (sel && sel.options && sel.options.length > 1) {
            Array.from(sel.options).forEach(o => push(o.textContent));
        }
        if (!out.length) {
            const table = doc.querySelector('#content-penal table') || doc.querySelector('table');
            if (table) {
                const headRow = table.querySelector('tr');
                let idx = -1;
                if (headRow) {
                    const cells = Array.from(headRow.querySelectorAll('th, td'));
                    idx = cells.findIndex(c => /manager/i.test(c.textContent || ''));
                }
                if (idx >= 0) {
                    table.querySelectorAll('tr').forEach((row, ri) => {
                        if (ri === 0) return;
                        const tds = row.querySelectorAll('td');
                        if (tds.length <= idx) return;
                        const txt = tds[idx].textContent || '';
                        if (/total/i.test(txt)) return;
                        push(txt);
                    });
                }
            }
        }
        out.sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
        return out;
    }

    // Mapa nome → login (coluna "User ID") do employeeRoster.
    function extractRoster(doc) {
        const direct = {}, sorted = {}, loose = {};
        const tables = Array.from(doc.querySelectorAll('table'));
        for (const table of tables) {
            const headRow = table.querySelector('tr');
            if (!headRow) continue;
            const cells = Array.from(headRow.querySelectorAll('th, td'));
            const loginIdx = cells.findIndex(c => /user\s*id|login|alias/i.test(c.textContent || ''));
            if (loginIdx < 0) continue; // não é a tabela do roster
            let nameIdx = cells.findIndex(c => /employee\s*name|associate\s*name|full\s*name/i.test(c.textContent || ''));
            if (nameIdx < 0) nameIdx = cells.findIndex((c, i) => i !== loginIdx && /\bname\b/i.test(c.textContent || '') && !/manager/i.test(c.textContent || ''));
            if (nameIdx < 0) continue;
            table.querySelectorAll('tr').forEach((row, ri) => {
                if (ri === 0) return;
                const tds = row.querySelectorAll('td');
                if (tds.length <= Math.max(loginIdx, nameIdx)) return;
                const name = (tds[nameIdx].textContent || '').replace(/\s+/g, ' ').trim();
                const login = (tds[loginIdx].textContent || '').replace(/\s+/g, ' ').trim();
                if (!name || !login || /total/i.test(name)) return;
                const kd = normDirect(name), ks = normSorted(name), kl = normLoose(name);
                if (kd && !direct[kd]) direct[kd] = login;
                if (ks && !sorted[ks]) sorted[ks] = login;
                if (kl && !(kl in loose)) loose[kl] = login; else if (kl && loose[kl] !== login) loose[kl] = null; // ambíguo → descarta
            });
            if (Object.keys(direct).length) break;
        }
        return { direct, sorted, loose };
    }

    // Junta nomes (TOT) + roster → entries com login; display = login || name.
    function buildEntries(names, roster) {
        const entries = [];
        const seen = {};
        (names || []).forEach(name => {
            let login = '';
            if (roster) login = roster.direct[normDirect(name)] || roster.sorted[normSorted(name)] || (roster.loose && roster.loose[normLoose(name)]) || '';
            const display = login || name;
            const key = display.toLowerCase();
            if (seen[key]) return; seen[key] = true;
            entries.push({ name, login, display });
        });
        entries.sort((a, b) => a.display.localeCompare(b.display, 'pt-BR', { sensitivity: 'base' }));
        return entries;
    }

    // Busca genérica de HTML via GM_xmlhttpRequest.
    function fetchHtml(url, cb) {
        if (typeof GM_xmlhttpRequest !== 'function') { cb(null, 'GM_xmlhttpRequest indisponível.'); return; }
        try {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 30000,
                onload: (resp) => {
                    if (resp.status < 200 || resp.status >= 300) { cb(null, 'HTTP ' + resp.status + ' — faça login no FCLM (midway).'); return; }
                    try { cb(new DOMParser().parseFromString(resp.responseText, 'text/html'), ''); }
                    catch (e) { cb(null, 'Falha ao ler a resposta.'); }
                },
                onerror: () => cb(null, 'Erro de rede ao acessar o FCLM.'),
                ontimeout: () => cb(null, 'Tempo esgotado ao acessar o FCLM.'),
            });
        } catch (e) { cb(null, 'Falha ao iniciar a busca.'); }
    }

    // Carrega o Roster (mapa nome→login). Usa cache enquanto fresco (TTL); senão busca.
    // cb(roster|null, err). Sempre entrega o cache antigo como fallback se a busca falhar.
    function loadRoster(force, cb) {
        const rc = getRosterCache();
        if (!force && rosterFresh(rc)) { if (cb) cb(rc, ''); return; }
        fetchHtml(ROSTER_URL, (doc, err) => {
            if (!doc) { if (cb) cb((rc && rc.direct) ? rc : null, err || 'Roster indisponível.'); return; }
            const roster = extractRoster(doc);
            if (Object.keys(roster.direct).length) { setRosterCache(roster); if (cb) cb(getRosterCache(), ''); }
            else if (cb) cb((rc && rc.direct) ? rc : null, 'coluna User ID não encontrada.');
        });
    }

    // Prefetch da tarde: baixa o Roster 1x por dia (janela 13:00–17:00) p/ acelerar a manhã.
    function maybePrefetchRoster() {
        const now = new Date(), m = minsOf(now), opd = operationalDate(now);
        if (m < PREFETCH_START_MIN || m > PREFETCH_END_MIN) return;
        if (store.get(K_PREFETCH, '') === opd) return;               // já feito hoje
        const lastTry = parseInt(store.get(K_PREFETCH_TRY, '0'), 10) || 0;
        if (nowMs() - lastTry < PREFETCH_RETRY_MS) return;           // throttle entre tentativas
        store.set(K_PREFETCH_TRY, String(nowMs()));
        loadRoster(true, (roster) => { if (roster && roster.direct) store.set(K_PREFETCH, opd); });
    }

    // Carrega gestores: nomes de hoje (TOT) + logins (Roster, do cache quando possível).
    function loadManagers(force) {
        const opd = operationalDate(new Date());
        const nc = getNamesCache(), rc = getRosterCache();
        const namesOk = nc && nc.opDate === opd && Array.isArray(nc.names) && nc.names.length;
        const rosterPresent = rc && rc.direct;

        // Caminho rápido: nomes de hoje em cache + roster disponível → exibe já.
        if (!force && namesOk && rosterPresent) {
            mgrState = { status: 'ok', entries: buildEntries(nc.names, rc), error: '' }; emitMgr();
            // Se o roster estiver velho, atualiza em segundo plano sem travar a tela.
            if (!rosterFresh(rc)) loadRoster(false, (roster) => {
                if (roster) { mgrState = { status: 'ok', entries: buildEntries(nc.names, roster), error: '' }; emitMgr(); }
            });
            return;
        }
        if (mgrState.status === 'loading') return;
        // Fallback: entradas já em memória → hoje → última lista salva (ontem).
        const baseNames = namesOk ? nc.names : getLastNames();
        const prior = mgrState.entries.length ? mgrState.entries : buildEntries(baseNames, rosterPresent ? rc : null);
        mgrState = { status: 'loading', entries: prior, error: '' }; emitMgr();

        const withNames = (names) => {
            loadRoster(force, (roster, rErr) => {
                const entries = buildEntries(names, roster);
                if (!entries.length) { mgrState = { status: 'error', entries: prior, error: 'Nenhum gestor encontrado no relatório de hoje.' }; emitMgr(); return; }
                mgrState = { status: 'ok', entries, error: (rErr && !roster) ? ('Logins indisponíveis: ' + rErr) : '' }; emitMgr();
            });
        };

        // Nomes de gestores presentes hoje (TOT) — sempre do dia.
        if (!force && namesOk) { withNames(nc.names); return; }
        fetchHtml(PPA_TOT_URL, (doc, err) => {
            if (!doc) {
                const msg = /401|403/.test(err || '') ? 'Faça login no FCLM (midway) e toque em Atualizar.' : (err || 'Falha ao acessar o FCLM.');
                mgrState = { status: 'error', entries: prior, error: msg + (prior.length ? ' Mostrando a lista de ontem.' : '') }; emitMgr(); return;
            }
            const names = extractManagerNames(doc);
            if (!names.length) { mgrState = { status: 'error', entries: prior, error: 'Nenhum gestor encontrado no relatório de hoje.' }; emitMgr(); return; }
            setNamesCache(names);
            withNames(names);
        });
    }

    // ── Estado atual ─────────────────────────────────────────────────────
    let menuOpen = false, menuVisible = false, warnedIds = {}, beepedIds = {}, listFilter = '', chkTab = 'tasks';
    let audioCtx = null, centered = false, setupPostponed = false, manualSetup = false, lastListSig = '';
    // Lembrete de hora cheia: guarda a última hora (0–23) em que o menu abriu sozinho,
    // para abrir só 1x por hora quando o overlay está no modo círculo (menu fechado).
    let lastAutoOpenHour = new Date().getHours();

    function computeState() {
        const c = ensureCycle();
        if (!c.selection || !SEL_LABEL[c.selection]) {
            return { needSetup: true, shift: currentShift(c), manager: c.manager || null, items: [], total: 0, doneCount: 0, pct: 0, overdue: [], warning: [] };
        }
        const shift = currentShift(c), done = c.done || {}, snoozeMap = c.snooze || {}, t = nowMs();
        let list = checklistFor(c.selection).filter(a => !(a.dayOnly && shift !== 'day'));
        const items = list.map((a, idx) => {
            const id = c.selection + '_' + idx;
            const hhmm = (shift === 'night') ? (a.night || null) : (a.day || null);
            const ts = alertTs(c.opDate, shift, hhmm);
            const secsLeft = ts ? Math.round((ts - t) / 1000) : null;
            // Done: periódico (semana/quinzena) para itens com periodKey; senão diário.
            const periodKey = a.periodKey || null;
            const periodId = periodKey ? periodIdFor(a.periodType) : null;
            const isDone = periodKey ? periodicIsDone(periodKey, periodId) : !!done[id];
            const snoozeUntil = snoozeMap[id] || 0;
            const snoozed = !isDone && t < snoozeUntil;
            const desc = (typeof a.d === 'function') ? a.d(c.selection) : (a.d || null);
            return {
                id, label: a.t, desc: desc, url: a.url || null, apolloMetric: a.apolloMetric || null,
                periodKey: periodKey, periodId: periodId, alert: hhmm || null, ts,
                done: isDone, secsLeft,
                snoozed, snoozeLeft: snoozed ? Math.round((snoozeUntil - t) / 1000) : 0,
                overdue: !!ts && !isDone && !snoozed && t >= ts,
                warning: !!ts && !isDone && !snoozed && secsLeft > 0 && secsLeft <= WARN_SEC,
            };
        });
        // Itens pessoais adicionados pelo usuário (aba "Adicionar") — done por dia como os demais.
        // Alerta opcional (ci.alert = 'HH:MM') ancorado no dia operacional/turno, igual aos itens fixos.
        getCustom().forEach(ci => {
            const id = 'cust_' + ci.id;
            const hhmm = ci.alert || null;
            const ts = alertTs(c.opDate, shift, hhmm);
            const secsLeft = ts ? Math.round((ts - t) / 1000) : null;
            const isDone = !!done[id];
            const snoozeUntil = snoozeMap[id] || 0;
            const snoozed = !isDone && t < snoozeUntil;
            items.push({
                id: id, label: ci.t, desc: null, url: ci.url || null, apolloMetric: null, periodKey: null, periodId: null,
                alert: hhmm, ts: ts, done: isDone, secsLeft: secsLeft,
                snoozed: snoozed, snoozeLeft: snoozed ? Math.round((snoozeUntil - t) / 1000) : 0,
                overdue: !!ts && !isDone && !snoozed && t >= ts,
                warning: !!ts && !isDone && !snoozed && secsLeft > 0 && secsLeft <= WARN_SEC,
                custom: true, customId: ci.id,
            });
        });
        const total = items.length, doneCount = items.filter(i => i.done).length;
        const pct = total ? Math.round((doneCount / total) * 100) : 0;
        const overdue = items.filter(i => i.overdue).sort((a, b) => a.ts - b.ts);
        const warning = items.filter(i => i.warning);
        return { needSetup: false, selection: c.selection, manager: c.manager || null, shift, items, total, doneCount, pct, overdue, warning };
    }

    // ── Helpers de UI (CSSOM — seguro sob CSP) ───────────────────────────
    const FF = "font-family:'Segoe UI',Arial,sans-serif;";
    function el(tag, cssText, text) {
        const e = document.createElement(tag);
        if (cssText) e.style.cssText = cssText;
        if (text != null) e.textContent = text;
        return e;
    }
    function fadeIn(node, ms, dy) {
        if (!node || !node.animate) return;
        try { node.animate([{ opacity: 0, transform: 'translateY(' + (dy || 0) + 'px)' }, { opacity: 1, transform: 'none' }], { duration: ms || 160, easing: 'ease' }); } catch (e) {}
    }
    function fadeOut(node, ms, cb) {
        if (!node) return;
        if (!node.animate) { if (cb) cb(); return; }
        try { const a = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms || 140, easing: 'ease' }); a.onfinish = () => { if (cb) cb(); }; a.oncancel = () => { if (cb) cb(); }; }
        catch (e) { if (cb) cb(); }
    }
    function startPulse(node) {
        if (!node || node._pulse || !node.animate) return;
        try { node._pulse = node.animate([{ boxShadow: '0 0 0 0 rgba(204,0,0,.55)' }, { boxShadow: '0 0 0 16px rgba(204,0,0,0)' }], { duration: 1500, iterations: Infinity }); } catch (e) {}
    }
    function stopPulse(node) { if (node && node._pulse) { try { node._pulse.cancel(); } catch (e) {} node._pulse = null; } }
    function beep() {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const t0 = audioCtx.currentTime;
            [0, 0.30].forEach(function (off) {
                const o = audioCtx.createOscillator(), g = audioCtx.createGain();
                o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
                const t = t0 + off;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
                o.start(t); o.stop(t + 0.24);
            });
        } catch (e) {}
    }
    function fmtLeft(s) {
        if (s <= 0) return '';
        if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
        if (s >= 60) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
        return s + 's';
    }
    function openUrl(url) { try { window.open(url, '_blank', 'noopener'); } catch (e) { location.href = url; } }

    // ── Elementos ────────────────────────────────────────────────────────
    let fab, fabWater, fabPct, menu, listEl, hdPct, hdSub, hdSubTxt, take, modeBtn, setupEl, helpEl, searchInput;
    let chkTabBtnTasks, chkTabBtnAdd, addInput, chkSearchBar;

    function buildUI() {
        const sz = FAB_SIZE;
        // z-index do círculo MAIOR que o do menu → o círculo nunca fica atrás/abaixo da lista.
        fab = el('div', 'position:fixed;top:100px;left:16px;z-index:2147483350;width:' + sz + 'px;height:' + sz + 'px;'
            + 'border-radius:50%;cursor:pointer;overflow:hidden;box-shadow:0 5px 16px rgba(0,0,0,.45);'
            + 'background:#1b2733;border:2px solid rgba(255,255,255,.16);' + FF + 'transition:transform .15s ease;');
        fab.id = 'chkmec-fab';
        fab.title = 'Mini checklist Mecanismos — clique para abrir, arraste para mover';
        fab.setAttribute('role', 'button');
        fab.setAttribute('aria-label', 'Mini checklist Mecanismos (abrir/fechar)');
        // Camada de água: altura = %, transição suave (fluido) + ondas girando.
        fabWater = el('div', 'position:absolute;left:0;right:0;bottom:0;height:0%;background:#ff9900;'
            + 'transition:height .9s cubic-bezier(.34,1.1,.3,1),background .4s ease;');
        const wave1 = el('div', 'position:absolute;left:-50%;top:-13px;width:200%;height:200%;background:rgba(255,255,255,.22);border-radius:43%;');
        const wave2 = el('div', 'position:absolute;left:-50%;top:-9px;width:200%;height:200%;background:rgba(255,255,255,.12);border-radius:47%;');
        fabWater.appendChild(wave1); fabWater.appendChild(wave2);
        try { wave1.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 7000, iterations: Infinity }); } catch (e) {}
        try { wave2.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-360deg)' }], { duration: 11000, iterations: Infinity }); } catch (e) {}
        fab.appendChild(fabWater);
        const core = el('div', 'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;'
            + 'align-items:center;justify-content:center;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.55);pointer-events:none;');
        fabPct = el('span', 'font-size:19px;font-weight:800;line-height:1;', '0%');
        core.appendChild(fabPct);
        core.appendChild(el('span', 'font-size:8px;letter-spacing:.06em;opacity:.85;margin-top:2px;', 'FEITO'));
        fab.appendChild(core);
        fab.addEventListener('mouseenter', () => { if (!dragging) fab.style.transform = 'scale(1.06)'; });
        fab.addEventListener('mouseleave', () => { if (!dragging) fab.style.transform = 'none'; });
        document.body.appendChild(fab);
        // Sem animação de entrada: aparece instantâneo na posição salva (não "pisca" ao trocar de página).
        wireDrag();

        // Paleta clara padronizada com o painel Time On Task.
        menu = el('div', 'position:fixed;top:180px;left:16px;z-index:2147483000;width:340px;max-height:82vh;'
            + 'display:none;flex-direction:column;background:#EEF1F4;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden;' + AMZ);
        menu.id = 'chkmec-menu';

        const hd = el('div', 'background:linear-gradient(135deg,#2C3E50,#232F3E 55%,#131921);padding:12px 14px;color:#fff;');
        const hdTop = el('div', 'display:flex;align-items:center;gap:8px;');
        hdTop.appendChild(el('span', 'font-size:16px;', '🗒️'));
        hdTop.appendChild(el('span', 'font-size:14px;font-weight:800;flex:1;', 'Mini checklist Mecanismos'));
        const help = el('button', 'width:24px;height:24px;border-radius:8px;border:none;background:rgba(255,255,255,.14);'
            + 'color:#fff;font-weight:800;cursor:pointer;line-height:1;padding:0;flex:none;' + AMZ, '?');
        help.title = 'Sobre este checklist';
        help.setAttribute('aria-label', 'Sobre este checklist');
        help.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp(); });
        hdTop.appendChild(help);
        hdPct = el('span', 'font-size:12px;font-weight:800;color:#FEBD69;margin-left:6px;', '0%');
        hdTop.appendChild(hdPct);
        const mClose = el('button', 'width:24px;height:24px;border-radius:8px;border:none;background:#cc0000;'
            + 'color:#fff;font-weight:800;cursor:pointer;line-height:1;padding:0;flex:none;margin-left:2px;' + AMZ, '✕');
        mClose.title = 'Fechar (voltar ao círculo)';
        mClose.addEventListener('click', (e) => { e.stopPropagation(); menuOpen = false; render(); });
        hdTop.appendChild(mClose);
        hd.appendChild(hdTop);
        hdSub = el('div', 'display:flex;align-items:center;gap:8px;font-size:11px;color:#CBD8E6;margin-top:7px;');
        hdSubTxt = el('span', 'flex:1;', '');
        const shiftBtn = el('button', 'flex:none;background:rgba(255,255,255,.14);border:none;color:#fff;border-radius:8px;'
            + 'padding:4px 9px;cursor:pointer;font-size:10.5px;font-weight:700;' + AMZ, '⇄ Turno');
        shiftBtn.title = 'Alternar turno (Day/Night) manualmente';
        shiftBtn.setAttribute('aria-label', 'Alternar turno Day ou Night');
        shiftBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleShift(); render(); });
        hdSub.appendChild(hdSubTxt); hdSub.appendChild(shiftBtn);
        hd.appendChild(hdSub);
        menu.appendChild(hd);

        const modeBar = el('div', 'display:flex;align-items:center;gap:8px;padding:8px 12px;'
            + 'background:#fff;border-bottom:1px solid #E8E8E8;font-size:11px;color:#5B6B7B;');
        modeBar.appendChild(el('span', 'flex:none;font-weight:700;', 'Modo:'));
        modeBtn = el('button', 'flex:1;background:#EAEDF0;border:1px solid #CBD3DB;color:#232F3E;border-radius:8px;'
            + 'padding:6px 8px;cursor:pointer;font-size:11.5px;font-weight:800;' + AMZ, 'Alerta');
        modeBtn.title = 'Alternar entre Alerta (trava + som) e Silencioso (sem travar)';
        modeBtn.setAttribute('aria-label', 'Alternar modo Alerta ou Silencioso');
        modeBtn.addEventListener('click', () => { setMode(getMode() === 'alert' ? 'silent' : 'alert'); if (getMode() === 'silent') hideTakeover(); render(); });
        modeBar.appendChild(modeBtn);
        menu.appendChild(modeBar);

        // Campo de busca: filtra as tarefas da lista pelo texto digitado.
        const searchBar = el('div', 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fff;border-bottom:2px solid #FF9900;');
        searchBar.appendChild(el('span', 'flex:none;font-size:12px;opacity:.7;', '🔎'));
        searchInput = el('input', 'flex:1;min-width:0;background:#fff;border:1px solid #CBD3DB;color:#232F3E;border-radius:8px;padding:6px 10px;font-size:12px;outline:none;' + AMZ);
        searchInput.type = 'text';
        searchInput.placeholder = 'Pesquisar tarefa…';
        searchInput.setAttribute('aria-label', 'Pesquisar tarefa na lista');
        searchInput.addEventListener('input', () => { listFilter = searchInput.value.trim().toLowerCase(); lastListSig = ''; render(); });
        searchInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { searchInput.value = ''; listFilter = ''; lastListSig = ''; render(); } });
        searchBar.appendChild(searchInput);
        menu.appendChild(searchBar);
        chkSearchBar = searchBar;

        // Abas: Tarefas · ➕ Adicionar (itens pessoais).
        const chkTabs = el('div', 'display:flex;background:#fff;border-bottom:1px solid #E8E8E8;');
        const mkChkTab = (key, label) => {
            const t = el('button', 'flex:1;background:transparent;border:none;border-bottom:3px solid transparent;'
                + 'padding:9px 6px;cursor:pointer;font-size:12px;font-weight:800;color:#5B6B7B;' + AMZ, label);
            t.addEventListener('click', (e) => { e.stopPropagation(); chkTab = key; lastListSig = ''; styleChkTabs(); render(); });
            return t;
        };
        chkTabBtnTasks = mkChkTab('tasks', '✓ Tarefas');
        chkTabBtnAdd = mkChkTab('add', '➕ Adicionar');
        chkTabs.appendChild(chkTabBtnTasks); chkTabs.appendChild(chkTabBtnAdd);
        menu.appendChild(chkTabs);

        listEl = el('div', 'flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px;background:#EEF1F4;');
        menu.appendChild(listEl);
        styleChkTabs();

        const ft = el('div', 'padding:9px 12px;background:#fff;border-top:1px solid #E8E8E8;display:flex;justify-content:space-between;'
            + 'align-items:center;gap:8px;font-size:11px;color:#7C8B99;');
        const chg = el('button', 'background:#EAEDF0;border:1px solid #CBD3DB;color:#232F3E;border-radius:8px;'
            + 'padding:5px 9px;cursor:pointer;font-size:11px;font-weight:700;' + AMZ, '↺ Trocar fluxo');
        chg.title = 'Perguntar novamente (gestor + cargo)';
        chg.setAttribute('aria-label', 'Trocar fluxo (perguntar novamente)');
        chg.addEventListener('click', () => { manualSetup = true; reAsk(); render(); });
        ft.appendChild(el('span', 'flex:1;', 'Clique na tarefa para marcar/desmarcar'));
        ft.appendChild(chg);
        menu.appendChild(ft);
        document.body.appendChild(menu);

        applyPos();
        buildRing();
    }

    // ── Anel "Time On Task" (2º anel no círculo) + badge ─────────────────
    const RING_EXTRA = 12;   // quanto o anel extrapola o círculo
    function positionRing() {
        if (!fab) return;
        const r = fab.getBoundingClientRect();
        if (totRing) {
            totRing.style.left = Math.round(r.left - RING_EXTRA / 2) + 'px';
            totRing.style.top = Math.round(r.top - RING_EXTRA / 2) + 'px';
            totRing.style.width = Math.round(r.width + RING_EXTRA) + 'px';
            totRing.style.height = Math.round(r.height + RING_EXTRA) + 'px';
        }
        if (totBadge) {
            totBadge.style.left = Math.round(r.right - 12) + 'px';
            totBadge.style.top = Math.round(r.top - 6) + 'px';
        }
    }
    function buildRing() {
        if (document.getElementById('chkmec-ring')) {
            totRing = document.getElementById('chkmec-ring');
            totBadge = document.getElementById('chkmec-badge');
            return;
        }
        totRing = el('div', 'position:fixed;z-index:2147483349;pointer-events:none;border-radius:50%;'
            + 'box-sizing:border-box;border:3px solid transparent;display:none;');
        totRing.id = 'chkmec-ring';
        document.body.appendChild(totRing);
        totBadge = el('div', 'position:fixed;z-index:2147483360;pointer-events:none;min-width:20px;height:20px;'
            + 'padding:0 6px;border-radius:10px;background:#cc0000;color:#fff;font-size:11px;font-weight:800;'
            + 'display:none;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.45);' + FF);
        totBadge.id = 'chkmec-badge';
        document.body.appendChild(totBadge);
        positionRing();
    }

    // Menu do checklist fixo no mesmo canto do painel Time On Task (inferior-esquerdo).
    function positionMenu() {
        if (!menu) return;
        menu.style.left = '16px';
        menu.style.right = 'auto';
        menu.style.top = 'auto';
        menu.style.bottom = '72px';
    }
    function applyPos() {
        let left = 16, top = 100;
        const p = getPos();
        if (p && typeof p.left === 'number' && typeof p.top === 'number') { left = p.left; top = p.top; }
        left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - FAB_SIZE));
        top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - FAB_SIZE));
        fab.style.left = left + 'px'; fab.style.top = top + 'px';
        positionRing();
        positionMenu();
    }
    // Um overlay (checklist ou Time On Task) está aberto? → o círculo/anel somem.
    function overlayOpen() { return !!assocEl || (!!menu && menuVisible); }
    // Aplica a visibilidade do grupo (círculo + anel + badge) conforme overlay aberto.
    function applyGroupVisibility() {
        const hide = overlayOpen();
        if (fab) fab.style.display = hide ? 'none' : '';
        if (hide) { if (totRing) totRing.style.display = 'none'; if (totBadge) totBadge.style.display = 'none'; }
    }
    let dragging = false, moved = false, offX = 0, offY = 0, docDragWired = false;
    function wireDrag() {
        fab.addEventListener('mousedown', e => {
            dragging = true; moved = false;
            const r = fab.getBoundingClientRect();
            offX = e.clientX - r.left; offY = e.clientY - r.top;
            fab.style.transition = 'none'; fab.style.transform = 'none';
            e.preventDefault();
        });
        if (docDragWired) return;
        docDragWired = true;
        document.addEventListener('mousemove', e => {
            if (!dragging || !fab) return;
            moved = true;
            let fabLeft = e.clientX - offX, fabTop = e.clientY - offY;
            fabLeft = Math.min(Math.max(0, fabLeft), window.innerWidth - fab.offsetWidth);
            fabTop = Math.min(Math.max(0, fabTop), window.innerHeight - fab.offsetHeight);
            fab.style.left = fabLeft + 'px'; fab.style.top = fabTop + 'px';
            positionRing(); positionMenu(); if (radialEl) hideRadial();
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            if (fab) fab.style.transition = 'transform .15s ease';
            if (moved) { const r = fab.getBoundingClientRect(); setPos({ left: Math.round(r.left), top: Math.round(r.top) }); }
            else {
                const c = ensureCycle();
                if (!c.selection) {
                    // Sem fluxo → só abre a pergunta após o Startup (06:10 Day / 18:10 Night).
                    if (setupAllowedNow(currentShift(c)) || manualSetup) { setupPostponed = false; showSetup(); }
                    else { toast('A seleção de gestor/cargo abre às ' + setupOpenTimeLabel(currentShift(c)) + ', após o Startup.'); }
                }
                else if (totEnabled()) {   // OPS/AM → mini-menu radial (Checklist / Time On Task)
                    if (menuOpen) menuOpen = false;
                    else if (radialEl) hideRadial();
                    else showRadial();
                }
                else { menuOpen = !menuOpen; }   // PA → abre direto o checklist
                render();
            }
        });
    }

    // ── Toast ─────────────────────────────────────────────────────────────
    function toast(msg, ms) {
        const tEl = el('div', 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483600;'
            + 'background:#12202e;color:#e6edf3;border:1px solid #52708c;border-radius:10px;padding:12px 16px;'
            + 'max-width:80vw;box-shadow:0 10px 30px rgba(0,0,0,.5);font-size:13px;line-height:1.5;' + FF, msg);
        document.body.appendChild(tEl);
        fadeIn(tEl, 160);
        setTimeout(() => fadeOut(tEl, 220, () => tEl.remove()), ms || 7000);
    }

    // ── Ajuda (objetivo do checklist) ────────────────────────────────────
    function toggleHelp() {
        if (helpEl) { const h = helpEl; helpEl = null; fadeOut(h, 140, () => h.remove()); return; }
        helpEl = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483500;background:rgba(5,10,18,.6);'
            + 'display:flex;align-items:center;justify-content:center;' + AMZ);
        const box = el('div', 'width:min(460px,90vw);background:#EEF1F4;border-radius:14px;overflow:hidden;'
            + 'box-shadow:0 20px 60px rgba(0,0,0,.5);');
        const hh = el('div', 'background:linear-gradient(135deg,#2C3E50,#232F3E 55%,#131921);color:#fff;padding:14px 18px;'
            + 'font-size:16px;font-weight:800;', 'ℹ️ Sobre este checklist');
        box.appendChild(hh);
        const bd = el('div', 'padding:18px;');
        bd.appendChild(el('p', 'font-size:13px;line-height:1.6;color:#37475A;margin:0 0 10px;',
            'Este mini-checklist serve para NÃO esquecer as tarefas de maior impacto do turno de Mecanismos. Marque cada item ao concluir (clique no texto ou na caixa). Itens com horário disparam alerta pela hora atual — no modo Alerta a tela é travada e toca um bip 1 minuto antes. Use os botões 🔗 para abrir cada atividade.'));
        bd.appendChild(el('p', 'font-size:12.5px;line-height:1.6;color:#5B6B7B;margin:0 0 16px;',
            'Após o Startup (06:10 no Day / 18:10 no Night) o app pergunta quem é o seu gestor e o seu cargo (PA, OPS ou AM). A lista de gestores é puxada do FCLM (ppaTimeOnTask) e o nome é convertido no login pelo Roster (coluna User ID). Se a lista não carregar, faça login no FCLM (midway) e use “↻ Atualizar”.'));
        box.appendChild(bd);
        const close = el('button', 'display:block;margin:0 18px 18px auto;background:#FF9900;color:#131921;border:1px solid #E88B00;'
            + 'border-radius:9px;padding:9px 18px;font-weight:800;cursor:pointer;' + AMZ, 'Entendi');
        close.addEventListener('click', () => toggleHelp());
        box.appendChild(close);
        helpEl.appendChild(box);
        helpEl.addEventListener('click', (e) => { if (e.target === helpEl) toggleHelp(); });
        document.body.appendChild(helpEl);
        fadeIn(helpEl, 160);
    }

    // ── Setup: pergunta de fluxo (PA / OPS / AM) ─────────────────────────
    function hideSetup() { if (setupEl) { const s = setupEl; setupEl = null; if (s._mgrRetry) clearInterval(s._mgrRetry); s.remove(); } }
    function bigBtn(label, bg, cb) {
        const b = el('button', 'display:block;width:100%;margin:8px 0;padding:13px;border:none;border-radius:11px;'
            + 'font-size:15px;font-weight:800;cursor:pointer;color:#fff;background:' + bg + ';' + FF, label);
        b.addEventListener('mouseenter', () => b.style.filter = 'brightness(1.08)');
        b.addEventListener('mouseleave', () => b.style.filter = 'none');
        b.addEventListener('click', cb);
        return b;
    }
    let mgrFilter = '';
    function renderSetupStep(step) {
        const card = setupEl._card; card.textContent = '';
        setupEl._step = step;
        const c = ensureCycle();
        card.appendChild(el('div', 'font-size:20px;font-weight:800;color:#ffce7a;margin-bottom:4px;', '🗒️ Mini checklist Mecanismos'));
        card.appendChild(el('div', 'font-size:12px;color:#9fb3c8;margin-bottom:16px;',
            'Turno detectado: ' + (currentShift(c) === 'day' ? '☀️ Day (05:30–18:00)' : '🌙 Night (18:00–05:30)')));

        if (step === 1) {
            card.appendChild(el('div', 'font-size:15px;font-weight:700;margin-bottom:4px;', 'Quem é o seu gestor?'));
            card.appendChild(el('div', 'font-size:11px;color:#8aa1b6;margin-bottom:10px;', 'Lista de gestores presentes pelo FCLM'));

            const search = el('input', 'width:100%;box-sizing:border-box;background:#0d1b2a;border:1px solid #52708c;color:#e6edf3;'
                + 'border-radius:9px;padding:9px 11px;font-size:13px;outline:none;margin-bottom:8px;' + FF);
            search.type = 'text'; search.placeholder = '🔎 Filtrar gestor…'; search.value = mgrFilter;
            search.setAttribute('aria-label', 'Filtrar gestor');
            search.addEventListener('input', () => { mgrFilter = search.value.trim().toLowerCase(); paintMgrList(); });
            search.addEventListener('keydown', (e) => e.stopPropagation());
            card.appendChild(search);

            const status = el('div', 'font-size:11px;color:#9fb3c8;margin-bottom:6px;min-height:14px;text-align:left;');
            card.appendChild(status);

            const listBox = el('div', 'max-height:240px;overflow:auto;border:1px solid #2b3d4f;border-radius:10px;'
                + 'background:#0d1b2a;padding:4px;text-align:left;');
            card.appendChild(listBox);

            function paintMgrList() {
                const st = mgrState;
                const n = (st.entries || []).length;
                // Botão de login reflete o estado: laranja "✓ Logado" quando autenticado (dados OK).
                if (setupEl && setupEl._loginBtn) {
                    const lb = setupEl._loginBtn;
                    if (st.status === 'ok') { lb.textContent = '✓ Logado no FCLM'; lb.style.background = '#FF9900'; lb.style.borderColor = '#E88B00'; lb.style.color = '#131921'; }
                    else { lb.textContent = '🔑 Fazer login no FCLM'; lb.style.background = '#4A86C8'; lb.style.borderColor = '#3A76B8'; lb.style.color = '#fff'; }
                }
                if (st.status === 'loading' && !n) status.textContent = '⏳ Carregando gestores do FCLM…';
                else if (st.status === 'error') status.textContent = '⚠️ ' + st.error + (n ? ' (mostrando lista salva)' : '');
                else if (st.status === 'ok' || n) status.textContent = '✅ ' + n + ' gestores' + (st.error ? ' · ' + st.error : '') + (st.status === 'loading' ? ' (atualizando…)' : '');
                else status.textContent = '';
                listBox.textContent = '';
                const items = (st.entries || []).filter(e => !mgrFilter || e.display.toLowerCase().includes(mgrFilter) || e.name.toLowerCase().includes(mgrFilter));
                if (!items.length) {
                    if (st.status === 'loading') {
                        listBox.appendChild(el('div', 'padding:14px;text-align:center;color:#8aa1b6;font-size:12px;', '⏳ Buscando…'));
                    } else if (mgrFilter) {
                        listBox.appendChild(el('div', 'padding:14px;text-align:center;color:#8aa1b6;font-size:12px;', 'Nenhum gestor encontrado'));
                    } else {
                        // Nada carregado → informativo pedindo login no FCLM.
                        const info = el('div', 'padding:16px 14px;text-align:center;');
                        info.appendChild(el('div', 'font-size:26px;margin-bottom:6px;', '🔒'));
                        info.appendChild(el('div', 'font-size:13px;font-weight:800;color:#ffce7a;margin-bottom:4px;', 'Faça login no FCLM'));
                        info.appendChild(el('div', 'font-size:11.5px;line-height:1.5;color:#9fb3c8;margin-bottom:12px;',
                            'Não foi possível carregar os gestores. Faça login no FCLM (midway) e depois toque em “Atualizar”. A lista carrega sozinha quando você voltar.'));
                        const lg = el('button', 'background:#4A86C8;border:1px solid #3A76B8;color:#fff;border-radius:9px;'
                            + 'padding:9px 14px;cursor:pointer;font-size:12px;font-weight:800;' + FF, '🔑 Fazer login no FCLM');
                        lg.addEventListener('click', () => { openUrl(PPA_TOT_URL); });
                        info.appendChild(lg);
                        listBox.appendChild(info);
                    }
                } else {
                    const renderItem = (e) => {
                        const b = el('button', 'display:block;width:100%;text-align:left;background:transparent;border:none;'
                            + 'border-radius:8px;padding:8px 10px;cursor:pointer;' + FF);
                        b.appendChild(el('div', 'color:#e6edf3;font-size:13px;font-weight:700;', e.display));
                        if (e.login && e.name && e.name.toLowerCase() !== e.display.toLowerCase())
                            b.appendChild(el('div', 'color:#8aa1b6;font-size:10.5px;margin-top:1px;', e.name));
                        b.addEventListener('mouseenter', () => b.style.background = '#243444');
                        b.addEventListener('mouseleave', () => b.style.background = 'transparent');
                        b.addEventListener('click', () => { setManager(e.name, e.login); renderSetupStep(2); });
                        listBox.appendChild(b);
                    };
                    const withLogin = items.filter(e => e.login);
                    const noLogin = items.filter(e => !e.login);
                    withLogin.forEach(renderItem);
                    if (noLogin.length) {
                        listBox.appendChild(el('div', 'padding:8px 10px 4px;margin-top:4px;border-top:1px solid #2b3d4f;'
                            + 'font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#8aa1b6;',
                            'Não identificado'));
                        noLogin.forEach(renderItem);
                    }
                }
            }
            setupEl._paintMgr = paintMgrList;
            paintMgrList();

            const btnRow = el('div', 'display:flex;gap:8px;margin-top:10px;');
            const login = el('button', 'flex:1;background:#4A86C8;border:1px solid #3A76B8;color:#fff;border-radius:9px;'
                + 'padding:9px;cursor:pointer;font-size:12px;font-weight:800;' + FF, '🔑 Fazer login no FCLM');
            login.title = 'Abre o FCLM (midway) em nova aba; depois volte e a lista atualiza sozinha';
            login.addEventListener('click', () => { openUrl(PPA_TOT_URL); });
            setupEl._loginBtn = login;
            paintMgrList();   // já reflete o estado de login no botão
            const refresh = el('button', 'flex:1;background:#12202e;border:1px solid #52708c;color:#c2d2e0;border-radius:9px;'
                + 'padding:9px;cursor:pointer;font-size:12px;font-weight:700;' + FF, '↻ Atualizar lista');
            refresh.addEventListener('click', () => { loadManagers(true); });
            btnRow.appendChild(login); btnRow.appendChild(refresh);
            card.appendChild(btnRow);

            const later = el('button', 'margin-top:10px;background:transparent;border:none;color:#8aa1b6;cursor:pointer;font-size:12px;' + FF, 'Agora não (perguntar depois)');
            later.title = 'Fecha por enquanto — clique no círculo para escolher depois';
            later.addEventListener('click', () => { setupPostponed = true; hideSetup(); });
            card.appendChild(later);

            // dispara carga (usa cache do dia se houver) + auto-retry enquanto não logar.
            loadManagers(false);
            if (!setupEl._mgrRetry) setupEl._mgrRetry = setInterval(() => {
                if (!setupEl || setupEl._step !== 1) return;
                if (mgrState.status !== 'ok') loadManagers(true);   // volta a tentar (ex.: após login)
            }, 15000);
        } else {
            card.appendChild(el('div', 'font-size:12px;color:#9fb3c8;margin-bottom:12px;text-align:left;',
                '👤 Gestor: ' + (c.manager || '—')));
            card.appendChild(el('div', 'font-size:15px;font-weight:700;margin-bottom:12px;', 'Qual é o seu cargo?'));
            card.appendChild(bigBtn('PA', 'linear-gradient(180deg,#3aa0ff,#1f6fd6)', () => choose('pa')));
            card.appendChild(bigBtn('OPS', 'linear-gradient(180deg,#ffab2e,#f59e0b)', () => choose('ops')));
            card.appendChild(bigBtn('AM', 'linear-gradient(180deg,#2ecc71,#1e8449)', () => choose('am')));
            const back = el('button', 'margin-top:8px;background:transparent;border:none;color:#8aa1b6;cursor:pointer;font-size:12px;' + FF, '← Voltar (trocar gestor)');
            back.addEventListener('click', () => renderSetupStep(1));
            card.appendChild(back);
        }
    }
    function showSetup() {
        if (setupEl) return;
        setupEl = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483550;background:rgba(5,10,18,.92);'
            + 'display:flex;align-items:center;justify-content:center;' + FF);
        const card = el('div', 'width:min(460px,92vw);background:#12202e;border:2px solid #ff9900;border-radius:16px;'
            + 'padding:26px;color:#e6edf3;box-shadow:0 24px 70px rgba(0,0,0,.6);text-align:center;');
        setupEl._card = card;
        setupEl.appendChild(card);
        document.body.appendChild(setupEl);
        fadeIn(setupEl, 180); fadeIn(card, 260, 10);
        mgrFilter = '';
        renderSetupStep(1);
    }
    // Atualiza a lista de gestores na tela de setup quando o fetch termina.
    onMgr(() => { if (setupEl && setupEl._step === 1 && typeof setupEl._paintMgr === 'function') setupEl._paintMgr(); });
    function choose(sel) { setSelection(sel); manualSetup = false; hideSetup(); menuOpen = true; render(); if (sel === 'ops' || sel === 'am') loadAssociates(false); }

    // ── Linha da tarefa ──────────────────────────────────────────────────
    let hoveredLinkId = null;   // mantém o botão 🔗 preenchido mesmo quando a lista é reconstruída
    function buildRow(i) {
        const accent = i.done ? '#27AE60' : (i.overdue ? '#CC0000' : (i.warning ? '#E88B00' : '#CBD3DB'));
        const row = el('div', 'display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #E8E8E8;'
            + 'border-left:4px solid ' + accent + ';border-radius:10px;padding:9px 11px;margin-bottom:8px;'
            + 'box-shadow:0 2px 6px rgba(35,47,62,.06);cursor:pointer;opacity:' + (i.done ? '.7' : '1') + ';');
        row.addEventListener('mouseenter', () => row.style.background = '#F7FAFF');
        row.addEventListener('mouseleave', () => row.style.background = '#fff');
        row.addEventListener('click', () => { if (i.periodKey) togglePeriodic(i.periodKey, i.periodId); else toggleDone(i.id); render(); });

        const box = el('span', 'width:20px;height:20px;border-radius:6px;border:2px solid ' + (i.done ? '#27AE60' : (i.overdue ? '#CC0000' : '#B9C4CE')) + ';'
            + 'background:' + (i.done ? '#27AE60' : '#fff') + ';flex:none;display:flex;align-items:center;'
            + 'justify-content:center;font-size:13px;color:#fff;', i.done ? '✔' : '');
        row.appendChild(box);

        const mid = el('div', 'flex:1;min-width:0;');
        mid.appendChild(el('div', 'font-size:13px;font-weight:800;line-height:1.3;'
            + (i.done ? 'text-decoration:line-through;color:#8090A0;' : 'color:#232F3E;'), i.label));
        if (i.desc) mid.appendChild(el('div', 'font-size:11px;line-height:1.3;margin-top:1px;color:' + (i.done ? '#9AA7B4' : '#5B6B7B') + ';', i.desc));
        let stTxt, stColor;
        if (i.done) { stTxt = '✔ Concluído'; stColor = '#1E8449'; }
        else if (i.snoozed) { stTxt = '😴 Adiado (' + fmtLeft(i.snoozeLeft) + ')'; stColor = '#7C8B99'; }
        else if (i.overdue) { stTxt = '⛔ Atrasado (alerta ' + i.alert + ')'; stColor = '#CC0000'; }
        else if (i.warning) { stTxt = '⏰ Faça agora — alerta ' + i.alert + ' (faltam ' + fmtLeft(i.secsLeft) + ')'; stColor = '#E88B00'; }
        else if (i.alert) { stTxt = '⏰ Alerta ' + i.alert + (i.secsLeft > 0 ? ' (em ' + fmtLeft(i.secsLeft) + ')' : ''); stColor = '#7C8B99'; }
        else { stTxt = '— sem alerta'; stColor = '#9AA7B4'; }
        mid.appendChild(el('div', 'font-size:10px;font-weight:700;margin-top:2px;color:' + stColor + ';', stTxt));
        row.appendChild(mid);

        if (i.url) {
            const on = (hoveredLinkId === i.id);
            const lb = el('button', 'flex:none;background:' + (on ? '#FF9900' : '#fff') + ';border:1px solid #FF9900;color:' + (on ? '#131921' : '#FF9900') + ';border-radius:8px;'
                + 'padding:7px 9px;cursor:pointer;font-size:13px;font-weight:800;transition:background .2s ease,color .2s ease;' + AMZ, '🔗');
            lb.title = i.apolloMetric ? ('Abrir Apollo com métrica: ' + i.apolloMetric) : 'Abrir atividade';
            lb.addEventListener('mouseenter', () => { hoveredLinkId = i.id; lb.style.background = '#FF9900'; lb.style.color = '#131921'; });
            lb.addEventListener('mouseleave', () => { hoveredLinkId = null; lb.style.background = '#fff'; lb.style.color = '#FF9900'; });
            lb.addEventListener('click', (e) => { e.stopPropagation(); if (i.apolloMetric) openApolloWithMetric(i.url, i.apolloMetric); else openUrl(i.url); });
            row.appendChild(lb);
        }
        if (i.custom) {
            const rm = el('button', 'flex:none;background:#fff;border:1px solid #cc0000;color:#cc0000;border-radius:8px;'
                + 'padding:7px 9px;cursor:pointer;font-size:13px;font-weight:800;' + AMZ, '✕');
            rm.title = 'Remover este item pessoal';
            rm.addEventListener('click', (e) => { e.stopPropagation(); removeCustomItem(i.customId); lastListSig = ''; render(); });
            row.appendChild(rm);
        }
        return row;
    }

    // ── Takeover (modo Alerta) ───────────────────────────────────────────
    function showTakeover(item) {
        if (take && take._id === item.id) return;
        hideTakeover();
        take = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483600;background:rgba(8,12,18,.94);'
            + 'display:flex;align-items:center;justify-content:center;' + FF);
        take.id = 'chkmec-take'; take._id = item.id;
        const box = el('div', 'width:min(540px,92vw);background:#12202e;border:2px solid #cc0000;border-radius:18px;'
            + 'padding:30px;text-align:center;color:#fff;box-shadow:0 24px 70px rgba(0,0,0,.6);');
        box.appendChild(el('div', 'font-size:52px;', '⚠️'));
        box.appendChild(el('h2', 'margin:10px 0 4px;font-size:22px;color:#ff6b6b;', 'Atividade pendente!'));
        box.appendChild(el('div', 'font-size:18px;font-weight:800;margin:14px 0;color:#ffce7a;', item.label));
        box.appendChild(el('p', 'color:#c2d2e0;font-size:14px;margin:6px 0 22px;line-height:1.5;',
            'Passou do horário de alerta (' + (item.alert || '') + ') e a atividade ainda não foi concluída.'));
        const go = el('button', 'background:linear-gradient(180deg,#ff5252,#cc0000);color:#fff;border:none;padding:14px 26px;'
            + 'border-radius:11px;font-size:16px;font-weight:800;cursor:pointer;' + FF,
            item.url ? '▶ Abrir e marcar como feita' : '✔ Marcar como feita');
        go.addEventListener('mouseenter', () => go.style.filter = 'brightness(1.1)');
        go.addEventListener('mouseleave', () => go.style.filter = 'none');
        go.addEventListener('click', () => { if (item.url) { if (item.apolloMetric) openApolloWithMetric(item.url, item.apolloMetric); else openUrl(item.url); } if (item.periodKey) togglePeriodic(item.periodKey, item.periodId); else toggleDone(item.id); hideTakeover(); render(); });
        box.appendChild(go);
        startPulse(go);
        const sn = el('button', 'display:block;margin:12px auto 0;background:transparent;color:#c2d2e0;border:1px solid #52708c;'
            + 'padding:10px 20px;border-radius:11px;font-size:13px;font-weight:700;cursor:pointer;' + FF, '⏰ Adiar 5 min');
        sn.setAttribute('aria-label', 'Adiar esta atividade por 5 minutos');
        sn.addEventListener('mouseenter', () => sn.style.background = 'rgba(255,255,255,.08)');
        sn.addEventListener('mouseleave', () => sn.style.background = 'transparent');
        sn.addEventListener('click', () => { snoozeItem(item.id); hideTakeover(); render(); });
        box.appendChild(sn);
        box.appendChild(el('div', 'margin-top:12px;font-size:12px;color:#8aa1b6;', 'Conclua a atividade ou adie por 5 min para fechar.'));
        take.appendChild(box);
        document.body.appendChild(take);
        fadeIn(take, 200); fadeIn(box, 260, 10);
    }
    function hideTakeover() { if (!take || take._closing) return; const t = take; take._closing = true; take = null; fadeOut(t, 160, () => t.remove()); }

    // ── Menu visível (fade só na mudança) ────────────────────────────────
    function setMenuVisible(v) {
        if (v === menuVisible) return;
        menuVisible = v;
        if (v) { menu.style.display = 'flex'; positionMenu(); fadeIn(menu, 170, -8); }
        else { fadeOut(menu, 140, () => { if (!menuVisible) menu.style.display = 'none'; }); }
    }

    // ── 100% concluído: centraliza o círculo no topo + comemoração ───────
    function centerFab() {
        if (!fab) return;
        const left = Math.max(0, Math.round((window.innerWidth - fab.offsetWidth) / 2));
        fab.style.transition = 'left .5s cubic-bezier(.18,.9,.32,1.2), top .5s cubic-bezier(.18,.9,.32,1.2), transform .15s ease';
        fab.style.left = left + 'px';
        fab.style.top = '16px';
        positionMenu();
    }
    function confettiBurst() {
        const colors = ['#FF9900', '#27ae60', '#4A86C8', '#E01E5A', '#ECB22E', '#2EB67D', '#ffffff'];
        const cx = window.innerWidth / 2, cy = 40;
        for (let i = 0; i < 90; i++) {
            const c = el('div', 'position:fixed;z-index:2147483399;pointer-events:none;border-radius:2px;'
                + 'width:' + (6 + Math.random() * 8).toFixed(0) + 'px;height:' + (8 + Math.random() * 10).toFixed(0) + 'px;'
                + 'left:' + cx + 'px;top:' + cy + 'px;background:' + colors[i % colors.length] + ';');
            document.body.appendChild(c);
            const angle = Math.random() * Math.PI * 2;
            const dist = 120 + Math.random() * 280;
            const dx = Math.cos(angle) * dist;
            const dy = Math.abs(Math.sin(angle)) * dist * 0.4 + 220 + Math.random() * 340; // cai pra baixo
            const rot = (Math.random() * 720 - 360);
            const dur = 1500 + Math.random() * 1500;
            try {
                const a = c.animate(
                    [{ transform: 'translate(0,0) rotate(0deg)', opacity: 1 }, { transform: 'translate(' + dx.toFixed(0) + 'px,' + dy.toFixed(0) + 'px) rotate(' + rot.toFixed(0) + 'deg)', opacity: 0 }],
                    { duration: dur, easing: 'cubic-bezier(.2,.6,.4,1)' }
                );
                a.onfinish = () => c.remove(); a.oncancel = () => c.remove();
            } catch (e) { c.remove(); }
        }
    }
    function celebrate() {
        const b = el('div', 'position:fixed;top:96px;left:50%;transform:translateX(-50%);z-index:2147483400;'
            + 'background:linear-gradient(135deg,#2ecc71,#1e8449);color:#fff;padding:14px 28px;border-radius:14px;'
            + 'font-size:18px;font-weight:800;box-shadow:0 14px 34px rgba(0,0,0,.45);text-align:center;' + FF,
            '🎉 Parabéns! Checklist 100% concluído! 🎉');
        document.body.appendChild(b);
        fadeIn(b, 220, -12);
        confettiBurst();
        setTimeout(() => confettiBurst(), 400);
        setTimeout(() => fadeOut(b, 320, () => b.remove()), 4200);
        try { beep(); } catch (e) {}
    }

    // ═════════════════════════════════════════════════════════════════════
    // ASSOCIADOS DO GESTOR — Inferred Time > 0.70 (ppaTimeOnTask, janela do turno)
    // Estilo "onboarding hours": dashboard flutuante + refresh + CSV.
    // ═════════════════════════════════════════════════════════════════════
    const ALERT_MIN = 0.75;      // limite: lista/alerta de Inferred Time
    const AGGR_STEP = 1.0;       // a cada +1.0 acima de 0.75 → overlay agressivo (1.75, 2.75, ...)
    const AGGR_MIN = ALERT_MIN + AGGR_STEP;   // 1.75 — primeiro disparo do overlay agressivo
    const AGGR_SNOOZE_MS = 60 * 60 * 1000;    // adiar o overlay agressivo por 1 hora
    const CHECKS_ALARM = 5;      // nº de resolvidos (não desconsiderados) no dia → alarme extra
    const ASSOC_POLL_MS = 2 * 60 * 1000;  // atualiza os dados em 2º plano a cada 2 min
    const REMINDER_MS = 5 * 60 * 1000;    // lembrete (Time Off Task + Inferred) a cada 5 min
    // Apollo Audit (Seek to Understand) — link + valores para pré-preenchimento.
    const APOLLO_URL = 'https://apollo-audit.corp.amazon.com/audits/new?audit_type_id=21572';
    const APOLLO_METRIC = 'Unknown Idle Time (Tempo Ocioso Desconhecido)';
    const APOLLO_EXPECTED = '0.75';
    const K_APOLLO = 'chkmec_apollo';  // { ts, login, metric, expected, current } — prefill pendente
    const K_REMINDER = 'chkmec_reminder';  // ts do último lembrete de 5 min (persistido entre páginas)
    let assocEl = null, totRing = null, totBadge = null, assocTab = 'inferred';
    let assocTake = null, radialEl = null;   // overlay agressivo + mini-menu radial
    let assocState = { status: 'idle', rows: [], label: '', ts: 0, error: '', fallback: false }; // idle|loading|ok|error

    // Data 'YYYY/MM/DD' a partir do dia operacional (ISO 'YYYY-MM-DD'), com offset opcional.
    function ppaDateStr(opdISO, addDays) {
        const p = (opdISO || operationalDate(new Date())).split('-').map(Number);
        const d = new Date(p[0], p[1] - 1, p[2]);
        if (addDays) d.setDate(d.getDate() + addDays);
        return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    }
    // URL intraday do ppaTimeOnTask conforme o turno (Day 06:00→18:00 / Night 18:00→06:00).
    function buildTotIntradayUrl(shift, opd) {
        const sH = shift === 'night' ? 18 : 6, eH = shift === 'night' ? 6 : 18;
        const sDate = ppaDateStr(opd, 0), eDate = shift === 'night' ? ppaDateStr(opd, 1) : ppaDateStr(opd, 0);
        return 'https://fclm-portal.amazon.com/reports/ppaTimeOnTask?reportFormat=HTML&warehouseId=' + WAREHOUSE
            + '&spanType=Intraday'
            + '&startDateIntraday=' + sDate + '&startHourIntraday=' + sH + '&startMinuteIntraday=0'
            + '&endDateIntraday=' + eDate + '&endHourIntraday=' + eH + '&endMinuteIntraday=0';
    }
    function shiftWindowLabel(shift, opd) {
        return (shift === 'night' ? 'Night 18:00→06:00' : 'Day 06:00→18:00') + ' · ' + ppaDateStr(opd, 0);
    }
    // Data 'YYYY-MM-DD' (com traços) a partir do dia operacional, com offset opcional.
    function isoDateStr(opdISO, addDays) {
        const p = (opdISO || operationalDate(new Date())).split('-').map(Number);
        const d = new Date(p[0], p[1] - 1, p[2]);
        if (addDays) d.setDate(d.getDate() + addDays);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    // Link direto p/ o ppaTimeDetails do associado, na janela intraday do turno (TZ -0300).
    function buildTimeDetailsUrl(empId, shift, opd) {
        const sH = shift === 'night' ? 18 : 6, eH = shift === 'night' ? 6 : 18;
        const sDate = isoDateStr(opd, 0), eDate = shift === 'night' ? isoDateStr(opd, 1) : isoDateStr(opd, 0);
        const t = (date, h) => date + 'T' + pad(h) + '%3a00%3a00-0300';
        return 'https://fclm-portal.amazon.com/employee/ppaTimeDetails?employeeId=' + encodeURIComponent(empId)
            + '&warehouseId=' + WAREHOUSE + '&startTime=' + t(sDate, sH) + '&endTime=' + t(eDate, eH);
    }

    // Parseia a tabela do ppaTimeOnTask por cabeçalho (índices dinâmicos).
    function parsePpaTable(doc) {
        const table = doc.querySelector('#content-penal table') || doc.querySelector('table');
        if (!table) return [];
        const headRow = table.querySelector('tr');
        if (!headRow) return [];
        const heads = Array.from(headRow.querySelectorAll('th, td')).map(c => (c.textContent || '').trim().toLowerCase());
        const find = (re) => heads.findIndex(h => re.test(h));
        const col = {
            id: find(/employee\s*id/), name: find(/employee\s*name/), manager: find(/manager/),
            tot: find(/time\s*on\s*task/), inferred: find(/inferred/), total: find(/total\s*time/), pct: find(/percent/),
        };
        if (col.name < 0 || col.manager < 0 || col.inferred < 0) return [];
        const rows = [];
        Array.from(table.querySelectorAll('tr')).forEach((tr, i) => {
            if (i === 0) return;
            const tds = tr.querySelectorAll('td');
            if (!tds.length) return;
            const get = (idx) => (idx >= 0 && tds[idx]) ? (tds[idx].textContent || '').replace(/\s+/g, ' ').trim() : '';
            const name = get(col.name);
            if (!name || /^total/i.test(name)) return;
            const num = (s) => parseFloat((s || '').replace(',', '.')) || 0;
            const onTaskNum = num(get(col.tot)), totalNum = num(get(col.total)), inferredNum = num(get(col.inferred));
            // Time Off Task = Total − Time On Task − Inferred (igual ao script de Off-Task).
            rows.push({
                id: get(col.id), name, manager: get(col.manager),
                tot: get(col.tot), inferred: inferredNum,
                total: get(col.total), pct: get(col.pct),
                offTask: +(totalNum - onTaskNum - inferredNum).toFixed(4),
            });
        });
        return rows;
    }

    // Carrega os dados do relatório (janela intraday; fallback p/ padrão se não vier dado).
    function loadAssociates(force, cb) {
        if (!force && assocState.status === 'ok' && (nowMs() - assocState.ts < 90000)) { if (cb) cb(); return; }
        if (assocState.status === 'loading') { if (cb) cb(); return; }
        assocState = Object.assign({}, assocState, { status: 'loading', error: '' });
        if (assocEl) paintAssoc();
        const c = ensureCycle();
        const done = (rows, label, fallback, err) => {
            assocState = { status: err && !rows.length ? 'error' : 'ok', rows: rows || [], label: label || '', ts: nowMs(), error: err || '', fallback: !!fallback };
            if (assocEl) paintAssoc();
            if (cb) cb();
        };
        const tryDefault = (prevErr) => {
            fetchHtml(PPA_TOT_URL, (doc2, err2) => {
                if (!doc2) { done([], '', false, err2 || prevErr || 'Falha ao acessar o FCLM.'); return; }
                done(parsePpaTable(doc2), 'Padrão do relatório', true, '');
            });
        };
        fetchHtml(buildTotIntradayUrl(currentShift(c), c.opDate), (doc, err) => {
            if (!doc) { tryDefault(err); return; }
            const rows = parsePpaTable(doc);
            if (!rows.length) { tryDefault(err); return; }
            done(rows, shiftWindowLabel(currentShift(c), c.opDate), false, '');
        });
    }

    // Estado por associado (por dia): 'ack' (resolvido) | 'disc' (desconsiderado) | null.
    // Resolvido e desconsiderado são mutuamente exclusivos; ambos saem do alerta.
    function setAssocFlag(id, kind) {
        const c = ensureCycle();
        if (!c.assocAck) c.assocAck = {}; if (!c.assocDisc) c.assocDisc = {};
        delete c.assocAck[id]; delete c.assocDisc[id];
        if (kind === 'ack') c.assocAck[id] = true; else if (kind === 'disc') c.assocDisc[id] = true;
        setCycle(c);
    }
    function toggleAssocAck(id) { const c = ensureCycle(); setAssocFlag(id, (c.assocAck && c.assocAck[id]) ? null : 'ack'); }
    function toggleAssocDisc(id) { const c = ensureCycle(); setAssocFlag(id, (c.assocDisc && c.assocDisc[id]) ? null : 'disc'); }

    // Login do associado a partir do Roster (mesmo mapa usado para os gestores).
    function resolveLogin(name) {
        const rc = getRosterCache();
        if (!rc) return '';
        return (rc.direct && rc.direct[normDirect(name)]) || (rc.sorted && rc.sorted[normSorted(name)]) || (rc.loose && rc.loose[normLoose(name)]) || '';
    }

    // Associados do gestor com Inferred > 0.75 (resolvidos/desconsiderados vão para o fim).
    function assocFiltered() {
        const c = ensureCycle();
        const mgrD = normDirect(c.managerName || ''), mgrL = normLoose(c.managerName || '');
        if (!mgrD) return [];
        const ack = c.assocAck || {}, disc = c.assocDisc || {};
        return assocState.rows
            .filter(r => {
                const rm = normDirect(r.manager);
                if (!(rm === mgrD || (mgrL && normLoose(r.manager) === mgrL))) return false;
                return r.inferred > ALERT_MIN;
            })
            .sort((a, b) => { const aa = (ack[a.id] || disc[a.id]) ? 1 : 0, ab = (ack[b.id] || disc[b.id]) ? 1 : 0; if (aa !== ab) return aa - ab; return b.inferred - a.inferred; });
    }

    // Alerta: associados > 0.75 que não foram resolvidos nem desconsiderados.
    function assocAlertList() {
        const c = ensureCycle();
        if (!c.selection || !c.managerName) return [];
        const ack = c.assocAck || {}, disc = c.assocDisc || {};
        return assocFiltered().filter(r => !ack[r.id] && !disc[r.id]);
    }

    // Aba 2: associados do gestor com QUALQUER Time Off Task (dados > 0), ordenado desc.
    function assocOffTaskList() {
        const c = ensureCycle();
        const mgrD = normDirect(c.managerName || ''), mgrL = normLoose(c.managerName || '');
        if (!mgrD) return [];
        return assocState.rows
            .filter(r => {
                const rm = normDirect(r.manager);
                if (!(rm === mgrD || (mgrL && normLoose(r.manager) === mgrL))) return false;
                return (r.offTask || 0) > 0.01;
            })
            .sort((a, b) => b.offTask - a.offTask);
    }

    // Abre um Apollo genérico já com a métrica (Benchmarking) pré-selecionada.
    function openApolloWithMetric(url, metric) {
        store.set(K_APOLLO, JSON.stringify({ ts: nowMs(), login: '', metric: metric || '', expected: '', current: '' }));
        openUrl(url);
    }

    // ── Apollo Audit: abre o formulário e agenda o pré-preenchimento ─────
    function openApolloAudit(r) {
        const login = resolveLogin(r.name);
        store.set(K_APOLLO, JSON.stringify({
            ts: nowMs(), login: login || '', metric: APOLLO_METRIC,
            expected: APOLLO_EXPECTED, current: r.inferred.toFixed(2),
        }));
        openUrl(APOLLO_URL);
        if (!login) toast('Login do associado não encontrado no Roster — preencha manualmente no Apollo.');
    }

    // Módulo que roda na página do Apollo e preenche os campos do formulário.
    function apolloAutofill() {
        if (!/^https?:\/\/apollo-audit\.corp\.amazon\.com\/audits\/new/i.test(location.href)) return;
        let data; try { data = JSON.parse(store.get(K_APOLLO, 'null')); } catch (e) { data = null; }
        if (!data || (nowMs() - (data.ts || 0) > 10 * 60 * 1000)) return;   // só se recente (10 min)

        const nrm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        function setReactValue(elm, value) {
            try {
                const proto = elm.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                setter.call(elm, value);
            } catch (e) { elm.value = value; }
            elm.dispatchEvent(new Event('input', { bubbles: true }));
            elm.dispatchEvent(new Event('change', { bubbles: true }));
            elm.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        function selectByText(sel, sub) {
            const s = nrm(sub);
            const opt = Array.from(sel.options).find(o => nrm(o.textContent).includes(s));
            if (!opt) return false;
            sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true;
        }
        // Descobre o rótulo de um controle olhando o texto imediatamente anterior.
        function labelOf(ctrl) {
            let node = ctrl;
            for (let up = 0; up < 6 && node; up++) {
                let p = node.previousElementSibling;
                while (p) { const t = nrm(p.textContent); if (t) return t; p = p.previousElementSibling; }
                node = node.parentElement;
            }
            return '';
        }
        function fill(subs, value, isSelect) {
            const ctrls = Array.from(document.querySelectorAll('input:not([type=hidden]),select,textarea'));
            for (const ct of ctrls) {
                const lab = labelOf(ct);
                if (subs.some(s => lab.includes(s))) {
                    if (isSelect && ct.tagName === 'SELECT') return selectByText(ct, value);
                    if (ct.tagName === 'SELECT') return selectByText(ct, value);
                    setReactValue(ct, value); return true;
                }
            }
            return false;
        }

        // Preenche só os campos que vieram (login/métrica/esperado/atual podem estar vazios).
        const want = { login: !!data.login, metric: !!data.metric, expected: !!data.expected, current: !!data.current };
        const doneF = { login: false, metric: false, expected: false, current: false };
        const metricSub = (data.metric || '').split('(')[0].trim().toLowerCase();  // ex.: "unknown idle time"
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (want.login && !doneF.login) {
                const byPh = document.querySelector('input[placeholder*="associate login" i], input[placeholder*="login" i]');
                if (byPh) { setReactValue(byPh, data.login); doneF.login = true; }
                else doneF.login = fill(['login do(a) associado', 'login do associado', 'inserir o login'], data.login, false);
            }
            if (want.metric && !doneF.metric) doneF.metric = fill(['benchmarking metric', 'seek to under'], metricSub, true);
            if (want.expected && !doneF.expected) doneF.expected = fill(['valor esperado'], data.expected, false);
            if (want.current && !doneF.current) doneF.current = fill(['valor atual'], data.current, false);
            const allDone = (!want.login || doneF.login) && (!want.metric || doneF.metric)
                && (!want.expected || doneF.expected) && (!want.current || doneF.current);
            if (allDone || tries > 40) {   // ~20s de tentativas
                clearInterval(timer);
                store.set(K_APOLLO, 'null');   // consome o prefill
            }
        }, 500);
    }

    // ── Mini-menu radial (Checklist / Time On Task) ─────────────────────
    function hideRadial() { if (!radialEl) return; const a = radialEl; radialEl = null; fadeOut(a, 120, () => a.remove()); }
    function showRadial() {
        if (radialEl) return;
        const r = fab.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2 + 34, sz = 46;
        radialEl = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483360;');
        radialEl.addEventListener('click', hideRadial);
        const pend = assocAlertList().length;
        const mk = (icon, title, angleDeg, cb, badgeN, bg) => {
            const a = angleDeg * Math.PI / 180;
            const bx = cx + rad * Math.cos(a) - sz / 2, by = cy + rad * Math.sin(a) - sz / 2;
            const b = el('button', 'position:fixed;width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;cursor:pointer;'
                + 'display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;border:2px solid rgba(255,255,255,.2);'
                + 'box-shadow:0 6px 16px rgba(0,0,0,.45);background:' + bg + ';' + FF, icon);
            b.style.left = Math.round(Math.min(Math.max(4, bx), window.innerWidth - sz - 4)) + 'px';
            b.style.top = Math.round(Math.min(Math.max(4, by), window.innerHeight - sz - 4)) + 'px';
            b.title = title;
            b.addEventListener('click', (e) => { e.stopPropagation(); hideRadial(); cb(); });
            try { b.animate([{ opacity: 0, transform: 'translate(' + Math.round((cx - bx - sz / 2)) + 'px,' + Math.round((cy - by - sz / 2)) + 'px) scale(.4)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.34,1.4,.4,1)' }); } catch (e2) {}
            radialEl.appendChild(b);
            if (badgeN) {
                const bd = el('div', 'position:fixed;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#cc0000;'
                    + 'color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;'
                    + 'box-shadow:0 2px 5px rgba(0,0,0,.4);border:1px solid #fff;', String(badgeN));
                bd.style.left = Math.round(parseFloat(b.style.left) + sz - 12) + 'px';
                bd.style.top = Math.round(parseFloat(b.style.top) - 4) + 'px';
                radialEl.appendChild(bd);
            }
        };
        // Checklist (acima-direita) e Time On Task (abaixo-direita).
        mk('🗒️', 'Abrir Checklist', -26, () => { if (assocEl) closeAssoc(); menuOpen = true; render(); }, 0, 'linear-gradient(145deg,#37475A,#232F3E)');
        mk('⏱', 'Abrir Time On Task', 26, () => { menuOpen = false; openAssoc(); }, pend, 'linear-gradient(145deg,#ff5252,#cc0000)');
        document.body.appendChild(radialEl);
        fadeIn(radialEl, 120);
    }

    // Time On Task só vale para OPS ou AM (com gestor definido).
    function totEnabled() { const c = ensureCycle(); return !!c.managerName && (c.selection === 'ops' || c.selection === 'am'); }

    // Lembrete a cada 5 min (persistido): 1º Time Off Task, depois Inferred Time.
    function maybeRemind() {
        if (!totEnabled()) return;
        const last = parseInt(store.get(K_REMINDER, '0'), 10) || 0;
        if (nowMs() - last < REMINDER_MS) return;
        const c = ensureCycle();
        const login = c.managerLogin || c.managerName || '';
        const offN = assocOffTaskList().length;
        const infN = assocAlertList().length;
        if (!offN && !infN) return;   // nada a lembrar; não marca o ts (dispara assim que houver dados)
        store.set(K_REMINDER, String(nowMs()));
        const DUR = 9000;
        let delay = 0;
        if (offN) { toast('⚠️ ' + login + ', tem ' + offN + ' AAs com Time Off Task.', DUR); delay = DUR + 400; }
        if (infN) { setTimeout(() => toast('⚠️ ' + login + ', tem ' + infN + ' AAs que ultrapassou Inferred Time.', DUR), delay); }
    }

    function updateAssocAlert() {
        const enabled = totEnabled();
        // Fora de OPS/AM: some o anel/badge e fecha overlays/radial.
        if (!enabled) {
            if (totRing) { totRing.style.display = 'none'; stopPulse(totRing); }
            if (totBadge) totBadge.style.display = 'none';
            if (assocEl) closeAssoc();
            if (assocTake) hideAssocTakeover();
            if (radialEl) hideRadial();
            return;
        }
        if (totRing) totRing.style.display = 'block';

        const list = assocAlertList();
        const c = ensureCycle();
        // (O aviso de texto é dado apenas pelo lembrete de 5 min — ver maybeRemind.)

        // Regra: 5 resolvidos (checks, sem contar desconsiderados) no dia → alarme extra (1x/dia).
        const acked = c.assocAck ? Object.keys(c.assocAck).length : 0;
        if (acked >= CHECKS_ALARM && !c.check5Alerted) {
            c.check5Alerted = true; setCycle(c);
            if (getMode() === 'alert') { try { beep(); } catch (e) {} }
            toast('🎯 Meta concluída.');
        }

        if (totRing) {
            positionRing();
            if (list.length) {
                totRing.style.borderColor = '#ff4d4d';
                totRing.style.boxShadow = '0 0 10px rgba(204,0,0,.6)';
                startPulse(totRing);
                if (totBadge) { totBadge.textContent = String(list.length); totBadge.style.display = 'flex'; }
            } else {
                totRing.style.borderColor = 'rgba(255,153,0,.55)';   // anel âmbar discreto no repouso
                totRing.style.boxShadow = 'none';
                stopPulse(totRing);
                if (totBadge) totBadge.style.display = 'none';
            }
        }
        // Atualiza o badge do Time On Task no radial, se estiver aberto.
        if (radialEl) { /* recriado ao reabrir; nada a fazer aqui */ }

        // Overlay AGRESSIVO (discreto): dispara 1x a cada novo degrau de +1.0 acima de 0.75
        // (1.75, 2.75, 3.75, ...). Não é contínuo — só reaparece no próximo degrau ou após o adiar.
        if (getMode() !== 'alert') { if (assocTake) hideAssocTakeover(); return; }
        // Fecha o overlay atual se aquele associado já saiu da lista (resolvido/desconsiderado).
        if (assocTake && !list.some(r => r.id === assocTake._id)) hideAssocTakeover();
        // Dispara o próximo degrau apenas quando não há overlay aberto.
        if (!assocTake) {
            const lvlMap = c.assocLvl || {}, snoozeMap = c.assocSnooze || {};
            let target = null, targetInf = -1;
            list.forEach(r => {
                const lvl = Math.floor(r.inferred - ALERT_MIN);   // 0 em [0.75,1.75), 1 em [1.75,2.75), ...
                if (lvl < 1) return;
                if (snoozeMap[r.id] && nowMs() < snoozeMap[r.id]) return;
                if (lvl > (lvlMap[r.id] || 0) && r.inferred > targetInf) { target = r; targetInf = r.inferred; }
            });
            if (target) {
                if (!c.assocLvl) c.assocLvl = {};
                c.assocLvl[target.id] = Math.floor(target.inferred - ALERT_MIN);
                setCycle(c);
                showAssocTakeover(target);
            }
        }
    }

    const AMZ = "font-family:'Amazon Ember','Segoe UI',Arial,sans-serif;";

    function styleAssocTabs() {
        if (!assocEl) return;
        [['inferred', assocEl._tabInf], ['offtask', assocEl._tabOff]].forEach(p => {
            const t = p[1]; if (!t) return; const on = assocTab === p[0];
            t.style.borderBottom = on ? '3px solid #FF9900' : '3px solid transparent';
            t.style.color = on ? '#232F3E' : '#5B6B7B';
            t.style.background = on ? '#FFF7E6' : 'transparent';
        });
    }
    function setAssocTab(k) { assocTab = k; styleAssocTabs(); paintAssoc(); }

    // ── Abas do checklist (Tarefas · ➕ Adicionar) ───────────────────────
    function styleChkTabs() {
        [['tasks', chkTabBtnTasks], ['add', chkTabBtnAdd]].forEach(p => {
            const t = p[1]; if (!t) return; const on = chkTab === p[0];
            t.style.borderBottom = on ? '3px solid #FF9900' : '3px solid transparent';
            t.style.color = on ? '#232F3E' : '#5B6B7B';
            t.style.background = on ? '#FFF7E6' : 'transparent';
        });
        // A busca só faz sentido na aba de tarefas.
        if (chkSearchBar) chkSearchBar.style.display = (chkTab === 'add') ? 'none' : 'flex';
    }

    // Monta a aba "➕ Adicionar": formulário (item + alerta opcional) + lista dos itens pessoais.
    function buildAddView() {
        if (!listEl) return;
        listEl.textContent = '';

        // ── Formulário ────────────────────────────────────────────────
        const form = el('div', 'background:#fff;border:1px solid #E3E7EC;border-radius:11px;padding:11px;margin-bottom:14px;'
            + 'box-shadow:0 2px 6px rgba(35,47,62,.06);');

        addInput = el('input', 'width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #CBD3DB;border-radius:8px;'
            + 'font-size:13px;background:#fff;color:#232F3E;' + AMZ);
        addInput.type = 'text';
        addInput.placeholder = 'Novo item…';
        addInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
        form.appendChild(addInput);

        // Campo de link (opcional): mostra o botão 🔗 na tarefa.
        const urlInput = el('input', 'width:100%;box-sizing:border-box;margin-top:9px;padding:9px 10px;border:1px solid #CBD3DB;'
            + 'border-radius:8px;font-size:13px;background:#fff;color:#232F3E;' + AMZ);
        urlInput.type = 'text';
        urlInput.placeholder = '🔗 Link (opcional)…';
        urlInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
        form.appendChild(urlInput);

        // Linha do alerta: toggle "🔔 Alerta" + horário (só habilita quando marcado).
        const alertRow = el('div', 'display:flex;align-items:center;gap:8px;margin-top:9px;');
        const alertLbl = el('label', 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px;'
            + 'font-weight:700;color:#232F3E;user-select:none;' + AMZ);
        const alertChk = el('input', 'width:16px;height:16px;accent-color:#FF9900;cursor:pointer;');
        alertChk.type = 'checkbox';
        alertLbl.appendChild(alertChk);
        alertLbl.appendChild(el('span', '', '🔔 Alerta'));
        alertRow.appendChild(alertLbl);

        const timeInput = el('input', 'flex:0 0 auto;padding:7px 9px;border:1px solid #CBD3DB;border-radius:8px;'
            + 'font-size:13px;background:#fff;color:#232F3E;opacity:.45;' + AMZ);
        timeInput.type = 'time';
        timeInput.disabled = true;
        timeInput.addEventListener('keydown', (e) => e.stopPropagation());
        alertRow.appendChild(timeInput);
        alertChk.addEventListener('change', () => {
            timeInput.disabled = !alertChk.checked;
            timeInput.style.opacity = alertChk.checked ? '1' : '.45';
            if (alertChk.checked) { if (!timeInput.value) timeInput.value = '12:00'; timeInput.focus(); }
        });
        form.appendChild(alertRow);

        const addBtn = el('button', 'width:100%;margin-top:11px;background:#FF9900;border:none;border-radius:8px;color:#232F3E;'
            + 'padding:9px 12px;cursor:pointer;font-size:13px;font-weight:800;' + AMZ, '＋ Adicionar');
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); doAdd(); });
        form.appendChild(addBtn);

        function doAdd() {
            const v = addInput.value.trim();
            if (!v) { addInput.focus(); return; }
            const alert = (alertChk.checked && timeInput.value) ? timeInput.value : null;
            let url = urlInput.value.trim();
            if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;   // completa o esquema se faltar
            addCustomItem(v, alert, url || null);
            lastListSig = ''; buildAddView(); render();
            if (addInput) addInput.focus();
        }

        listEl.appendChild(form);

        // ── Lista dos itens pessoais existentes ───────────────────────
        const custom = getCustom();
        if (!custom.length) {
            listEl.appendChild(el('div', 'padding:16px 10px;text-align:center;color:#5B6B7B;font-size:12.5px;line-height:1.5;',
                'Sem itens pessoais.\nAdicione tarefas suas acima — elas aparecem na aba “✓ Tarefas”.'));
            return;
        }
        custom.forEach(ci => {
            const row = el('div', 'display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #E3E7EC;'
                + 'border-radius:9px;padding:9px 10px;margin-bottom:7px;');
            const mid = el('div', 'flex:1 1 auto;min-width:0;');
            mid.appendChild(el('div', 'font-size:13px;font-weight:700;color:#232F3E;word-break:break-word;' + AMZ, ci.t));
            const meta = [ci.alert ? ('⏰ Alerta ' + ci.alert) : '— sem alerta'];
            if (ci.url) meta.push('🔗 com link');
            mid.appendChild(el('div', 'font-size:10.5px;font-weight:700;margin-top:2px;color:' + (ci.alert ? '#E88B00' : '#9AA7B4') + ';',
                meta.join('  ·  ')));
            row.appendChild(mid);
            if (ci.url) {
                const lb = el('button', 'flex:0 0 auto;background:#fff;border:1px solid #FF9900;color:#FF9900;border-radius:8px;'
                    + 'padding:6px 9px;cursor:pointer;font-size:13px;font-weight:800;' + AMZ, '🔗');
                lb.title = 'Abrir link';
                lb.addEventListener('click', (e) => { e.stopPropagation(); openUrl(ci.url); });
                row.appendChild(lb);
            }
            const rm = el('button', 'flex:0 0 auto;background:#fff;border:1.5px solid #CC0000;border-radius:8px;color:#CC0000;'
                + 'padding:6px 9px;cursor:pointer;font-size:13px;font-weight:800;' + AMZ, '✕');
            rm.title = 'Remover este item pessoal';
            rm.addEventListener('click', (e) => { e.stopPropagation(); removeCustomItem(ci.id); lastListSig = ''; buildAddView(); render(); });
            row.appendChild(rm);
            listEl.appendChild(row);
        });
    }

    function paintAssoc() {
        if (!assocEl) return;
        const body = assocEl._body, info = assocEl._info, countEl = assocEl._count, sub = assocEl._sub;
        const c = ensureCycle();
        if (sub) {
            if (assocState.status === 'loading' && !assocState.rows.length) sub.textContent = 'atualizando…';
            else if (assocState.ts) { const d = new Date(assocState.ts); sub.textContent = 'atualizado ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
            else sub.textContent = '';
        }
        info.textContent = '👤 ' + (c.managerLogin || c.managerName || '—')
            + (assocState.label ? '   ·   ' + assocState.label : '')
            + (assocState.fallback ? '   ·   (janela padrão)' : '');
        body.textContent = '';

        if (assocState.status === 'error') {
            countEl.textContent = '⚠️ erro';
            body.appendChild(el('div', 'padding:20px;text-align:center;color:#CC0000;font-size:12.5px;line-height:1.5;white-space:pre-wrap;',
                '⚠️ ' + (assocState.error || 'Erro ao carregar.') + '\nFaça login no FCLM (midway) e toque em Atualizar.'));
            return;
        }
        if (assocState.status === 'loading' && !assocState.rows.length) {
            countEl.textContent = '⏳ carregando…';
            body.appendChild(el('div', 'padding:20px;text-align:center;color:#5B6B7B;font-size:12.5px;', '⏳ Buscando no FCLM…'));
            return;
        }

        if (assocTab === 'offtask') { paintAssocOffTask(body, countEl, c); return; }
        paintAssocInferred(body, countEl, c);
    }

    function paintAssocOffTask(body, countEl, c) {
        const list = assocOffTaskList();
        countEl.textContent = '🚶 Com Time Off Task (' + list.length + ')';
        if (!list.length) {
            body.appendChild(el('div', 'padding:20px;text-align:center;color:#5B6B7B;font-size:12.5px;',
                'Nenhum associado do gestor com Time Off Task nesta janela. 🎉'));
            return;
        }
        body.appendChild(el('div', 'display:flex;align-items:center;gap:7px;background:linear-gradient(135deg,#37475A,#232F3E);'
            + 'color:#fff;font-weight:800;font-size:12px;padding:8px 12px;border-radius:8px;margin-bottom:10px;', '🚶 Time Off Task (com dados)'));
        list.forEach(r => {
            const hasLink = !!r.id;
            const url = hasLink ? buildTimeDetailsUrl(r.id, currentShift(c), c.opDate) : null;
            const card = el('div', 'display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #E8E8E8;'
                + 'border-left:4px solid #E88B00;border-radius:10px;padding:9px 11px;margin-bottom:8px;box-shadow:0 2px 6px rgba(35,47,62,.06);');
            const mid = el('div', 'flex:1;min-width:0;' + (hasLink ? 'cursor:pointer;' : ''));
            if (hasLink) { mid.title = 'Abrir Time Details de ' + r.name + ' (janela do turno)'; mid.addEventListener('click', () => openUrl(url)); }
            const l1 = el('div', 'font-size:13px;line-height:1.3;white-space:normal;');
            l1.appendChild(el('span', 'font-weight:800;color:#0F5FA6;', r.name));
            l1.appendChild(el('span', 'color:#5B6B7B;', ' — '));
            l1.appendChild(el('span', 'font-weight:800;color:#E88B00;', r.offTask.toFixed(2) + 'h off'));
            mid.appendChild(l1);
            mid.appendChild(el('div', 'font-size:10.5px;color:#7C8B99;margin-top:2px;',
                'ID ' + (r.id || '—') + (r.total ? ' · Total ' + r.total : '') + (r.tot ? ' · On ' + r.tot : '') + (r.pct ? ' · ' + r.pct + '% task' : '')));
            card.appendChild(mid);
            body.appendChild(card);
        });
    }

    function paintAssocInferred(body, countEl, c) {
        const list = assocFiltered();
        const pend = assocAlertList().length;
        countEl.textContent = '🔴 Acima de ' + ALERT_MIN.toFixed(2) + ' (' + list.length + ')'
            + (pend ? '   ·   ⚠ ' + pend + ' pendente' + (pend === 1 ? '' : 's') : '   ·   ✔ tudo resolvido');
        if (!list.length) {
            body.appendChild(el('div', 'padding:20px;text-align:center;color:#5B6B7B;font-size:12.5px;',
                'Nenhum associado do gestor com Inferred acima de ' + ALERT_MIN.toFixed(2) + ' nesta janela. 🎉'));
            return;
        }
        // Cabeçalho de seção (pill escuro) + botão "Desconsiderar todos".
        const sec = el('div', 'display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#37475A,#232F3E);'
            + 'color:#fff;font-weight:800;font-size:12px;padding:7px 10px;border-radius:8px;margin-bottom:10px;');
        sec.appendChild(el('span', 'flex:1;min-width:0;', '⏱ Inferred Time > ' + ALERT_MIN.toFixed(2)));
        const anyPend = list.some(r => !(c.assocDisc && c.assocDisc[r.id]) && !(c.assocAck && c.assocAck[r.id]));
        if (anyPend) {
            const discAll = el('button', 'flex:none;background:#5B6B7B;border:1px solid #47535E;color:#fff;border-radius:7px;'
                + 'padding:4px 9px;cursor:pointer;font-size:11px;font-weight:800;' + AMZ, '🚫 Desconsiderar todos');
            discAll.title = 'Marcar todos os listados como desconsiderados (sai do alerta)';
            discAll.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm('Desconsiderar TODOS os associados listados (Inferred > ' + ALERT_MIN.toFixed(2) + ')?')) return;
                const cc = ensureCycle();
                if (!cc.assocAck) cc.assocAck = {}; if (!cc.assocDisc) cc.assocDisc = {};
                assocFiltered().forEach(r => { delete cc.assocAck[r.id]; cc.assocDisc[r.id] = true; });
                setCycle(cc);
                paintAssoc(); updateAssocAlert();
            });
            sec.appendChild(discAll);
        }
        body.appendChild(sec);

        const ack = c.assocAck || {}, disc = c.assocDisc || {};
        list.forEach(r => {
            const isAck = !!ack[r.id], isDisc = !!disc[r.id];
            const handled = isAck || isDisc;
            const hasLink = !!r.id;
            const url = hasLink ? buildTimeDetailsUrl(r.id, currentShift(c), c.opDate) : null;
            const accent = isDisc ? '#8A94A0' : (isAck ? '#B9C4CE' : '#CC0000');
            const card = el('div', 'display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #E8E8E8;'
                + 'border-left:4px solid ' + accent + ';border-radius:10px;padding:9px 11px;margin-bottom:8px;'
                + 'box-shadow:0 2px 6px rgba(35,47,62,.06);opacity:' + (handled ? '.62' : '1') + ';');
            const mid = el('div', 'flex:1;min-width:0;' + (hasLink ? 'cursor:pointer;' : ''));
            if (hasLink) { mid.title = 'Abrir Time Details de ' + r.name + ' (janela do turno)'; mid.addEventListener('click', () => openUrl(url)); }
            const l1 = el('div', 'font-size:13px;line-height:1.3;white-space:normal;');
            l1.appendChild(el('span', 'font-weight:800;' + (handled ? 'color:#8090A0;text-decoration:line-through;' : 'color:#0F5FA6;'), r.name));
            l1.appendChild(el('span', 'color:#5B6B7B;', ' — '));
            l1.appendChild(el('span', 'font-weight:800;color:' + (handled ? '#8090A0' : '#CC0000') + ';', r.inferred.toFixed(2) + 'h'));
            mid.appendChild(l1);
            const status = isDisc ? ' · 🚫 desconsiderado' : (isAck ? ' · ✔ resolvido' : '');
            mid.appendChild(el('div', 'font-size:10.5px;color:#7C8B99;margin-top:2px;',
                'ID ' + (r.id || '—') + (r.total ? ' · Total ' + r.total : '') + (r.pct ? ' · ' + r.pct + '% task' : '') + status));
            card.appendChild(mid);

            const btnCss = 'flex:none;border-radius:8px;padding:6px 8px;cursor:pointer;font-size:13px;font-weight:800;' + AMZ;
            // ✔ Resolver
            const done = el('button', btnCss + (isAck ? 'background:#EAEDF0;border:1px solid #CBD3DB;color:#5B6B7B;' : 'background:#27AE60;border:1px solid #1E8449;color:#fff;'), isAck ? '↺' : '✔');
            done.title = isAck ? 'Desmarcar resolvido (voltar ao alerta)' : 'Marcar como resolvido (sai do alerta)';
            done.addEventListener('click', (e) => { e.stopPropagation(); toggleAssocAck(r.id); paintAssoc(); updateAssocAlert(); });
            card.appendChild(done);
            // 🚫 Desconsiderar
            const skip = el('button', btnCss + (isDisc ? 'background:#5B6B7B;border:1px solid #47535E;color:#fff;' : 'background:#EAEDF0;border:1px solid #CBD3DB;color:#5B6B7B;'), '🚫');
            skip.title = isDisc ? 'Reverter desconsiderar (voltar ao alerta)' : 'Desconsiderar (ex.: PS, PG, PA ou OPS) — sai do alerta';
            skip.addEventListener('click', (e) => { e.stopPropagation(); toggleAssocDisc(r.id); paintAssoc(); updateAssocAlert(); });
            card.appendChild(skip);
            // � Apollo Audit (Seek to Understand) com valores preenchidos
            const ap = el('button', 'flex:none;background:#FF9900;border:1px solid #E88B00;color:#131921;border-radius:8px;'
                + 'padding:6px 8px;cursor:pointer;font-size:13px;font-weight:800;', '📋');
            ap.title = 'Abrir Apollo (Seek to Understand) já com login, métrica (Unknown Idle Time), esperado 0.75 e atual ' + r.inferred.toFixed(2);
            ap.addEventListener('click', (e) => { e.stopPropagation(); openApolloAudit(r); });
            card.appendChild(ap);

            body.appendChild(card);
        });
    }

    function openAssoc() {
        const c = ensureCycle();
        if (!c.managerName) { toast('Selecione um gestor primeiro (clique no círculo após o Startup).'); return; }
        if (!(c.selection === 'ops' || c.selection === 'am')) { toast('Time On Task disponível apenas para OPS e AM.'); return; }
        if (assocEl) { closeAssoc(); return; }
        menuOpen = false;   // fecha o checklist (ocupam o mesmo canto)
        // Painel flutuante claro (estilo Learning Hours), ancorado acima do botão fixo.
        assocEl = el('div', 'position:fixed;left:16px;bottom:72px;z-index:2147483300;width:min(380px,94vw);max-height:80vh;'
            + 'display:flex;flex-direction:column;background:#EEF1F4;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);'
            + 'overflow:hidden;' + AMZ);

        const hd = el('div', 'background:linear-gradient(135deg,#2C3E50,#232F3E 55%,#131921);padding:12px 14px;color:#fff;');
        const hdTop = el('div', 'display:flex;align-items:center;gap:10px;');
        const titleCol = el('div', 'flex:1;min-width:0;');
        const t1 = el('div', 'display:flex;align-items:center;gap:7px;font-size:15px;font-weight:800;');
        t1.appendChild(el('span', 'font-size:16px;', '⏱'));
        t1.appendChild(el('span', '', 'Time On Task'));
        titleCol.appendChild(t1);
        assocEl._sub = el('div', 'font-size:10.5px;color:#FEBD69;font-weight:700;margin-top:2px;', 'atualizado --:--:--');
        titleCol.appendChild(assocEl._sub);
        hdTop.appendChild(titleCol);
        const refresh = el('button', 'background:#4A86C8;color:#fff;border:none;border-radius:8px;padding:7px 11px;'
            + 'font-weight:800;font-size:11px;cursor:pointer;' + AMZ, '🔄 Atualizar');
        refresh.addEventListener('mouseenter', () => refresh.style.filter = 'brightness(1.1)');
        refresh.addEventListener('mouseleave', () => refresh.style.filter = 'none');
        refresh.addEventListener('click', () => loadAssociates(true));
        hdTop.appendChild(refresh);
        const helpBtn = el('button', 'width:26px;height:26px;border-radius:8px;border:none;background:rgba(255,255,255,.14);'
            + 'color:#fff;font-weight:800;cursor:pointer;line-height:1;padding:0;' + AMZ, '?');
        helpBtn.title = 'Ajuda — quando desconsiderar';
        helpBtn.addEventListener('click', () => { const n = assocEl._note; if (n) n.style.display = (n.style.display === 'none' ? 'block' : 'none'); });
        hdTop.appendChild(helpBtn);
        const closeBtn = el('button', 'width:26px;height:26px;border-radius:8px;border:none;background:#cc0000;'
            + 'color:#fff;font-weight:800;cursor:pointer;line-height:1;padding:0;' + AMZ, '✕');
        closeBtn.title = 'Fechar';
        closeBtn.addEventListener('click', closeAssoc);
        hdTop.appendChild(closeBtn);
        hd.appendChild(hdTop);
        assocEl._info = el('div', 'font-size:11px;color:#CBD8E6;margin-top:8px;white-space:pre-wrap;line-height:1.4;', '');
        hd.appendChild(assocEl._info);
        assocEl.appendChild(hd);

        // Nota de ajuda (oculta por padrão; abre pelo "?").
        assocEl._note = el('div', 'display:none;background:#FFF7E6;border-bottom:1px solid #F0D9A8;color:#5B4a1f;'
            + 'padding:10px 12px;font-size:11.5px;line-height:1.5;');
        assocEl._note.appendChild(el('div', 'font-weight:800;margin-bottom:3px;', 'ℹ️ Quando desconsiderar'));
        assocEl._note.appendChild(el('div', '',
            'Se o associado for PS, PG, PA ou OPS, ele não necessariamente deve ser auditado — pode ser justificado via Apollo ou marcado como 🚫 Desconsiderar para sair do alerta. '
            + 'Para os demais: abra o 📋 Apollo (Seek to Understand) já preenchido, faça a tratativa e marque ✔ ao resolver. Clique no nome do associado para ver o Time Details no FCLM.'));
        assocEl.appendChild(assocEl._note);

        // Abas: Inferred > 0.75 · Time Off Task
        const tabsBar = el('div', 'display:flex;background:#fff;border-bottom:1px solid #E8E8E8;');
        const mkTab = (key, label) => {
            const t = el('button', 'flex:1;background:transparent;border:none;border-bottom:3px solid transparent;'
                + 'padding:9px 6px;cursor:pointer;font-size:11.5px;font-weight:800;color:#5B6B7B;' + AMZ, label);
            t.addEventListener('click', () => setAssocTab(key));
            return t;
        };
        assocEl._tabInf = mkTab('inferred', '⏱ Inferred > ' + ALERT_MIN.toFixed(2));
        assocEl._tabOff = mkTab('offtask', '🚶 Time Off Task');
        tabsBar.appendChild(assocEl._tabInf); tabsBar.appendChild(assocEl._tabOff);
        assocEl.appendChild(tabsBar);

        const cbar = el('div', 'padding:7px 12px;background:#fff;border-bottom:2px solid #FF9900;');
        assocEl._count = el('div', 'font-size:12px;font-weight:800;color:#232F3E;', '');
        cbar.appendChild(assocEl._count);
        assocEl.appendChild(cbar);

        assocEl._body = el('div', 'flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px 14px;background:#EEF1F4;');
        assocEl.appendChild(assocEl._body);

        document.body.appendChild(assocEl);
        fadeIn(assocEl, 200, 12);
        styleAssocTabs();
        paintAssoc();
        loadAssociates(false);
    }
    function closeAssoc() { if (!assocEl) return; const a = assocEl; assocEl = null; fadeOut(a, 150, () => a.remove()); }

    // ── Overlay AGRESSIVO (tela cheia) para Inferred crítico (>= 1.25) ───
    function hideAssocTakeover() { if (!assocTake) return; const a = assocTake; assocTake = null; fadeOut(a, 150, () => a.remove()); }
    function showAssocTakeover(r) {
        if (assocTake && assocTake._id === r.id) return;
        hideAssocTakeover();
        assocTake = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483601;background:rgba(8,12,18,.95);'
            + 'display:flex;align-items:center;justify-content:center;' + AMZ);
        assocTake.id = 'chkmec-assoc-take'; assocTake._id = r.id;
        const box = el('div', 'width:min(560px,92vw);background:#12202e;border:2px solid #cc0000;border-radius:18px;'
            + 'padding:26px 28px;text-align:center;color:#fff;box-shadow:0 24px 70px rgba(0,0,0,.6);');
        box.appendChild(el('div', 'font-size:50px;', '🚨'));
        box.appendChild(el('h2', 'margin:6px 0 2px;font-size:22px;color:#ff6b6b;', 'Inferred Time crítico!'));
        box.appendChild(el('div', 'font-size:19px;font-weight:800;margin:12px 0 2px;color:#ffce7a;', r.name));
        box.appendChild(el('div', 'font-size:15px;font-weight:800;margin:0 0 12px;color:#ff9a9a;', 'Inferred Time: ' + r.inferred.toFixed(2) + 'h'));
        box.appendChild(el('p', 'color:#c2d2e0;font-size:14px;margin:0 0 18px;line-height:1.5;',
            'Ultrapassou ' + (ALERT_MIN + Math.floor(r.inferred - ALERT_MIN)).toFixed(2) + 'h de Inferred Time e continua subindo. Trate agora (Seek to Understand) ou desconsidere.'));
        const mkBtn = (bg, bd, fg, txt) => {
            const b = el('button', 'display:block;width:100%;margin:8px 0;padding:12px;border-radius:11px;font-size:15px;'
                + 'font-weight:800;cursor:pointer;border:1px solid ' + bd + ';background:' + bg + ';color:' + fg + ';' + AMZ, txt);
            b.addEventListener('mouseenter', () => b.style.filter = 'brightness(1.08)');
            b.addEventListener('mouseleave', () => b.style.filter = 'none');
            return b;
        };
        const apollo = mkBtn('#FF9900', '#E88B00', '#131921', '📋 Abrir Apollo (Seek to Understand)');
        apollo.addEventListener('click', () => openApolloAudit(r));
        box.appendChild(apollo);
        const skip = mkBtn('#5B6B7B', '#47535E', '#fff', '🚫 Desconsiderar');
        skip.addEventListener('click', () => { setAssocFlag(r.id, 'disc'); hideAssocTakeover(); if (assocEl) paintAssoc(); updateAssocAlert(); });
        box.appendChild(skip);
        const snz = el('button', 'display:block;margin:10px auto 0;background:transparent;color:#c2d2e0;border:1px solid #52708c;'
            + 'padding:9px 18px;border-radius:11px;font-size:13px;font-weight:700;cursor:pointer;' + AMZ, '⏰ Adiar 1 hora');
        snz.addEventListener('click', () => {
            // Adiamento persistido no ciclo (sobrevive à troca de página).
            const cc = ensureCycle();
            if (!cc.assocSnooze) cc.assocSnooze = {};
            cc.assocSnooze[r.id] = nowMs() + AGGR_SNOOZE_MS;
            // Permite re-disparar o mesmo degrau quando o adiamento expirar.
            if (!cc.assocLvl) cc.assocLvl = {};
            cc.assocLvl[r.id] = Math.max(0, Math.floor(r.inferred - ALERT_MIN) - 1);
            setCycle(cc);
            hideAssocTakeover();
        });
        box.appendChild(snz);
        startPulse(box);
        assocTake.appendChild(box);
        document.body.appendChild(assocTake);
        fadeIn(assocTake, 180); fadeIn(box, 240, 10);
    }

    // ── Render (a cada tick) ─────────────────────────────────────────────
    function render() {
        if (!fab || !document.body.contains(fab)) buildUI();
        if (!totRing || !document.body.contains(totRing)) buildRing();
        if (!dragging) positionRing();   // mantém o anel/badge alinhados ao círculo
        const s = computeState();
        const mode = getMode();

        const ringColor = s.needSetup ? '#52708c' : (s.overdue.length ? '#cc0000' : (s.pct === 100 ? '#27ae60' : '#ff9900'));
        fabWater.style.height = s.pct + '%';         // nível da água = % (transição fluida)
        fabWater.style.background = ringColor;
        fabPct.textContent = s.pct + '%';
        if (s.overdue.length && mode === 'alert') startPulse(fab); else stopPulse(fab);

        // Alerta de associados (Inferred > 0.75) — sempre avaliado, mesmo sem o menu aberto.
        updateAssocAlert();

        // 100% concluído → esconde a lista e centraliza o círculo no topo (visual, sempre).
        // A COMEMORAÇÃO (confete/banner) roda só 1x por DIA OPERACIONAL (marcador salvo no ciclo).
        const is100 = !s.needSetup && s.total > 0 && s.pct === 100;
        if (is100) {
            const cyc = ensureCycle();
            if (!cyc.celebrated) {
                cyc.celebrated = true; setCycle(cyc);
                centered = true;
                menuOpen = false; setMenuVisible(false);   // esconde a lista antes de centralizar
                centerFab();
                celebrate();
            }
        } else {
            if (centered) { centered = false; applyPos(); }   // saiu do 100% → volta pra posição salva
        }

        if (s.needSetup) {
            setMenuVisible(false); hideTakeover();
            // A pergunta só aparece automaticamente após o Startup (06:10 Day / 18:10 Night).
            if (!setupPostponed && (setupAllowedNow(s.shift) || manualSetup)) showSetup();
            return;
        }
        hideSetup();

        // Lembrete de hora cheia: ao virar a hora, se o overlay está no modo círculo
        // (menu fechado), abre a lista sozinho para lembrar do checklist.
        const curHour = new Date().getHours();
        if (curHour !== lastAutoOpenHour) {
            lastAutoOpenHour = curHour;
            if (!menuOpen) menuOpen = true;
        }

        if (hdSubTxt) hdSubTxt.textContent = (s.manager ? s.manager + ' · ' : '') + (SEL_LABEL[s.selection] || '') + ' · Turno ' + (s.shift === 'day' ? 'Day ☀️' : 'Night 🌙');
        if (modeBtn) { const a = mode === 'alert'; modeBtn.textContent = a ? '🔔 Alerta (trava + som)' : '🔕 Silencioso (sem travar)'; modeBtn.style.borderColor = a ? '#ff9900' : '#52708c'; modeBtn.style.color = a ? '#ffce7a' : '#8aa1b6'; }

        s.warning.forEach(w => { if (!warnedIds[w.id]) { warnedIds[w.id] = true; menuOpen = true; } });

        if (menuOpen) {
            hdPct.textContent = s.pct + '% (' + s.doneCount + '/' + s.total + ')';
            if (chkTab === 'add') {
                // Aba "➕ Adicionar": só reconstrói quando a lista de itens pessoais muda
                // (preserva o foco do input entre ticks de 1s).
                const sig = 'add|' + getCustom().map(c => c.id + ':' + c.t + ':' + (c.alert || '') + ':' + (c.url || '')).join('|');
                if (sig !== lastListSig || listEl.childElementCount === 0) {
                    lastListSig = sig;
                    buildAddView();
                }
            } else {
                // Aba "✓ Tarefas": lista de tarefas com filtro de busca.
                const visible = listFilter ? s.items.filter(i => i.label.toLowerCase().includes(listFilter)) : s.items;
                // Só reconstrói a lista quando o estado visível muda (evita churn de DOM a cada tick).
                const sig = 'tasks|f=' + listFilter + '|' + visible.map(i => i.id + (i.done ? 'D' : '') + (i.snoozed ? 'z' + i.snoozeLeft : '')
                    + (i.overdue ? 'o' : i.warning ? 'w' : i.alert ? 'a' + i.secsLeft : '')).join('|');
                if (sig !== lastListSig || listEl.childElementCount === 0) {
                    lastListSig = sig;
                    listEl.textContent = '';
                    if (!visible.length) {
                        listEl.appendChild(el('div', 'padding:16px 10px;text-align:center;color:#5B6B7B;font-size:12.5px;',
                            listFilter ? 'Nenhuma tarefa encontrada para “' + searchInput.value.trim() + '”' : 'Sem tarefas'));
                    } else {
                        visible.forEach(i => listEl.appendChild(buildRow(i)));
                    }
                }
            }
        } else { lastListSig = ''; }
        setMenuVisible(menuOpen);
        if (menuOpen) positionMenu();

        if (mode === 'alert') {
            s.items.forEach(i => { if (!i.done && i.ts && i.secsLeft > 0 && i.secsLeft <= SOUND_LEAD_SEC && !beepedIds[i.id]) { beepedIds[i.id] = true; beep(); } });
        }
        if (mode === 'alert' && s.overdue.length) showTakeover(s.overdue[0]); else hideTakeover();

        applyGroupVisibility();   // some com o círculo/anel quando um overlay está aberto
    }

    // ── Início ───────────────────────────────────────────────────────────
    function init() {
        if (!document.body) { setTimeout(init, 300); return; }
        apolloAutofill();   // se estiver na página do Apollo, preenche o formulário
        ensureCycle();
        buildUI();
        render();
        setInterval(render, 1000);
        // Prefetch do Roster à tarde (acelera a manhã seguinte). Checa agora e a cada 60s.
        maybePrefetchRoster();
        setInterval(maybePrefetchRoster, 60 * 1000);
        // Atualiza os associados em 2º plano p/ o alerta funcionar sem abrir o dashboard.
        const cyc0 = ensureCycle();
        if (cyc0.managerName && (cyc0.selection === 'ops' || cyc0.selection === 'am')) loadAssociates(false);
        setInterval(() => {
            const c = ensureCycle();
            if (c.managerName && (c.selection === 'ops' || c.selection === 'am') && setupAllowedNow(currentShift(c))) loadAssociates(false);
        }, ASSOC_POLL_MS);
        // Lembrete recorrente (5 min): Time Off Task e Inferred Time.
        setInterval(maybeRemind, 20 * 1000);
        window.addEventListener('resize', () => { if (fab) applyPos(); });
        window.addEventListener('pointerdown', function unlock() {
            try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
        }, { once: true });
        // Esc fecha a ajuda (não fecha setup nem takeover de propósito).
        window.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (helpEl) { toggleHelp(); return; }
            if (radialEl) { hideRadial(); return; }
            if (assocEl) { closeAssoc(); return; }
            if (menuOpen) { menuOpen = false; render(); return; }
        });
    }
    init();
})();
