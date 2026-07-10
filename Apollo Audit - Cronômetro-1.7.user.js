// ==UserScript==
// @name         Apollo Audit - Cronômetro
// @namespace    http://tampermonkey.net/
// @version      1.7.4
// @icon         https://apollo-audit.corp.amazon.com/assets/logo-dd85fb4df17c677f72dfe230a166634f262b989d378eb197330a715439f9062f.png
// @description  Cronômetro flutuante + preenchimento automático da auditoria com os dados vindos do Acompanhamento LC
// @author       ladislke
// @match        https://apollo-audit.corp.amazon.com/audits/new?audit_type_id=*
// @connect      fclm-portal.amazon.com
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

// v1.7.4 — Correção do id do Login: o campo é "audit_properties_Login do Associado:"
//          (o script usava o id antigo 'apollo-employee-login'). Agora tenta os dois
//          ids (o 1º que existir vence), então o Login volta a preencher.
// v1.7.3 — Login resiliente: o campo de Login (autocomplete) era limpo pelo React
//          ao preencher os selects seguintes. Agora ele é reaplicado com retry +
//          reforço final. (Rate esperado vazio = FCLM sem sessão → use o botão ↻.)
// v1.7.2 — Correção do Pick: o preenchimento agora é independente por campo, então
//          a pergunta extra "Selecione o destino do Pick:" não trava mais o
//          preenchimento de Login/Turno/Learning Curve/Rate. O destino continua
//          intencionalmente em branco (o auditor escolhe).
// v1.7.1 — Rate esperado passa a usar o rate DIÁRIO (spanType=Day) em vez do
//          semanal, que é o valor correto exibido por padrão no FCLM.
// v1.7 — Correção do FCLM: URL agora usa reportFormat=HTML + spanType + datas
//        para o servidor renderizar a tabela; parse passou a ser por linha
//        (acha o nome em "Line Items" e lê o valor no offset +5 = Plan Rate),
//        baseado no scraper Python de referência.
// v1.6 — Botão flutuante "Buscar Rate esperado": consulta o FCLM sob demanda,
//        preenche o campo e mostra o resultado/erro na tela (sem precisar do
//        console). Funciona mesmo sem o hash, usando o audit_type_id da URL.
// v1.5 — Rate esperado automático: busca o "Plan Rate" no FCLM Portal
//        (processPathRollup do GRU5) a partir do processo auditado e preenche
//        o campo "Rate esperado no processo:". Processos sem rollup (CC, SBC,
//        SRC, Receive Dock) ficam em branco.
// v1.4 — Preenchimento automático: ao abrir pelo link do Acompanhamento LC
//        (gru5acompanhamentos.netlify.app / 127.0.0.1:5500), preenche:
//        Área auditora (Learning), Login, Turno (mapeado), Learning Curve e Rate esperado.

// v1.3 — Reescrita limpa + alertas escalonados:
//        • Contagem crescente a partir de 00:00 (formato MM:SS), zera a cada load.
//        • 7 min → cor AMARELA + 1 beep.
//        • 9 min → cor VERMELHA + 2 beeps.
//        • 10 min → som de alerta (3 beeps graves) + OVERLAY GRANDE "SESSÃO SERÁ EXPIRADA".
//        • Cada alerta toca uma única vez (flags). Áudio destravado no 1º clique/tecla.
//        • Overlay do tempo no topo-centro, arrastável e com posição lembrada.
//        • Teste de som: atalho Shift+P toca os beeps (só fora de campos de texto).
// v1.2 — Alertas sonoros iniciais (5/10 min).
// v1.1 — Sem drift, título da aba, arrastável, posição lembrada.
// v1.0 — Overlay flutuante estilo Amazon; cronômetro HH:MM:SS.

