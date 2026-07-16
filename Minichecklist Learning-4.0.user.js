// ==UserScript==
// @name         Minichecklist Learning
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Mini-checklist flutuante do turno (Learning GRU5). Na 1ª abertura do dia pergunta o fluxo (Onboarding Dia 1/2/3, PA ou Support) e detecta o turno (day 05:30–18:00 / night 18:00–05:30), com override manual de turno. Alertas por horário do relógio (day/night); no modo Alerta trava a tela (com "Adiar 5 min") e toca bip 1 min antes. 3 formas: círculo dinâmico (%), menu de check e mensagem em tela cheia. Links viram botões ao lado de cada tarefa. Quando o fluxo for Onboarding (ou na página do functionRollup do FCLM), mostra o Onboarding Hours (barra + dashboard + CSV, janela 05:30). Estado no armazenamento do Tampermonkey (compartilhado entre sites e mantido ao fechar/abrir o Firefox). CSSOM para funcionar sob CSP restrito.
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
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
            { t: 'Envio de horas via Slack (1/3)', url: U.funcRollAll, day: '09:00', night: '21:00' },
            { t: 'Envio de horas via Slack (2/3)', url: U.funcRollAll, day: '13:00', night: '01:00' },
            { t: 'Envio de horas via Slack (3/3)', url: U.funcRollAll, day: '17:00', night: '04:00' },
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
    let menuOpen = false, menuVisible = false, warnedIds = {}, beepedIds = {};
    let audioCtx = null, centered = false, setupPostponed = false, lastListSig = '';
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
        const total = items.length, doneCount = items.filter(i => i.done).length;
        const pct = total ? Math.round((doneCount / total) * 100) : 0;
        const overdue = items.filter(i => i.overdue).sort((a, b) => a.ts - b.ts);
        const warning = items.filter(i => i.warning);
        return { needSetup: false, selection: c.selection, shift, items, total, doneCount, pct, overdue, warning };
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
    let fab, fabWater, fabPct, menu, listEl, hdPct, hdSub, hdSubTxt, take, modeBtn, setupEl, helpEl;

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

        menu = el('div', 'position:fixed;top:96px;left:16px;z-index:2147483000;width:340px;background:#1b2733;'
            + 'color:#e6edf3;border:2px solid #ff9900;border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.5);'
            + FF + 'overflow:hidden;display:none;');
        menu.id = 'chkatv-menu';

        const hd = el('div', 'background:linear-gradient(135deg,#2c3e50,#1b2733);padding:11px 12px;'
            + 'border-bottom:2px solid #ff9900;');
        const hdTop = el('div', 'display:flex;align-items:center;gap:8px;');
        hdTop.appendChild(el('span', 'font-size:16px;', '🗒️'));
        hdTop.appendChild(el('span', 'font-size:13px;font-weight:800;flex:1;', 'Mini checklist'));
        const help = el('button', 'width:22px;height:22px;border-radius:50%;border:1px solid #8aa1b6;background:transparent;'
            + 'color:#c2d2e0;font-weight:800;cursor:pointer;line-height:1;padding:0;flex:none;' + FF, '?');
        help.title = 'Sobre este checklist';
        help.setAttribute('aria-label', 'Sobre este checklist');
        help.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp(); });
        hdTop.appendChild(help);
        hdPct = el('span', 'font-size:12px;font-weight:800;color:#ffce7a;margin-left:6px;', '0%');
        hdTop.appendChild(hdPct);
        hd.appendChild(hdTop);
        hdSub = el('div', 'display:flex;align-items:center;gap:8px;font-size:10.5px;color:#9fb3c8;margin-top:4px;');
        hdSubTxt = el('span', 'flex:1;', '');
        const shiftBtn = el('button', 'flex:none;background:#12202e;border:1px solid #52708c;color:#c2d2e0;border-radius:7px;'
            + 'padding:3px 8px;cursor:pointer;font-size:10px;font-weight:700;' + FF, '⇄ Turno');
        shiftBtn.title = 'Alternar turno (Day/Night) manualmente';
        shiftBtn.setAttribute('aria-label', 'Alternar turno Day ou Night');
        shiftBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleShift(); render(); });
        hdSub.appendChild(hdSubTxt); hdSub.appendChild(shiftBtn);
        hd.appendChild(hdSub);
        menu.appendChild(hd);

        const modeBar = el('div', 'display:flex;align-items:center;gap:8px;padding:8px 12px;'
            + 'border-bottom:1px solid #2b3d4f;font-size:11px;color:#8aa1b6;');
        modeBar.appendChild(el('span', 'flex:none;', 'Modo:'));
        modeBtn = el('button', 'flex:1;background:#12202e;border:1px solid #52708c;color:#e6edf3;border-radius:8px;'
            + 'padding:6px 8px;cursor:pointer;font-size:11.5px;font-weight:800;' + FF, 'Alerta');
        modeBtn.title = 'Alternar entre Alerta (trava + som) e Silencioso (sem travar)';
        modeBtn.setAttribute('aria-label', 'Alternar modo Alerta ou Silencioso');
        modeBtn.addEventListener('click', () => { setMode(getMode() === 'alert' ? 'silent' : 'alert'); if (getMode() === 'silent') hideTakeover(); render(); });
        modeBar.appendChild(modeBtn);
        menu.appendChild(modeBar);

        listEl = el('div', 'max-height:52vh;overflow:auto;padding:6px;');
        menu.appendChild(listEl);

        const ft = el('div', 'padding:9px 12px;border-top:1px solid #2b3d4f;display:flex;justify-content:space-between;'
            + 'align-items:center;gap:8px;font-size:11px;color:#8aa1b6;');
        const chg = el('button', 'background:transparent;border:1px solid #52708c;color:#c2d2e0;border-radius:7px;'
            + 'padding:5px 9px;cursor:pointer;font-size:11px;font-weight:700;' + FF, '↺ Trocar fluxo');
        chg.title = 'Perguntar novamente (Onboarding / PA / Support)';
        chg.setAttribute('aria-label', 'Trocar fluxo (perguntar novamente)');
        chg.addEventListener('click', () => { reAsk(); render(); });
        ft.appendChild(el('span', 'flex:1;', 'Clique na tarefa para marcar/desmarcar'));
        ft.appendChild(chg);
        menu.appendChild(ft);
        document.body.appendChild(menu);

        applyPos();
    }

    // ── Posicionamento + arrastar ────────────────────────────────────────
    function positionMenu() {
        if (!fab || !menu) return;
        const r = fab.getBoundingClientRect();
        const mw = menu.offsetWidth || 340, mh = menu.offsetHeight || 320;
        let left = r.left, top = r.bottom + 8;
        if (top + mh > window.innerHeight) top = Math.max(8, r.top - 8 - mh);
        left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);
        menu.style.left = left + 'px'; menu.style.top = top + 'px';
    }
    function applyPos() {
        let left = 16, top = 16;
        const p = getPos();
        if (p && typeof p.left === 'number' && typeof p.top === 'number') { left = p.left; top = p.top; }
        left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - FAB_SIZE));
        top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - FAB_SIZE));
        fab.style.left = left + 'px'; fab.style.top = top + 'px';
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
                else { menuOpen = !menuOpen; }
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
            + 'display:flex;align-items:center;justify-content:center;' + FF);
        const box = el('div', 'width:min(460px,90vw);background:#12202e;border:2px solid #ff9900;border-radius:14px;'
            + 'padding:22px;color:#e6edf3;box-shadow:0 20px 60px rgba(0,0,0,.6);');
        box.appendChild(el('div', 'font-size:16px;font-weight:800;color:#ffce7a;margin-bottom:10px;', 'ℹ️ Sobre este checklist'));
        box.appendChild(el('p', 'font-size:13px;line-height:1.6;color:#c2d2e0;margin:0 0 10px;',
            'Este mini-checklist serve para NÃO esquecer as tarefas de maior impacto do turno. Marque cada item ao concluir (clique no texto ou na caixa). Itens com horário disparam alerta pela hora atual — no modo Alerta a tela é travada e toca um bip 1 minuto antes. Use os botões 🔗 para abrir cada atividade.'));
        box.appendChild(el('p', 'font-size:12.5px;line-height:1.6;color:#8aa1b6;margin:0 0 16px;',
            'Quem não tiver o verificador_treinamento.exe na pasta Documentos deve falar com os analistas na mesa de Learning.'));
        const close = el('button', 'background:#ff9900;color:#1b2733;border:none;border-radius:9px;padding:9px 18px;'
            + 'font-weight:800;cursor:pointer;' + FF, 'Entendi');
        close.addEventListener('click', () => toggleHelp());
        box.appendChild(close);
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

    // ── Linha da tarefa ──────────────────────────────────────────────────
    function buildRow(i) {
        const row = el('div', 'display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;'
            + 'cursor:pointer;transition:background .12s;');
        row.addEventListener('mouseenter', () => row.style.background = '#243444');
        row.addEventListener('mouseleave', () => row.style.background = 'transparent');
        row.addEventListener('click', () => { toggleDone(i.id); render(); });

        const bColor = i.done ? '#27ae60' : (i.overdue ? '#cc0000' : '#52708c');
        const box = el('span', 'width:20px;height:20px;border-radius:6px;border:2px solid ' + bColor + ';'
            + 'background:' + (i.done ? '#27ae60' : 'transparent') + ';flex:none;display:flex;align-items:center;'
            + 'justify-content:center;font-size:13px;color:#0d1b2a;', i.done ? '✔' : '');
        row.appendChild(box);

        const mid = el('div', 'flex:1;min-width:0;');
        mid.appendChild(el('div', 'font-size:12.5px;line-height:1.35;'
            + (i.done ? 'text-decoration:line-through;color:#8aa1b6;' : 'color:#e6edf3;'), i.label));
        let stTxt, stColor;
        if (i.done) { stTxt = '✔ Concluído'; stColor = '#46e08a'; }
        else if (i.snoozed) { stTxt = '😴 Adiado (' + fmtLeft(i.snoozeLeft) + ')'; stColor = '#9fb3c8'; }
        else if (i.overdue) { stTxt = '⛔ Atrasado (alerta ' + i.alert + ')'; stColor = '#ff6b6b'; }
        else if (i.warning) { stTxt = '⏰ Faça agora — alerta ' + i.alert + ' (faltam ' + fmtLeft(i.secsLeft) + ')'; stColor = '#ffce7a'; }
        else if (i.alert) { stTxt = '⏰ Alerta ' + i.alert + (i.secsLeft > 0 ? ' (em ' + fmtLeft(i.secsLeft) + ')' : ''); stColor = '#9fb3c8'; }
        else { stTxt = '— sem alerta'; stColor = '#6b8199'; }
        mid.appendChild(el('div', 'font-size:10px;font-weight:700;margin-top:2px;color:' + stColor + ';', stTxt));
        row.appendChild(mid);

        if (i.url) {
            const lb = el('button', 'flex:none;background:#12202e;border:1px solid #52708c;color:#ffce7a;border-radius:8px;'
                + 'padding:7px 9px;cursor:pointer;font-size:13px;' + FF, '🔗');
            lb.title = 'Abrir atividade';
            lb.addEventListener('click', (e) => { e.stopPropagation(); openUrl(i.url); });
            row.appendChild(lb);
        } else if (i.note) {
            const nb = el('button', 'flex:none;background:#12202e;border:1px solid #52708c;color:#c2d2e0;border-radius:8px;'
                + 'padding:7px 9px;cursor:pointer;font-size:13px;' + FF, '📄');
            nb.title = 'Abrir verificador_treinamento.exe';
            nb.addEventListener('click', (e) => { e.stopPropagation(); tryLaunchExe(); });
            row.appendChild(nb);
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
        if (v) { menu.style.display = 'block'; positionMenu(); fadeIn(menu, 170, -8); }
        else { fadeOut(menu, 140, () => { if (!menuVisible) menu.style.display = 'none'; }); }
    }

    // Está na página do relatório functionRollup do FCLM (processId 1002986)?
    // Nessa página o Onboarding Hours fica SEMPRE ativo (independe do fluxo escolhido).
    function onFclmOnbReport() {
        const u = location.href;
        return /^https?:\/\/fclm-portal\.amazon\.com\/reports\/functionRollup/i.test(u) && /processId=(1002986|1002960)/.test(u);
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
        const s = computeState();
        const mode = getMode();

        const ringColor = s.needSetup ? '#52708c' : (s.overdue.length ? '#cc0000' : (s.pct === 100 ? '#27ae60' : '#ff9900'));
        fabWater.style.height = s.pct + '%';         // nível da água = % (transição fluida)
        fabWater.style.background = ringColor;
        fabPct.textContent = s.pct + '%';
        if (s.overdue.length && mode === 'alert') startPulse(fab); else stopPulse(fab);

        // Onboarding Hours (barra + dashboard): ativo quando o fluxo é Onboarding OU
        // sempre que estiver na página do relatório functionRollup do FCLM (processId 1002986).
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
            // Só reconstrói a lista quando o estado visível muda (evita churn de DOM a cada tick).
            const sig = s.items.map(i => i.id + (i.done ? 'D' : '') + (i.snoozed ? 'z' + i.snoozeLeft : '')
                + (i.overdue ? 'o' : i.warning ? 'w' : i.alert ? 'a' + i.secsLeft : '')).join('|');
            if (sig !== lastListSig || listEl.childElementCount === 0) {
                lastListSig = sig;
                listEl.textContent = '';
                s.items.forEach(i => listEl.appendChild(buildRow(i)));
            }
        } else { lastListSig = ''; }
        setMenuVisible(menuOpen);
        if (menuOpen) positionMenu();

        if (mode === 'alert') {
            s.items.forEach(i => { if (!i.done && i.ts && i.secsLeft > 0 && i.secsLeft <= SOUND_LEAD_SEC && !beepedIds[i.id]) { beepedIds[i.id] = true; beep(); } });
        }
        if (mode === 'alert' && s.overdue.length) showTakeover(s.overdue[0]); else hideTakeover();
    }

    // ═════════════════════════════════════════════════════════════════════
    // MÓDULO ONBOARDING POR TREINAMENTO (FCLM → Slack) — assimilado.
    // Escopo isolado (nomes próprios, sem colisão). Só é ativado quando o
    // fluxo escolhido é Onboarding (enable/disable a partir do render).
    // ═════════════════════════════════════════════════════════════════════
    function createOnbModule() {
        const C = {
            dark: '#232F3E', darker: '#131921', hover: '#37475A', accent: '#FF9900',
            gold: '#FEBD69', blue: '#4A86C8', grey: '#607D8B', red: '#CC0000',
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
        const ALLOWED_FN = [
            { id: '4300018945', re: /fc safety tour/i },
            { id: '4300006671', re: /general fc training/i },
            { id: '4300018942', re: /safety school/i },
            { id: LEARN_FN, re: null },   // Learning: só pelo fnId exato (não pega LN_LEARNING_STAFF)
        ];
        function isAllowedTraining(t) { return ALLOWED_FN.some(a => t.fnId === a.id || (a.re && a.re.test(t.title))); }
        function isLearning(t) { return t.fnId === LEARN_FN; }
        // Filtro de funções: SEMPRE só as funções que precisamos (Learning só pelo fnId 4300006689
        // + treinamentos permitidos). Não existe mais opção de "mostrar tudo".
        function passFilter(t) { return isAllowedTraining(t); }
        // Único filtro alternável: limitar por horas (só quem passou do limite) OU
        // mostrar todos os associados das funções que precisamos.
        const LIMIT_KEY = 'fclm_onb_limit_by_hours';
        let limitByHours = gmGet(LIMIT_KEY, '1') !== '0';
        function setLimitByHours(on) { limitByHours = !!on; gmSet(LIMIT_KEY, limitByHours ? '1' : '0'); }
        function limitLabel() { return limitByHours ? '⏱️ Limitar por horas' : '� Mostrar todos'; }
        function listTitle() { return limitByHours ? 'Acima em hora' : 'Todos (horas logadas)'; }
        // Learning aparece SEMPRE na página do functionRollup; no onboarding só no Dia 3.
        function showLearning() {
            if (onFclmOnbReport()) return true;
            const c = getCycle(); return !!(c && c.selection === 'onb3');
        }

        function reportUrl(processId) {
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
            // maxIntradayDays cobre quantas DATAS de calendário a janela abrange:
            // DIA = 1 (mesma data); NOITE/MADRUGADA = 2 (cruza a meia-noite).
            const dayDiff = Math.round((endD - startD) / 86400000);
            const p = new URLSearchParams();
            p.set('reportFormat', 'HTML'); p.set('warehouseId', WAREHOUSE); p.set('processId', processId || ONB_PROCESS);
            p.set('maxIntradayDays', String(dayDiff + 1)); p.set('spanType', 'Intraday');
            p.set('startDateIntraday', fmt(startD)); p.set('startHourIntraday', String(sH)); p.set('startMinuteIntraday', String(sM));
            p.set('endDateIntraday', fmt(endD)); p.set('endHourIntraday', String(eH)); p.set('endMinuteIntraday', String(eM));
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
            const targets = [ONB_PROCESS];
            if (showLearning()) targets.push(LEARN_PROCESS);
            let done = 0, errs = 0, trainings = [];
            const finish = () => {
                if (done < targets.length) return;
                // Na própria página do relatório, também lê as tabelas que estão na tela
                // (garante capturar o Learning [4300006689] mesmo que esteja sob outro processId).
                if (onFclmOnbReport()) { try { trainings = trainings.concat(parseFunctionTables(document).filter(passFilter)); } catch (e) {} }
                trainings = mergeTrainings(trainings);
                if (!trainings.length) { cb(null, errs === targets.length ? 'Falha de conexão' : null); return; }
                cb(buildReportFrom(trainings), null);
            };
            targets.forEach(pid => fetchOne(pid, doc => {
                if (doc) { try { trainings = trainings.concat(parseFunctionTables(doc).filter(passFilter)); } catch (e) {} }
                else errs++;
                done++; finish();
            }));
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
            onb2: [{ re: /fc training/i, name: 'FC Training', limit: 3 }, { re: /safety tour/i, name: 'Safety Tour', limit: 1 }, { re: /safety school/i, name: 'Safety School', limit: 1 }],
            onb3: [{ re: /fc training/i, name: 'FC Training', limit: 1 }, { re: /safety tour/i, name: 'Safety Tour', limit: 1 }, { re: /safety school/i, name: 'Safety School', limit: 1 }, { re: /learning/i, name: 'Learning', limit: 1 }],
        };
        // Padrão (acesso direto ao FCLM ou fluxo não-Onboarding): mantém o filtro atual + Learning > 1h.
        const DEFAULT_SET = [{ re: /fc training/i, name: 'FC Training', limit: 9 }, { re: /safety school/i, name: 'Safety School', limit: 2 }, { re: /learning/i, name: 'Learning', limit: 1 }];
        // Conjunto de limites ativo: usa o dia do Onboarding escolhido no checklist; senão o padrão.
        function activeLimitSet() {
            try { const c = getCycle(); const sel = c && c.selection; if (DAY_LIMITS[sel]) return DAY_LIMITS[sel]; } catch (e) {}
            return DEFAULT_SET;
        }
        function getLimit(title) { const set = activeLimitSet(); for (const r of set) if (r.re.test(title)) return r.limit; return DEFAULT_LIMIT; }
        function limitsDesc() { const parts = activeLimitSet().map(r => r.name + ' > ' + r.limit + 'h'); parts.push('demais > ' + DEFAULT_LIMIT + 'h'); return parts.join(' · '); }
        function computeExceeding(trainings) {
            const list = [];
            // limitByHours ON  → só quem passou do limite.
            // limitByHours OFF → todos os associados das funções que precisamos (com horas logadas).
            trainings.forEach(t => { const lim = getLimit(t.title); t.people.forEach(p => { if (p.total != null && (!limitByHours || p.total > lim)) list.push({ name: p.name, id: p.id, manager: p.manager, link: p.link, title: t.title, total: p.total, limit: lim }); }); });
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
        // Títulos usados na comparação "Precisa logar em outro" — exclui Learning
        // (Learning é opcional no Dia 3; só entra na checagem "Acima em hora" > limite).
        function compareTitles(r) {
            const learn = new Set(r.trainings.filter(t => t.fnId === LEARN_FN || isLearning(t)).map(t => t.title));
            return r.titles.filter(tt => !learn.has(tt));
        }

        // ── Exportação CSV (formato largo: 1 linha por associado) ────────
        function personKey(p) { return p.id || p.name.toLowerCase(); }
        function buildCsv(r) {
            const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
            const titles = r.titles;
            const cmpTitles = compareTitles(r);
            const header = ['Nome', 'ID', 'Manager'].concat(titles).concat(['Faltando em', 'Acima do limite']);
            const lines = [header.map(q).join(',')];
            r.allPeople.forEach(p => {
                const key = personKey(p);
                const hoursByTitle = {}; const acima = [];
                r.trainings.forEach(t => {
                    const pp = t.people.find(x => personKey(x) === key);
                    if (pp) { hoursByTitle[t.title] = pp.total; if (pp.total != null && pp.total > getLimit(t.title)) acima.push(t.title + ' (' + pp.total.toFixed(2) + 'h)'); }
                });
                const falta = cmpTitles.filter(tt => !p.inset.has(tt));
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

        // ── Envio para o Slack (só no overlay fixo do FCLM/function) ─────
        const SLACK_KEY = 'fclm_onb_slack_webhook';
        function slackName(name, link) { return link ? '<' + link + '|' + name + '>' : '*' + name + '*'; }
        function buildSlackText(r) {
            const exceeding = computeExceeding(r.trainings);
            const cmpTitles = compareTitles(r);
            const faltantes = r.allPeople.map(p => ({ p, falta: cmpTitles.filter(tt => !p.inset.has(tt)) })).filter(x => x.falta.length > 0);
            const now = new Date();
            const dLbl = String(now.getDate()).padStart(2, '0') + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + now.getFullYear();
            const title = onFclmOnbReport() ? 'Learning Hours' : 'Onboarding — Horas';
            let msg = ':bar_chart: *' + title + '* — ' + dLbl + '\n_' + limitsDesc() + '_\n\n';
            msg += (limitByHours ? ':alarm_clock:' : ':clipboard:') + ' *' + listTitle() + ' (' + exceeding.length + ')*\n';
            if (exceeding.length) {
                const by = groupByManager(exceeding, e => e.manager);
                Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => {
                    msg += '> *' + mgr + '*\n';
                    by[mgr].forEach(e => { msg += '>  • ' + slackName(e.name, e.link) + ' — ' + e.title + ': *' + e.total.toFixed(2) + 'h*\n'; });
                });
            } else { msg += '> ' + (limitByHours ? 'Ninguém acima do limite' : 'Nenhum associado nas funções que precisamos') + ' :white_check_mark:\n'; }
            msg += '\n:repeat: *Precisa logar em outro (' + faltantes.length + ')*\n';
            if (faltantes.length) {
                const by = groupByManager(faltantes, x => x.p.manager);
                Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => {
                    msg += '> *' + mgr + '*\n';
                    by[mgr].forEach(({ p, falta }) => { msg += '>  • ' + slackName(p.name, p.link) + ' — colocar em: ' + falta.join(', ') + '\n'; });
                });
            } else { msg += '> Todos presentes em todos :white_check_mark:\n'; }
            return msg;
        }
        function sendSlack(r, btn) {
            let wh = gmGet(SLACK_KEY, '');
            if (!wh) {
                wh = prompt('🔗 Integração Slack:\nCole a URL do Incoming Webhook do seu canal:');
                if (!wh) return;
                gmSet(SLACK_KEY, wh);
            }
            const orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Enviando...'; }
            const restore = () => { if (btn) { btn.disabled = false; btn.innerHTML = orig; } };
            try {
                GM_xmlhttpRequest({
                    method: 'POST', url: wh,
                    data: JSON.stringify({ text: buildSlackText(r) }),
                    headers: { 'Content-Type': 'application/json' },
                    onload: res => {
                        restore();
                        if (res.status >= 200 && res.status < 300) { alert('✅ Enviado para o Slack!'); }
                        else if (confirm('❌ Erro ' + res.status + '. Deseja resetar o webhook?')) { gmSet(SLACK_KEY, ''); }
                    },
                    onerror: () => { restore(); alert('❌ Falha de conexão ao enviar para o Slack.'); },
                });
            } catch (e) { restore(); alert('❌ Não foi possível enviar para o Slack.'); }
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
            btnX.style.cssText = 'background:rgba(255,255,255,0.08);color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;transition:all .15s ease;';
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
            const cmpTitles = compareTitles(fr);
            const faltantes = fr.allPeople.map(p => ({ p, falta: cmpTitles.filter(tt => !p.inset.has(tt)) })).filter(x => x.falta.length > 0);
            let html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px;"><div style="background:linear-gradient(135deg,#37475A,#1a2530);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">Associados</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + fr.allPeople.length + '</div></div><div style="background:linear-gradient(135deg,#E74C3C,#991010);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">' + esc(listTitle()) + '</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + exceeding.length + '</div></div><div style="background:linear-gradient(135deg,#E88B00,#a35f00);color:#fff;padding:18px 22px;border-radius:12px;text-align:center;"><div style="font-size:12px;text-transform:uppercase;opacity:.85;letter-spacing:.08em;">Precisa logar</div><div style="font-size:40px;font-weight:800;margin-top:4px;">' + faltantes.length + '</div></div></div>';
            html += '<div style="font-size:13px;font-weight:700;color:' + C.grey + ';text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">🎓 Treinamentos (clique para ver quem está)</div>';
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:22px;">';
            fr.trainings.forEach((t, i) => { html += '<div class="onb-train-card" data-idx="' + i + '" style="background:#fff;border:1px solid ' + C.border + ';border-left:4px solid ' + C.accent + ';border-radius:10px;padding:14px 16px;cursor:pointer;box-shadow:0 2px 8px rgba(35,47,62,0.06);transition:all .15s ease;"><div style="font-size:15px;font-weight:700;color:' + C.dark + ';">' + esc(t.title) + '</div><div style="font-size:26px;font-weight:800;color:' + C.blue + ';margin-top:4px;">' + t.people.length + ' <span style="font-size:13px;color:' + C.grey + ';font-weight:600;">associado(s)</span></div></div>'; });
            html += '</div>';
            html += '<div style="background:rgba(204,0,0,0.06);border:1px solid ' + C.red + ';border-radius:12px;padding:14px 16px;margin-bottom:18px;"><div style="font-size:15px;font-weight:800;color:' + C.red + ';margin-bottom:8px;">' + (limitByHours ? '⏰' : '📋') + ' ' + esc(listTitle()) + ' (' + exceeding.length + ')' + (limitByHours ? ' <span style="font-weight:600;color:' + C.grey + ';font-size:12px;">— ' + esc(limitsDesc()) + '</span>' : '') + '</div>';
            if (exceeding.length) { const by = groupByManager(exceeding, e => e.manager); Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { html += '<div style="margin:10px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 12px;border-radius:6px;border-left:4px solid ' + C.accent + ';">👤 ' + esc(mgr) + '</div>'; by[mgr].forEach(e => { html += '<div style="font-size:15px;color:' + C.dark + ';padding:3px 0 3px 10px;">' + nameLink(e.name, e.link) + ' — ' + esc(e.title) + ': <span style="color:' + C.red + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span></div>'; }); }); } else { html += '<div style="font-size:14px;color:' + C.grey + ';">' + (limitByHours ? 'Ninguém acima do limite ✅' : 'Nenhum associado nas funções que precisamos ✅') + '</div>'; }
            html += '</div>';
            html += '<div style="background:rgba(232,139,0,0.08);border:1px solid ' + C.amber + ';border-radius:12px;padding:14px 16px;"><div style="font-size:15px;font-weight:800;color:' + C.amber + ';margin-bottom:8px;">🔁 Precisa logar em outro (' + faltantes.length + ')</div>';
            if (faltantes.length) { const byF = groupByManager(faltantes, x => x.p.manager); Object.keys(byF).sort((a, b) => a.localeCompare(b)).forEach(mgr => { html += '<div style="margin:10px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 12px;border-radius:6px;border-left:4px solid ' + C.amber + ';">👤 ' + esc(mgr) + '</div>'; byF[mgr].forEach(({ p, falta }) => { html += '<div style="font-size:15px;color:' + C.dark + ';padding:3px 0 3px 10px;">' + nameLink(p.name, p.link) + ' — colocar em: <span style="color:' + C.red + ';font-weight:600;">' + esc(falta.join(', ')) + '</span></div>'; }); }); } else { html += '<div style="font-size:14px;color:' + C.grey + ';">Todos presentes em todos os treinamentos ✅</div>'; }
            html += '</div>';
            return html;
        }
        function showDashboard(r) {
            const { modal, box } = makeModal('onb-dash', '1040px');
            const head = modalHeader(box, '📊 Onboarding — Associados por Treinamento', r.allPeople.length + ' associado(s) · ' + r.trainings.length + ' treinamento(s)');
            let currentR = r;
            // Filtro de horas no header (à esquerda do ✖).
            const btnFlt = document.createElement('button'); btnFlt.innerHTML = limitLabel(); btnFlt.title = 'Alterna entre limitar por horas (só quem passou do limite) e mostrar todos os associados das funções que precisamos';
            btnFlt.style.cssText = 'background:' + (limitByHours ? C.green : C.grey) + ';color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;margin-right:8px;';
            btnFlt.onclick = () => { setLimitByHours(!limitByHours); btnFlt.innerHTML = limitLabel(); btnFlt.style.background = limitByHours ? C.green : C.grey; renderD(); };
            head.insertBefore(btnFlt, head.lastElementChild);
            const body = document.createElement('div'); body.style.cssText = 'flex:1;overflow-y:auto;padding:22px;background:' + C.bodyBg + ';';
            const filterBar = document.createElement('div'); filterBar.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;';
            const lbl = document.createElement('span'); lbl.textContent = '👤 Filtrar por gestor:'; lbl.style.cssText = 'font-size:12px;font-weight:700;color:' + C.dark + ';';
            const sel = document.createElement('select'); sel.style.cssText = 'padding:8px 12px;border:1px solid #CDD4DA;border-radius:8px;font-size:13px;color:' + C.dark + ';background:#fff;cursor:pointer;min-width:220px;';
            sel.innerHTML = '<option value="__all__">Todos os gestores</option>' + allManagers(r.trainings).map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
            filterBar.appendChild(lbl); filterBar.appendChild(sel);
            const content = document.createElement('div'); body.appendChild(filterBar); body.appendChild(content); box.appendChild(body);
            function renderD() { content.innerHTML = buildDashHTML(currentR); }
            renderD();
            sel.onchange = () => { currentR = filterByManager(r, sel.value); renderD(); };
            content.addEventListener('click', ev => { const card = ev.target.closest('.onb-train-card'); if (!card) return; showPeopleModal(currentR.trainings[+card.dataset.idx]); });
            content.addEventListener('mouseover', ev => { const card = ev.target.closest('.onb-train-card'); if (card) { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 6px 16px rgba(35,47,62,0.15)'; } });
            content.addEventListener('mouseout', ev => { const card = ev.target.closest('.onb-train-card'); if (card) { card.style.transform = 'none'; card.style.boxShadow = '0 2px 8px rgba(35,47,62,0.06)'; } });
            const foot = document.createElement('div'); foot.style.cssText = 'background:#fff;border-top:1px solid ' + C.border + ';padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0;';
            const lblF = document.createElement('span'); lblF.textContent = 'Exporta a visão atual (respeita o filtro de gestor)'; lblF.style.cssText = 'font-size:12px;color:' + C.grey + ';';
            const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:8px;align-items:center;';
            const btnFclm = document.createElement('button'); btnFclm.innerHTML = '🔗 Abrir no FCLM'; btnFclm.style.cssText = 'background:#fff;color:' + C.dark + ';border:1px solid #CDD4DA;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;'; btnFclm.onclick = () => { try { window.open(REPORT_LINK, '_blank', 'noopener'); } catch (e) { location.href = REPORT_LINK; } };
            const btnCsv = document.createElement('button'); btnCsv.innerHTML = '📥 Extrair CSV'; btnCsv.style.cssText = 'background:linear-gradient(145deg,#1e8449,#14562f);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(30,132,73,0.35);'; btnCsv.onclick = () => exportCsv(currentR);
            right.appendChild(btnFclm);
            if (onFclmOnbReport()) {
                const btnSlack = document.createElement('button'); btnSlack.innerHTML = '📤 Enviar para o Slack'; btnSlack.style.cssText = 'background:linear-gradient(145deg,#4A154B,#611f69);color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;box-shadow:0 3px 10px rgba(74,21,75,0.35);'; btnSlack.onclick = () => sendSlack(currentR, btnSlack);
                right.appendChild(btnSlack);
            }
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
                    if (!r || !r.trainings.length) { alert('❌ Nenhuma tabela de treinamento encontrada no relatório.'); return; }
                    injectOverlay(r);
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
            const ov = document.createElement('div'); ov.id = 'onb-overlay';
            ov.style.cssText = 'position:fixed;left:16px;bottom:56px;z-index:9997;width:390px;max-width:calc(100vw - 32px);max-height:64vh;display:flex;flex-direction:column;background:#fff;border:2px solid ' + C.accent + ';border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,0.4);font-family:\'Amazon Ember\',Arial,sans-serif;overflow:hidden;transform-origin:bottom left;animation:onbRise .3s cubic-bezier(.18,.9,.32,1.2);';
            const head = document.createElement('div'); head.style.cssText = 'background:' + C.headerGrad + ';color:#fff;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
            const dia = (() => { const h = new Date().getHours(); return h >= 6 && h < 18; })();
            const headLeft = document.createElement('div');
            headLeft.innerHTML = '<div style="font-size:14px;font-weight:700;">' + (dia ? '☀️' : '🌙') + ' Alertas de Onboarding <span style="font-size:11px;font-weight:600;opacity:.85;">(' + (dia ? 'Dia' : 'Noite') + ')</span></div>';
            const updatedEl = document.createElement('div'); updatedEl.style.cssText = 'font-size:10px;font-weight:600;color:' + C.gold + ';margin-top:2px;'; updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
            const nextEl = document.createElement('div'); nextEl.style.cssText = 'font-size:10px;font-weight:600;color:#9fb3c8;margin-top:1px;';
            headLeft.appendChild(updatedEl); headLeft.appendChild(nextEl); head.appendChild(headLeft);
            const headBtns = document.createElement('div'); headBtns.style.cssText = 'display:flex;gap:6px;align-items:center;';
            const btnFlt = document.createElement('button'); btnFlt.innerHTML = limitLabel(); btnFlt.title = 'Alterna entre limitar por horas (só quem passou do limite) e mostrar todos os associados das funções que precisamos';
            btnFlt.style.cssText = 'background:' + (limitByHours ? C.green : C.grey) + ';color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:700;font-size:12px;';
            btnFlt.onclick = () => { setLimitByHours(!limitByHours); ov.remove(); injectOverlay(curR); };
            const btnRefresh = document.createElement('button'); btnRefresh.innerHTML = '🔄'; btnRefresh.title = 'Atualizar agora';
            btnRefresh.style.cssText = 'background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:13px;';
            btnRefresh.onclick = () => doRefresh(true);
            const btnDet = document.createElement('button'); btnDet.innerHTML = '🔎 Mais detalhes'; btnDet.style.cssText = 'background:' + C.accent + ';color:#232F3E;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:700;font-size:12px;'; btnDet.onclick = () => { ov.remove(); showDashboard(curR); };
            const x = document.createElement('button'); x.textContent = '✖'; x.style.cssText = 'background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:6px;width:26px;height:26px;cursor:pointer;'; x.onclick = () => ov.remove();
            headBtns.appendChild(btnFlt); headBtns.appendChild(btnRefresh); headBtns.appendChild(btnDet); headBtns.appendChild(x); head.appendChild(headBtns);
            const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid ' + C.border + ';background:#fff;';
            const tabHora = document.createElement('button'); const tabLog = document.createElement('button');
            const tabBase = 'flex:1;border:none;padding:10px 8px;cursor:pointer;font-weight:700;font-size:13px;font-family:\'Amazon Ember\',Arial,sans-serif;background:#fff;';
            function updateTabLabels() { tabHora.innerHTML = (limitByHours ? '⏰ ' : '📋 ') + listTitle() + ' (' + exceeding.length + ')'; tabLog.innerHTML = '🔁 Precisa logar (' + faltantes.length + ')'; }
            updateTabLabels();
            const body = document.createElement('div'); body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:12px 14px;background:' + C.bodyBg + ';';
            const mgrHeader = (mgr) => '<div style="margin:12px 0 4px;font-size:13px;font-weight:800;color:#fff;background:' + C.dark + ';padding:6px 10px;border-radius:6px;border-left:4px solid ' + C.accent + ';">👤 ' + esc(mgr) + '</div>';
            function renderHora() { if (!exceeding.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">' + (limitByHours ? 'Ninguém acima do limite ✅' : 'Nenhum associado nas funções que precisamos ✅') + '</div>'; return; } const by = groupByManager(exceeding, e => e.manager); let html = ''; Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { html += mgrHeader(mgr); by[mgr].forEach(e => { html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(e.name, e.link) + ' — <span style="color:' + C.red + ';font-weight:700;">' + e.total.toFixed(2) + 'h</span> <span style="color:' + C.grey + ';font-size:12px;">(' + esc(e.title) + ')</span></div>'; }); }); body.innerHTML = html; }
            function renderLog() { if (!faltantes.length) { body.innerHTML = '<div style="font-size:13px;color:' + C.grey + ';">Todos presentes em todos ✅</div>'; return; } const by = groupByManager(faltantes, x => x.p.manager); let html = ''; Object.keys(by).sort((a, b) => a.localeCompare(b)).forEach(mgr => { html += mgrHeader(mgr); by[mgr].forEach(({ p, falta }) => { html += '<div style="font-size:14px;padding:4px 0 4px 8px;border-bottom:1px solid #E8E8E8;color:' + C.dark + ';">' + nameLink(p.name, p.link) + ' — colocar em: <span style="color:' + C.red + ';">' + esc(falta.join(', ')) + '</span></div>'; }); }); body.innerHTML = html; }
            function renderTab() { if (activeTab === 'hora') renderHora(); else renderLog(); }
            function setActive(which) { activeTab = which; tabHora.style.cssText = tabBase + (which === 'hora' ? 'color:' + C.red + ';border-bottom:3px solid ' + C.red + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); tabLog.style.cssText = tabBase + (which === 'log' ? 'color:' + C.amber + ';border-bottom:3px solid ' + C.amber + ';' : 'color:' + C.grey + ';border-bottom:3px solid transparent;'); renderTab(); }
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
                    if (err || !r2 || !r2.trainings.length) { updatedEl.textContent = '⚠️ falha ao atualizar ' + fmtTime(new Date()); return; }
                    curR = r2; recompute(); updateTabLabels();
                    const s = sig();
                    if (s !== lastSig) { lastSig = s; const st = body.scrollTop; renderTab(); body.scrollTop = st; }
                    updatedEl.textContent = 'atualizado ' + fmtTime(new Date());
                    nextAt = Date.now() + OVERLAY_REFRESH_MS;
                });
            }
            tabHora.onclick = () => setActive('hora'); tabLog.onclick = () => setActive('log');
            tabs.appendChild(tabHora); tabs.appendChild(tabLog);
            ov.appendChild(head); ov.appendChild(tabs); ov.appendChild(body); document.body.appendChild(ov); setActive('hora');
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

        let enabled = false, mo = null;
        function enable() {
            if (enabled) { injectBar(); return; }
            enabled = true; injectUICss(); injectBar();
            if (!mo) {
                let moT = null;
                mo = new MutationObserver(() => { if (!enabled || moT) return; moT = setTimeout(() => { moT = null; if (enabled) injectBar(); }, 500); });
                try { mo.observe(document.body, { childList: true }); } catch (e) {}
            }
        }
        function disable() { if (!enabled) return; enabled = false; removeAll(); }
        return { enable, disable };
    }
    const onbModule = createOnbModule();

    // ── Início ───────────────────────────────────────────────────────────
    function init() {
        if (!document.body) { setTimeout(init, 300); return; }
        ensureCycle();
        buildUI();
        render();
        setInterval(render, 1000);
        window.addEventListener('resize', () => { if (fab) applyPos(); });
        window.addEventListener('pointerdown', function unlock() {
            try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
        }, { once: true });
        // Esc fecha: ajuda e os overlays do Onboarding (não fecha setup nem takeover de propósito).
        window.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (helpEl) { toggleHelp(); return; }
            const ids = ['onb-people', 'onb-dash', 'onb-overlay'];
            for (let i = 0; i < ids.length; i++) { const n = document.getElementById(ids[i]); if (n) { n.remove(); return; } }
        });
    }
    init();
})();
