// ==UserScript==
// @name         Pick Console - Auto Refresh
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Recarrega a página do Pick Console (pick-workforce) automaticamente a cada 30 segundos, com controle flutuante para ligar/desligar e contador regressivo destacado.
// @author       ladislke
// @icon         https://picking-console.na.picking.aft.a2z.com/favicon.ico
// @match        https://picking-console.na.picking.aft.a2z.com/fc/*/pick-workforce*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// v1.1 — Intervalo reduzido para 30s. Contador agora fica num badge destacado, que fica
//        vermelho nos últimos 5s antes de recarregar.
// v1.0 — Auto refresh a cada 60s no pick-workforce. Botão flutuante (ligar/desligar) +
//        contador regressivo. Estado (ON/OFF) memorizado em localStorage. Pausa sozinho
//        quando a aba está em segundo plano (reinicia a contagem ao voltar).

(function () {
    'use strict';

    var REFRESH_SEC = 30;                       // intervalo do refresh (segundos)
    var STATE_KEY   = 'pc_autorefresh_enabled'; // 'on' | 'off'

    var enabled   = localStorage.getItem(STATE_KEY) !== 'off';   // padrão: ligado
    var remaining = REFRESH_SEC;

    // ── UI flutuante ────────────────────────────────────────────────
    var bar = document.createElement('div');
    bar.id = 'pc-autoref';
    bar.style.cssText =
        'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;' +
        'padding:8px 12px;border-radius:22px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;' +
        'color:#fff;box-shadow:0 3px 12px rgba(0,0,0,0.35);cursor:pointer;user-select:none;transition:background .15s;';

    var dot = document.createElement('span');
    dot.style.cssText = 'width:9px;height:9px;border-radius:50%;flex-shrink:0;';

    var txt = document.createElement('span');

    // Badge do contador (tempo restante), bem visível.
    var count = document.createElement('span');
    count.style.cssText =
        'min-width:34px;text-align:center;padding:3px 8px;border-radius:14px;background:rgba(255,255,255,0.22);' +
        'font-variant-numeric:tabular-nums;font-weight:800;';

    bar.appendChild(dot);
    bar.appendChild(txt);
    bar.appendChild(count);

    function render() {
        if (enabled) {
            bar.style.background = '#146EB4';
            dot.style.background = '#5fd38a';
            txt.textContent = '🔄 Auto refresh:';
            count.style.display = '';
            // Fica vermelho nos últimos 5s para avisar que vai recarregar.
            count.style.background = remaining <= 5 ? '#c0392b' : 'rgba(255,255,255,0.22)';
            count.textContent = remaining + 's';
            bar.title = 'Auto refresh LIGADO (recarrega a cada ' + REFRESH_SEC + 's) — clique para desligar';
        } else {
            bar.style.background = '#5a6470';
            dot.style.background = '#ff7a7a';
            txt.textContent = '⏸ Auto refresh: OFF';
            count.style.display = 'none';
            bar.title = 'Auto refresh DESLIGADO — clique para ligar';
        }
    }

    bar.addEventListener('click', function () {
        enabled = !enabled;
        localStorage.setItem(STATE_KEY, enabled ? 'on' : 'off');
        remaining = REFRESH_SEC;   // reinicia a contagem ao ligar/desligar
        render();
    });

    function mount() {
        if (!document.body) { setTimeout(mount, 300); return; }
        if (!document.getElementById('pc-autoref')) document.body.appendChild(bar);
        render();
    }
    mount();

    // ── Loop de 1s ──────────────────────────────────────────────────
    setInterval(function () {
        if (!enabled) { render(); return; }
        // Não conta enquanto a aba está em segundo plano (evita reload fora de foco).
        if (document.hidden) { remaining = REFRESH_SEC; render(); return; }
        remaining--;
        if (remaining <= 0) {
            location.reload();
            return;
        }
        render();
    }, 1000);
})();
