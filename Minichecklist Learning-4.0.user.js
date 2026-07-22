// ==UserScript==
// @name         Minichecklist Learning
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Mini-checklist flutuante do turno (Learning GRU5). Na 1ª abertura do dia pergunta o fluxo (Onboarding Dia 1/2/3, PA ou Support) e detecta o turno (day 05:30–18:00 / night 18:00–05:30), com override manual de turno. Alertas por horário do relógio (day/night); no modo Alerta trava a tela (com "Adiar 5 min") e toca bip 1 min antes. 3 formas: círculo dinâmico (%), menu de check e mensagem em tela cheia. Links viram botões ao lado de cada tarefa. Quando o fluxo for Onboarding (ou na página do functionRollup do FCLM), mostra o Onboarding/Learning Hours (barra + dashboard + CSV) puxando TODOS os processos do FCLM (como o Learning Hours), com abas por processo, aba de Horas totais e Ajuste de Badge. No fluxo Onboarding a janela é automática pelo turno; na página fixa do functionRollup há filtro de janela selecionável (Dia/Noite/06→05/Dia todo + data). Estado no armazenamento do Tampermonkey (compartilhado entre sites e mantido ao fechar/abrir o Firefox). CSSOM para funcionar sob CSP restrito.
// @author       ladislke
// @match        *://*/*
// @match        file:///*
// @run-at       document-idle
// @connect      fclm-portal.amazon.com
// @connect      hooks.slack.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==
//
// OBJETIVO: ajudar a NÃO esquecer as tarefas de maior impacto do turno.
//  • 1ª abertura do "dia operacional" (vira às 05:30): pergunta se vai conduzir Onboarding
//    (Dia 1/2/3) ou, se não, PA ou Support. A escolha e o turno ficam salvos até o próximo dia.
//  • Turno: day = 05:30–18:00; night = 18:00–05:30. Definido na 1ª abertura e NÃO muda no meio
//    (ex.: quem abriu de dia continua com a lista do dia mesmo às 18:10).
//  • Alertas usam a HORA ATUAL (horários day/night por tarefa). Modo Alerta trava a tela e toca
//    um bip 1 min antes; modo Silencioso não trava.
//  • Estado via GM_setValue (mesmo em qualquer site e após reiniciar o navegador).
//
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (document.getElementById('chkatv-fab')) return;

    // ── URLs reutilizadas ────────────────────────────────────────────────
    const U = {
        mail:      'https://outlook.cloud.microsoft/mail/',
        checklist: 'https://atlas.qubit.amazon.dev/standard-work/checklists/dd0f7f64-2c61-4d23-b41d-01477dbd8797',
        tickets:   'https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%7B%22OR%22%3A%5B%22Assigned%22%2C%7B%22OR%22%3A%5B%22Researching%22%2C%7B%22OR%22%3A%5B%22Work%20In%20Progress%22%2C%22Pending%22%5D%7D%5D%7D%5D%7D%2C%22assignedGroup%22%3A%22Learning%20-%20GRU5%22%7D%7D',
        planOnb:   'https://amazon-my.sharepoint.com/:x:/p/terto/IQB22IYz-6yRT6ql5lVe-YPHAesvdKlvHRlnoBpmq5t9lhY?e=ObnnmJ',
        planEmb:   'https://amazon-my.sharepoint.com/:x:/p/terto/IQD1HYzdoL7uRYOWKFIpaKb_AWK8EvuAKkl6valEGohH3hM?e=0aIek2',
        perms:     'https://fclm-portal.amazon.com/employee/permissions',
        kiosk:     'https://fcmenu-iad-regionalized.corp.amazon.com/GRU5/laborTrackingKiosk',
        ata:       'https://iad.umbrella.amazon.dev/ata/initiate',
        funcRoll:  'https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=HTML&warehouseId=GRU5&processId=1002986',
        funcRollAll:'https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=HTML&warehouseId=GRU5',
        ppa:       'https://fclm-portal.amazon.com/reports/ppaAttendance?warehouseId=GRU5',
        timeDet:   'https://fclm-portal.amazon.com/employee/timeDetails?&warehouseId=GRU5',
        apollo:    'https://apollo-audit.corp.amazon.com/reporting/ncfah_by_auditor',
        guided:    'https://guided-coaching.corp.amazon.com/#/opportunities',
        netlify:   'https://gru5acompanhamento.netlify.app/',
        quicksight:'https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/78f45e65-4574-4bfe-913d-40b51e62ef55/views/91e2643f-ccef-4bd8-ba8b-2993c4b9b01a',
        asanaExp:  'https://form.asana.com/?k=kNaDhMiAmvdHT2844xr0vw&d=8442528107068',
        asanaFb:   'https://form.asana.com/?k=Vg5FzckBDm3pwiDO4oRmlg&d=8442528107068',
    };
    const NOTE_EXE = 'Abra o verificador_treinamento.exe (pasta Documentos). O navegador não executa programas: para abrir com 1 clique, registre o protocolo (arquivo .reg fornecido). Sem o arquivo? Fale com os analistas na mesa de Learning.';
    const PROTO_EXE = 'gru5verificador://open';   // protocolo do Windows p/ abrir o .exe (via .reg)

    // ── Listas por fluxo (label, url|note, alerta day/night) ──────────────
    // a = alerta "HH:MM" ou null (sem alerta). dayOnly: só aparece no turno day.
    const CHECKLISTS = {
        onb1: [
            { t: 'Conferiu se os lanches foram entregues na recepção?' },
            { t: 'A sala de treinamento está organizada e os equipamentos necessários foram testados?' },
            { t: 'Verificou seu e-mail?', url: U.mail },
            { t: 'Abriu seu checklist do dia?', url: U.checklist, day: '06:15', night: '18:15' },
            { t: 'Validou e redirecionou seus tickets? (se possível)', url: U.tickets },
            { t: 'Validou a planilha de Onboarding?', url: U.planOnb, day: '06:30', night: '18:30' },
            { t: 'Resetou certificados e permissões dos associados do Onboarding?', url: U.perms },
            { t: 'Fez a chamada e logou os associados do Onboarding?', url: U.kiosk, day: '07:30', night: '19:30' },
            { t: 'Atribuiu os associados ao treinamento "Behind the Smile"?', url: U.ata },
            { t: 'Gestão de pontos e TOT dos novos associados', url: U.ppa },
            { t: 'Realizou a Experiência de Onboarding? (Asana)', url: U.asanaExp, day: '17:00', night: '04:00' },
            { t: 'Realizou o Onboarding Feedback do Dia 1? (Asana)', url: U.asanaFb, day: '17:30', night: '04:30' },
            { t: 'Enviou o checklist e o EOS?', url: U.checklist, day: '18:00', night: '05:00' },
        ],
        onb2: [
            { t: 'Verificou seu e-mail?', url: U.mail },
            { t: 'Abriu seu checklist do dia?', url: U.checklist, day: '06:15', night: '18:15' },
            { t: 'Validou seus tickets? (se possível)', url: U.tickets },
            { t: 'Logou e fez a chamada com os associados de Onboarding?', url: U.planOnb },
            { t: 'Verificou se os embaixadores se logaram e logaram os associados no calm code correto?', url: U.timeDet },
            { t: 'Certificou se os embaixadores registraram todos os treinamentos no ATA?', note: NOTE_EXE, day: '09:00', night: '21:00' },
            { t: 'Certificou se os embaixadores executaram os apollos de qualidade?', url: U.apollo, day: '15:00', night: '02:30' },
            { t: 'Gestão de ponto e TOT dos novos associados (Dia 1 e Dia 2)', url: U.ppa },
            { t: 'Fechou os GCAs abertos dos associados de Onboarding?', url: U.guided, day: '16:00', night: '03:00' },
            { t: 'Realizou sua meta de apollos? (PA:10 · Support:20)', url: U.netlify },
            { t: 'Realizou o Onboarding Feedback do Dia 2? (Asana)', url: U.asanaFb, day: '17:30', night: '04:30' },
            { t: 'Enviou o checklist e o EOS?', url: U.checklist, day: '18:00', night: '05:00' },
        ],
        onb3: [
            { t: 'Verificou seu e-mail?', url: U.mail },
            { t: 'Abriu seu checklist do dia?', url: U.checklist, day: '06:15', night: '18:15' },
            { t: 'Logou e fez a chamada com os associados de Onboarding?', url: U.planOnb },
            { t: 'Certificou se os embaixadores registraram todos os treinamentos no ATA?', note: NOTE_EXE, day: '09:00', night: '21:00' },
            { t: 'Retirou as permissões dos associados que faltaram no Dia 2 do Onboarding?', url: U.perms, day: '10:00', night: '22:00' },
            { t: 'Certificou se os embaixadores executaram os apollos de qualidade e produtividade?', url: U.apollo, day: '15:00', night: '02:30' },
            { t: 'Gestão de ponto e TOT dos novos associados (Dia 1 ao Dia 3)', url: U.ppa },
            { t: 'Fechou os GCAs abertos dos associados de Onboarding?', url: U.guided, day: '16:00', night: '03:00' },
            { t: 'Realizou sua meta de apollos? (PA:10 · Support:20)', url: U.netlify },
            { t: 'Realizou o Onboarding Feedback do Dia 3? (Asana)', url: U.asanaFb, day: '17:30', night: '04:30' },
            { t: 'Enviou o checklist e o EOS?', url: U.checklist, day: '18:00', night: '05:00' },
        ],
        pa: [
            { t: 'Verificou seu e-mail?', url: U.mail },
            { t: 'Abriu seu checklist do dia?', url: U.checklist, day: '06:15', night: '18:15' },
            { t: 'Validou/tratou os tickets?', url: U.tickets },
            { t: 'Atualizou o app de acompanhamento LC? (só turno day)', url: U.netlify, day: '08:10', dayOnly: true },
            { t: 'Alinhou e/ou validou os safety compliance? (ao menos 1x por escala)', url: U.quicksight },
            { t: 'Verificou a conformidade da planilha de Embaixadores? (ao menos 1x por escala)', url: U.planEmb },
            { t: 'Acompanhou algum treinamento? Se sim, verificou os registros no ATA?', note: NOTE_EXE },
            { t: 'Acompanhando os associados LCs? (PA:10 · Support:20)', url: U.netlify },
            { t: 'Enviar TTs pendentes para o Slack', url: U.tickets, day: '16:30', night: '04:30' },
            { t: 'Enviou o checklist e o EOS?', url: U.checklist, day: '18:00', night: '05:00' },
        ],
        support: [
            { t: 'Verificou seu e-mail?', url: U.mail },
            { t: 'Validou/tratou os tickets?', url: U.tickets },
            { t: 'Acompanhou algum treinamento? Se sim, verificou os registros no ATA?', note: NOTE_EXE },
            { t: 'Acompanhando os associados LCs? (PA:10 · Support:20)', url: U.netlify, day: '08:30', night: '19:00' },
            { t: 'Enviou o checklist e o EOS?', url: U.mail, day: '18:00', night: '05:00' },
        ],
    };
    const SEL_LABEL = { onb1: 'Onboarding — Dia 1', onb2: 'Onboarding — Dia 2', onb3: 'Onboarding — Dia 3', pa: 'PA', support: 'Support' };

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
    const K_CYCLE = 'chkatv_cycle';   // { opDate, shift, selection, done }
    const K_POS   = 'chkatv_pos';
    const K_MODE  = 'chkatv_mode';
    const K_CUSTOM = 'chkatv_custom'; // [{ id, t }] — itens pessoais adicionados pelo usuário

    // ── Itens pessoais (aba "Adicionar") ─────────────────────────────────
    function getCustom() { try { const v = JSON.parse(store.get(K_CUSTOM, '[]')); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
    function setCustom(a) { store.set(K_CUSTOM, JSON.stringify(a)); }
    function addCustomItem(t, alert, url) { const a = getCustom(); a.push({ id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000), t: t, alert: alert || null, url: url || null }); setCustom(a); }
    function removeCustomItem(id) { setCustom(getCustom().filter(x => x.id !== id)); }

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
    // Mudanças em outras abas refletem em até 3s; setCycle atualiza o cache na hora.
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
            c = { opDate: opd, shift: shiftFromTime(now), selection: null, done: {} };
            setCycle(c);
            warnedIds = {}; beepedIds = {};
        }
        return c;
    }
    function setSelection(sel) { const c = ensureCycle(); c.selection = sel; c.done = {}; setCycle(c); warnedIds = {}; beepedIds = {}; }
    function toggleDone(id) { const c = ensureCycle(); if (c.done[id]) delete c.done[id]; else c.done[id] = true; setCycle(c); }
    function reAsk() { const c = ensureCycle(); c.selection = null; c.done = {}; setCycle(c); warnedIds = {}; beepedIds = {}; }
    const SNOOZE_MS = 5 * 60 * 1000;   // adiar no máximo 5 minutos
    function snoozeItem(id) { const c = ensureCycle(); if (!c.snooze) c.snooze = {}; c.snooze[id] = nowMs() + SNOOZE_MS; setCycle(c); }
    // Override manual do turno (mantém a detecção automática; só troca quando o usuário clica).
    function toggleShift() { const c = ensureCycle(); c.shift = (c.shift === 'day') ? 'night' : 'day'; setCycle(c); warnedIds = {}; beepedIds = {}; }

    // ── Estado atual ─────────────────────────────────────────────────────
    let menuOpen = false, menuVisible = false, warnedIds = {}, beepedIds = {}, listFilter = '', chkTab = 'tasks';
    let audioCtx = null, centered = false, setupPostponed = false, lastListSig = '', radialEl = null;
    let ringEl = null, ringBadge = null, erradoCount = 0;   // anel vermelho de "logados errados"
    // Lembrete de hora cheia: guarda a última hora (0–23) em que o menu abriu sozinho,
    // para abrir só 1x por hora quando o overlay está no modo círculo (menu fechado).
    let lastAutoOpenHour = new Date().getHours();

    function computeState() {
        const c = ensureCycle();
        if (!c.selection || !CHECKLISTS[c.selection]) {
            return { needSetup: true, shift: c.shift, items: [], total: 0, doneCount: 0, pct: 0, overdue: [], warning: [] };
        }
        const shift = c.shift, done = c.done || {}, snoozeMap = c.snooze || {}, t = nowMs();
        let list = CHECKLISTS[c.selection].filter(a => !(a.dayOnly && shift !== 'day'));
        const items = list.map((a, idx) => {
            const id = c.selection + '_' + idx;
            const hhmm = (shift === 'night') ? (a.night || null) : (a.day || null);
            const ts = alertTs(c.opDate, shift, hhmm);
            const secsLeft = ts ? Math.round((ts - t) / 1000) : null;
            const isDone = !!done[id];
            const snoozeUntil = snoozeMap[id] || 0;
            const snoozed = !isDone && t < snoozeUntil;
            return {
                id, label: a.t, url: a.url || null, note: a.note || null, alert: hhmm || null, ts,
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
                id: id, label: ci.t, url: ci.url || null, note: null, alert: hhmm, ts: ts,
                done: isDone, secsLeft: secsLeft,
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
        return { needSetup: false, selection: c.selection, shift, items, total, doneCount, pct, overdue, warning };
    }

    // ── Helpers de UI (CSSOM — seguro sob CSP) ───────────────────────────
    const FF = "font-family:'Segoe UI',Arial,sans-serif;";
    const AMZ = "font-family:'Amazon Ember','Segoe UI',Arial,sans-serif;";
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
    // Abre o .exe via protocolo do Windows (precisa do .reg registrado). Mostra instrução.
    function tryLaunchExe() {
        try {
            const a = document.createElement('a');
            a.href = PROTO_EXE; a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => a.remove(), 600);
        } catch (e) {}
        toast(NOTE_EXE);
    }

    // ── Elementos ────────────────────────────────────────────────────────
    let fab, fabWater, fabPct, menu, listEl, hdPct, hdSub, hdSubTxt, take, modeBtn, setupEl, helpEl, searchInput;
    let chkTabBtnTasks, chkTabBtnAdd, addInput, chkSearchBar;

    function buildUI() {
        const sz = FAB_SIZE;
        // z-index do círculo MAIOR que o do menu → o círculo nunca fica atrás/abaixo da lista.
        fab = el('div', 'position:fixed;top:16px;left:16px;z-index:2147483010;width:' + sz + 'px;height:' + sz + 'px;'
            + 'border-radius:50%;cursor:pointer;overflow:hidden;box-shadow:0 5px 16px rgba(0,0,0,.45);'
            + 'background:#1b2733;border:2px solid rgba(255,255,255,.16);' + FF + 'transition:transform .15s ease;');
        fab.id = 'chkatv-fab';
        fab.title = 'Mini checklist — clique para abrir, arraste para mover';
        fab.setAttribute('role', 'button');
        fab.setAttribute('aria-label', 'Mini checklist (abrir/fechar)');
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
        fadeIn(fab, 260, -6);
        wireDrag();

        // Paleta clara (padrão Amazon), igual ao Minichecklist Mecanismos.
        menu = el('div', 'position:fixed;bottom:16px;left:16px;z-index:2147483000;width:340px;max-height:82vh;'
            + 'background:#EEF1F4;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);overflow:hidden;display:none;flex-direction:column;' + AMZ);
        menu.id = 'chkatv-menu';

        const hd = el('div', 'background:linear-gradient(135deg,#2C3E50,#232F3E 55%,#131921);padding:12px 14px;color:#fff;');
        const hdTop = el('div', 'display:flex;align-items:center;gap:8px;');
        hdTop.appendChild(el('span', 'font-size:16px;', '🗒️'));
        hdTop.appendChild(el('span', 'font-size:14px;font-weight:800;flex:1;', 'Mini checklist'));
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
        chg.title = 'Perguntar novamente (Onboarding / PA / Support)';
        chg.setAttribute('aria-label', 'Trocar fluxo (perguntar novamente)');
        chg.addEventListener('click', () => { reAsk(); render(); });
        ft.appendChild(el('span', 'flex:1;', 'Clique na tarefa para marcar/desmarcar'));
        ft.appendChild(chg);
        menu.appendChild(ft);
        document.body.appendChild(menu);

        applyPos();
        buildRing();
    }

    // ── Posicionamento + arrastar ────────────────────────────────────────
    // Menu do checklist fixo no canto inferior-esquerdo (mesmo lugar do painel Onboarding Hours).
    function positionMenu() {
        if (!menu) return;
        menu.style.left = '16px';
        menu.style.right = 'auto';
        menu.style.top = 'auto';
        menu.style.bottom = '16px';
    }
    // Um overlay (checklist OU onboarding hours) está aberto? → o círculo some.
    function overlayOpen() { return menuVisible || (onbModule && onbModule.isOpen()); }
    function applyGroupVisibility() {
        const hide = overlayOpen();
        if (fab) fab.style.display = hide ? 'none' : '';
        if (hide) { if (ringEl) ringEl.style.display = 'none'; if (ringBadge) ringBadge.style.display = 'none'; }
    }

    // ── Anel vermelho de "logados errados" ao redor do círculo ──────────
    const RING_EXTRA = 12;
    function buildRing() {
        if (document.getElementById('chkatv-ring')) { ringEl = document.getElementById('chkatv-ring'); ringBadge = document.getElementById('chkatv-ring-badge'); return; }
        ringEl = el('div', 'position:fixed;z-index:2147483009;pointer-events:none;border-radius:50%;'
            + 'box-sizing:border-box;border:3px solid transparent;display:none;');
        ringEl.id = 'chkatv-ring';
        document.body.appendChild(ringEl);
        ringBadge = el('div', 'position:fixed;z-index:2147483012;pointer-events:none;min-width:20px;height:20px;'
            + 'padding:0 6px;border-radius:10px;background:#cc0000;color:#fff;font-size:11px;font-weight:800;'
            + 'display:none;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.45);' + FF);
        ringBadge.id = 'chkatv-ring-badge';
        document.body.appendChild(ringBadge);
        positionRing();
    }
    function positionRing() {
        if (!fab) return;
        const r = fab.getBoundingClientRect();
        if (ringEl) {
            ringEl.style.left = Math.round(r.left - RING_EXTRA / 2) + 'px';
            ringEl.style.top = Math.round(r.top - RING_EXTRA / 2) + 'px';
            ringEl.style.width = Math.round(r.width + RING_EXTRA) + 'px';
            ringEl.style.height = Math.round(r.height + RING_EXTRA) + 'px';
        }
        if (ringBadge) { ringBadge.style.left = Math.round(r.right - 12) + 'px'; ringBadge.style.top = Math.round(r.top - 6) + 'px'; }
    }
    // Só aparece quando há "logados errados" (>0), no contexto de Onboarding/FCLM, e o círculo visível.
    function updateRing() {
        if (!ringEl) return;
        const c = ensureCycle();
        const onbAvail = c.selection && (onFclmOnbReport() || /^onb/.test(c.selection || ''));
        if (!onbAvail || overlayOpen() || erradoCount <= 0) {
            ringEl.style.display = 'none'; if (ringBadge) ringBadge.style.display = 'none'; stopPulse(ringEl);
            return;
        }
        positionRing();
        ringEl.style.display = 'block';
        ringEl.style.borderColor = '#ff4d4d';
        ringEl.style.boxShadow = '0 0 10px rgba(204,0,0,.6)';
        startPulse(ringEl);
        ringBadge.textContent = String(erradoCount);
        ringBadge.style.display = 'flex';
    }

    // ── Mini-menu radial (Checklist / Onboarding Hours) ─────────────────
    function hideRadial() { if (!radialEl) return; const a = radialEl; radialEl = null; fadeOut(a, 120, () => a.remove()); }
    function showRadial() {
        if (radialEl || !fab) return;
        const r = fab.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width / 2 + 34, sz = 46;
        radialEl = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483060;' + FF);
        radialEl.addEventListener('click', hideRadial);
        const mk = (icon, title, angleDeg, cb, bg) => {
            const a = angleDeg * Math.PI / 180;
            const bx = cx + rad * Math.cos(a) - sz / 2, by = cy + rad * Math.sin(a) - sz / 2;
            const b = el('button', 'position:fixed;width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;cursor:pointer;'
                + 'display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;border:2px solid rgba(255,255,255,.2);'
                + 'box-shadow:0 6px 16px rgba(0,0,0,.45);background:' + bg + ';' + FF, icon);
            b.style.left = Math.round(Math.min(Math.max(4, bx), window.innerWidth - sz - 4)) + 'px';
            b.style.top = Math.round(Math.min(Math.max(4, by), window.innerHeight - sz - 4)) + 'px';
            b.title = title;
            b.addEventListener('click', (e) => { e.stopPropagation(); hideRadial(); cb(); });
            try { b.animate([{ opacity: 0, transform: 'translate(' + Math.round(cx - bx - sz / 2) + 'px,' + Math.round(cy - by - sz / 2) + 'px) scale(.4)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.34,1.4,.4,1)' }); } catch (e2) {}
            radialEl.appendChild(b);
        };
        mk('🗒️', 'Abrir Checklist', -26, () => { if (onbModule) onbModule.closeAll(); menuOpen = true; render(); }, 'linear-gradient(145deg,#37475A,#232F3E)');
        mk('📊', 'Abrir Onboarding Hours', 26, () => { menuOpen = false; setMenuVisible(false); if (onbModule) onbModule.openOverlay(); render(); }, 'linear-gradient(145deg,#f59e0b,#c77800)');
        document.body.appendChild(radialEl);
        fadeIn(radialEl, 120);
    }
    function applyPos() {
        let left = 16, top = 16;
        const p = getPos();
        if (p && typeof p.left === 'number' && typeof p.top === 'number') { left = p.left; top = p.top; }
        left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - FAB_SIZE));
        top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - FAB_SIZE));
        fab.style.left = left + 'px'; fab.style.top = top + 'px';
        positionRing();
        positionMenu();
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
            let left = e.clientX - offX, top = e.clientY - offY;
            left = Math.min(Math.max(0, left), window.innerWidth - fab.offsetWidth);
            top = Math.min(Math.max(0, top), window.innerHeight - fab.offsetHeight);
            fab.style.left = left + 'px'; fab.style.top = top + 'px';
            positionRing();
            positionMenu();
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            if (fab) fab.style.transition = 'transform .15s ease';
            if (moved) { const r = fab.getBoundingClientRect(); setPos({ left: Math.round(r.left), top: Math.round(r.top) }); }
            else {
                const c = ensureCycle();
                if (!c.selection) { setupPostponed = false; showSetup(); }   // sem fluxo → reabre o setup
                else {
                    const onbAvail = onFclmOnbReport() || /^onb/.test(c.selection || '');
                    if (radialEl) hideRadial();
                    else if (onbAvail) showRadial();   // 2 opções: Checklist / Onboarding Hours
                    else menuOpen = true;              // fluxos sem onboarding → abre o checklist direto
                }
                render();
            }
        });
    }

    // ── Toast (instrução de itens sem link) ──────────────────────────────
    function toast(msg) {
        const tEl = el('div', 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483600;'
            + 'background:#12202e;color:#e6edf3;border:1px solid #52708c;border-radius:10px;padding:12px 16px;'
            + 'max-width:80vw;box-shadow:0 10px 30px rgba(0,0,0,.5);font-size:13px;line-height:1.5;' + FF, msg);
        document.body.appendChild(tEl);
        fadeIn(tEl, 160);
        setTimeout(() => fadeOut(tEl, 220, () => tEl.remove()), 4500);
    }

    // ── Ajuda (objetivo do checklist) ────────────────────────────────────
    function toggleHelp() {
        if (helpEl) { const h = helpEl; helpEl = null; fadeOut(h, 140, () => h.remove()); return; }
        helpEl = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483500;background:rgba(5,10,18,.6);'
            + 'display:flex;align-items:center;justify-content:center;' + AMZ);
        const box = el('div', 'width:min(460px,90vw);background:#EEF1F4;border-radius:14px;overflow:hidden;'
            + 'box-shadow:0 20px 60px rgba(0,0,0,.5);');
        box.appendChild(el('div', 'background:linear-gradient(135deg,#2C3E50,#232F3E 55%,#131921);color:#fff;padding:14px 18px;'
            + 'font-size:16px;font-weight:800;', 'ℹ️ Sobre este checklist'));
        const bd = el('div', 'padding:18px;');
        bd.appendChild(el('p', 'font-size:13px;line-height:1.6;color:#37475A;margin:0 0 10px;',
            'Este mini-checklist serve para NÃO esquecer as tarefas de maior impacto do turno. Marque cada item ao concluir (clique no texto ou na caixa). Itens com horário disparam alerta pela hora atual — no modo Alerta a tela é travada e toca um bip 1 minuto antes. Use os botões 🔗 para abrir cada atividade.'));
        bd.appendChild(el('p', 'font-size:12.5px;line-height:1.6;color:#5B6B7B;margin:0 0 16px;',
            'Quem não tiver o verificador_treinamento.exe na pasta Documentos deve falar com os analistas na mesa de Learning.'));
        const close = el('button', 'display:block;margin-left:auto;background:#FF9900;color:#131921;border:1px solid #E88B00;border-radius:9px;padding:9px 18px;'
            + 'font-weight:800;cursor:pointer;' + AMZ, 'Entendi');
        close.addEventListener('click', () => toggleHelp());
        bd.appendChild(close);
        box.appendChild(bd);
        helpEl.appendChild(box);
        helpEl.addEventListener('click', (e) => { if (e.target === helpEl) toggleHelp(); });
        document.body.appendChild(helpEl);
        fadeIn(helpEl, 160);
    }

    // ── Setup: pergunta de fluxo (Onboarding / PA / Support) ─────────────
    function hideSetup() { if (setupEl) { const s = setupEl; setupEl = null; s.remove(); } }
    function bigBtn(label, bg, cb) {
        const b = el('button', 'display:block;width:100%;margin:8px 0;padding:13px;border:none;border-radius:11px;'
            + 'font-size:15px;font-weight:800;cursor:pointer;color:#fff;background:' + bg + ';' + FF, label);
        b.addEventListener('mouseenter', () => b.style.filter = 'brightness(1.08)');
        b.addEventListener('mouseleave', () => b.style.filter = 'none');
        b.addEventListener('click', cb);
        return b;
    }
    function renderSetupStep(step) {
        const card = setupEl._card; card.textContent = '';
        const c = ensureCycle();
        card.appendChild(el('div', 'font-size:20px;font-weight:800;color:#ffce7a;margin-bottom:4px;', '🗒️ Mini checklist'));
        card.appendChild(el('div', 'font-size:12px;color:#9fb3c8;margin-bottom:16px;',
            'Turno detectado: ' + (c.shift === 'day' ? '☀️ Day (05:30–18:00)' : '🌙 Night (18:00–05:30)')));
        if (step === 1) {
            card.appendChild(el('div', 'font-size:15px;font-weight:700;margin-bottom:12px;', 'Vai conduzir Onboarding hoje?'));
            card.appendChild(bigBtn('Onboarding — Dia 1', 'linear-gradient(180deg,#ffab2e,#f59e0b)', () => choose('onb1')));
            card.appendChild(bigBtn('Onboarding — Dia 2', 'linear-gradient(180deg,#ffab2e,#f59e0b)', () => choose('onb2')));
            card.appendChild(bigBtn('Onboarding — Dia 3', 'linear-gradient(180deg,#ffab2e,#f59e0b)', () => choose('onb3')));
            card.appendChild(bigBtn('Não vou conduzir Onboarding', 'linear-gradient(180deg,#37475A,#232F3E)', () => renderSetupStep(2)));
            const later = el('button', 'margin-top:8px;background:transparent;border:none;color:#8aa1b6;cursor:pointer;font-size:12px;' + FF, 'Agora não (perguntar depois)');
            later.title = 'Fecha por enquanto — clique no círculo para escolher depois';
            later.addEventListener('click', () => { setupPostponed = true; hideSetup(); });
            card.appendChild(later);
        } else {
            card.appendChild(el('div', 'font-size:15px;font-weight:700;margin-bottom:12px;', 'Qual é o seu fluxo hoje?'));
            card.appendChild(bigBtn('PA', 'linear-gradient(180deg,#3aa0ff,#1f6fd6)', () => choose('pa')));
            card.appendChild(bigBtn('Support', 'linear-gradient(180deg,#2ecc71,#1e8449)', () => choose('support')));
            const back = el('button', 'margin-top:8px;background:transparent;border:none;color:#8aa1b6;cursor:pointer;font-size:12px;' + FF, '← Voltar');
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
        renderSetupStep(1);
    }
    function choose(sel) { setSelection(sel); hideSetup(); menuOpen = true; render(); }

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

    // ── Linha da tarefa ──────────────────────────────────────────────────
    let hoveredLinkId = null;   // mantém o botão 🔗 preenchido mesmo quando a lista é reconstruída
    function buildRow(i) {
        const accent = i.done ? '#27AE60' : (i.overdue ? '#CC0000' : (i.warning ? '#E88B00' : '#CBD3DB'));
        const row = el('div', 'display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #E8E8E8;'
            + 'border-left:4px solid ' + accent + ';border-radius:10px;padding:9px 11px;margin-bottom:8px;'
            + 'box-shadow:0 2px 6px rgba(35,47,62,.06);cursor:pointer;opacity:' + (i.done ? '.7' : '1') + ';');
        row.addEventListener('mouseenter', () => row.style.background = '#F7FAFF');
        row.addEventListener('mouseleave', () => row.style.background = '#fff');
        row.addEventListener('click', () => { toggleDone(i.id); render(); });

        const box = el('span', 'width:20px;height:20px;border-radius:6px;border:2px solid ' + (i.done ? '#27AE60' : (i.overdue ? '#CC0000' : '#B9C4CE')) + ';'
            + 'background:' + (i.done ? '#27AE60' : '#fff') + ';flex:none;display:flex;align-items:center;'
            + 'justify-content:center;font-size:13px;color:#fff;', i.done ? '✔' : '');
        row.appendChild(box);

        const mid = el('div', 'flex:1;min-width:0;');
        mid.appendChild(el('div', 'font-size:13px;font-weight:800;line-height:1.3;'
            + (i.done ? 'text-decoration:line-through;color:#8090A0;' : 'color:#232F3E;'), i.label));
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
            lb.title = 'Abrir atividade';
            lb.addEventListener('mouseenter', () => { hoveredLinkId = i.id; lb.style.background = '#FF9900'; lb.style.color = '#131921'; });
            lb.addEventListener('mouseleave', () => { hoveredLinkId = null; lb.style.background = '#fff'; lb.style.color = '#FF9900'; });
            lb.addEventListener('click', (e) => { e.stopPropagation(); openUrl(i.url); });
            row.appendChild(lb);
        } else if (i.note) {
            const nb = el('button', 'flex:none;background:#EAEDF0;border:1px solid #CBD3DB;color:#232F3E;border-radius:8px;'
                + 'padding:7px 9px;cursor:pointer;font-size:13px;' + AMZ, '📄');
            nb.title = 'Abrir verificador_treinamento.exe';
            nb.addEventListener('click', (e) => { e.stopPropagation(); tryLaunchExe(); });
            row.appendChild(nb);
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
        take.id = 'chkatv-take'; take._id = item.id;
        const box = el('div', 'width:min(540px,92vw);background:#12202e;border:2px solid #cc0000;border-radius:18px;'
            + 'padding:30px;text-align:center;color:#fff;box-shadow:0 24px 70px rgba(0,0,0,.6);');
        box.appendChild(el('div', 'font-size:52px;', '⚠️'));
        box.appendChild(el('h2', 'margin:10px 0 4px;font-size:22px;color:#ff6b6b;', 'Atividade pendente!'));
        box.appendChild(el('div', 'font-size:18px;font-weight:800;margin:14px 0;color:#ffce7a;', item.label));
        box.appendChild(el('p', 'color:#c2d2e0;font-size:14px;margin:6px 0 22px;line-height:1.5;',
            'Passou do horário de alerta (' + (item.alert || '') + ') e a atividade ainda não foi concluída.'));
        const go = el('button', 'background:linear-gradient(180deg,#ff5252,#cc0000);color:#fff;border:none;padding:14px 26px;'
            + 'border-radius:11px;font-size:16px;font-weight:800;cursor:pointer;' + FF,
            (item.url || item.note) ? '▶ Abrir e marcar como feita' : '✔ Marcar como feita');
        go.addEventListener('mouseenter', () => go.style.filter = 'brightness(1.1)');
        go.addEventListener('mouseleave', () => go.style.filter = 'none');
        go.addEventListener('click', () => { if (item.url) openUrl(item.url); else if (item.note) tryLaunchExe(); toggleDone(item.id); hideTakeover(); render(); });
        box.appendChild(go);
        startPulse(go);
        const sn = el('button', 'display:block;margin:12px auto 0;background:transparent;color:#c2d2e0;border:1px solid #52708c;'
            + 'padding:10px 20px;border-radius:11px;font-size:13px;font-weight:700;cursor:pointer;' + FF, '⏰ Adiar 5 min');
        sn.setAttribute('aria-label', 'Adiar esta atividade por 5 minutos');
        sn.addEventListener('mouseenter', () => sn.style.background = 'rgba(255,255,255,.08)');
        sn.addEventListener('mouseleave', () => sn.style.background = 'transparent');
        sn.addEventListener('click', () => { snoozeItem(item.id); hideTakeover(); render(); });
        box.appendChild(sn);
        if (item.note) box.appendChild(el('div', 'margin-top:12px;font-size:12px;color:#8aa1b6;', item.note));
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

    // Página fixa do FCLM: QUALQUER relatório functionRollup (o painel puxa todos os
    // processos, igual ao Learning Hours). Nela o painel fica SEMPRE ativo (independe do fluxo)
    // e ganha o filtro de janela selecionável.
    function onFclmOnbReport() {
        return /^https?:\/\/fclm-portal\.amazon\.com\/reports\/functionRollup/i.test(location.href);
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

    // ── Render (a cada tick) ─────────────────────────────────────────────
    function render() {
        if (!fab || !document.body.contains(fab)) buildUI();
        if (!ringEl || !document.body.contains(ringEl)) buildRing();
        const s = computeState();
        const mode = getMode();

        const ringColor = s.needSetup ? '#52708c' : (s.overdue.length ? '#cc0000' : (s.pct === 100 ? '#27ae60' : '#ff9900'));
        fabWater.style.height = s.pct + '%';         // nível da água = % (transição fluida)
        fabWater.style.background = ringColor;
        fabPct.textContent = s.pct + '%';
        if (s.overdue.length && mode === 'alert') startPulse(fab); else stopPulse(fab);

        // Onboarding/Learning Hours (barra + dashboard): ativo quando o fluxo é Onboarding OU
        // sempre que estiver em qualquer relatório functionRollup do FCLM (painel fixo).
        if (onbModule) {
            const onbActive = onFclmOnbReport() || (!s.needSetup && /^onb/.test(s.selection || ''));
            if (onbActive) onbModule.enable(); else onbModule.disable();
        }

        // 100% concluído → esconde a lista e centraliza o círculo no topo (visual, sempre).
        // A COMEMORAÇÃO (confete/banner) roda só 1x por DIA OPERACIONAL (marcador salvo no ciclo).
        // A centralização do círculo acontece SÓ no momento do efeito (junto da comemoração,
        // 1x por dia operacional). Em reload já comemorado, fica na posição salva (não centraliza).
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

        if (s.needSetup) { setMenuVisible(false); hideTakeover(); if (!setupPostponed) showSetup(); return; }
        hideSetup();

        // Lembrete de hora cheia: ao virar a hora, se o overlay está no modo círculo
        // (menu fechado), abre a lista sozinho para lembrar do checklist.
        const curHour = new Date().getHours();
        if (curHour !== lastAutoOpenHour) {
            lastAutoOpenHour = curHour;
            if (!menuOpen) menuOpen = true;
        }

        if (hdSubTxt) hdSubTxt.textContent = (SEL_LABEL[s.selection] || '') + ' · Turno ' + (s.shift === 'day' ? 'Day ☀️' : 'Night 🌙');
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

        updateRing();             // anel vermelho de "logados errados"
        applyGroupVisibility();   // some com o círculo quando um overlay (checklist/onboarding) está aberto
    }

    // ═════════════════════════════════════════════════════════════════════
    // MÓDULO ONBOARDING POR TREINAMENTO (FCLM → Slack) — assimilado.
    // Escopo isolado (nomes próprios, sem colisão). Só é ativado quando o
    // fluxo escolhido é Onboarding (enable/disable a partir do render).
    // ═════════════════════════════════════════════════════════════════════
    function createOnbModule() {
        const C = {
            dark: '#232F3E', darker: '#131921', hover: '#37475A', accent: '#FF9900',
            gold: '#FEBD69', blue: '#4A86C8', navy: '#12395F', grey: '#607D8B', red: '#CC0000',
            amber: '#E88B00', green: '#27AE60', white: '#FFFFFF', light: '#F7F7F7', border: '#E8E8E8',
            headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
            btnGrad: 'linear-gradient(145deg,#37475A 0%,#232F3E 100%)',
            btnGradH: 'linear-gradient(145deg,#4A5D72 0%,#37475A 100%)',
            bodyBg: '#EEF1F4',
        };
        const POSKEY = 'fclm_onb_panel_pos';
        const FCLM_ORIGIN = 'https://fclm-portal.amazon.com';

        function gmGet(k, d) { try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : (localStorage.getItem(k) ?? d); } catch (e) { return d; } }
        function gmSet(k, v) { try { (typeof GM_setValue === 'function') ? GM_setValue(k, v) : localStorage.setItem(k, v); } catch (e) {} }

        const WAREHOUSE = 'GRU5';
        const ONB_PROCESS = '1002986';     // relatório de Onboarding
        const LEARN_PROCESS = '1002960';   // relatório de Learning (confirme o processId)
        const LEARN_FN = '4300006689';     // função "Learning"
        const REPORT_LINK = 'https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=HTML&warehouseId=GRU5&processId=1002986';
        const ICQA_PROCESS = '1003030';    // relatório de ICQA (ICQA Ambassador + ICQA Training)
        // Página fixa: qualquer relatório functionRollup do FCLM (aqui vale o filtro selecionável).
        function onFclmReport() { return /^https?:\/\/fclm-portal\.amazon\.com\/reports\/functionRollup/i.test(location.href); }

        // ── Processos (abas de "Mais detalhes") — assimilado do Learning Hours ──
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
            { key: 'errado', name: 'Logado errado', virtual: true },   // General FC Training nos Dias 2/3
            { key: 'badge', name: 'Ajuste de Badge', virtual: true },
        ];
        // Limite de horas POR TREINAMENTO (configurável e persistente). Fonte única de funções.
        const TRAININGS = [
            { fnId: '4300018945', re: /fc safety tour/i, name: 'FC Safety Tour', proc: 'onb', limitKey: 'fclm_onb_lim_fcsafetytour', defLimit: 1 },
            { fnId: '4300006671', re: /general fc training|fc training/i, name: 'General FC Training', proc: 'onb', limitKey: 'fclm_onb_lim_fctraining', defLimit: 9 },
            { fnId: '4300018942', re: /safety school/i, name: 'Safety School', proc: 'onb', limitKey: 'fclm_onb_lim_safetyschool', defLimit: 2 },
            { re: /icqa ambassador/i, name: 'ICQA Ambassador', proc: 'icqa', limitKey: 'fclm_onb_lim_icqaamb', defLimit: 11 },
            { re: /icqa training/i, name: 'ICQA Training', proc: 'icqa', limitKey: 'fclm_onb_lim_icqatrn', defLimit: 4 },
            { re: /c-?returns ambassador/i, name: 'C-Returns Ambassador', proc: 'cret', limitKey: 'fclm_onb_lim_cretamb', defLimit: 11 },
            { re: /c-?returns training/i, name: 'C-Returns Training', proc: 'cret', limitKey: 'fclm_onb_lim_crettrn', defLimit: 4 },
            { re: /sort ambassador/i, name: 'Sort Ambassador', proc: 'sort', limitKey: 'fclm_onb_lim_sortamb', defLimit: 11 },
            { re: /sort training/i, name: 'Sort Training', proc: 'sort', limitKey: 'fclm_onb_lim_sorttrn', defLimit: 4 },
            { re: /pick ambassador/i, name: 'Pick Ambassador', proc: 'pick', limitKey: 'fclm_onb_lim_pickamb', defLimit: 11 },
            { re: /pick training/i, name: 'Pick Training', proc: 'pick', limitKey: 'fclm_onb_lim_picktrn', defLimit: 4 },
            { re: /pack ambassador/i, name: 'Pack Ambassador', proc: 'pack', limitKey: 'fclm_onb_lim_packamb', defLimit: 11 },
            { re: /pack training/i, name: 'Pack Training', proc: 'pack', limitKey: 'fclm_onb_lim_packtrn', defLimit: 4 },
            { re: /ship ambassador/i, name: 'Ship Ambassador', proc: 'ship', limitKey: 'fclm_onb_lim_shipamb', defLimit: 11 },
            { re: /ship training/i, name: 'Ship Training', proc: 'ship', limitKey: 'fclm_onb_lim_shiptrn', defLimit: 4 },
            { re: /stow ambassador/i, name: 'Stow Ambassador', proc: 'stow', limitKey: 'fclm_onb_lim_stowamb', defLimit: 11 },
            { re: /stow prime training|stow training/i, name: 'Stow Prime Training', proc: 'stow', limitKey: 'fclm_onb_lim_stowtrn', defLimit: 4 },
            { re: /transfer in amb/i, name: 'Transfer In Ambssdr', proc: 'tin', limitKey: 'fclm_onb_lim_tinamb', defLimit: 11 },
            { re: /transfer in training/i, name: 'Transfer In Training', proc: 'tin', limitKey: 'fclm_onb_lim_tintrn', defLimit: 4 },
            { re: /ib dock ambassador/i, name: 'IB Dock Ambassador', proc: 'recv', limitKey: 'fclm_onb_lim_ibdockamb', defLimit: 11 },
            { re: /receive ambassador/i, name: 'Receive Ambassador', proc: 'recv', limitKey: 'fclm_onb_lim_recvamb', defLimit: 11 },
            { re: /receive training/i, name: 'Receive Training', proc: 'recv', limitKey: 'fclm_onb_lim_recvtrn', defLimit: 4 },
            { re: /v-?returns ambassador/i, name: 'V-Returns Ambassador', proc: 'vret', limitKey: 'fclm_onb_lim_vretamb', defLimit: 11 },
            { re: /v-?returns training/i, name: 'V-Returns Training', proc: 'vret', limitKey: 'fclm_onb_lim_vrettrn', defLimit: 4 },
            { re: /prep ambassador/i, name: 'Prep Ambassador', proc: 'prep', limitKey: 'fclm_onb_lim_prepamb', defLimit: 11 },
            { re: /prep training/i, name: 'Prep Training', proc: 'prep', limitKey: 'fclm_onb_lim_preptrn', defLimit: 4 },
            { fnId: LEARN_FN, exact: true, name: 'Learning', proc: 'adm', limitKey: 'fclm_onb_lim_learning', defLimit: 1 },
        ];
        function cfgOf(t) { const fnId = t && t.fnId; const title = (t && t.title) || (typeof t === 'string' ? t : ''); return TRAININGS.find(c => (c.fnId && fnId && fnId === c.fnId) || (!c.exact && c.re && c.re.test(title)) || (c.exact && title && title.toLowerCase() === c.name.toLowerCase())) || null; }
        function isAllowedTraining(t) { return !!cfgOf(t); }
        function isLearning(t) { return t.fnId === LEARN_FN; }
        // Puxa TODAS as funções que o Learning Hours puxa (fonte única = TRAININGS).
        function passFilter(t) { return isAllowedTraining(t); }
        const procIdOf = key => { const p = PROCESSES.find(x => x.key === key); return p ? p.processId : ONB_PROCESS; };
        function procOf(t) { const c = cfgOf(t); const key = c ? c.proc : 'onb'; return PROCESSES.find(p => p.key === key) || PROCESSES[0]; }

        // Único filtro alternável: limitar por horas (só quem passou do limite) OU mostrar todos.
        const LIMIT_KEY = 'fclm_onb_limit_by_hours';
        let limitByHours = gmGet(LIMIT_KEY, '1') !== '0';
        function setLimitByHours(on) { limitByHours = !!on; gmSet(LIMIT_KEY, limitByHours ? '1' : '0'); }
        function limitLabel() { return limitByHours ? '⏱️ Limitar por horas' : '📋 Mostrar todos'; }
        function listTitle() { return limitByHours ? 'Acima em hora' : 'Todos (horas logadas)'; }

        // ── Filtro de janela selecionável (só na página fixa do FCLM) ──────────
        // Fora da página do FCLM (fluxo Onboarding Dia 1/2/3), a janela é detectada
        // automaticamente pelo turno atual (dia/noite/madrugada) — comportamento antigo.
        const FILTER_KEY = 'fclm_onb_window_filter';
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
            if (f.mode === 'full') {
                p.set('spanType', 'Day');
                p.set('startDate', ymdDash(base) + 'T00:00:00.000');
                p.set('endDate', ymdDash(next) + 'T00:00:00.000');
            } else if (f.mode === 'night') {
                p.set('maxIntradayDays', '2'); p.set('spanType', 'Intraday');
                p.set('startDateIntraday', ymdSlash(base)); p.set('startHourIntraday', '18'); p.set('startMinuteIntraday', '0');
                p.set('endDateIntraday', ymdSlash(next)); p.set('endHourIntraday', '5'); p.set('endMinuteIntraday', '30');
            } else if (f.mode === 'd6to5') {
                const prev = new Date(base); prev.setDate(base.getDate() - 1);
                p.set('maxIntradayDays', '2'); p.set('spanType', 'Intraday');
                p.set('startDateIntraday', ymdSlash(prev)); p.set('startHourIntraday', '6'); p.set('startMinuteIntraday', '0');
                p.set('endDateIntraday', ymdSlash(base)); p.set('endHourIntraday', '5'); p.set('endMinuteIntraday', '0');
            } else {
                p.set('maxIntradayDays', '1'); p.set('spanType', 'Intraday');
                p.set('startDateIntraday', ymdSlash(base)); p.set('startHourIntraday', '5'); p.set('startMinuteIntraday', '30');
                p.set('endDateIntraday', ymdSlash(base)); p.set('endHourIntraday', '18'); p.set('endMinuteIntraday', '0');
            }
            return p;
        }
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
        // Janela AUTOMÁTICA pelo turno atual (fluxo Onboarding fora da página do FCLM).
        function autoShiftParams() {
            const now = new Date();
            const mins = now.getHours() * 60 + now.getMinutes();
            const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const fmt = d => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
            let startD, endD, sH, sM, eH, eM;
            if (mins >= 330 && mins < 1080) { startD = day0; endD = day0; sH = 5; sM = 30; eH = 18; eM = 0; }
            else if (mins >= 1080) { startD = day0; endD = new Date(day0); endD.setDate(day0.getDate() + 1); sH = 18; sM = 0; eH = 5; eM = 30; }
            else { startD = new Date(day0); startD.setDate(day0.getDate() - 1); endD = day0; sH = 18; sM = 0; eH = 5; eM = 30; }
            const dayDiff = Math.round((endD - startD) / 86400000);
            const p = new URLSearchParams();
            p.set('warehouseId', WAREHOUSE);
            p.set('maxIntradayDays', String(dayDiff + 1)); p.set('spanType', 'Intraday');
            p.set('startDateIntraday', fmt(startD)); p.set('startHourIntraday', String(sH)); p.set('startMinuteIntraday', String(sM));
            p.set('endDateIntraday', fmt(endD)); p.set('endHourIntraday', String(eH)); p.set('endMinuteIntraday', String(eM));
            return p;
        }

        function reportUrl(processId) {
            // Na página fixa do FCLM usa a janela selecionável; fora dela, a janela do turno.
            const p = onFclmReport() ? buildWindowParams(currentFilter) : autoShiftParams();
            p.set('reportFormat', 'HTML');
            p.set('processId', processId || ONB_PROCESS);
            return FCLM_ORIGIN + '/reports/functionRollup?' + p.toString();
        }
        function fetchOne(processId, cb) {
            GM_xmlhttpRequest({
                method: 'GET', url: reportUrl(processId),
                onload: res => { try { cb((res.status >= 200 && res.status < 300) ? new DOMParser().parseFromString(res.responseText, 'text/html') : null); } catch (e) { cb(null); } },
                onerror: () => cb(null),
            });
        }
        // Busca o relatório de Onboarding e (quando aplicável) o de Learning, combinando.
        function fetchReport(cb) {
            // Puxa TODOS os processos que o Learning Hours puxa (não só Onboarding/Learning).
            const targets = PROCESSES.filter(p => p.processId).map(p => p.processId);
            let done = 0, errs = 0, trainings = [];
            const finish = () => {
                if (done < targets.length) return;
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
        // Cache do relatório: o poll (a cada 3 min) busca fresco e alimenta o cache;
        // abrir o overlay reusa o cache (instantâneo) se recente. force=true sempre rebusca.
        let repCache = null, repCacheTs = 0;
        const REP_TTL_MS = 3 * 60 * 1000;
        function getReport(force, cb) {
            if (!force && repCache && (Date.now() - repCacheTs) < REP_TTL_MS) { cb(repCache, null); return; }
            fetchReport((r, err) => { if (r) { repCache = r; repCacheTs = Date.now(); } cb(r, err); });
        }
        function injectUICss() {
            if (document.getElementById('onb-ui-css')) return;
            const st = document.createElement('style'); st.id = 'onb-ui-css';
            st.textContent = '@keyframes onbFade{from{opacity:0}to{opacity:1}}@keyframes onbPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}@keyframes onbRise{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:none}}';
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
                    // As horas ficam na coluna "Paid Hours → Total" (a 1ª célula com classe
                    // "size-total highlighted"). Em tabelas onde o associado também tem produção
                    // (EachStowed/ItemPacked/etc.) a última célula é UPH de outra métrica, não a hora.
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
        // Une treinamentos iguais (mesmo fnId/título) vindos de fontes diferentes
        // (fetch + página) sem duplicar pessoas — mantém o maior total por pessoa.
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
        // Limites de horas POR DIA de Onboarding (máx por treinamento).
        const DAY_LIMITS = {
            onb1: [{ re: /fc training/i, name: 'FC Training', limit: 9 }, { re: /safety tour/i, name: 'Safety Tour', limit: 1 }, { re: /safety school/i, name: 'Safety School', limit: 2 }],
            // Dia 2: General FC Training é tratado na aba "Logado errado" (fora de "Acima em hora").
            onb2: [{ re: /safety tour/i, name: 'Safety Tour', limit: 1 }, { re: /safety school/i, name: 'Safety School', limit: 1 }],
            // Dia 3: qualquer "Training" (todos os processos) = 2h no máximo. General FC Training vai em "Logado errado".
            onb3: [{ re: /training/i, name: 'Training (todos)', limit: 2 }, { re: /safety tour/i, name: 'Safety Tour', limit: 1 }, { re: /safety school/i, name: 'Safety School', limit: 1 }, { re: /learning/i, name: 'Learning', limit: 1 }],
        };
        // Limite POR TREINAMENTO (configurável e persistente) — base fora do fluxo de dia.
        function trainingLimit(c) { const v = parseFloat(String(gmGet(c.limitKey, String(c.defLimit))).replace(',', '.')); return isNaN(v) ? c.defLimit : v; }
        function setTrainingLimit(c, v) { gmSet(c.limitKey, String(v)); }
        // Override do limite pelo DIA de Onboarding (fluxo onb1/2/3, fora da página fixa do FCLM).
        function dayLimitFor(title) {
            if (onFclmReport()) return null;
            let sel; try { const c = getCycle(); sel = c && c.selection; } catch (e) {}
            const set = DAY_LIMITS[sel]; if (!set) return null;
            for (const r of set) if (r.re.test(title)) return r.limit;
            return null;
        }
        // Aceita training (objeto) ou título (string).
        function getLimit(t) {
            const title = (t && t.title != null) ? t.title : String(t || '');
            const dl = dayLimitFor(title); if (dl != null) return dl;
            const c = cfgOf((t && t.title != null) ? t : { title: title });
            return c ? trainingLimit(c) : DEFAULT_LIMIT;
        }
        function limitsDesc() {
            let sel; try { const c = getCycle(); sel = c && c.selection; } catch (e) {}
            if (!onFclmReport() && DAY_LIMITS[sel]) { const parts = DAY_LIMITS[sel].map(r => r.name + ' > ' + r.limit + 'h'); parts.push('demais > ' + DEFAULT_LIMIT + 'h'); return parts.join(' · '); }
            return TRAININGS.map(c => c.name + ' > ' + trainingLimit(c) + 'h').join(' · ');
        }
        // Limite EFETIVO do treinamento no dia atual (para exibir no popup "Ver limites").
        // General FC Training = 0h nos Dias 2/3 (ninguém deve logar nele).
        function effectiveLimit(c) {
            if (c.name === 'General FC Training' && isDay2or3()) return 0;
            return getLimit({ title: c.name, fnId: c.fnId });
        }
        // Treinamentos esperados na aba "Horas totais" (derivados da fonte única; zerados somem).
        const EXPECTED_TOTALS = TRAININGS.map(c => ({ re: c.exact ? new RegExp('^' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') : c.re, name: c.name, process: procIdOf(c.proc) }));
        // ── Ajuste de Badge: quem passou do limite (padrão 12h), derivado dos dados ──
        const BADGE_KEY = 'fclm_onb_lim_badge';
        function badgeLimit() { const v = parseFloat(String(gmGet(BADGE_KEY, '12')).replace(',', '.')); return isNaN(v) ? 12 : v; }
        function setBadgeLimit(v) { gmSet(BADGE_KEY, String(v)); }
        function badgeEntries(r) {
            const byP = {};
            r.trainings.forEach(t => { const pr = procOf(t); t.people.forEach(p => { if (p.total != null && p.total > badgeLimit()) { const k = p.id || p.name.toLowerCase(); if (!byP[k] || p.total > byP[k].total) byP[k] = { name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, procName: pr.name, total: p.total }; } }); });
            return Object.values(byP).sort((a, b) => b.total - a.total);
        }
        function badgeTag(total) { return (total != null && total > badgeLimit()) ? ' <span style="background:' + C.red + ';color:#fff;font-size:11px;font-weight:800;padding:1px 7px;border-radius:10px;margin-left:4px;">🪪 ajuste de badge</span>' : ''; }
        // Escopo por DIA de Onboarding (o que aparece no painel):
        //   Dia 1  → só os calm codes de On Boarding (processo 'onb').
        //   Dia 2/3 (e demais contextos) → todas as horas (todos os processos).
        //   Página fixa do FCLM → sempre tudo (tem o filtro de janela).
        function scopedTrainings(trainings) {
            if (onFclmReport()) return trainings;
            let sel; try { const c = getCycle(); sel = c && c.selection; } catch (e) {}
            if (sel === 'onb1') return trainings.filter(t => procOf(t).key === 'onb');
            return trainings;
        }
        // Fonte da lista "Acima em hora": nos Dias 2/3 tira General FC Training (vai na aba "Logado errado").
        function exceedingSource(trainings) {
            const scoped = scopedTrainings(trainings);
            return isDay2or3() ? scoped.filter(t => !isGeneralFcTraining(t)) : scoped;
        }
        // forceLimit=true → sempre limita por horas (usado no overlay simplificado, que
        // NUNCA mostra todos; "mostrar todos" existe só no detalhe/dashboard).
        function computeExceeding(trainings, forceLimit) {
            const list = [];
            const useLimit = forceLimit || limitByHours;
            trainings.forEach(t => { const lim = getLimit(t); t.people.forEach(p => { if (p.total != null && (!useLimit || p.total > lim)) list.push({ name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, total: p.total, limit: lim }); }); });
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
        function filterByProcess(r, procKey) { const trainings = r.trainings.filter(t => procOf(t).key === procKey); const fr = buildReportFrom(trainings); fr.manager = r.manager; return fr; }
        // Dia do Onboarding escolhido no checklist.
        function daySel() { let sel; try { const c = getCycle(); sel = c && c.selection; } catch (e) {} return sel; }
        function isDay1() { return daySel() === 'onb1'; }
        function isDay2() { return daySel() === 'onb2'; }
        function isDay3() { return daySel() === 'onb3'; }
        function isDay2or3() { const s = daySel(); return s === 'onb2' || s === 'onb3'; }
        // General FC Training: nos Dias 2/3 ninguém deve estar logado nele (vira "Logado errado").
        function isGeneralFcTraining(t) { const c = cfgOf(t); return !!(c && c.name === 'General FC Training'); }
        // Títulos da comparação "Precisa logar em outro" — APENAS os calm codes do
        // processo On Boarding (exclui Learning e demais processos).
        function compareTitles(r) {
            const onb = filterByProcess(r, 'onb');
            const learn = new Set(onb.trainings.filter(t => t.fnId === LEARN_FN || isLearning(t)).map(t => t.title));
            return onb.titles.filter(tt => !learn.has(tt));
        }
        // "Precisa logar" (só Dia 1 e Dia 2):
        //   Dia 1 → associados de On Boarding faltando em algum calm code de On Boarding.
        //   Dia 2 → quem está logado em Learning mas NÃO está em nenhum calm code "* Training"
        //           (General FC Training NÃO conta como Training válido — é "logado errado").
        function computeFaltantes(r) {
            if (isDay1()) {
                // Base: quem está logado em General FC Training. Compara com os OUTROS 2 calm codes
                // de On Boarding (FC Safety Tour e Safety School) para ver quem precisa logar.
                const otherNames = TRAININGS.filter(c => c.proc === 'onb' && c.name !== 'General FC Training').map(c => c.name);
                const haveNames = {};   // personKey -> Set de calm codes (FC Safety Tour / Safety School) em que está
                r.trainings.forEach(t => { const c = cfgOf(t); if (c && c.proc === 'onb' && c.name !== 'General FC Training') t.people.forEach(p => { const k = personKey(p); (haveNames[k] = haveNames[k] || new Set()).add(c.name); }); });
                const out = [], seen = new Set();
                r.trainings.filter(t => isGeneralFcTraining(t)).forEach(t => t.people.forEach(p => {
                    const k = personKey(p); if (seen.has(k)) return; seen.add(k);
                    const have = haveNames[k] || new Set();
                    const falta = otherNames.filter(n => !have.has(n));
                    if (falta.length) out.push({ p: { name: p.name, id: p.id, manager: p.manager, link: p.link }, falta });
                }));
                return out.sort((a, b) => (a.p.manager || '').localeCompare(b.p.manager || ''));
            }
            if (isDay2()) {
                const inTraining = new Set();
                r.trainings.filter(t => /training/i.test(t.title) && !isGeneralFcTraining(t)).forEach(t => t.people.forEach(p => inTraining.add(personKey(p))));
                const out = [], seen = new Set();
                r.trainings.filter(t => t.fnId === LEARN_FN || isLearning(t) || /^\s*learning\s*$/i.test(t.title)).forEach(t => t.people.forEach(p => {
                    const k = personKey(p);
                    if (seen.has(k)) return; seen.add(k);
                    if (!inTraining.has(k)) out.push({ p: { name: p.name, id: p.id, manager: p.manager, link: p.link }, falta: ['algum calm code de Training'] });
                }));
                return out.sort((a, b) => (a.p.manager || '').localeCompare(b.p.manager || ''));
            }
            return [];
        }
        // "Logado errado" (Dia 2/3): qualquer associado logado em General FC Training (a partir de 0h).
        function logadoErrado(r) {
            if (!isDay2or3()) return [];
            const out = [], seen = new Set();
            r.trainings.filter(t => isGeneralFcTraining(t)).forEach(t => t.people.forEach(p => {
                const k = personKey(p); if (seen.has(k)) return; seen.add(k);
                out.push({ name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, total: p.total || 0 });
            }));
            return out.sort((a, b) => (b.total || 0) - (a.total || 0));
        }

        // ── Exportação CSV (formato largo: 1 linha por associado) ────────
        function personKey(p) { return p.id || p.name.toLowerCase(); }
        function buildCsv(r) {
            const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
            const titles = r.titles;
            const faltaMap = {}; computeFaltantes(r).forEach(({ p, falta }) => { faltaMap[personKey(p)] = falta; });
            const header = ['Nome', 'ID', 'Manager'].concat(titles).concat(['Faltando em', 'Acima do limite']);
            const lines = [header.map(q).join(',')];
            r.allPeople.forEach(p => {
                const key = personKey(p);
                const hoursByTitle = {}; const acima = [];
                r.trainings.forEach(t => {
                    const pp = t.people.find(x => personKey(x) === key);
                    if (pp) { hoursByTitle[t.title] = pp.total; if (pp.total != null && pp.total > getLimit(t.title)) acima.push(t.title + ' (' + pp.total.toFixed(2) + 'h)'); }
                });
                const falta = faltaMap[key] || [];
                const row = [p.name, p.id, p.manager]
                    .concat(titles.map(tt => hoursByTitle[tt] != null ? hoursByTitle[tt].toFixed(2) : ''))
                    .concat([falta.join('; '), acima.join('; ')]);
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
            downloadCsv(buildCsv(r), 'onboarding_treinamentos' + mgr + '_' + dLbl + '.csv');
        }

        // ── Envio para o Slack (SÓ no overlay fixo do FCLM/functionRollup) ─────
        const SLACK_KEY = 'fclm_onb_slack_webhook';
        function slackName(name, link) { return link ? '<' + link + '|' + name + '>' : '*' + name + '*'; }
        // Emoji de relógio conforme a hora APROXIMADA (mais perto do horário de envio):
        // 09h/21h = :clock9: · 13h/01h = :clock1: · 17h = :clock5: · 04h = :clock4:.
        function slackClockEmoji() {
            const targets = [[9 * 60, ':clock9:'], [13 * 60, ':clock1:'], [17 * 60, ':clock5:'], [21 * 60, ':clock9:'], [1 * 60, ':clock1:'], [4 * 60, ':clock4:']];
            const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
            let bestE = targets[0][1], bestD = Infinity;
            targets.forEach(([m, e]) => { let d = Math.abs(cur - m); d = Math.min(d, 1440 - d); if (d < bestD) { bestD = d; bestE = e; } });
            return bestE;
        }
        // Categorias "amigáveis" p/ dividir as horas no Slack:
        //   General FC Training → Horas de onboarding · FC Safety Tour → Tour
        //   qualquer *Ambassador → Embaixadores · qualquer *Training (fora os acima) → Em treinamento.
        function slackCat(title) {
            if (/general fc training/i.test(title)) return 'Horas de onboarding';
            if (/fc safety tour/i.test(title)) return 'Tour';
            if (/ambassador/i.test(title)) return 'Embaixadores';
            if (/training/i.test(title)) return 'Em treinamento';
            return title;   // demais (Safety School, Learning, etc.) mantêm o nome
        }
        // Obs. resumida: uma linha por categoria com o limite (hora) na frente.
        function slackObs() {
            const lim = name => { const c = TRAININGS.find(x => x.name === name); return c ? effectiveLimit(c) : '?'; };
            const trnCfg = TRAININGS.find(c => c.proc !== 'onb' && /training/i.test(c.name));   // ex.: ICQA Training
            const ambCfg = TRAININGS.find(c => /ambassador/i.test(c.name));
            const parts = [];
            parts.push('Horas de onboarding (General FC Training) = ' + lim('General FC Training') + 'h');
            parts.push('Tour (FC Safety Tour) = ' + lim('FC Safety Tour') + 'h');
            if (trnCfg) parts.push('Em treinamento (todos com Training) = ' + effectiveLimit(trnCfg) + 'h');
            if (ambCfg) parts.push('Embaixadores (todos com Ambassador) = ' + effectiveLimit(ambCfg) + 'h');
            return parts.join(' · ');
        }
        function buildSlackText(r) {
            const now = new Date();
            const dLbl = pad2(now.getDate()) + '/' + pad2(now.getMonth() + 1) + '/' + now.getFullYear();
            const hhmm = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
            const exceeding = computeExceeding(r.trainings);
            const faltantes = computeFaltantes(r);
            const errados = logadoErrado(r);
            const badges = badgeEntries(r);
            let msg = slackClockEmoji() + ' *Learning Hours* — ' + dLbl + ' ' + hhmm + '\n';
            // Cada seção só aparece quando TEM dados.
            // ⏰ Acima da hora limite (dividido por categoria)
            if (exceeding.length) {
                msg += '\n⏰ *Acima da hora limite (' + exceeding.length + ')*\n';
                const CAT_ORDER = ['Horas de onboarding', 'Tour', 'Em treinamento', 'Embaixadores'];
                const by = groupByManager(exceeding, e => slackCat(e.title));
                const cats = Object.keys(by).sort((a, b) => { const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
                cats.forEach(cat => {
                    msg += '> *' + cat + '*\n';
                    by[cat].sort((a, b) => (b.total || 0) - (a.total || 0)).forEach(e => { msg += '>  • ' + slackName(e.name, e.link) + ' — *' + e.total.toFixed(2) + 'h*' + (e.manager ? ' (' + e.manager + ')' : '') + '\n'; });
                });
            }
            // 🔁 Faltar Logar
            if (faltantes.length) {
                msg += '\n🔁 *Faltar Logar (' + faltantes.length + ')*\n';
                const by = groupByManager(faltantes, x => x.p.manager);
                Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { msg += '> *' + mgr + '*\n'; by[mgr].forEach(({ p, falta }) => { msg += '>  • ' + slackName(p.name, p.link) + ' — colocar em: ' + falta.join(', ') + '\n'; }); });
            }
            // 🚫 Logado errado (General FC Training)
            if (errados.length) {
                msg += '\n🚫 *Logado errado (' + errados.length + ')*\n';
                const by = groupByManager(errados, e => e.manager);
                Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { msg += '> *' + mgr + '*\n'; by[mgr].forEach(e => { msg += '>  • ' + slackName(e.name, e.link) + ' — *' + (e.total || 0).toFixed(2) + 'h*\n'; }); });
            }
            // 🪪 Ajuste de Badge
            if (badges.length) {
                msg += '\n🪪 *Ajuste de Badge (' + badges.length + ')*\n';
                const by = groupByManager(badges, e => e.manager);
                Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { msg += '> *' + mgr + '*\n'; by[mgr].forEach(e => { msg += '>  • ' + slackName(e.name, e.link) + ' — *' + (e.total || 0).toFixed(2) + 'h* (' + e.title + ')\n'; }); });
            }
            msg += '\n_Obs.: ' + slackObs() + '_';
            return msg;
        }
        // Modal para colar/salvar o Webhook e enviar o resumo ao Slack.
        function openSlackModal(r) {
            const { modal, box } = makeModal('onb-webhook', '480px');
            modalHeader(box, '📤 Enviar para o Slack', 'cole/edite o Incoming Webhook e envie o resumo');
            const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:18px 20px;background:' + C.bodyBg + ';';
            body.innerHTML = '<label style="display:block;font-size:12px;font-weight:700;color:' + C.dark + ';margin-bottom:6px;">🔗 Webhook do Slack (https://hooks.slack.com/...)</label>';
            const inp = document.createElement('input'); inp.type = 'text'; inp.value = gmGet(SLACK_KEY, ''); inp.placeholder = 'https://hooks.slack.com/services/...';
            inp.style.cssText = 'width:100%;padding:10px 12px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;box-sizing:border-box;';
            body.appendChild(inp);
            const hint = document.createElement('div'); hint.style.cssText = 'font-size:11px;color:' + C.grey + ';margin-top:8px;'; hint.textContent = 'O webhook fica salvo neste navegador para os próximos envios.';
            body.appendChild(hint); box.appendChild(body);
            const foot = document.createElement('div'); foot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:12px 18px;display:flex;justify-content:space-between;gap:8px;flex-shrink:0;';
            const okWh = wh => /^https:\/\/hooks\.slack\.com\//i.test(wh);
            const bSave = document.createElement('button'); bSave.innerHTML = '💾 Salvar webhook'; bSave.style.cssText = 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;';
            bSave.onclick = () => { const wh = (inp.value || '').trim(); if (!okWh(wh)) { alert('❌ Informe uma URL válida (https://hooks.slack.com/...).'); return; } gmSet(SLACK_KEY, wh); alert('✅ Webhook salvo.'); };
            const bSend = document.createElement('button'); bSend.innerHTML = '📤 Enviar'; bSend.style.cssText = 'background:linear-gradient(145deg,#4A154B,#611f69);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(74,21,75,0.35);';
            bSend.onclick = () => {
                const wh = (inp.value || '').trim();
                if (!okWh(wh)) { alert('❌ Informe uma URL válida (https://hooks.slack.com/...).'); return; }
                gmSet(SLACK_KEY, wh);
                bSend.disabled = true; bSend.innerHTML = '⏳ Enviando...';
                const reset = () => { bSend.disabled = false; bSend.innerHTML = '📤 Enviar'; };
                try {
                    GM_xmlhttpRequest({
                        method: 'POST', url: wh, data: JSON.stringify({ text: buildSlackText(r) }), headers: { 'Content-Type': 'application/json' },
                        onload: res => { if (res.status >= 200 && res.status < 300) { modal.remove(); alert('✅ Enviado para o Slack!'); } else { reset(); alert('❌ Erro ' + res.status + ' ao enviar. Verifique o webhook.'); } },
                        onerror: () => { reset(); alert('❌ Falha de conexão ao enviar para o Slack.'); },
                    });
                } catch (e) { reset(); alert('❌ Não foi possível enviar para o Slack.'); }
            };
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') bSend.click(); });
            foot.appendChild(bSave); foot.appendChild(bSend); box.appendChild(foot); document.body.appendChild(modal);
        }

        function makeModal(id, maxW) {
            document.getElementById(id) && document.getElementById(id).remove();
            const modal = document.createElement('div'); modal.id = id;
            modal.style.cssText = 'position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:\'Amazon Ember\',Arial,sans-serif;animation:onbFade .18s ease;';
            modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:16px;overflow:hidden;width:94%;max-width:' + maxW + ';max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:onbPop .24s cubic-bezier(.18,.9,.32,1.2);';
            modal.appendChild(box);
            return { modal, box };
        }
        function modalHeader(box, title, sub, accent) {
            const head = document.createElement('div');
            head.style.cssText = 'background:' + C.headerGrad + ';color:' + C.white + ';padding:16px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ' + (accent || C.accent) + ';flex-shrink:0;';
            head.innerHTML = '<div><div style="font-size:16px;font-weight:700;">' + title + '</div>' + (sub ? '<div style="font-size:11px;color:' + C.gold + ';margin-top:3px;">' + sub + '</div>' : '') + '</div>';
            const btnX = document.createElement('button'); btnX.textContent = '✖';
            btnX.style.cssText = 'background:' + C.red + ';color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;transition:all .15s ease;';
            btnX.onmouseenter = () => { btnX.style.background = C.red; btnX.style.transform = 'rotate(90deg)'; };
            btnX.onmouseleave = () => { btnX.style.background = 'rgba(255,255,255,0.08)'; btnX.style.transform = 'none'; };
            btnX.onclick = () => box.closest('[id]').remove();
            head.appendChild(btnX); box.appendChild(head); return head;
        }
        function showPeopleModal(training) {
            const lim = getLimit(training.title);
            const { modal, box } = makeModal('onb-people', '620px');
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
            fr.trainings.forEach((t, i) => { html += '<div class="onb-train-card" data-idx="' + i + '" style="background:#fff;border:1px solid ' + C.border + ';border-left:4px solid ' + C.accent + ';border-radius:10px;padding:14px 16px;cursor:pointer;box-shadow:0 2px 8px rgba(35,47,62,0.06);transition:all .15s ease;"><div style="font-size:15px;font-weight:700;color:' + C.dark + ';">' + esc(t.title) + '</div><div style="font-size:26px;font-weight:800;color:' + C.blue + ';margin-top:4px;">' + t.people.length + ' <span style="font-size:13px;color:' + C.grey + ';font-weight:600;">associado(s)</span></div></div>'; });
            html += '</div>';
            html += '<div style="background:rgba(204,0,0,0.06);border:1px solid ' + C.red + ';border-radius:12px;padding:14px 16px;margin-bottom:18px;"><div style="font-size:15px;font-weight:800;color:' + C.red + ';margin-bottom:8px;">' + (limitByHours ? '⏰' : '📋') + ' ' + esc(listTitle()) + ' (' + exceeding.length + ')' + (limitByHours ? ' <span style="font-weight:600;color:' + C.grey + ';font-size:12px;">— ' + esc(fr.trainings.map(t => t.title + ' > ' + getLimit(t) + 'h').join(' · ')) + '</span>' : '') + '</div>';
            if (exceeding.length) { const hClr = limitByHours ? C.red : C.blue; const by = groupByManager(exceeding, e => e.title || 'Sem função'); Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(fn => { html += '<div style="margin:10px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 12px;border-radius:6px;border-left:4px solid ' + C.accent + ';">🎓 ' + esc(fn) + '</div>'; by[fn].forEach(e => { html += '<div style="font-size:15px;color:' + C.dark + ';padding:3px 0 3px 10px;">' + nameLink(e.name, e.link) + ' — <span style="color:' + hClr + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span>' + (e.manager ? ' <span style="color:' + C.grey + ';font-size:13px;">(' + esc(e.manager) + ')</span>' : '') + badgeTag(e.total) + '</div>'; }); }); } else { html += '<div style="font-size:14px;color:' + C.grey + ';">' + (limitByHours ? 'Ninguém acima do limite ✅' : 'Nenhum associado nas funções que precisamos ✅') + '</div>'; }
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
        function buildLogadoErradoHTML(fr) {
            const list = logadoErrado(fr);
            let html = '<div style="margin-bottom:20px;"><div style="background:linear-gradient(135deg,#E74C3C,#991010);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">🚫 Logado errado (General FC Training)</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + list.length + '</div></div></div>';
            html += '<div style="background:rgba(204,0,0,0.06);border:1px solid ' + C.red + ';border-radius:12px;padding:14px 16px;">';
            html += '<div style="font-size:15px;font-weight:800;color:' + C.red + ';margin-bottom:8px;">🚫 Não deveriam estar logados em General FC Training nos Dias 2/3 (' + list.length + ')</div>';
            if (list.length) {
                const by = groupByManager(list, e => e.manager || 'Sem gestor');
                Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => {
                    html += '<div style="margin:10px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 12px;border-radius:6px;border-left:4px solid ' + C.accent + ';">👤 ' + esc(mgr) + '</div>';
                    by[mgr].forEach(e => { html += '<div style="font-size:15px;color:' + C.dark + ';padding:3px 0 3px 10px;">' + nameLink(e.name, e.link) + ' — <span style="color:' + C.red + ';font-weight:700;">' + (e.total || 0).toFixed(2) + 'h</span> <span style="color:' + C.grey + ';font-size:13px;">(' + esc(e.title) + ')</span></div>'; });
                });
            } else { html += '<div style="font-size:14px;color:' + C.grey + ';">Ninguém logado em General FC Training ✅ (só vale nos Dias 2 e 3)</div>'; }
            html += '</div>';
            return html;
        }
        function showDashboard(r) {
            r = buildReportFrom(scopedTrainings(r.trainings));   // Dia 1 = só On Boarding; Dia 2/3 = tudo
            const { modal, box } = makeModal('onb-dash', '1040px');
            modalHeader(box, '📊 Learning Hours — Associados por Função', r.allPeople.length + ' associado(s) · ' + r.trainings.length + ' função(ões)');
            let currentR = r;                        // relatório filtrado por gestor (base das abas)
            let currentProc = PROCESSES[0].key;      // aba de processo ativa
            let viewR = r;                           // visão exibida (gestor + processo)
            const btnFlt = document.createElement('button'); btnFlt.innerHTML = limitLabel(); btnFlt.title = 'Alterna entre limitar por horas (só quem passou do limite) e mostrar todos';
            btnFlt.style.cssText = 'background:' + (limitByHours ? C.green : C.grey) + ';color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;';
            btnFlt.onclick = () => { setLimitByHours(!limitByHours); btnFlt.innerHTML = limitLabel(); btnFlt.style.background = limitByHours ? C.green : C.grey; renderD(); };
            const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:22px;background:' + C.bodyBg + ';';
            const filterBar = document.createElement('div'); filterBar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;';
            const lbl = document.createElement('span'); lbl.textContent = '👤 Filtrar por gestor:'; lbl.style.cssText = 'font-size:12px;font-weight:700;color:' + C.dark + ';';
            const sel = document.createElement('select'); sel.style.cssText = 'padding:8px 12px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;color:' + C.dark + ';background:#fff;cursor:pointer;min-width:220px;';
            sel.innerHTML = '<option value="__all__">Todos os gestores</option>' + allManagers(r.trainings).map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
            filterBar.appendChild(lbl); filterBar.appendChild(sel); filterBar.appendChild(btnFlt);
            const procObj = k => PROCESSES.find(p => p.key === k) || PROCESSES[0];
            const procTabs = document.createElement('div'); procTabs.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;';
            const procBtns = PROCESSES.map(pr => { const b = document.createElement('button'); b.dataset.proc = pr.key; b.onclick = () => { currentProc = pr.key; renderD(); }; procTabs.appendChild(b); return b; });
            function procHasData(key) { return key === 'badge' ? badgeEntries(currentR).length > 0 : key === 'errado' ? logadoErrado(currentR).length > 0 : currentR.trainings.some(t => procOf(t).key === key && t.people.length > 0); }
            function styleProcBtns() { procBtns.forEach(b => { const pr = procObj(b.dataset.proc); const on = b.dataset.proc === currentProc; const hasData = procHasData(b.dataset.proc); b.innerHTML = esc(pr.name); b.style.cssText = 'border:none;border-radius:8px;padding:9px 16px;cursor:pointer;font-weight:700;font-size:13px;transition:all .15s ease;' + (on ? 'background:' + C.dark + ';color:#fff;box-shadow:0 3px 10px rgba(35,47,62,0.3);' : (hasData ? 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;' : 'background:#F2F4F6;color:#B5BDC5;border:1px solid #E6EAEE;opacity:.55;')); }); }
            const btnLimits = document.createElement('button'); btnLimits.innerHTML = '⏱️ Ver limites de horas';
            btnLimits.title = 'Apenas visualização dos limites de horas (não é possível alterar)';
            btnLimits.style.cssText = 'background:' + C.blue + ';color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:700;font-size:13px;';
            btnLimits.onclick = () => openLimitsPopup();
            // Somente leitura: mostra os limites de horas em uso, sem permitir edição.
            function openLimitsPopup() {
                const pr = procObj(currentProc);
                const { modal: lmodal, box: pbox } = makeModal('onb-limits', '460px');
                modalHeader(pbox, '⏱️ Limites — ' + esc(pr.name), 'somente leitura · acima disso o associado é sinalizado em "Acima em hora"');
                const pbody = document.createElement('div'); pbody.style.cssText = 'flex:1;overflow-y:auto;padding:16px 18px;background:' + C.bodyBg + ';';
                const row = (label, val) => '<div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ' + C.border + ';border-radius:8px;padding:9px 11px;"><span style="flex:1;font-size:13px;font-weight:700;color:' + C.dark + ';">' + label + '</span><span style="font-size:14px;font-weight:800;color:' + C.blue + ';">' + val + 'h</span></div>';
                let h = '<div style="display:flex;flex-direction:column;gap:10px;">';
                if (currentProc === 'badge') { h += row('🪪 Ajuste de Badge', badgeLimit()); }
                else { const list = TRAININGS.filter(c => c.proc === currentProc); h += list.length ? list.map(c => row('🎓 ' + esc(c.name), effectiveLimit(c))).join('') : '<div style="font-size:13px;color:' + C.grey + ';">Sem treinamentos neste processo.</div>'; }
                h += '</div>'; pbody.innerHTML = h; pbox.appendChild(pbody);
                document.body.appendChild(lmodal);
            }
            filterBar.appendChild(btnLimits);
            const content = document.createElement('div'); body.appendChild(filterBar); body.appendChild(procTabs); body.appendChild(content); box.appendChild(body);
            function renderD() {
                currentR = filterByManager(r, sel.value); styleProcBtns();
                if (currentProc === 'badge') { viewR = currentR; content.innerHTML = buildBadgeHTML(currentR); }
                else if (currentProc === 'errado') { viewR = currentR; content.innerHTML = buildLogadoErradoHTML(currentR); }
                else { viewR = filterByProcess(currentR, currentProc); content.innerHTML = buildDashHTML(viewR); }
            }
            renderD();
            sel.onchange = renderD;
            content.addEventListener('click', ev => { const card = ev.target.closest('.onb-train-card'); if (!card) return; showPeopleModal(viewR.trainings[+card.dataset.idx]); });
            content.addEventListener('mouseover', ev => { const card = ev.target.closest('.onb-train-card'); if (card) { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 6px 16px rgba(35,47,62,0.15)'; } });
            content.addEventListener('mouseout', ev => { const card = ev.target.closest('.onb-train-card'); if (card) { card.style.transform = 'none'; card.style.boxShadow = '0 2px 8px rgba(35,47,62,0.06)'; } });
            const foot = document.createElement('div'); foot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0;';
            const lblF = document.createElement('span'); lblF.textContent = 'Exporta a visão atual (respeita o filtro de gestor)'; lblF.style.cssText = 'font-size:12px;color:' + C.grey + ';';
            const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:8px;align-items:center;';
            const btnFclm = document.createElement('button'); btnFclm.innerHTML = '🔗 Abrir no FCLM'; btnFclm.style.cssText = 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;'; btnFclm.onclick = () => { try { window.open(REPORT_LINK, '_blank', 'noopener'); } catch (e) { location.href = REPORT_LINK; } };
            const btnCsv = document.createElement('button'); btnCsv.innerHTML = '📥 Extrair CSV'; btnCsv.style.cssText = 'background:linear-gradient(145deg,#1e8449,#14562f);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(30,132,73,0.35);'; btnCsv.onclick = () => exportCsv(viewR);
            right.appendChild(btnFclm);
            // Envio ao Slack só no overlay fixo do FCLM (página functionRollup).
            if (onFclmReport()) { const btnSlack = document.createElement('button'); btnSlack.innerHTML = '📤 Enviar para o Slack'; btnSlack.style.cssText = 'background:linear-gradient(145deg,#4A154B,#611f69);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(74,21,75,0.35);'; btnSlack.onclick = () => openSlackModal(currentR); right.appendChild(btnSlack); }
            right.appendChild(btnCsv);
            foot.appendChild(lblF); foot.appendChild(right); box.appendChild(foot); document.body.appendChild(modal);
        }
        function makeDraggable(el2, handle) {
            let dragging = false, moved = false, offX = 0, offY = 0;
            handle.addEventListener('mousedown', e => { dragging = true; moved = false; const r = el2.getBoundingClientRect(); offX = e.clientX - r.left; offY = e.clientY - r.top; el2.style.transition = 'none'; e.preventDefault(); });
            document.addEventListener('mousemove', e => { if (!dragging) return; moved = true; let l = Math.min(Math.max(0, e.clientX - offX), window.innerWidth - el2.offsetWidth); let t = Math.min(Math.max(0, e.clientY - offY), window.innerHeight - el2.offsetHeight); el2.style.left = l + 'px'; el2.style.top = t + 'px'; el2.style.right = 'auto'; el2.style.bottom = 'auto'; });
            document.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; const r = el2.getBoundingClientRect(); gmSet(POSKEY, JSON.stringify({ left: r.left, top: r.top })); });
            el2._movedRecently = () => moved;
        }
        function injectBar() {
            if (!enabled) return;
            if (document.getElementById('onb-bar')) return;
            const bar = document.createElement('button'); bar.id = 'onb-bar';
            bar._label = onFclmOnbReport() ? '📊 Learning Hours' : '📊 Onboarding Hours';
            bar.innerHTML = bar._label;
            bar.title = 'Clique para ver os alertas de onboarding';
            bar.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9998;background:' + C.btnGrad + ';color:' + C.white + ';border:none;border-top:3px solid ' + C.accent + ';border-right:3px solid ' + C.accent + ';border-top-right-radius:12px;padding:12px 26px;font-size:14px;font-weight:800;letter-spacing:.03em;cursor:pointer;font-family:\'Amazon Ember\',Arial,sans-serif;box-shadow:0 -3px 14px rgba(0,0,0,0.3);';
            bar.onmouseenter = () => { bar.style.background = C.btnGradH; };
            bar.onmouseleave = () => { bar.style.background = C.btnGrad; };
            bar.onclick = () => {
                bar.disabled = true; bar.innerHTML = '⏳ Buscando...';
                fetchReport((r, err) => {
                    bar.disabled = false; bar.innerHTML = bar._label;
                    if (err) { alert('❌ ' + err + '\nNão consegui buscar o relatório de onboarding.'); return; }
                    injectOverlay(r || buildReportFrom([]));   // abre mesmo vazio (mostra 0)
                });
            };
            document.body.appendChild(bar);
        }
        // Auto-atualização do painel base: enquanto o overlay estiver aberto, re-busca o
        // relatório do FCLM a cada REFRESH_MS e atualiza os números sozinho (preserva aba e scroll).
        const OVERLAY_REFRESH_MS = 120000;   // 2 min
        function injectOverlay(r) {
            document.getElementById('onb-overlay') && document.getElementById('onb-overlay').remove();
            let curR = r;
            let exceeding = [], faltantes = [], logErrado = [], lastSig = '', refreshing = false, activeTab = 'hora';
            function recompute() {
                exceeding = computeExceeding(exceedingSource(curR.trainings), true);   // overlay: sempre limitado por horas
                faltantes = computeFaltantes(curR);
                logErrado = logadoErrado(curR);
            }
            function sig() { return 'H|' + exceeding.map(e => (e.id || e.name) + ':' + e.total).join(',') + '||L|' + faltantes.map(x => (x.p.id || x.p.name) + ':' + x.falta.join('/')).join(',') + '||E|' + logErrado.map(e => (e.id || e.name) + ':' + e.total).join(','); }
            function fmtTime(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); }
            function fmtCountdown(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m > 0 ? (m + 'm' + String(s % 60).padStart(2, '0') + 's') : (s + 's'); }
            const REFRESH_LABEL = Math.round(OVERLAY_REFRESH_MS / 60000) + ' min';
            let nextAt = Date.now() + OVERLAY_REFRESH_MS;
            recompute();
            const ov = document.createElement('div'); ov.id = 'onb-overlay';
            ov.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483040;width:390px;max-width:calc(100vw - 32px);max-height:82vh;display:flex;flex-direction:column;background:#fff;border:2px solid ' + C.accent + ';border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,0.4);font-family:\'Amazon Ember\',Arial,sans-serif;overflow:hidden;transform-origin:bottom left;animation:onbRise .3s cubic-bezier(.18,.9,.32,1.2);';
            const head = document.createElement('div'); head.style.cssText = 'background:' + C.headerGrad + ';color:#fff;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
            const dia = (() => { const h = new Date().getHours(); return h >= 6 && h < 18; })();
            const headLeft = document.createElement('div');
            headLeft.innerHTML = '<div style="font-size:14px;font-weight:700;">' + (onFclmReport() ? (modeLabel(currentFilter.mode) + ' Learning Hours') : ((dia ? '☀️' : '🌙') + ' Alertas de Onboarding <span style="font-size:11px;font-weight:600;opacity:.85;">(' + (dia ? 'Dia' : 'Noite') + ')</span>')) + '</div>';
            const updatedEl = document.createElement('div'); updatedEl.style.cssText = 'font-size:10px;font-weight:600;color:' + C.gold + ';margin-top:2px;'; updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
            const nextEl = document.createElement('div'); nextEl.style.cssText = 'font-size:10px;font-weight:600;color:#9fb3c8;margin-top:1px;';
            headLeft.appendChild(updatedEl); headLeft.appendChild(nextEl); head.appendChild(headLeft);
            const headBtns = document.createElement('div'); headBtns.style.cssText = 'display:flex;gap:6px;align-items:center;';
            // Overlay simplificado é SEMPRE limitado por horas — sem botão "Mostrar todos"
            // (essa opção existe só no detalhe/dashboard).
            const btnRefresh = document.createElement('button'); btnRefresh.innerHTML = '🔄'; btnRefresh.title = 'Atualizar agora';
            btnRefresh.style.cssText = 'background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:13px;';
            btnRefresh.onclick = () => doRefresh(true);
            const btnDet = document.createElement('button'); btnDet.innerHTML = '🔎 Mais detalhes'; btnDet.style.cssText = 'background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:700;font-size:12px;'; btnDet.onclick = () => { ov.remove(); showDashboard(curR); };
            const x = document.createElement('button'); x.textContent = '✖'; x.style.cssText = 'background:' + C.red + ';color:#fff;border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;'; x.onclick = () => ov.remove();
            headBtns.appendChild(btnRefresh); headBtns.appendChild(btnDet); headBtns.appendChild(x); head.appendChild(headBtns);
            const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid ' + C.border + ';background:#fff;';
            const tabHora = document.createElement('button'); const tabLog = document.createElement('button'); const tabErrado = document.createElement('button');
            const tabBase = 'flex:1;border:none;padding:10px 8px;cursor:pointer;font-weight:700;font-size:13px;font-family:\'Amazon Ember\',Arial,sans-serif;background:#fff;';
            function updateTabLabels() { tabHora.innerHTML = '⏰ Acima em hora (' + exceeding.length + ')'; tabLog.innerHTML = '🔁 Precisa logar (' + faltantes.length + ')'; tabErrado.innerHTML = '🚫 Logado errado (' + logErrado.length + ')'; }
            updateTabLabels();
            const body = document.createElement('div'); body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:12px 14px;background:' + C.bodyBg + ';';
            const mgrHeader = (mgr) => '<div style="margin:12px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 10px;border-radius:6px;border-left:4px solid ' + C.accent + ';">👤 ' + esc(mgr) + '</div>';
            const fnHeader = (fn) => '<div style="margin:12px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 10px;border-radius:6px;border-left:4px solid ' + C.accent + ';">🎓 ' + esc(fn) + '</div>';
            // Agrupado pelo CALM CODE (função) logado — não mais por gestor.
            function renderHora() { if (!exceeding.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Ninguém acima do limite ✅</div>'; return; } const by = groupByManager(exceeding, e => e.title || 'Sem função'); let html = ''; Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(fn => { html += fnHeader(fn); by[fn].forEach(e => { const over = e.total > e.limit; html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(e.name, e.link) + ' — <span style="color:' + (over ? C.red : C.navy) + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span>' + (e.manager ? ' <span style="color:' + C.grey + ';font-size:12px;">(' + esc(e.manager) + ')</span>' : '') + '</div>'; }); }); body.innerHTML = html; }
            function renderLog() { if (!faltantes.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Todos presentes em todos ✅</div>'; return; } const by = groupByManager(faltantes, x => x.p.manager); let html = ''; Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { html += mgrHeader(mgr); by[mgr].forEach(({ p, falta }) => { html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(p.name, p.link) + ' — colocar em: <span style="color:' + C.red + ';">' + esc(falta.join(', ')) + '</span></div>'; }); }); body.innerHTML = html; }
            function renderErrado() { if (!logErrado.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Ninguém logado em General FC Training ✅</div>'; return; } const by = groupByManager(logErrado, e => e.manager); let html = '<div style="font-size:12px;color:' + C.grey + ';margin-bottom:6px;">Não deveriam estar logados em General FC Training nos Dias 2/3:</div>'; Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { html += mgrHeader(mgr); by[mgr].forEach(e => { html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(e.name, e.link) + ' — <span style="color:' + C.red + ';font-weight:700;">' + (e.total || 0).toFixed(2) + 'h</span> <span style="color:' + C.grey + ';font-size:12px;">(' + esc(e.title) + ')</span></div>'; }); }); body.innerHTML = html; }
            function renderTab() { if (activeTab === 'hora') renderHora(); else if (activeTab === 'errado') renderErrado(); else renderLog(); }
            function setActive(which) { activeTab = which; tabHora.style.cssText = tabBase + (which === 'hora' ? 'color:' + C.red + ';border-bottom:3px solid ' + C.red + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabLog.style.cssText = tabBase + (which === 'log' ? 'color:' + C.amber + ';border-bottom:3px solid ' + C.amber + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabErrado.style.cssText = tabBase + (which === 'errado' ? 'color:' + C.red + ';border-bottom:3px solid ' + C.red + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); renderTab(); }
            // Re-busca o relatório e atualiza os números sem fechar o painel.
            function doRefresh(manual) {
                if (refreshing || !document.body.contains(ov)) return;
                refreshing = true;
                nextAt = Date.now() + OVERLAY_REFRESH_MS;
                if (btnRefresh) { btnRefresh.disabled = true; btnRefresh.style.opacity = '.5'; }
                updatedEl.textContent = 'atualizando…';
                getReport(true, (r2, err) => {
                    refreshing = false;
                    if (btnRefresh) { btnRefresh.disabled = false; btnRefresh.style.opacity = '1'; }
                    if (!document.body.contains(ov)) return;
                    if (err || !r2) { updatedEl.textContent = '⚠️ falha ao atualizar ' + fmtTime(new Date()); return; }
                    curR = r2; recompute(); updateTabLabels();
                    const s = sig();
                    if (s !== lastSig) { lastSig = s; const st = body.scrollTop; renderTab(); body.scrollTop = st; }
                    updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
                    nextAt = Date.now() + OVERLAY_REFRESH_MS;
                });
            }
            tabHora.onclick = () => setActive('hora'); tabLog.onclick = () => setActive('log'); tabErrado.onclick = () => setActive('errado');
            // Durante o Onboarding (Dia 1/2/3) mostra as TRÊS abas: Acima em hora, Precisa logar e Logado errado.
            // (Os dados de cada uma seguem as regras por dia; fora do Onboarding fica só "Acima em hora".)
            tabs.appendChild(tabHora); if (isDay1() || isDay2or3()) { tabs.appendChild(tabLog); tabs.appendChild(tabErrado); }
            ov.appendChild(head);
            // Filtro de janela SELECIONÁVEL: só na página fixa do FCLM (functionRollup).
            // No fluxo Onboarding (fora do FCLM) a janela é automática pelo turno.
            if (onFclmReport()) {
                const fRow = document.createElement('div');
                fRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-shrink:0;padding:8px 14px;background:#fff;border-bottom:1px solid ' + C.border + ';';
                const selMode = document.createElement('select');
                selMode.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;cursor:pointer;';
                [['day', '☀️ Dia (05:30–18:00)'], ['night', '🌙 Noite (18:00–05:30)'], ['d6to5', '🕕 (D-1)06:00–05:00 '], ['full', '🗓️ Dia todo (00:00–00:00)']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (currentFilter.mode === v) o.selected = true; selMode.appendChild(o); });
                const inpDate = document.createElement('input'); inpDate.type = 'date'; inpDate.value = currentFilter.date; inpDate.style.cssText = 'padding:6px 8px;border:1px solid #CDD4DA;border-radius:6px;font-size:12px;';
                const previewEl = document.createElement('div'); previewEl.style.cssText = 'flex-shrink:0;padding:2px 14px 8px;background:#fff;border-bottom:1px solid ' + C.border + ';font-size:11px;font-weight:700;color:' + C.blue + ';';
                const syncPreview = () => { previewEl.textContent = '🗓️ ' + windowPreviewText({ mode: selMode.value, date: inpDate.value || ymdDash(new Date()) }); };
                const applyFilter = () => { currentFilter = { mode: selMode.value, date: inpDate.value || ymdDash(new Date()) }; saveFilter(currentFilter); syncPreview(); const t = headLeft.querySelector('div'); if (t) t.innerHTML = modeLabel(currentFilter.mode) + ' Learning Hours'; doRefresh(true); };
                selMode.onchange = applyFilter; inpDate.onchange = applyFilter;
                fRow.appendChild(selMode); fRow.appendChild(inpDate);
                syncPreview();
                ov.appendChild(fRow); ov.appendChild(previewEl);
            }
            ov.appendChild(tabs); ov.appendChild(body); document.body.appendChild(ov); setActive('hora');
            lastSig = sig();
            // Ticker de 1s: mostra "atualiza a cada X · próxima em ..." e dispara o refresh no tempo.
            // Para sozinho quando o painel é removido do DOM.
            function tick() {
                const left = (nextAt - Date.now()) / 1000;
                if (!refreshing) nextEl.textContent = '🔄 atualiza a cada ' + REFRESH_LABEL + ' · próxima em ' + fmtCountdown(left);
                if (left <= 0) doRefresh(false);
            }
            tick();
            const timer = setInterval(() => { if (!document.body.contains(ov)) { clearInterval(timer); return; } tick(); }, 1000);
        }
        function removeAll() { ['onb-bar', 'onb-overlay', 'onb-dash', 'onb-people', 'onb-webhook'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); }); }

        let enabled = false;
        // enable = só prepara (injeta CSS). A ENTRADA agora é o mini-menu radial do círculo
        // (não injeta mais a barra fixa 'onb-bar').
        function enable() { if (enabled) return; enabled = true; injectUICss(); }
        function disable() { if (!enabled) return; enabled = false; removeAll(); }
        // Abre o painel de Onboarding/Learning Hours sob demanda (igual ao antigo clique da barra).
        function openOverlay() {
            if (!enabled) { enabled = true; injectUICss(); }
            const ex = document.getElementById('onb-overlay'); if (ex) ex.remove();
            getReport(false, (r, err) => {   // usa cache recente (abre instantâneo); rebusca só se vazio/velho
                if (err && !r) { alert('❌ ' + err + '\nNão consegui buscar o relatório de onboarding.'); return; }
                injectOverlay(r || buildReportFrom([]));
            });
        }
        function isOpen() { return !!(document.getElementById('onb-overlay') || document.getElementById('onb-dash') || document.getElementById('onb-people')); }
        function closeAll() { removeAll(); }
        // Busca o relatório e devolve só as contagens de alerta (p/ o anel do círculo).
        function fetchCounts(cb) {
            getReport(true, (r, err) => {   // poll: busca fresco e alimenta o cache p/ a abertura ficar instantânea
                if (err || !r) { if (cb) cb(null, err || 'sem dados'); return; }
                let errado = 0;
                try { errado = logadoErrado(r).length; } catch (e) {}
                if (cb) cb({ errado: errado }, null);
            });
        }
        return { enable, disable, openOverlay, isOpen, closeAll, fetchCounts };
    }
    const onbModule = createOnbModule();

    // ── Início ───────────────────────────────────────────────────────────
    function init() {
        if (!document.body) { setTimeout(init, 300); return; }
        ensureCycle();
        buildUI();
        render();
        setInterval(render, 1000);
        // Poll dos "logados errados" p/ o anel vermelho. Compartilhado entre abas:
        // se outra aba já buscou nos últimos 3 min, reusa a contagem (sem refazer o fetch pesado).
        const ONB_SHARE_MS = 3 * 60 * 1000;
        function pollErrado() {
            const c = ensureCycle();
            const onbAvail = c.selection && (onFclmOnbReport() || /^onb/.test(c.selection || ''));
            if (!onbAvail || !onbModule) return;
            let shared = null; try { shared = JSON.parse(store.get('chkatv_onb_errado', 'null')); } catch (e) {}
            if (shared && (Date.now() - (shared.ts || 0) < ONB_SHARE_MS)) { erradoCount = shared.errado || 0; return; }
            // marca otimista (evita várias abas buscando ao mesmo tempo)
            store.set('chkatv_onb_errado', JSON.stringify({ ts: Date.now(), errado: (shared && shared.errado) || 0 }));
            onbModule.fetchCounts((cts) => {
                if (cts) { erradoCount = cts.errado || 0; store.set('chkatv_onb_errado', JSON.stringify({ ts: Date.now(), errado: erradoCount })); }
            });
        }
        setTimeout(pollErrado, 4000);
        setInterval(pollErrado, 60 * 1000);   // checa a cada 1 min (leve); só busca quando o compartilhado vence
        window.addEventListener('resize', () => { if (fab) applyPos(); });
        window.addEventListener('pointerdown', function unlock() {
            try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
        }, { once: true });
        // Esc fecha: ajuda e os overlays do Onboarding (não fecha setup nem takeover de propósito).
        window.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (helpEl) { toggleHelp(); return; }
            if (radialEl) { hideRadial(); return; }
            const ids = ['onb-people', 'onb-dash', 'onb-overlay'];
            for (let i = 0; i < ids.length; i++) { const n = document.getElementById(ids[i]); if (n) { n.remove(); render(); return; } }
            if (menuOpen) { menuOpen = false; render(); return; }
        });
    }
    init();
})();