(function() {
    'use strict';

    // ── Limites (em segundos) ─────────────────────────────────────────────
    const WARN_SECONDS   = 7 * 60;   //  7 min → amarelo + 1 beep
    const DANGER_SECONDS = 9 * 60;   //  9 min → vermelho + 2 beeps
    const EXPIRE_SECONDS = 10 * 60;  // 10 min → alerta + overlay grande

    // ── Paleta Amazon ─────────────────────────────────────────────────────
    const C = {
        dark:   '#232F3E',
        accent: '#FF9900',
        gold:   '#FEBD69',
        green:  '#27AE60',
        amber:  '#E8A200',
        red:    '#CC0000',
        white:  '#FFFFFF',
    };

    const POS_KEY   = 'apollo_timer_pos';
    const startTime = Date.now();

    // ── Som (Web Audio API — sem arquivos externos) ───────────────────────
    let audioCtx = null;
    function ensureAudio() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) {}
    }
    // Navegadores só permitem áudio após interação do usuário → destrava no 1º gesto
    ['click', 'keydown', 'mousedown', 'touchstart'].forEach(function(ev) {
        window.addEventListener(ev, ensureAudio, { once: true, capture: true });
    });
    function beep(freq, durationMs, type, gainVal) {
        ensureAudio();
        if (!audioCtx || audioCtx.state !== 'running') return;
        try {
            const osc  = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = type || 'sine';
            osc.frequency.value = freq;
            gain.gain.value = gainVal == null ? 0.18 : gainVal;
            osc.connect(gain).connect(audioCtx.destination);
            const t0 = audioCtx.currentTime;
            osc.start(t0);
            gain.gain.setValueAtTime(gain.gain.value, t0 + durationMs / 1000 - 0.03);
            gain.gain.linearRampToValueAtTime(0.0001, t0 + durationMs / 1000);
            osc.stop(t0 + durationMs / 1000);
        } catch (e) {}
    }
    // 7 min → 1 beep curto
    function playWarn()   { beep(800, 240, 'sine', 0.17); }
    // 9 min → 2 beeps rápidos
    function playDanger() { beep(900, 170, 'square', 0.19); setTimeout(function(){ beep(900, 170, 'square', 0.19); }, 230); }
    // 10 min → 3 beeps graves/longos (alerta)
    function playExpire() {
        beep(440, 420, 'square', 0.24);
        setTimeout(function(){ beep(392, 420, 'square', 0.24); }, 480);
        setTimeout(function(){ beep(349, 560, 'square', 0.26); }, 960);
    }

    // ── Estilos (pulso + overlay grande) ──────────────────────────────────
    const style = document.createElement('style');
    style.textContent =
        '@keyframes apolloPulse{0%,100%{box-shadow:0 4px 16px rgba(0,0,0,0.35);}' +
        '50%{box-shadow:0 4px 22px rgba(204,0,0,0.7);}}' +
        '#apollo-timer-overlay.apollo-danger{animation:apolloPulse 1.1s ease-in-out infinite;}' +
        '@keyframes apolloFade{from{opacity:0;}to{opacity:1;}}' +
        '@keyframes apolloPop{from{opacity:0;transform:translateY(14px) scale(0.96);}to{opacity:1;transform:none;}}' +
        '@keyframes apolloWarnPulse{0%,100%{transform:scale(1);}50%{transform:scale(1.04);}}' +
        '#apollo-expire-ov{position:fixed;inset:0;background:rgba(13,19,26,0.78);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:2147483646;display:flex;align-items:center;justify-content:center;animation:apolloFade 0.25s ease;cursor:pointer;}' +
        '#apollo-expire-card{background:linear-gradient(135deg,#7A1F08 0%,#B23A1A 55%,#8B2500 100%);color:#fff;border:3px solid #FF9900;border-radius:18px;max-width:560px;width:90vw;padding:34px 40px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,0.6);font-family:\'Amazon Ember\',Arial,sans-serif;animation:apolloPop 0.3s cubic-bezier(0.18,0.9,0.32,1.2);}' +
        '#apollo-expire-card .apollo-ic{font-size:56px;line-height:1;margin-bottom:12px;animation:apolloWarnPulse 1s ease-in-out infinite;}' +
        '#apollo-expire-card h1{margin:0 0 12px;font-size:30px;font-weight:900;letter-spacing:0.03em;color:#FFD24D;text-shadow:0 2px 6px rgba(0,0,0,0.4);}' +
        '#apollo-expire-card p{margin:0 0 8px;font-size:16px;line-height:1.5;color:#FFE8DC;}' +
        '#apollo-expire-card .apollo-hint{margin-top:18px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.7);}';
    document.head.appendChild(style);

    // ── Overlay do cronômetro ─────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'apollo-timer-overlay';
    Object.assign(overlay.style, {
        position:        'fixed',
        top:             '4px',
        left:            '50%',
        transform:       'translateX(-50%)',
        backgroundColor: C.dark,
        color:           C.white,
        padding:         '10px 16px',
        borderRadius:    '10px',
        boxShadow:       '0 4px 16px rgba(0,0,0,0.35)',
        zIndex:          '999999',
        fontFamily:      "'Amazon Ember', Arial, sans-serif",
        borderLeft:      `4px solid ${C.accent}`,
        userSelect:      'none',
        minWidth:        '150px',
        textAlign:       'center',
        cursor:          'grab',
        transition:      'background-color 0.3s ease, box-shadow 0.2s ease',
    });

    const title = document.createElement('div');
    title.textContent = '\u23F1 TEMPO DE AUDITORIA';
    title.style.cssText = 'font-size:11px;font-weight:bold;letter-spacing:0.06em;color:' + C.gold + ';margin-bottom:4px;';

    const timeEl = document.createElement('div');
    timeEl.id = 'apollo-timer-value';
    timeEl.textContent = '00:00';
    timeEl.setAttribute('aria-live', 'polite');
    timeEl.setAttribute('role', 'timer');
    timeEl.style.cssText = 'font-size:26px;font-weight:bold;line-height:1.1;font-variant-numeric:tabular-nums;color:' + C.green + ';';

    overlay.appendChild(title);
    overlay.appendChild(timeEl);
    overlay.title = 'Início: ' + new Date(startTime).toLocaleTimeString() + ' (arraste para mover)';

    overlay.addEventListener('mouseenter', () => { if (!overlay.classList.contains('apollo-danger')) overlay.style.boxShadow = '0 6px 22px rgba(0,0,0,0.45)'; });
    overlay.addEventListener('mouseleave', () => { if (!overlay.classList.contains('apollo-danger')) overlay.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)'; });

    document.body.appendChild(overlay);

    // ── Posição lembrada ──────────────────────────────────────────────────
    let hasCustomPos = false;
    (function restorePos() {
        try {
            const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
            if (p && typeof p.left === 'number' && typeof p.top === 'number') {
                applyPos(p.left, p.top);
                hasCustomPos = true;
            }
        } catch (e) {}
    })();

    function applyPos(left, top) {
        const r  = overlay.getBoundingClientRect();
        const mx = Math.max(0, window.innerWidth  - r.width);
        const my = Math.max(0, window.innerHeight - r.height);
        left = Math.min(Math.max(0, left), mx);
        top  = Math.min(Math.max(0, top),  my);
        overlay.style.left      = left + 'px';
        overlay.style.top       = top + 'px';
        overlay.style.right     = 'auto';
        overlay.style.bottom    = 'auto';
        overlay.style.transform = 'none';
    }

    // ── Arrastar ──────────────────────────────────────────────────────────
    (function makeDraggable() {
        let dragging = false, ox = 0, oy = 0;
        overlay.addEventListener('mousedown', (e) => {
            dragging = true;
            const r = overlay.getBoundingClientRect();
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            overlay.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            applyPos(e.clientX - ox, e.clientY - oy);
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            hasCustomPos = true;
            overlay.style.cursor = 'grab';
            const r = overlay.getBoundingClientRect();
            try { localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top })); } catch (e) {}
        });
        window.addEventListener('resize', () => {
            if (!hasCustomPos) return;
            const r = overlay.getBoundingClientRect();
            applyPos(r.left, r.top);
        });
    })();

    // ── Overlay grande de expiração ───────────────────────────────────────
    function showExpireOverlay() {
        if (document.getElementById('apollo-expire-ov')) return;
        const ov = document.createElement('div');
        ov.id = 'apollo-expire-ov';
        ov.innerHTML =
            '<div id="apollo-expire-card" role="alertdialog" aria-live="assertive">' +
            '<div class="apollo-ic">\u26A0\uFE0F</div>' +
            '<h1>SESS\u00c3O SER\u00c1 EXPIRADA</h1>' +
            '<p><strong>Conclua a auditoria agora.</strong></p>' +
            '<p>A sess\u00e3o do Apollo est\u00e1 prestes a expirar e o trabalho n\u00e3o salvo pode ser perdido.</p>' +
            '<div class="apollo-hint">Clique para fechar este aviso</div>' +
            '</div>';
        ov.addEventListener('click', function() { ov.remove(); });
        document.body.appendChild(ov);
    }

    // ── Formata segundos → MM:SS (HH:MM:SS se passar de 1h) ───────────────
    function fmt(totalSec) {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? [h, m, s].map(pad).join(':') : [m, s].map(pad).join(':');
    }

    // ── Loop de atualização ───────────────────────────────────────────────
    const baseTitle = document.title;
    let warnedPlayed = false, dangerPlayed = false, expiredPlayed = false;
    function tick() {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const txt = fmt(elapsed);
        timeEl.textContent = txt;
        document.title = '\u23F1 ' + txt + ' \u00b7 ' + baseTitle;

        if (elapsed >= EXPIRE_SECONDS) {
            timeEl.style.color       = C.red;
            overlay.style.borderLeft = `4px solid ${C.red}`;
            overlay.classList.add('apollo-danger');
            if (!expiredPlayed) { expiredPlayed = true; playExpire(); showExpireOverlay(); }
        } else if (elapsed >= DANGER_SECONDS) {
            timeEl.style.color       = C.red;
            overlay.style.borderLeft = `4px solid ${C.red}`;
            overlay.classList.add('apollo-danger');
            if (!dangerPlayed) { dangerPlayed = true; playDanger(); }
        } else if (elapsed >= WARN_SECONDS) {
            timeEl.style.color       = C.amber;
            overlay.style.borderLeft = `4px solid ${C.amber}`;
            overlay.classList.remove('apollo-danger');
            if (!warnedPlayed) { warnedPlayed = true; playWarn(); }
        } else {
            timeEl.style.color       = C.green;
            overlay.style.borderLeft = `4px solid ${C.accent}`;
            overlay.classList.remove('apollo-danger');
        }
    }

    tick();
    setInterval(tick, 1000);

    // ── Atalho de teste: Shift+P toca os beeps (verifica se o som funciona) ─
    document.addEventListener('keydown', function(e) {
        if (!e.shiftKey) return;
        if (e.code !== 'KeyP' && (e.key || '').toLowerCase() !== 'p') return;
        // Ignora quando o usuário está digitando num campo (evita atrapalhar a auditoria)
        const t = e.target;
        const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        e.preventDefault();
        ensureAudio();
        // Toca os 3 níveis em sequência para conferir os tons
        playWarn();
        setTimeout(playDanger, 700);
        setTimeout(playExpire, 1500);
        console.log('[Apollo Timer] Teste de som (Shift+P) — se não ouviu, verifique volume/aba mutada.');
    });
})();


/* ============================================================================
 *  PREENCHIMENTO AUTOMÁTICO DA AUDITORIA
 *  Dados vêm no #hash do link gerado pelo Acompanhamento LC:
 *    ...?audit_type_id=NNNNN#lcprefill=1&login=...&lc=...&rate=...&shift=...&processo=...&week=...
 * ============================================================================ */
(function () {
    'use strict';

    // Lê os parâmetros do hash da URL
    function lerParams() {
        var h = (location.hash || '').replace(/^#/, '');
        if (!h) return null;
        var p = {};
        h.split('&').forEach(function (par) {
            var kv = par.split('=');
            p[decodeURIComponent(kv[0] || '')] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
        });
        return p.lcprefill ? p : null;
    }

    var dados = lerParams(); // pode ser null (aberto sem dados do Acompanhamento LC)

    var AREA_AUDITORA = 'Learning'; // sempre Learning

    // Turno: código do shift (Acompanhamento LC) -> opção do select do Apollo
    var TURNO_MAP = {
        'DR-Z0600': 'Front Day | Blue Day',
        'NR-Z1800': 'Front Night | Blue Night',
        'DSAZ0600': 'Back Day | Red Day',
        'NSAZ1800': 'Back Night | Red Night'
    };

    // Processo (Acompanhamento LC) -> nome da linha em "Line Items" no FCLM Portal.
    // Processos ausentes deste mapa (CC, SBC, SRC, Receive Dock) não têm rollup:
    // o campo "Rate esperado" fica em branco.
    var ROLLUP_MAP = {
        'stow to prime':        'Stow to Prime - Total',
        'sort-batch':           'Batch Sort - Total',
        'pack multis':          'Pack Multis - Total',
        'transfer out pick':    'Transfer Out Pick - Total',
        'each transfer in':     'Each Transfer In - Total',
        'each-receive':         'Each Receive - Total',
        'pick':                 'Pick - Total',
        'prep recorder':        'Prep Recorder - Total',
        'pack singles':         'Pack Multis - Total',
        'rc sort':              'RC Sort - Total',
        'c-returns processed':  'C-Return Processed - Total',
        'pallet-receive':       'Pallet Receive'
    };

    // Fallback: audit_type_id (na URL) -> nome da linha em "Line Items" no FCLM.
    // Usado pelo botão quando a página é aberta sem o hash do Acompanhamento LC.
    // Obs.: 22466 é ambíguo (Pick / Transfer Out Pick) -> assume "Pick - Total".
    var AUDIT_ROLLUP = {
        '22468': 'Stow to Prime - Total',
        '22467': 'Batch Sort - Total',
        '24793': 'Pack Multis - Total',
        '22466': 'Pick - Total',
        '24841': 'Each Transfer In - Total',
        '24812': 'Each Receive - Total',
        '11435': 'Prep Recorder - Total',
        '22465': 'Pack Multis - Total',
        '17923': 'RC Sort - Total',
        '24823': 'C-Return Processed - Total',
        '24818': 'Pallet Receive'
    };

    // Relatório do FCLM (Path Rollup). PRECISA de reportFormat=HTML + spanType + datas
    // para o servidor renderizar a TABELA de dados; só ?warehouseId devolve só o título.
    var FCLM_BASE = 'https://fclm-portal.amazon.com/reports/processPathRollup';

    // Monta a URL do relatório para o DIA atual (spanType=Day) — é o rate que o
    // portal mostra por padrão e o que vale como "Rate esperado".
    function fclmUrl() {
        var now = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var enc = function (d) { return d.getFullYear() + '%2F' + pad(d.getMonth() + 1) + '%2F' + pad(d.getDate()); };
        return FCLM_BASE + '?reportFormat=HTML&warehouseId=GRU5' +
            '&spanType=Day&startDateDay=' + enc(now);
    }

    // Deslocamento do valor (Plan > Rate) a partir da célula do nome (Line Items):
    //   nome(0) · Unit(1) · Vol(2) · Hrs(3) · Rate Actual(4) · Rate Plan(5)
    var OFFSET_PLAN_RATE = 5;

    // IDs dos campos no Apollo (padrão para todos os processos)
    var ID_AREA     = 'audit_properties_Selecione a área auditora:';
    // O campo de login costuma ter o id abaixo; alguns formulários usam o id antigo
    // 'apollo-employee-login'. Tentamos ambos (o 1º que existir vence).
    var ID_LOGIN    = ['audit_properties_Login do Associado:', 'apollo-employee-login'];
    var ID_TURNO    = 'audit_properties_Selecione o turno do associado:';
    var ID_LC       = 'audit_properties_Selecione a Learning Curve do associado:';
    var ID_RATE_ESP = 'audit_properties_Rate esperado no processo:';
    var ID_RATE_ATUAL = 'audit_properties_Rate atual no processo:';
    // Campo EXCLUSIVO do Pick — deve ficar SEMPRE em branco (o auditor escolhe).
    // Só está aqui documentado para deixar claro que é intencionalmente ignorado.
    var ID_DESTINO_PICK = 'audit_properties_Selecione o destino do Pick:';

    // Retorna o 1º elemento existente dentre um id (string) ou vários ids (array).
    function acharPorIds(ids) {
        ids = [].concat(ids);
        for (var i = 0; i < ids.length; i++) {
            var e = document.getElementById(ids[i]);
            if (e) return e;
        }
        return null;
    }

    // Espera um elemento aparecer (a página do Apollo renderiza os campos aos poucos).
    // Aceita um id (string) ou uma lista de ids alternativos (array).
    function esperar(id, timeout) {
        return new Promise(function (resolve) {
            var el = acharPorIds(id);
            if (el) return resolve(el);
            var obs = new MutationObserver(function () {
                var e = acharPorIds(id);
                if (e) { obs.disconnect(); resolve(e); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(function () { obs.disconnect(); resolve(acharPorIds(id)); }, timeout || 15000);
        });
    }

    // Preenche INPUT de forma compatível com React (setter nativo + eventos)
    function setInput(el, valor) {
        if (!el || valor == null || valor === '') return false;
        var proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, String(valor));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // Preenche um INPUT de forma RESILIENTE: aplica o valor e, se o React
    // re-renderizar e limpar o campo (típico no autocomplete de Login), reaplica.
    // Verifica se o valor "colou" e tenta de novo algumas vezes.
    function setInputResiliente(id, valor, tentativas) {
        return new Promise(function (resolve) {
            tentativas = tentativas || 8;
            if (valor == null || valor === '') { resolve(false); return; }
            function tenta(n) {
                var el = acharPorIds(id);
                if (el) {
                    setInput(el, valor);
                    if (String(el.value) === String(valor)) { resolve(true); return; }
                }
                if (n <= 0) { resolve(el ? String(el.value) === String(valor) : false); return; }
                setTimeout(function () { tenta(n - 1); }, 250);
            }
            tenta(tentativas);
        });
    }

    // Seleciona a opção de um <select> pelo texto (ou valor). Compatível com React.
    function setSelect(el, alvo) {
        if (!el || alvo == null || alvo === '') return false;
        var alvoN = String(alvo).trim().toLowerCase();
        var idx = -1;
        for (var i = 0; i < el.options.length; i++) {
            var txt = (el.options[i].textContent || '').trim().toLowerCase();
            var val = (el.options[i].value || '').trim().toLowerCase();
            if (txt === alvoN || val === alvoN) { idx = i; break; }
        }
        if (idx < 0) { // fallback: "contém"
            for (var j = 0; j < el.options.length; j++) {
                if ((el.options[j].textContent || '').trim().toLowerCase().indexOf(alvoN) > -1) { idx = j; break; }
            }
        }
        if (idx < 0) { console.warn('[Apollo Prefill] Opção não encontrada para:', alvo); return false; }
        var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, el.options[idx].value);
        el.selectedIndex = idx;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // Normaliza texto p/ comparação (minúsculo, espaços colapsados, sem acento).
    function norm(s) {
        return String(s == null ? '' : s)
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // Extrai número do texto da célula, removendo separador de milhar (US: 2,860.02 -> 2860.02).
    function parseNumeroCelula(txt) {
        var m = String(txt || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
        return m ? m[0] : '';
    }

    // Baixa o HTML do FCLM (cross-origin) usando GM_xmlhttpRequest.
    function baixarFCLM(url) {
        return new Promise(function (resolve, reject) {
            var xhr = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest
                    : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest
                    : null;
            if (!xhr) { reject(new Error('GM_xmlhttpRequest indisponível (confira @grant/@connect e recarregue o script)')); return; }
            xhr({
                method: 'GET',
                url: url,
                timeout: 25000,
                onload: function (resp) {
                    var html = resp.responseText || '';
                    console.log('[Apollo Prefill] FCLM status=' + resp.status +
                        ' finalUrl=' + (resp.finalUrl || url) + ' tamanho=' + html.length + ' bytes');
                    if (/midway|federate|login|sign\s?in/i.test(resp.finalUrl || '') ||
                        /midway|please sign in|authentication required/i.test(html.slice(0, 2000))) {
                        console.warn('[Apollo Prefill] Parece que o FCLM redirecionou para autenticação (Midway). ' +
                            'Abra ' + FCLM_BASE + ' numa aba, garanta que está logado, e tente de novo.');
                    }
                    resolve(html);
                },
                onerror: function (e) { reject(new Error('Falha de rede ao acessar o FCLM: ' + (e && e.error ? e.error : ''))); },
                ontimeout: function () { reject(new Error('Timeout ao acessar o FCLM')); }
            });
        });
    }

    // Lê o texto "de valor" de uma célula: prioriza um <div> interno (padrão do FCLM),
    // senão usa innerText/textContent. Mesma lógica do scraper Python.
    function textoCelula(td) {
        if (!td) return '';
        var div = td.querySelector('div');
        var t = div ? (div.textContent || '') : '';
        if (!t) t = td.textContent || '';
        return t.replace(/\s+/g, ' ').trim();
    }

    // Descobre o rate planejado (Plan > Rate) percorrendo TODAS as linhas <tr>:
    // acha a célula cujo texto == nome do rollup ("Line Items") e lê o valor no
    // deslocamento OFFSET_PLAN_RATE (nome+5). Não depende de qual <table> é.
    function extrairPlanRate(html, rollup) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var trs = doc.querySelectorAll('tr');
        console.log('[Apollo Prefill] Linhas <tr> na página do FCLM:', trs.length);

        var alvo = norm(rollup);

        // Passo 1: match EXATO do nome; Passo 2: fallback "começa com".
        for (var passo = 0; passo < 2; passo++) {
            for (var i = 0; i < trs.length; i++) {
                var tds = trs[i].querySelectorAll('td');
                if (tds.length < 2) continue;
                for (var k = 0; k < tds.length; k++) {
                    var nome = norm(textoCelula(tds[k]));
                    if (!nome) continue;
                    var casa = (passo === 0) ? (nome === alvo)
                                             : (nome.indexOf(alvo) === 0 || nome === alvo);
                    if (!casa) continue;
                    var celValor = tds[k + OFFSET_PLAN_RATE];
                    var valor = parseNumeroCelula(textoCelula(celValor));
                    console.log('[Apollo Prefill] Linha "' + rollup + '" encontrada (passo ' + passo +
                        ', nome na col ' + k + '). Célula Plan>Rate:', celValor ? textoCelula(celValor) : '(ausente)',
                        '-> valor:', valor);
                    if (valor) return valor;
                }
            }
        }
        console.warn('[Apollo Prefill] Line Item não encontrado no FCLM:', rollup,
            '— verifique login/URL do relatório.');
        return '';
    }

    // Busca o rate esperado no FCLM para o processo atual (ou '' se não houver rollup/erro).
    async function obterRateEsperado(processo) {
        var rollup = ROLLUP_MAP[norm(processo)];
        if (!rollup) { console.log('[Apollo Prefill] Processo sem rollup (rate esperado em branco):', processo); return ''; }
        try {
            var html = await baixarFCLM(fclmUrl());
            var rate = extrairPlanRate(html, rollup);
            if (rate) console.log('[Apollo Prefill] Rate esperado (FCLM) para "' + rollup + '":', rate);
            return rate;
        } catch (e) {
            console.warn('[Apollo Prefill] Não foi possível obter o rate esperado do FCLM:', e && e.message ? e.message : e);
            return '';
        }
    }

    // Resolve o rollup (Line Items) a partir do hash (processo) ou do audit_type_id da URL.
    function resolverRollup() {
        if (dados && dados.processo) {
            return { rollup: ROLLUP_MAP[norm(dados.processo)] || '', origem: dados.processo };
        }
        var m = (location.search || '').match(/audit_type_id=(\d+)/);
        var id = m ? m[1] : '';
        return { rollup: AUDIT_ROLLUP[id] || '', origem: 'audit_type_id ' + (id || '?') };
    }

    // Ícone de "cycle" (↻) dentro do overlay do cronômetro: busca o Plan Rate
    // no FCLM e preenche o "Rate esperado".
    function criarBotaoRate() {
        if (document.getElementById('apollo-rate-btn')) return;

        var overlay = document.getElementById('apollo-timer-overlay');
        if (!overlay) { // overlay ainda não existe → tenta de novo em breve
            setTimeout(criarBotaoRate, 300);
            return;
        }

        // Animação de rotação do ícone enquanto busca
        if (!document.getElementById('apollo-rate-spin-style')) {
            var st = document.createElement('style');
            st.id = 'apollo-rate-spin-style';
            st.textContent = '@keyframes apolloSpin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}' +
                '#apollo-rate-btn.apollo-spinning{animation:apolloSpin 0.8s linear infinite;}';
            document.head.appendChild(st);
        }

        var btn = document.createElement('button');
        btn.id = 'apollo-rate-btn';
        btn.type = 'button';
        btn.title = 'Buscar Rate esperado no FCLM';
        btn.textContent = '\u21BB'; // ↻ cycle
        btn.style.cssText =
            'width:24px;height:24px;padding:0;margin:8px auto 0;line-height:1;' +
            'cursor:pointer;border:none;border-radius:50%;font-size:16px;font-weight:bold;' +
            'color:#232F3E;background:#FF9900;box-shadow:0 2px 6px rgba(0,0,0,0.3);' +
            'display:flex;align-items:center;justify-content:center;transition:filter 0.15s ease;';
        btn.addEventListener('mouseenter', function () { btn.style.filter = 'brightness(0.94)'; });
        btn.addEventListener('mouseleave', function () { btn.style.filter = 'none'; });
        // Impede que clicar/segurar o botão comece a arrastar o overlay
        btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });

        // Mensagem de status: aparece abaixo do cronômetro, dentro do overlay
        // (assim acompanha o overlay quando ele é arrastado).
        var msg = document.createElement('div');
        msg.id = 'apollo-rate-msg';
        msg.style.cssText =
            'font-size:11px;line-height:1.3;color:#fff;margin-top:6px;padding:5px 7px;' +
            'background:#1a2330;border-radius:6px;display:none;white-space:pre-wrap;text-align:left;';

        function setMsg(txt, cor) {
            msg.style.display = 'block';
            msg.textContent = txt;
            msg.style.background = cor || '#1a2330';
        }

        btn.addEventListener('click', async function () {
            var info = resolverRollup();
            if (!info.rollup) {
                setMsg('Processo sem rate esperado no FCLM (' + info.origem + ').', '#8a6d00');
                return;
            }
            btn.disabled = true;
            btn.classList.add('apollo-spinning');
            setMsg('Consultando o FCLM para: ' + info.rollup, '#1a2330');
            try {
                var html = await baixarFCLM(fclmUrl());
                var rate = extrairPlanRate(html, info.rollup);
                if (rate) {
                    var campo = document.getElementById(ID_RATE_ESP);
                    if (campo) {
                        setInput(campo, rate);
                        setMsg('\u2713 Rate esperado: ' + rate + '\nAplicado no campo do Apollo.', '#1e7d34');
                    } else {
                        setMsg('\u2713 Rate esperado: ' + rate + '\n(Campo do Apollo não encontrado — copie manualmente.)', '#8a6d00');
                    }
                } else {
                    setMsg('Não encontrei o rate de "' + info.rollup + '" no FCLM.\nVeja o Console (F12) para detalhes.', '#a12020');
                }
            } catch (e) {
                setMsg('Erro ao buscar no FCLM:\n' + (e && e.message ? e.message : e) + '\nGaranta que está logado no FCLM.', '#a12020');
            } finally {
                btn.disabled = false;
                btn.classList.remove('apollo-spinning');
            }
        });

        overlay.appendChild(btn);
        overlay.appendChild(msg);
    }

    async function preencher() {
        // 1) Área auditora (sempre Learning) — revela os demais campos.
        setSelect(await esperar(ID_AREA), AREA_AUDITORA);

        // Os campos seguintes são preenchidos de forma INDEPENDENTE (cada um espera
        // só o SEU campo aparecer). Assim uma pergunta a mais em certos processos
        // — ex.: "Selecione o destino do Pick:" — não trava o preenchimento dos demais.
        // OBS.: o "destino do Pick" (ID_DESTINO_PICK) é intencionalmente NÃO preenchido.
        var tarefas = [];

        // 2) Login do associado (campo de autocomplete → preenchimento resiliente)
        tarefas.push(esperar(ID_LOGIN).then(function () {
            return setInputResiliente(ID_LOGIN, dados.login);
        }).then(function (ok) {
            console.log('[Apollo Prefill] Login', ok ? '(ok)' : '(falhou/ausente)');
        }));

        // 3) Turno (mapeado do código do shift)
        var turnoApollo = TURNO_MAP[String(dados.shift || '').toUpperCase()] || '';
        if (turnoApollo) {
            tarefas.push(esperar(ID_TURNO).then(function (el) {
                console.log('[Apollo Prefill] Turno', setSelect(el, turnoApollo) ? '(ok)' : '(falhou/ausente)');
            }));
        } else {
            console.warn('[Apollo Prefill] Shift sem mapeamento de turno:', dados.shift);
        }

        // 4) Learning Curve (mesmo valor do campo LC)
        tarefas.push(esperar(ID_LC).then(function (el) {
            console.log('[Apollo Prefill] Learning Curve', setSelect(el, dados.lc) ? '(ok)' : '(falhou/ausente)');
        }));

        // 5) Rate ATUAL no processo (em percentual: 16.6 -> "16.6%")
        var rateFmt = (dados.rate != null && String(dados.rate).trim() !== '')
            ? (String(dados.rate).trim() + '%') : '';
        if (rateFmt) {
            tarefas.push(esperar(ID_RATE_ATUAL).then(function (el) {
                console.log('[Apollo Prefill] Rate atual', setInput(el, rateFmt) ? '(ok)' : '(falhou/ausente)');
            }));
        }

        // Espera todos os campos independentes terminarem (cada um tem seu próprio timeout).
        await Promise.all(tarefas);

        // Reforço: ao preencher os <select> o React pode ter re-renderizado e limpado
        // os campos de TEXTO (Login/Rate atual). Reaplica o que porventura tenha sumido.
        var loginEl = acharPorIds(ID_LOGIN);
        if (loginEl && dados.login && String(loginEl.value) !== String(dados.login)) {
            console.log('[Apollo Prefill] Reaplicando Login (foi limpo pelo re-render)…');
            await setInputResiliente(ID_LOGIN, dados.login);
        }
        if (rateFmt) {
            var rateEl = document.getElementById(ID_RATE_ATUAL);
            if (rateEl && String(rateEl.value) !== String(rateFmt)) {
                await setInputResiliente(ID_RATE_ATUAL, rateFmt);
            }
        }

        // 6) Rate ESPERADO no processo: buscado no FCLM (Plan > Rate) pelo processo auditado.
        console.log('[Apollo Prefill] Buscando rate esperado no FCLM para o processo:', dados.processo);
        var rateEsp = await obterRateEsperado(dados.processo);
        if (rateEsp) {
            var campoEsp = await esperar(ID_RATE_ESP);
            if (!campoEsp) console.warn('[Apollo Prefill] Campo "Rate esperado" não encontrado (id: ' + ID_RATE_ESP + ').');
            else console.log('[Apollo Prefill] Preenchendo "Rate esperado" com:', rateEsp, setInput(campoEsp, rateEsp) ? '(ok)' : '(falhou)');
        } else {
            console.warn('[Apollo Prefill] Rate esperado ficou em branco (sem valor obtido do FCLM).');
        }

        console.log('[Apollo Prefill] Dados aplicados:', dados);
    }

    function iniciar() {
        criarBotaoRate();       // botão manual sempre disponível
        if (dados) preencher(); // preenchimento automático só com dados do Acompanhamento LC
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
