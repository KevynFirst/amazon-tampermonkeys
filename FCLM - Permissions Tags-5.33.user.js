// ==UserScript==
// @name         FCLM - Permissions Tags
// @namespace    FCLM_Trained_by_Permissions
// @version      5.33
// @description  Shows associate permissions as shields.io-style badges in timeDetails
// v5.33 — ShipDock (Sort Center) agora tem gatilho FIXO no código, independente da config
//         salva e do editor (que só guarda 1 permissão por processo). Aparece com Outbound Dock
//         OU Container/Exception Mgmt, SC Audit, Sort Center Support, Sorter/Vehicle Mgmt.
// v5.32 — Correspondência de tag agora é OR (qualquer permissão exigida serve; mostra o maior nível).
// @author       @ladislke
// @match        https://fclm-portal.amazon.com/employee*
// @match        https://iad.umbrella.amazon.dev/*
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// ==/UserScript==

// v5.31 — Novas permissões padrão (Problem Solve / Inventory): Add Itens, Add Multi-Itens,
//          Delete Itens, Delete Container, Edit Itens, Move Itens, Move Container.
//          Mapeadas para Inventory-Add/Delete/Edit/Move nos níveis BEGINNER/EXPERT.
//          + FIX: defaults do código agora fazem MERGE com a config salva (fclm_perm_config/
//          fclm_cert_config). Antes, ter config salva ignorava 100% dos defaults — processos
//          novos não apareciam nos badges nem no Config Manager. Agora os defaults são a base
//          e a config salva sobrescreve item a item; processos novos sempre surgem.
//          (Certificados a definir depois — CERT_MAP ainda sem UUIDs para esses processos.)
// v5.30 — Tarja final fixa nas duas filas: ao terminar, o banner verde permanece na tela
//          ("Clique aqui para fechar esta aba") e só fecha quando o usuário clica — confirmando
//          a finalização. Removido o auto-close por timeout no fim de Permissões e Certificados.
// v5.29 — Fechamento de aba confiável: helper closeTab() "adota" a janela (window.open('','_self'))
//          antes do window.close(), contornando bloqueio do navegador em abas abertas via GM_openInTab.
//          Aplicado no fim das DUAS filas (Permissões e Certificados) + abas de coleta Umbrella.
//          Fallback: se o close for bloqueado, a aba navega para about:blank.
// v5.28 — Reset Onboarding: espera de verificação pós-reload reduzida de 1000ms → 400ms (avança mais rápido)
// v5.27 — Watchdog anti-trava em ambas as filas (Remover Permissões e Revogar Certificados)
//          Se NENHUM status muda por ~60s (20×3s), marca o item travado como 'error (pulado)'
//          e promove a próxima pessoa pendente abrindo nova aba — a fila NUNCA mais para.
//          Corrige caso da fila parar na primeira pessoa problemática (ex: redirect SSO sem employeeId/login).
// v5.26 — Reset Onboarding: timeout e "save não encontrado" agora chamam goNext() (não travam a fila)


(function() {
    'use strict';


    // ── Detecção de contexto (v5.8/5.9) ──────────────────────────────────
    var isUmbrella = window.location.hostname.includes('umbrella.amazon.dev');
    var isPermPage  = window.location.pathname.includes('/employee/permissions');


    // ── Config keys — definidos ANTES das early returns (fix bug v5.9) ───
    // isPermPage e isUmbrella retornam cedo: vars abaixo seriam undefined sem este fix
    var PERM_KEY = 'fclm_perm_config';
    var CERT_KEY   = 'fclm_cert_config';
    var REVOKE_KEY = 'fclm_revoke_queue'; // v5.14: fila reset onboarding
    var CERT_REVOKE_KEY = 'fclm_cert_revoke_queue'; // v5.15: fila revogar certificados Umbrella
    var CERT_REVOKE_CUTOFF_KEY = 'fclm_cert_revoke_cutoff'; // v5.21: revogar só certs a partir desta data (ms)
    var CERT_REVOKE_COMMENT_KEY = 'fclm_cert_revoke_comment'; // v5.24: comentário/motivo personalizável
    var CERT_REVOKE_DRYRUN_KEY = 'fclm_cert_revoke_dryrun'; // v5.25: modo simulação (não revoga, só lista)
    var REVOKE_REASON   = 'Tempo fora do caminho'; // motivo fixo (mat-option)
    var REVOKE_COMMENT  = 'Ex-Associado, em novo processo de onboarding'; // comentário fixo
    var LEVELS     = ['BEGINNER', 'INTERMEDIATE', 'EXPERT', 'ADMIN'];


    // ── CSS Config Manager — injetado ANTES das early returns (fix v5.9.1) ─
    // isPermPage e isUmbrella retornam cedo: sem este bloco, styleEl nunca é adicionado nessas páginas
    if (!document.getElementById('fclm-cm-css')) {
        var cmCss = document.createElement('style');
        cmCss.id  = 'fclm-cm-css';
        cmCss.textContent =
            '#fclm-cfg-gear{position:fixed;bottom:20px;right:20px;width:60px;height:60px;background:linear-gradient(145deg,#232F3E 0%,#131921 100%);color:#FF9900;border:2px solid #FF9900;border-radius:14px;cursor:pointer;z-index:99990;box-shadow:0 4px 16px rgba(0,0,0,0.6);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;transition:all 0.22s ease;user-select:none;padding:0;line-height:1;}' +
            '#fclm-cfg-gear:hover{background:linear-gradient(145deg,#37475A 0%,#232F3E 100%);transform:translateY(-3px) scale(1.06);box-shadow:0 8px 24px rgba(0,0,0,0.7);border-color:#FEBD69;}' +
            '#fclm-cfg-gear .fclm-gear-icon{font-size:24px;line-height:1;display:block;transition:transform 0.35s ease;}' +
            '#fclm-cfg-gear:hover .fclm-gear-icon{transform:rotate(60deg);}' +
            '#fclm-cfg-gear .fclm-gear-label{font-size:8px;font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;letter-spacing:0.12em;color:#FF9900;text-transform:uppercase;}' +
            '#fclm-cfg-gear.fclm-gear-custom{border-color:#E88B00;box-shadow:0 4px 16px rgba(232,139,0,0.45);}' +
            '#fclm-cfg-gear.fclm-gear-custom::after{content:"\\25CF";position:absolute;top:6px;right:7px;color:#FF9900;font-size:9px;pointer-events:none;line-height:1;}' +
            '#fclm-cfg-tabs{display:flex;background:#16202B;border-bottom:3px solid #FF9900;flex-shrink:0;}' +
            '.fclm-tab{flex:1;padding:13px 16px;background:transparent;color:rgba(255,255,255,0.5);border:none;border-bottom:3px solid transparent;margin-bottom:-3px;cursor:pointer;font-family:\'Amazon Ember\',\'Segoe UI\',Arial,sans-serif;font-size:13px;font-weight:bold;transition:all 0.18s ease;letter-spacing:0.04em;}' +
            '.fclm-tab:hover{color:#fff;background:rgba(255,255,255,0.07);}' +
            '.fclm-tab.fclm-tab-active{color:#FF9900;border-bottom-color:#FF9900;background:linear-gradient(180deg,rgba(255,153,0,0.12) 0%,rgba(255,153,0,0.03) 100%);}' +
            '#fclm-cfg-overlay{position:fixed;inset:0;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:99995;display:flex;align-items:center;justify-content:center;animation:fclmFade 0.18s ease;}' +
            '@keyframes fclmFade{from{opacity:0;}to{opacity:1;}}' +
            '@keyframes fclmPop{from{opacity:0;transform:translateY(12px) scale(0.98);}to{opacity:1;transform:none;}}' +
            '#fclm-cfg-panel{background:#fff;border-radius:14px;width:760px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(255,153,0,0.18);font-family:\'Amazon Ember\',\'Segoe UI\',Arial,sans-serif;animation:fclmPop 0.22s cubic-bezier(0.18,0.9,0.32,1.2);}' +
            '#fclm-cfg-hdr{background:linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#1A252F 100%);color:#fff;padding:14px 18px;display:flex;align-items:center;gap:10px;font-weight:bold;font-size:14px;letter-spacing:0.02em;border-bottom:3px solid #FF9900;flex-shrink:0;}' +
            '#fclm-cfg-hdr-title{flex:1;}.fclm-badge-custom{background:linear-gradient(145deg,#FFA52C 0%,#E88B00 100%);color:#fff;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:bold;letter-spacing:0.03em;box-shadow:0 1px 3px rgba(232,139,0,0.4);}' +
            '.fclm-badge-default{background:#607D8B;color:#fff;padding:3px 9px;border-radius:20px;font-size:10px;letter-spacing:0.03em;}' +
            '#fclm-cfg-close{background:rgba(255,255,255,0.08);border:none;color:#fff;font-size:18px;cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:0.8;transition:all 0.15s ease;}#fclm-cfg-close:hover{opacity:1;color:#fff;background:#E74C3C;transform:rotate(90deg);}' +
            '#fclm-cfg-body{flex:1;overflow-y:auto;padding:18px;background:#EEF1F4;}' +
            '#fclm-perm-table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border-radius:10px;overflow:hidden;font-size:12px;box-shadow:0 2px 10px rgba(35,47,62,0.10);}' +
            '#fclm-perm-table thead th{background:linear-gradient(135deg,#2C3E50 0%,#232F3E 100%);color:#fff;padding:10px 12px;text-align:left;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;}' +
            '#fclm-perm-table tbody tr:nth-child(even){background:#F6F8FA;}#fclm-perm-table tbody tr{transition:background 0.12s ease;}#fclm-perm-table tbody tr:hover{background:#FFF6E5;}' +
            '#fclm-perm-table tbody td{padding:7px 10px;border-bottom:1px solid #ECEFF2;}' +
            '.fclm-cert-row{background:#fff;border-radius:10px;margin-bottom:10px;padding:12px 14px;box-shadow:0 2px 8px rgba(35,47,62,.08);border:1px solid #ECEFF2;transition:box-shadow 0.15s ease,transform 0.15s ease;}.fclm-cert-row:hover{box-shadow:0 4px 14px rgba(35,47,62,.14);transform:translateY(-1px);}' +
            '.fclm-cert-hdr{display:flex;align-items:center;gap:8px;margin-bottom:10px;}' +
            '.fclm-uuid-wrap{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;min-height:26px;}' +
            '.fclm-uuid-chip{background:linear-gradient(145deg,#37475A 0%,#2C3E50 100%);color:#fff;border-radius:20px;padding:3px 8px 3px 10px;font-size:10px;font-family:\'SFMono-Regular\',Consolas,monospace;display:inline-flex;align-items:center;gap:5px;box-shadow:0 1px 3px rgba(35,47,62,0.25);}' +
            '.fclm-chip-x{background:transparent;border:none;color:#FFB36B;cursor:pointer;font-size:14px;padding:0;line-height:1;font-weight:bold;transition:color 0.12s ease;}.fclm-chip-x:hover{color:#FF6B6B;}' +
            '.fclm-uuid-add-row{display:flex;gap:6px;}.fclm-uuid-in{flex:1;font-family:\'SFMono-Regular\',Consolas,monospace;font-size:11px;border:1px solid #D5DBE0;border-radius:7px;padding:6px 9px;box-sizing:border-box;transition:all 0.15s ease;}' +
            '.fclm-uuid-in:focus{outline:none;border-color:#FF9900;box-shadow:0 0 0 3px rgba(255,153,0,.18);}' +
            '.fclm-btn-add-uuid{background:linear-gradient(145deg,#37475A 0%,#232F3E 100%);color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:11px;font-weight:bold;cursor:pointer;white-space:nowrap;transition:all 0.15s ease;}.fclm-btn-add-uuid:hover{background:linear-gradient(145deg,#4A5D72 0%,#37475A 100%);transform:translateY(-1px);}' +
            '.fclm-in{border:1px solid #D5DBE0;border-radius:7px;padding:6px 9px;font-size:11px;box-sizing:border-box;width:100%;transition:all .15s ease;}' +
            '.fclm-in:focus{outline:none;border-color:#FF9900;box-shadow:0 0 0 3px rgba(255,153,0,.18);}.fclm-proc-in{flex:1;}' +
            '.fclm-sel{border:1px solid #D5DBE0;border-radius:7px;padding:6px 8px;font-size:11px;background:#fff;cursor:pointer;width:100%;transition:all 0.15s ease;}.fclm-sel:focus{outline:none;border-color:#FF9900;box-shadow:0 0 0 3px rgba(255,153,0,.18);}' +
            '.fclm-del{background:transparent;border:none;cursor:pointer;font-size:14px;padding:2px 5px;border-radius:6px;opacity:.5;transition:all .15s ease;flex-shrink:0;}.fclm-del:hover{opacity:1;background:rgba(231,76,60,0.12);}' +
            '.fclm-add-row-btn{margin-top:12px;width:100%;background:rgba(255,153,0,0.08);color:#B36B00;border:1.5px dashed #FFB44D;border-radius:9px;padding:9px 14px;font-size:12px;font-weight:bold;cursor:pointer;transition:all 0.15s ease;}.fclm-add-row-btn:hover{background:rgba(255,153,0,0.16);border-color:#FF9900;color:#8A5200;}' +
            '#fclm-cfg-footer{padding:12px 16px;background:#fff;border-top:1px solid #E4E8EC;display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;}' +
            '#fclm-cfg-reset{background:#fff;color:#5A6B7B;border:1px solid #CDD4DA;border-radius:8px;padding:8px 16px;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s ease;}#fclm-cfg-reset:hover{background:#F2F4F6;border-color:#9AA6B1;color:#37475A;}' +
            '#fclm-cfg-save{background:linear-gradient(145deg,#37475A 0%,#232F3E 100%);color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:12px;font-weight:bold;letter-spacing:0.02em;cursor:pointer;box-shadow:0 2px 8px rgba(35,47,62,0.25);transition:all 0.15s ease;}#fclm-cfg-save:hover{background:linear-gradient(145deg,#4A5D72 0%,#37475A 100%);transform:translateY(-1px);box-shadow:0 4px 12px rgba(35,47,62,0.32);}' +
            '#fclm-cfg-toast{position:fixed;bottom:90px;right:20px;background:linear-gradient(145deg,#2C3E50 0%,#232F3E 100%);color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:500;z-index:99999;border-left:4px solid #27AE60;box-shadow:0 6px 20px rgba(0,0,0,.35);transition:opacity .5s;font-family:\'Amazon Ember\',\'Segoe UI\',Arial,sans-serif;animation:fclmPop 0.25s ease;}' +
            // v5.14 — Reset Onboarding
            '#fclm-reset-btn{position:fixed;bottom:20px;right:90px;width:60px;height:60px;background:linear-gradient(145deg,#B23A1A 0%,#7A1F08 100%);color:#FFD24D;border:2px solid #E88B00;border-radius:14px;cursor:pointer;z-index:99990;box-shadow:0 4px 16px rgba(0,0,0,0.6);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;transition:all 0.22s ease;user-select:none;padding:0;line-height:1;}' +
            '#fclm-reset-btn:hover{background:linear-gradient(145deg,#CC4422 0%,#A33000 100%);transform:translateY(-3px) scale(1.06);box-shadow:0 8px 24px rgba(178,58,26,0.55);border-color:#FFD24D;}' +
            '#fclm-reset-ov{position:fixed;inset:0;background:rgba(13,19,26,0.64);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:99996;display:flex;align-items:center;justify-content:center;animation:fclmFade 0.18s ease;}' +
            '#fclm-reset-panel{background:#fff;border-radius:14px;width:600px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,0.55),0 0 0 1px rgba(178,58,26,0.22);font-family:\'Amazon Ember\',\'Segoe UI\',Arial,sans-serif;animation:fclmPop 0.22s cubic-bezier(0.18,0.9,0.32,1.2);}' +
            '#fclm-reset-hdr{background:linear-gradient(135deg,#B23A1A 0%,#8B2500 55%,#6B1A00 100%);color:#fff;padding:14px 18px;display:flex;align-items:center;gap:10px;font-weight:bold;font-size:14px;letter-spacing:0.02em;border-bottom:3px solid #E88B00;flex-shrink:0;}' +
            '#fclm-reset-body{flex:1;overflow-y:auto;padding:18px;background:#F6EEEC;}' +
            '.fclm-reset-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;margin-top:10px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(139,37,0,0.10);}' +
            '.fclm-reset-tbl th{background:linear-gradient(135deg,#B23A1A 0%,#8B2500 100%);color:#fff;padding:9px 11px;text-align:left;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;}' +
            '.fclm-reset-tbl td{padding:8px 11px;border-bottom:1px solid #EEE2DF;font-size:12px;}' +
            '.fclm-reset-tbl tr:nth-child(even){background:#FBF3F1;}' +
            '.fclm-proc-btn{width:100%;padding:12px;background:linear-gradient(145deg,#B23A1A 0%,#8B2500 100%);color:#FFD24D;border:none;border-radius:10px;font-size:14px;font-weight:bold;letter-spacing:0.02em;cursor:pointer;margin-top:14px;box-shadow:0 3px 10px rgba(139,37,0,0.3);transition:all 0.18s ease;}' +
            '.fclm-proc-btn:hover:not(:disabled){background:linear-gradient(145deg,#CC4422 0%,#A33000 100%);transform:translateY(-1px);box-shadow:0 5px 16px rgba(139,37,0,0.4);}.fclm-proc-btn:disabled{opacity:0.5;cursor:not-allowed;}' +
            // v5.22 — Listing moderno: colunas + status pills
            '.fclm-reset-tbl tbody tr{transition:background 0.12s ease;}.fclm-reset-tbl tbody tr:hover{background:#FBEDE9;}' +
            '.fclm-rc-idx{color:#B0917F;font-variant-numeric:tabular-nums;width:34px;text-align:center;font-weight:bold;}' +
            '.fclm-rc-login{font-weight:600;color:#232F3E;}' +
            '.fclm-rc-id{font-family:\'SFMono-Regular\',Consolas,monospace;color:#5A6B7B;font-variant-numeric:tabular-nums;}' +
            '.fclm-st{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:600;line-height:1.5;white-space:nowrap;letter-spacing:0.01em;}' +
            '.fclm-st::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0;}' +
            '.fclm-st-wait{background:#FFF3D6;color:#9A6700;}' +
            '.fclm-st-run{background:#E1EFFF;color:#1B6FB3;}' +
            '.fclm-st-run::before{animation:fclmPulse 1s ease-in-out infinite;}' +
            '.fclm-st-ok{background:#DCF5E4;color:#1E8449;}' +
            '.fclm-st-err{background:#FCE2DE;color:#B23A1A;}' +
            '.fclm-st-stop{background:#E7EAEE;color:#5A6B7B;}' +
            '.fclm-st-warn{background:#FFE7D1;color:#B36B00;}' +
            '@keyframes fclmPulse{0%,100%{opacity:1;}50%{opacity:0.3;}}';
        document.head.appendChild(cmCss);
    }


    // ── permissionsData + CERT_MAP + _TAB styles antes das early returns (fix v5.9.2) ─
    // isPermPage e isUmbrella retornam cedo — sem este bloco o Config Manager não tem defaults
    // v5.31 — defaults extraídos para constantes + merge: a config salva sobrescreve item a item,
    //          mas processos NOVOS adicionados no código sempre aparecem (badges + Config Manager).
    function mergeWithDefaults(defaults, key) {
        var base = JSON.parse(JSON.stringify(defaults || {}));
        try {
            var s = GM_getValue(key, null);
            if (s) { var d = JSON.parse(s); if (d && Object.keys(d).length) { for (var k in d) base[k] = d[k]; } }
        } catch(e) {}
        return base;
    }
    var PERM_DEFAULTS = {
        "Dock IB":      { "Receive Dock":        "BEGINNER"     },
        "Receive":      { "Receive Each":         "BEGINNER"     },
        "Decant":       { "Decanter":             "BEGINNER"     },
        "Stow Nike":    { "Stow Nike Active":     "BEGINNER"     },
        "Stow":         { "Stow to Prime (Sub)":  "BEGINNER"     },
        "Prep":         { "Prep":                 "BEGINNER"     },
        "Pick RF":      { "Pick RF":              "BEGINNER"     },
        "SBC":          { "IC QA":                "BEGINNER"     },
        "CC":           { "IC QA":                "INTERMEDIATE" },
        "SRC":          { "IC QA":                "INTERMEDIATE" },
        "SmartPac":     { "PACK AUTOMATION":      "BEGINNER"     },
        "Pack Singles": { "PackApp":              "BEGINNER"     },
        "Pack Multis":  { "Pack Multis":          "BEGINNER"     },
        "Rebin":        { "Rebin":                "BEGINNER"     },
        "Induct":       { "AR Manual Induct":     "BEGINNER"     },
        "SLAM":         { "Pack Manual SLAM":     "BEGINNER"     },
        // ShipDock: doca de saída (Outbound Dock) OU permissões de Sort Center (v5.32)
        "ShipDock":     { "Outbound Dock": "BEGINNER", "Container Mgmt": "BEGINNER", "Exception Mgmt": "BEGINNER", "SC Audit": "BEGINNER", "Sort Center Support": "BEGINNER", "Sorter Mgmt": "BEGINNER", "Vehicle Mgmt": "BEGINNER" },
        "Sortation":    { "RC Sort (Sub)":        "BEGINNER"     },
        "CRET":         { "C-Returns (Sub)":      "BEGINNER"     },
        "Transfer Out": { "Transfer Out (Sub)":   "BEGINNER"     },
        "Tote Wrangler":{ "Tote Wrangler":        "BEGINNER"     },
        // v5.31 — Problem Solve / Inventory
        "Add Itens":      { "Inventory-Add":      "BEGINNER"     },
        "Add Multi-Itens":{ "Inventory-Add":      "EXPERT"       },
        "Delete Itens":   { "Inventory-Delete":   "BEGINNER"     },
        "Delete Container":{ "Inventory-Delete":  "EXPERT"       },
        "Edit Itens":     { "Inventory-Edit":     "BEGINNER"     },
        "Move Itens":     { "Inventory-Move":     "BEGINNER"     },
        "Move Container": { "Inventory-Move":     "EXPERT"       },
    };
    var permissionsData = mergeWithDefaults(PERM_DEFAULTS, 'fclm_perm_config');
    var CERT_DEFAULTS = {
        'Dock IB':      ['c53c95d5-4019-5750-a858-a7a525d56845','96be176b-0909-5044-919a-1aba78d27be0','da3309ff-3c94-50b5-a024-e9a567be3a6b'],
        'Receive':      ['a423f328-7b1c-5f41-87ba-baa53f594416','d028f877-fe2c-5a42-9f0e-76b9d1f9d11e'],
        'Stow':         ['aa328485-ce6c-5cc2-abb9-248f5d10524e','8d6c6423-2c27-55eb-950a-e4e14e28235c'],
        'Prep':         ['d2c64c5d-46f3-5a7a-80b8-c5967cb1163b','feba5459-a5e1-5c71-9c45-e0094901c18a','41718380-1d5c-552c-8594-ba18e5838813'],
        'Pick RF':      ['a80c1329-3b74-5f7c-a01e-b798eb2dcff6','89274fe5-78fe-5e81-b2d7-893ec3712a16','1ecb8ced-b922-5fa4-b69e-bf6991102298'],
        'SBC':          ['a1ff410c-81da-58af-a32b-670f3f455544','a47f838b-1d38-52aa-a69c-89e2dd7e080d'],
        'CC':           ['84edf4bf-1789-5bc2-8df2-b01b0a8a0cd8'],
        'SRC':          ['a626772b-784f-5506-88c2-336680c5c433'],
        'Pack Singles': ['cdd74cee-7f04-5a4e-854c-c571f83ade2c','9cbff22c-6ca2-5d26-b1e3-e8dc37fad775'],
        'Pack Multis':  ['cdd74cee-7f04-5a4e-854c-c571f83ade2c','9cbff22c-6ca2-5d26-b1e3-e8dc37fad775'],
        'Rebin':        ['d0ab8787-6d3b-582b-a69c-3b6a39fe935a','482d5e2a-9d9e-5acc-94c4-544adec5398e'],
        'SLAM':         ['90710e86-a092-5eac-b567-eb8c97360380','07cc0361-66fd-5aa5-b419-17c30d223ec6'],
        'ShipDock':     ['84d8d31f-f2c9-5da2-bdf9-644b33344d5c','acaeba4f-a21c-5e72-a564-560a5646cbd4','93086d09-d962-5915-b37c-350ab2694d57','2d3cd373-d2ac-51ba-9527-d7e3d30fc6e3'],
        'Sortation':    ['3688ab3d-009c-5446-9d9a-4c231513acee'],
        'CRET':         ['f3946276-0e77-5e8c-8343-6ea46f8d0873','6b35d30d-9194-51c0-a8fc-faadab1bebb5','d0ad4de7-fcf5-55e6-aac6-c8e98fecb54d'],
        'Transfer Out': ['2d3cd373-d2ac-51ba-9527-d7e3d30fc6e3','9634f8e9-a894-56c5-9c63-2e3a43feec1c','5bd77d06-efcf-5d41-8748-9e7d0f6ef37b'],
        'Tote Wrangler':['ba5e4990-112b-55cb-829c-ed4500299ee1'],
        };
    var CERT_MAP = mergeWithDefaults(CERT_DEFAULTS, 'fclm_cert_config');
    // _TAB styles antes das early returns — undefined caso contrário em isPermPage/isUmbrella
    var _TAB_BASE = 'flex:1;padding:13px 20px;border:none;border-bottom:4px solid transparent;cursor:pointer;font-size:13px;font-weight:bold;letter-spacing:0.03em;transition:all 0.18s;font-family:\'Amazon Ember\',Arial,sans-serif;';
    var _TAB_ON   = _TAB_BASE + 'background:#FF9900;color:#232F3E;border-bottom-color:#E88B00;';
    var _TAB_OFF  = _TAB_BASE + 'background:#1A252F;color:rgba(255,255,255,0.45);';


    // ── 1. Extrai IDs da URL ───────────────────────────────────────────────
    var urlParams   = new URLSearchParams(window.location.search);
    var employeeId  = urlParams.get('employeeId')  || '';
    var warehouseId = urlParams.get('warehouseId') || '';


    // isPermPage não precisa de IDs na URL — pula a validação para esta página (fix v5.9)
    if (!isUmbrella && !isPermPage && (!employeeId || !warehouseId)) {
        console.warn('[Perm Tags] employeeId ou warehouseId não encontrados na URL');
        return;
    }


    // ── Umbrella: coleta certs OU revoga certs + ⚙️ Config Manager (v5.9/5.16) ──
    if (isUmbrella) {
        // v5.16: roteamento robusto — flag explícita na URL OU fila com item 'processing'
        // (não confia em umb_revoke_login residual — Angular pode ter stripado a URL)
        var _revFlag   = /[?&]tm_revoke=1/.test(window.location.href);
        var _checkFlag = /[?&]tm_check=1/.test(window.location.href);
        var _umbFn;
        if (_revFlag)        _umbFn = runOnUmbrellaRevoke;
        else if (_checkFlag) _umbFn = runOnUmbrella;
        else {
            // Flags stripadas pelo Angular → decide pela fila que tem item 'processing'
            // v5.18: + guard de freshness — ignora 'processing' órfão (> 3min sem atividade)
            // (aba fechada/cancelada deixa processing residual → não pode reativar)
            var _hasRevActive = false;
            try {
                var _rTs    = Number(GM_getValue('umb_revoke_ts', '0'));
                var _rFresh = _rTs && (Date.now() - _rTs) < 180000; // 3 min
                _hasRevActive = _rFresh && JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]')).some(function(i){ return i.status === 'processing'; });
            } catch(e) {}
            _umbFn = _hasRevActive ? runOnUmbrellaRevoke : runOnUmbrella;
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _umbFn);
        } else {
            setTimeout(_umbFn, 500);
        }
        return;
    }


    // ── employee/permissions: ⚙️ Config Manager + Reset Onboarding (v5.14) ─
    if (isPermPage) {
        if (document.body) { setTimeout(function() { injectGear(); runOnPermissionsRevoke(); }, 300); }
        else { document.addEventListener('DOMContentLoaded', function() { setTimeout(function() { injectGear(); runOnPermissionsRevoke(); }, 300); }); }
        return;
    }


    // ── 2. permissionsData: definida antes das early returns — não reavaliada (v5.10) ─
    permissionsData = permissionsData || (function() {
        try { var _s = GM_getValue('fclm_perm_config', null); if (_s) { var _d = JSON.parse(_s); if (_d && Object.keys(_d).length) return _d; } } catch(e) {}
        return {
        "Dock IB":      { "Receive Dock":        "BEGINNER"     }, // era "Inbound Dock"
        "Receive":      { "Receive Each":         "BEGINNER"     }, // novo
        "Decant":       { "Decanter":             "BEGINNER"     },
        "Stow Nike":    { "Stow Nike Active":     "BEGINNER"     },
        "Stow":         { "Stow to Prime (Sub)":  "BEGINNER"     },
        "Prep":         { "Prep":                 "BEGINNER"     }, // novo
        "Pick RF":      { "Pick RF":              "BEGINNER"     }, // unificou Pick + Pick TO
        "SBC":          { "IC QA":                "BEGINNER"     },
        "CC":           { "IC QA":                "INTERMEDIATE" },
        "SRC":          { "IC QA":                "INTERMEDIATE" },
        "SmartPac":     { "PACK AUTOMATION":      "BEGINNER"     },
        "Pack Singles": { "PackApp":              "BEGINNER"     }, // absorveu PackApp
        "Pack Multis":  { "Pack Multis":          "BEGINNER"     }, // absorveu PPMIX
        "Rebin":        { "Rebin":                "BEGINNER"     },
        "Induct":       { "AR Manual Induct":     "BEGINNER"     },
        "SLAM":         { "Pack Manual SLAM":     "BEGINNER"     },
        "ShipDock":     { "Outbound Dock": "BEGINNER", "Container Mgmt": "BEGINNER", "Exception Mgmt": "BEGINNER", "SC Audit": "BEGINNER", "Sort Center Support": "BEGINNER", "Sorter Mgmt": "BEGINNER", "Vehicle Mgmt": "BEGINNER" },
        "Sortation":    { "RC Sort (Sub)":        "BEGINNER"     },
        "CRET":         { "C-Returns (Sub)":      "BEGINNER"     },
        "Transfer Out": { "Transfer Out (Sub)":   "BEGINNER"     },
        "Tote Wrangler":{ "Tote Wrangler":        "BEGINNER"     },
        // v5.31 — Problem Solve / Inventory
        "Add Itens":      { "Inventory-Add":      "BEGINNER"     },
        "Add Multi-Itens":{ "Inventory-Add":      "EXPERT"       },
        "Delete Itens":   { "Inventory-Delete":   "BEGINNER"     },
        "Delete Container":{ "Inventory-Delete":  "EXPERT"       },
        "Edit Itens":     { "Inventory-Edit":     "BEGINNER"     },
        "Move Itens":     { "Inventory-Move":     "BEGINNER"     },
        "Move Container": { "Inventory-Move":     "EXPERT"       },
        };
    })();


    // ── CERT_MAP: definido antes das early returns — não reavaliado (v5.10) ────────────
    CERT_MAP = CERT_MAP || (function() {
        try { var _s = GM_getValue('fclm_cert_config', null); if (_s) { var _d = JSON.parse(_s); if (_d && Object.keys(_d).length) return _d; } } catch(e) {}
        return {
        'Dock IB':      ['c53c95d5-4019-5750-a858-a7a525d56845',
                         '96be176b-0909-5044-919a-1aba78d27be0',
                         'da3309ff-3c94-50b5-a024-e9a567be3a6b'],
        'Receive':      ['a423f328-7b1c-5f41-87ba-baa53f594416',
                         'd028f877-fe2c-5a42-9f0e-76b9d1f9d11e'],
        'Stow':         ['aa328485-ce6c-5cc2-abb9-248f5d10524e',
                         '8d6c6423-2c27-55eb-950a-e4e14e28235c'],
        'Prep':         ['d2c64c5d-46f3-5a7a-80b8-c5967cb1163b',
                         'feba5459-a5e1-5c71-9c45-e0094901c18a',
                         '41718380-1d5c-552c-8594-ba18e5838813'],
        'Pick RF':      ['a80c1329-3b74-5f7c-a01e-b798eb2dcff6',
                         '89274fe5-78fe-5e81-b2d7-893ec3712a16',
                         '1ecb8ced-b922-5fa4-b69e-bf6991102298'],
        'SBC':          ['a1ff410c-81da-58af-a32b-670f3f455544',
                         'a47f838b-1d38-52aa-a69c-89e2dd7e080d'],
        'CC':           ['84edf4bf-1789-5bc2-8df2-b01b0a8a0cd8'],
        'SRC':          ['a626772b-784f-5506-88c2-336680c5c433'],
        'Pack Singles': ['cdd74cee-7f04-5a4e-854c-c571f83ade2c',
                         '9cbff22c-6ca2-5d26-b1e3-e8dc37fad775'],
        'Pack Multis':  ['cdd74cee-7f04-5a4e-854c-c571f83ade2c',
                         '9cbff22c-6ca2-5d26-b1e3-e8dc37fad775'],
        'Rebin':        ['d0ab8787-6d3b-582b-a69c-3b6a39fe935a',
                         '482d5e2a-9d9e-5acc-94c4-544adec5398e'],
        'SLAM':         ['90710e86-a092-5eac-b567-eb8c97360380',
                         '07cc0361-66fd-5aa5-b419-17c30d223ec6'],
        'ShipDock':     ['84d8d31f-f2c9-5da2-bdf9-644b33344d5c',
                         'acaeba4f-a21c-5e72-a564-560a5646cbd4',
                         '93086d09-d962-5915-b37c-350ab2694d57',
                         '2d3cd373-d2ac-51ba-9527-d7e3d30fc6e3'],
        'Sortation':    ['3688ab3d-009c-5446-9d9a-4c231513acee'],
        'CRET':         ['f3946276-0e77-5e8c-8343-6ea46f8d0873',
                         '6b35d30d-9194-51c0-a8fc-faadab1bebb5',
                         'd0ad4de7-fcf5-55e6-aac6-c8e98fecb54d'],
        'Transfer Out': ['2d3cd373-d2ac-51ba-9527-d7e3d30fc6e3',
                         '9634f8e9-a894-56c5-9c63-2e3a43feec1c',
                         '5bd77d06-efcf-5d41-8748-9e7d0f6ef37b'],
        'Tote Wrangler':['ba5e4990-112b-55cb-829c-ed4500299ee1'],
        };
    })();


    // ── 3. Nível → display ─────────────────────────────────────────────────
    var permLevel = ["NONE", "BEGINNER", "INTERMEDIATE", "EXPERT", "ADMIN"];


    var levelDisplay = {
        "BEGINNER":     { label: "LV1", rightBg: "#007EC6" }, // 🔵 azul
        "INTERMEDIATE": { label: "LV2", rightBg: "#9E9E9E" }, // ⬜ prata
        "EXPERT":       { label: "LV3", rightBg: "#D4AF37" }, // 🥇 ouro
        "ADMIN":        { label: "LV4", rightBg: "#9C27B0" }, // 🟣 roxo
    };


    // ── 4. CSS ─────────────────────────────────────────────────────────────
    var styleEl = document.createElement('style');
    styleEl.innerHTML = `
        /* Wrapper dedicado — irmão da body>table, responsivo (refresh visual v5.20) */
        #perm-tags-wrapper {
            width: 100%;
            box-sizing: border-box;
            padding: 10px 14px 12px 14px;
            margin: 0;
            background: linear-gradient(180deg, #FFFFFF 0%, #F4F6F8 100%);
            border-top: 3px solid #FF9900;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), 0 1px 4px rgba(35,47,62,0.06);
            font-family: 'Amazon Ember', 'Segoe UI', Arial, sans-serif;
        }
        #perm-tags-label {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            font-size: 10px;
            font-weight: bold;
            color: #232F3E;
            text-transform: uppercase;
            letter-spacing: 0.14em;
            margin-bottom: 9px;
        }
        #perm-tags-label::before,
        #perm-tags-label::after {
            content: "";
            height: 1px;
            width: 46px;
            background: linear-gradient(90deg, rgba(255,153,0,0) 0%, #FF9900 100%);
        }
        #perm-tags-label::after {
            background: linear-gradient(90deg, #FF9900 0%, rgba(255,153,0,0) 100%);
        }
        #perm-tags-container {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            align-items: center;
            justify-content: center;
        }
        .perm-badge {
            display: inline-flex;
            align-items: stretch;
            border-radius: 6px;
            overflow: hidden;
            font-size: 11px;
            font-family: 'Amazon Ember', 'Segoe UI', Verdana, Arial, sans-serif;
            box-shadow: 0 1px 2px rgba(35,47,62,0.18), 0 2px 6px rgba(35,47,62,0.10);
            cursor: default;
            vertical-align: middle;
            transition: box-shadow 0.18s ease, transform 0.14s ease;
            user-select: none;
        }
        .perm-badge:hover {
            box-shadow: 0 4px 12px rgba(35,47,62,0.28);
            transform: translateY(-2px);
        }
        .perm-badge-left {
            background: linear-gradient(145deg, #37475A 0%, #232F3E 100%);
            color: #ffffff;
            padding: 4px 9px;
            font-weight: 500;
            white-space: nowrap;
            letter-spacing: 0.02em;
        }
        .perm-badge-right {
            color: #ffffff;
            padding: 4px 9px;
            font-weight: bold;
            white-space: nowrap;
            letter-spacing: 0.03em;
            box-shadow: inset 1px 0 0 rgba(255,255,255,0.18), inset 0 1px 0 rgba(255,255,255,0.25);
            text-shadow: 0 1px 1px rgba(0,0,0,0.22);
        }
        .perm-row-break {
            width: 100%;
            height: 0;
        }
        .perm-cert-indicator {
            filter: drop-shadow(0 1px 1px rgba(0,0,0,0.18));
        }
        #perm-tags-loading {
            font-size: 11px;
            color: #5A6B7B;
            font-style: italic;
            text-align: center;
        }
        /* ── Certificado Umbrella (v5.8) ───────────────────────────────── */
        .perm-certified .perm-badge-left {
            background: linear-gradient(145deg, #2ECC71 0%, #1E8449 100%) !important; /* verde — tem certificado EARNED */
        }
        .perm-no-cert .perm-badge-left {
            background: linear-gradient(145deg, #E74C3C 0%, #A93226 100%) !important; /* vermelho — sem certificado */
        }
        #perm-cert-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            vertical-align: middle;
            margin-left: 8px;
            padding: 4px 11px;
            background: linear-gradient(145deg, #37475A 0%, #232F3E 100%);
            color: #FEBD69;
            border: 1.5px solid #D4AF37;
            border-radius: 6px;
            font-family: 'Amazon Ember', 'Segoe UI', Arial, sans-serif;
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 0.02em;
            cursor: pointer;
            transition: all 0.18s ease;
            box-sizing: border-box;
            white-space: nowrap;
            box-shadow: 0 1px 4px rgba(35,47,62,0.25);
        }
        #perm-cert-btn:hover:not(:disabled) {
            background: linear-gradient(145deg, #4A5D72 0%, #37475A 100%);
            border-color: #FEBD69;
            box-shadow: 0 3px 10px rgba(212,175,55,0.35);
            transform: translateY(-1px);
        }
        #perm-cert-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        /* ── Config Manager ⚙️ (v5.9) ──────────────────────────────── */
        #fclm-cfg-gear{position:fixed;bottom:20px;right:20px;width:60px;height:60px;background:linear-gradient(145deg,#232F3E 0%,#131921 100%);color:#FF9900;border:2px solid #FF9900;border-radius:14px;cursor:pointer;z-index:99990;box-shadow:0 4px 16px rgba(0,0,0,0.6);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;transition:all 0.22s ease;user-select:none;padding:0;line-height:1;}
        #fclm-cfg-gear:hover{background:linear-gradient(145deg,#37475A 0%,#232F3E 100%);transform:translateY(-3px) scale(1.06);box-shadow:0 8px 24px rgba(0,0,0,0.7);border-color:#FEBD69;}
        #fclm-cfg-gear .fclm-gear-icon{font-size:24px;line-height:1;display:block;transition:transform 0.35s ease;}
        #fclm-cfg-gear:hover .fclm-gear-icon{transform:rotate(60deg);}
        #fclm-cfg-gear .fclm-gear-label{font-size:8px;font-family:'Amazon Ember',Arial,sans-serif;font-weight:bold;letter-spacing:0.12em;color:#FF9900;text-transform:uppercase;}
        #fclm-cfg-gear.fclm-gear-custom{border-color:#E88B00;box-shadow:0 4px 16px rgba(232,139,0,0.45);}
        #fclm-cfg-gear.fclm-gear-custom::after{content:'●';position:absolute;top:6px;right:7px;color:#FF9900;font-size:9px;pointer-events:none;line-height:1;}
        #fclm-cfg-tabs{display:flex;background:#1A252F;border-bottom:3px solid #FF9900;flex-shrink:0;}
        .fclm-tab{flex:1;padding:12px 16px;background:transparent;color:rgba(255,255,255,0.45);border:none;border-bottom:3px solid transparent;margin-bottom:-3px;cursor:pointer;font-family:'Amazon Ember',Arial,sans-serif;font-size:13px;font-weight:bold;transition:all 0.15s;letter-spacing:0.02em;}
        .fclm-tab:hover{color:#fff;background:rgba(255,255,255,0.06);}
        .fclm-tab.fclm-tab-active{color:#FF9900;border-bottom-color:#FF9900;background:rgba(255,153,0,0.07);}
        #fclm-cfg-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99995;display:flex;align-items:center;justify-content:center;}
        #fclm-cfg-panel{background:#fff;border-radius:10px;width:760px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 45px rgba(0,0,0,0.45);font-family:'Amazon Ember',Arial,sans-serif;}
        #fclm-cfg-hdr{background:#232F3E;color:#fff;padding:11px 16px;display:flex;align-items:center;gap:10px;font-weight:bold;font-size:14px;border-bottom:3px solid #FF9900;flex-shrink:0;}
        #fclm-cfg-hdr-title{flex:1;} .fclm-badge-custom{background:#E88B00;color:#fff;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold;}
        .fclm-badge-default{background:#607D8B;color:#fff;padding:2px 8px;border-radius:3px;font-size:10px;}
        #fclm-cfg-close{background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px;opacity:0.7;}
        #fclm-cfg-close:hover{opacity:1;color:#FF9900;}
        #fclm-cfg-body{flex:1;overflow-y:auto;padding:14px;background:#F7F7F7;}
        #fclm-perm-table{width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,0.1);}
        #fclm-perm-table thead th{background:#232F3E;color:#fff;padding:8px 10px;text-align:left;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;}
        #fclm-perm-table tbody tr:nth-child(even){background:#F9F9F9;} #fclm-perm-table tbody tr:hover{background:#FFF8E7;}
        #fclm-perm-table tbody td{padding:5px 8px;border-bottom:1px solid #EBEBEB;}
        .fclm-cert-row{background:#fff;border-radius:6px;margin-bottom:8px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.08);}
        .fclm-cert-hdr{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
        .fclm-uuid-wrap{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;min-height:26px;}
        .fclm-uuid-chip{background:#2C3E50;color:#fff;border-radius:4px;padding:2px 6px 2px 8px;font-size:10px;font-family:monospace;display:inline-flex;align-items:center;gap:4px;}
        .fclm-chip-x{background:transparent;border:none;color:#E88B00;cursor:pointer;font-size:14px;padding:0;line-height:1;font-weight:bold;} .fclm-chip-x:hover{color:#CC0000;}
        .fclm-uuid-add-row{display:flex;gap:6px;} .fclm-uuid-in{flex:1;font-family:monospace;font-size:11px;border:1px solid #DDD;border-radius:4px;padding:4px 7px;box-sizing:border-box;}
        .fclm-uuid-in:focus{outline:none;border-color:#FF9900;box-shadow:0 0 0 2px rgba(255,153,0,.2);}
        .fclm-btn-add-uuid{background:#232F3E;color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap;} .fclm-btn-add-uuid:hover{background:#37475A;}
        .fclm-in{border:1px solid #DDD;border-radius:4px;padding:4px 7px;font-size:11px;box-sizing:border-box;width:100%;transition:border-color .15s;}
        .fclm-in:focus{outline:none;border-color:#FF9900;box-shadow:0 0 0 2px rgba(255,153,0,.2);} .fclm-proc-in{flex:1;}
        .fclm-sel{border:1px solid #DDD;border-radius:4px;padding:4px 6px;font-size:11px;background:#fff;cursor:pointer;width:100%;} .fclm-sel:focus{outline:none;border-color:#FF9900;}
        .fclm-del{background:transparent;border:none;cursor:pointer;font-size:14px;padding:2px 4px;opacity:.5;transition:opacity .15s;flex-shrink:0;} .fclm-del:hover{opacity:1;}
        .fclm-add-row-btn{margin-top:10px;width:100%;background:#EBF5FB;color:#2471A3;border:1.5px dashed #4A86C8;border-radius:5px;padding:6px 14px;font-size:12px;font-weight:bold;cursor:pointer;} .fclm-add-row-btn:hover{background:#D6EAF8;border-color:#2471A3;}
        #fclm-cfg-footer{padding:10px 14px;background:#fff;border-top:1px solid #E8E8E8;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;}
        #fclm-cfg-reset{background:#fff;color:#555;border:1px solid #ccc;border-radius:5px;padding:6px 14px;font-size:12px;cursor:pointer;} #fclm-cfg-reset:hover{background:#F5F5F5;border-color:#999;}
        #fclm-cfg-save{background:#232F3E;color:#fff;border:none;border-radius:5px;padding:6px 16px;font-size:12px;font-weight:bold;cursor:pointer;} #fclm-cfg-save:hover{background:#37475A;}
        #fclm-cfg-toast{position:fixed;bottom:76px;right:20px;background:#232F3E;color:#fff;padding:10px 16px;border-radius:6px;font-size:13px;z-index:99999;border-left:4px solid #27AE60;box-shadow:0 4px 14px rgba(0,0,0,.3);transition:opacity .5s;font-family:'Amazon Ember',Arial,sans-serif;}
    `;
    document.head.appendChild(styleEl);


    // ── Cert helpers v5.8 ─────────────────────────────────────────────────


    // Extrai login do DOM FCLM (label "Login" → célula adjacente)
    function extractLogin() {
        var cells = document.querySelectorAll('td, th, dt');
        for (var i = 0; i < cells.length; i++) {
            if (cells[i].textContent.trim() === 'Login') {
                var next = cells[i].nextElementSibling;
                if (next) return next.textContent.trim().replace(/@.*$/, '').trim();
            }
        }
        return null;
    }


    // Monta URL Umbrella com flag cross-tab
    function buildUmbrellaUrl(login) {
        var inner = encodeURIComponent('["' + login + '"]');
        var outer = encodeURIComponent(inner);
        return 'https://iad.umbrella.amazon.dev/portal/transcript/learner'
            + '?learnerIds=' + outer
            + '&currentTab=certificates&currentProgram=training'
            + '&tm_check=1&tm_login=' + encodeURIComponent(login);
    }


    // Verde se tem cert EARNED, vermelho se não tem; ✅/❌ abaixo do badge (v5.11)
    function applyCertBadges(certs) {
        var certSet = {};
        certs.forEach(function(c) { certSet[c.toLowerCase()] = true; });
        var count = 0;
        document.querySelectorAll('.perm-badge').forEach(function(badge) {
            var leftSpan = badge.querySelector('.perm-badge-left');
            if (!leftSpan) return;


            var process = leftSpan.textContent.trim().replace(/^★\s*/, '').trim();
            var uuids   = CERT_MAP[process];
            if (!uuids || !uuids.length) return; // sem mapeamento → mantém cinza


            // Remove star legada dentro do badge (v5.8 → v5.11)
            var oldStar = badge.querySelector('.perm-cert-star');
            if (oldStar) oldStar.remove();


            var hasCert = uuids.some(function(uuid) { return certSet[uuid.toLowerCase()]; });


            // Indicador ✅/❌ abaixo do wrapper (v5.11)
            var wrap = badge.parentNode;
            var indicator = wrap ? wrap.querySelector('.perm-cert-indicator') : null;
            if (!indicator && wrap && wrap.className === 'perm-badge-wrap') {
                indicator = document.createElement('div');
                indicator.className = 'perm-cert-indicator';
                indicator.style.cssText = 'font-size:14px;line-height:1;text-align:center;';
                wrap.appendChild(indicator);
            }


            if (hasCert) {
                badge.classList.add('perm-certified');
                badge.classList.remove('perm-no-cert');
                leftSpan.textContent = process;
                leftSpan.title = '✓ Certificado Umbrella EARNED';
                if (indicator) indicator.textContent = '✅';
                count++;
            } else {
                badge.classList.add('perm-no-cert');
                badge.classList.remove('perm-certified');
                leftSpan.textContent = process;
                leftSpan.title = '✗ Sem certificado Umbrella';
                if (indicator) indicator.textContent = '❌';
            }
        });
        return count;
    }


    // Abre aba Umbrella e aguarda resultado via GM_setValue (cross-tab)
    function fetchAllCerts(login, onResult) {
        GM_setValue('umb_certs_' + login, JSON.stringify({ status: 'pending', ts: Date.now() }));
        // Backup: salva login ANTES de abrir a aba — Angular pode strip os params da URL (v5.12)
        GM_setValue('umb_pending_login', login);
        GM_setValue('umb_pending_ts', String(Date.now()));
        GM_openInTab(buildUmbrellaUrl(login), { active: false });
        var start   = Date.now();
        var maxWait = 120000; // 2 minutos
        var poll    = setInterval(function() {
            if (Date.now() - start > maxWait) {
                clearInterval(poll);
                onResult(null, 'timeout');
                return;
            }
            try {
                var raw  = GM_getValue('umb_certs_' + login, 'null');
                var data = JSON.parse(raw);
                if (!data || data.status === 'pending') return;
                clearInterval(poll);
                if (data.status === 'done') onResult(data.certs || [], null);
                else                        onResult(null, data.status || 'error');
            } catch(e) {}
        }, 2000);
    }


    // Injeta botão "🎓 Verificar Certificados" ao lado do nome do associado (span.fold-control)
    function injectCertButton() {
        var poll = setInterval(function() {
            // Alvo: span.fold-control dentro de td.title (nome do associado)
            var nameSpan = document.querySelector('td.title span.fold-control');
            if (!nameSpan) return;
            if (document.getElementById('perm-cert-btn')) { clearInterval(poll); return; }
            clearInterval(poll);


            var login = extractLogin();
            var btn   = document.createElement('button');
            btn.id    = 'perm-cert-btn';
            btn.innerHTML = '🎓 Verificar Certificados';


            if (!login) {
                btn.innerHTML = '⚠ Login não encontrado';
                btn.disabled  = true;
                nameSpan.insertAdjacentElement('afterend', btn);
                return;
            }


            btn.onclick = function() {
                if (btn.disabled) return;
                btn.disabled  = true;
                btn.innerHTML = '⏳ Aguardando Umbrella...';
                btn.style.borderColor = '#E88B00';


                fetchAllCerts(login, function(certs, error) {
                    if (error || !certs) {
                        btn.innerHTML = '🔗 Abrir Umbrella';
                        btn.style.borderColor = '#4A86C8';
                        btn.disabled  = false;
                        btn.onclick   = function() {
                            window.open(
                                'https://iad.umbrella.amazon.dev/portal/transcript/learner'
                                + '?learnerIds=' + encodeURIComponent(encodeURIComponent('["' + login + '"]'))
                                + '&currentTab=certificates&currentProgram=training', '_blank');
                        };
                        return;
                    }
                    if (!certs.length) {
                        btn.innerHTML = '⚠ Sem certificados EARNED';
                        btn.style.borderColor = '#E88B00';
                        return;
                    }
                    var count = applyCertBadges(certs);
                    if (count > 0) {
                        btn.innerHTML = '✅ ' + count + ' cert(s) aplicado(s)';
                        btn.style.background  = '#27AE60';
                        btn.style.borderColor = '#1e8449';
                    } else {
                        btn.innerHTML = '🔗 Abrir Umbrella';
                        btn.style.borderColor = '#4A86C8';
                        btn.disabled  = false;
                        btn.onclick   = function() {
                            window.open(
                                'https://iad.umbrella.amazon.dev/portal/transcript/learner'
                                + '?learnerIds=' + encodeURIComponent(encodeURIComponent('["' + login + '"]'))
                                + '&currentTab=certificates&currentProgram=training', '_blank');
                        };
                    }
                });
            };


            // Envolve nome + botão num flex container → ficam lado a lado na mesma linha
            var inlineWrap = document.createElement('span');
            inlineWrap.id  = 'perm-title-wrap';
            inlineWrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;';
            nameSpan.parentNode.replaceChild(inlineWrap, nameSpan);
            inlineWrap.appendChild(nameSpan);
            inlineWrap.appendChild(btn);
        }, 400);
    }


    // ── runOnUmbrella: roda NA aba Umbrella, clica "Carregar mais" até fim ─
    // Coleta todos os UUIDs com status GANHOU/EARNED e salva via GM_setValue.
    function runOnUmbrella() {
        var params  = new URLSearchParams(window.location.search);
        var tmLogin = params.get('tm_login') || '';
        var tmCheck = params.get('tm_check') || '';


        // ── Fix v5.12: Angular SPA faz pushState e strip os params customizados ──
        // Fluxo igual ao fix manual do usuário: detecta params ausentes → injeta de volta → reload
        if (!tmLogin) {
            var pendingLogin = GM_getValue('umb_pending_login', '');
            var pendingTs    = Number(GM_getValue('umb_pending_ts', '0'));
            var isRecent     = pendingLogin && (Date.now() - pendingTs) < 300000; // 5 min


            if (isRecent) {
                // Guard v5.13: só prossegue se existe request ativo (status: 'pending')
                // Abertura manual do Umbrella → umb_certs_LOGIN está 'done'/'error'/null
                // → retorna silenciosamente sem redirect nem coleta
                var certEntry = null;
                try { certEntry = JSON.parse(GM_getValue('umb_certs_' + pendingLogin, 'null')); } catch(e) {}
                if (!certEntry || certEntry.status !== 'pending') return;


                var alreadyRedirected = sessionStorage.getItem('umb_redirected_once') === pendingLogin;


                if (!alreadyRedirected) {
                    // 1ª vez: Angular stripped os params → injeta de volta e recarrega
                    sessionStorage.setItem('umb_redirected_once', pendingLogin);
                    var base = window.location.href
                        .replace(/[?&]tm_check=[^&]*/g, '')
                        .replace(/[?&]tm_login=[^&]*/g, '');
                    var sep = base.indexOf('?') !== -1 ? '&' : '?';
                    window.location.replace(base + sep + 'tm_check=1&tm_login=' + encodeURIComponent(pendingLogin));
                    return; // aguarda o reload
                } else {
                    // 2ª vez: já redirecionou 1x — usa login direto sem redirecionar de novo
                    tmLogin = pendingLogin;
                    tmCheck = '1';
                    sessionStorage.removeItem('umb_redirected_once');
                }
            }
        }


        // Todos os fallbacks falharam — exibe erro APENAS se houve tm_check (v5.14.4)
        // Abertura manual do Umbrella sem parâmetros → retorna silenciosamente
        if (!tmLogin) {
            if (!tmCheck) return;
            var errDiv = document.createElement('div');
            errDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
                + 'background:#CC0000;color:#fff;padding:12px 20px;'
                + 'font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;font-size:14px;'
                + 'text-align:center;border-bottom:4px solid #8B0000;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
            errDiv.innerHTML = '❌ FCLM Permissions Tags — Login não encontrado. Feche esta aba e tente novamente.';
            document.body.appendChild(errDiv);
            return;
        }


        // Banner de progresso fixo no topo
        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
            + 'background:#232F3E;color:#fff;padding:12px 20px;'
            + 'font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;font-size:14px;'
            + 'text-align:center;border-bottom:4px solid #D4AF37;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        banner.innerHTML = '🎓 FCLM Permissions Tags — Coletando certificados... Aguarde.';
        document.body.appendChild(banner);


        function done(certs) {
            banner.style.borderBottomColor = '#27AE60';
            banner.innerHTML = '✅ ' + certs.length + ' certificado(s) EARNED coletado(s). Fechando aba...';
            GM_setValue('umb_certs_' + tmLogin, JSON.stringify({ status: 'done', certs: certs, ts: Date.now() }));
            setTimeout(function() { closeTab(); }, 2500);
        }


        function fail(reason) {
            banner.style.borderBottomColor = '#CC0000';
            banner.innerHTML = '❌ Erro: ' + reason + ' — Fechando aba.';
            GM_setValue('umb_certs_' + tmLogin, JSON.stringify({ status: 'error', certs: [], ts: Date.now() }));
            setTimeout(function() { closeTab(); }, 3000);
        }


        // Coleta UUIDs EARNED do DOM renderizado pelo Angular
        function collectUuids() {
            var found = [];
            document.querySelectorAll('a').forEach(function(a) {
                var text = (a.textContent || '').trim();
                // Verifica padrão UUID
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return;
                // Span irmão = status (GANHOU / EARNED / EXPIRED / REVOKED)
                var statusEl  = a.nextElementSibling;
                var statusTxt = statusEl ? statusEl.textContent.trim() : '';
                if (/ganhou|earned/i.test(statusTxt)) {
                    found.push(text.toLowerCase());
                    return;
                }
                // Fallback: sobe no DOM até 8 níveis
                var parent = a.parentElement;
                for (var d = 0; d < 8 && parent; d++) {
                    if (/ganhou|earned/i.test(parent.textContent)) {
                        found.push(text.toLowerCase());
                        break;
                    }
                    parent = parent.parentElement;
                }
            });
            // Remove duplicatas
            return found.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
        }


        // Clica "Carregar mais" recursivamente até não existir mais o botão
        function clickLoadMore(onAllLoaded, maxClicks) {
            if (maxClicks === undefined) maxClicks = 50;
            if (maxClicks <= 0) { onAllLoaded(); return; }


            var loadDiv = document.querySelector('.load-more');
            if (!loadDiv) { onAllLoaded(); return; }
            if (/não há mais|no more results/i.test(loadDiv.textContent)) { onAllLoaded(); return; }


            var btn = loadDiv.querySelector('button.btn-primary');
            if (!btn) {
                // Botão ainda não renderizado, aguarda
                setTimeout(function() { clickLoadMore(onAllLoaded, maxClicks - 1); }, 1500);
                return;
            }
            banner.innerHTML = '🎓 Carregando certificados... (lote ' + (51 - maxClicks) + ')';
            btn.click();
            setTimeout(function() { clickLoadMore(onAllLoaded, maxClicks - 1); }, 2500);
        }


        // Aguarda Angular renderizar os certificados (max 40s)
        function waitForAngular(timeout, cb) {
            var start = Date.now();
            var check = setInterval(function() {
                if (Date.now() - start > timeout) {
                    clearInterval(check);
                    cb(false);
                    return;
                }
                var cards  = document.querySelectorAll('lms-transcript-certificate-card, .transcript-certificate-card');
                var noMore = document.querySelector('.load-more');
                if (cards.length > 0 || noMore) {
                    clearInterval(check);
                    cb(true);
                }
            }, 800);
        }


        waitForAngular(40000, function(ok) {
            if (!ok) { fail('Angular não renderizou em 40s'); return; }
            banner.innerHTML = '🎓 Carregando todos os certificados...';
            clickLoadMore(function() {
                var certs = collectUuids();
                done(certs);
            });
        });
    }


    // ── v5.15: Revogação de certificados na aba Umbrella ──────────────────
    function buildUmbrellaRevokeUrl(login) {
        var inner = encodeURIComponent('["' + login + '"]');
        var outer = encodeURIComponent(inner);
        return 'https://iad.umbrella.amazon.dev/portal/transcript/learner'
            + '?learnerIds=' + outer
            + '&currentTab=certificates&currentProgram=training'
            + '&tm_revoke=1&tm_login=' + encodeURIComponent(login);
    }


    function runOnUmbrellaRevoke() {
        var params   = new URLSearchParams(window.location.search);
        var tmLogin  = params.get('tm_login')  || '';


        // ── Fix v5.16: Angular SPA faz pushState e strip os params customizados ──
        // Igual ao fix do runOnUmbrella: detecta params ausentes → reinjeta → reload (1x)
        if (!tmLogin) {
            var pLogin = GM_getValue('umb_revoke_login', '');
            var pTs    = Number(GM_getValue('umb_revoke_ts', '0'));
            var recent = pLogin && (Date.now() - pTs) < 300000; // 5 min
            if (recent) {
                // GUARD: só prossegue se há item 'processing' p/ este login na fila
                // (abertura manual do Umbrella → sem processing → retorna silencioso)
                var active = false;
                try { active = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]')).some(function(i){ return i.login === pLogin && i.status === 'processing'; }); } catch(e) {}
                if (!active) return;


                if (sessionStorage.getItem('umb_revoke_redirected') !== pLogin) {
                    // 1ª vez: Angular stripou os params → reinjeta e recarrega
                    sessionStorage.setItem('umb_revoke_redirected', pLogin);
                    var base = window.location.href
                        .replace(/[?&]tm_revoke=[^&]*/g, '')
                        .replace(/[?&]tm_login=[^&]*/g, '');
                    var sep = base.indexOf('?') !== -1 ? '&' : '?';
                    window.location.replace(base + sep + 'tm_revoke=1&tm_login=' + encodeURIComponent(pLogin));
                    return; // aguarda o reload
                } else {
                    // 2ª vez: já redirecionou 1x — usa login direto
                    tmLogin = pLogin;
                    sessionStorage.removeItem('umb_revoke_redirected');
                }
            }
        }


        if (!tmLogin) return; // sem alvo → silencioso (não dispara em abertura manual)


        // GUARD final: confirma item 'processing' p/ este login (evita reabrir URL antiga)
        var hasActive = false;
        try { hasActive = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]')).some(function(i){ return i.login === tmLogin && i.status === 'processing'; }); } catch(e) {}
        if (!hasActive) return;


        var login = tmLogin;


        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
            + 'background:#8B2500;color:#fff;padding:12px 20px;'
            + 'font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;font-size:14px;'
            + 'text-align:center;border-bottom:4px solid #E88B00;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        banner.innerHTML = '🎓 Revogando certificados de <b>' + login + '</b>... Aguarde.';
        document.body.appendChild(banner);


        var revokedCount = 0;
        var revokeNavigating = false; // v5.18: true antes de navegações programadas
        var revokeCutoff = Number(GM_getValue(CERT_REVOKE_CUTOFF_KEY, '0')) || 0; // v5.21: só revoga certs >= esta data
        var revokeComment = GM_getValue(CERT_REVOKE_COMMENT_KEY, '') || REVOKE_COMMENT; // v5.24: motivo personalizável
        var dryRun = GM_getValue(CERT_REVOKE_DRYRUN_KEY, '0') === '1'; // v5.25: modo simulação
        if (revokeCutoff > 0) {
            banner.innerHTML = '🎓 Revogando certificados de <b>' + login + '</b> anteriores a '
                + new Date(revokeCutoff).toLocaleDateString('pt-BR') + '...';
        }


        // v5.18: fechamento manual da aba (sem navegação programada) → aborta o processo
        // marca 'processing' como 'stopped' + limpa chaves → não reexecuta ao reabrir Umbrella
        window.addEventListener('beforeunload', function() {
            if (revokeNavigating) return; // refresher/goNextLearner/window.close → navegação ok
            GM_setValue('umb_revoke_login', '');
            GM_setValue('umb_revoke_ts', '0');
            try {
                var q = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]'));
                var chg = false;
                q.forEach(function(i){ if (i.status === 'processing') { i.status = 'stopped'; chg = true; } });
                if (chg) GM_setValue(CERT_REVOKE_KEY, JSON.stringify(q));
            } catch(e) {}
        });


        function setQueueStatus(status, extra) {
            try {
                var q = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]'));
                for (var i = 0; i < q.length; i++) {
                    if (q[i].login === login && q[i].status === 'processing') {
                        q[i].status = status;
                        if (extra && typeof extra.revoked === 'number') q[i].revoked = extra.revoked;
                        if (extra && extra.error) q[i].error = extra.error;
                        if (extra && extra.notFound) q[i].notFound = true;
                        if (extra && extra.dryRun) q[i].dryRun = true;
                        if (extra && typeof extra.kept === 'number') q[i].kept = extra.kept;
                        if (extra && extra.sim) q[i].sim = extra.sim;
                        break;
                    }
                }
                GM_setValue(CERT_REVOKE_KEY, JSON.stringify(q));
            } catch(e) {}
        }


        function goNextLearner() {
            var q;
            try { q = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]')); } catch(e) { q = []; }
            var next = null;
            for (var i = 0; i < q.length; i++) { if (q[i].status === 'pending') { next = q[i]; break; } }
            if (next) {
                next.status = 'processing';
                GM_setValue(CERT_REVOKE_KEY, JSON.stringify(q));
                GM_setValue('umb_revoke_login', next.login);
                GM_setValue('umb_revoke_ts', String(Date.now()));    // v5.16: backup p/ refresher
                sessionStorage.removeItem('umb_revoke_redirected');  // v5.16: reseta guard p/ próximo
                revokeNavigating = true;                              // v5.18: navegação programada
                window.location.href = buildUmbrellaRevokeUrl(next.login);
            } else {
                GM_setValue('umb_revoke_login', '');
                GM_setValue('umb_revoke_ts', '0');                   // v5.18: limpa timestamp
                revokeNavigating = true;                              // v5.18: fechamento programado
                banner.style.background = '#27AE60';
                banner.style.borderBottomColor = '#1E8449';
                banner.style.cursor = 'pointer';
                banner.innerHTML = '✅ Revogação de certificados concluída! Clique aqui para fechar esta aba.';
                banner.onclick = function() { closeTab(); };
                // v5.30: sem auto-close — a tarja fica fixa até o usuário clicar (confirma finalização)
            }
        }


        function finish(notFound) {
            setQueueStatus('done', { revoked: revokedCount, notFound: !!notFound });
            banner.style.borderBottomColor = notFound ? '#E88B00' : '#27AE60';
            if (notFound) {
                banner.innerHTML = '⚠️ <b>' + login + '</b> — não encontrado ou sem certificados. Avançando...';
            } else {
                banner.innerHTML = '✅ <b>' + revokedCount + '</b> certificado(s) revogado(s) de <b>' + login + '</b>. Avançando...';
            }
            setTimeout(goNextLearner, 1500);
        }


        function fail(reason) {
            setQueueStatus('error', { error: reason, revoked: revokedCount });
            banner.style.borderBottomColor = '#CC0000';
            banner.innerHTML = '❌ Erro (' + login + '): ' + reason + ' — Avançando...';
            setTimeout(goNextLearner, 2500);
        }


        function waitFor(fn, timeout, cb) {
            var start = Date.now();
            var iv = setInterval(function() {
                var r; try { r = fn(); } catch(e) { r = null; }
                if (r) { clearInterval(iv); cb(r); return; }
                if (Date.now() - start > timeout) { clearInterval(iv); cb(null); }
            }, 300);
        }


        // Native setter — Angular FormControl só valida com evento 'input' real
        function setTextarea(ta, val) {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, val);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('blur',  { bubbles: true }));
        }


        function loadAll(cb, max) {
            if (max === undefined) max = 50;
            if (max <= 0) { cb(); return; }
            var loadDiv = document.querySelector('.load-more');
            if (!loadDiv) { cb(); return; }
            if (/não há mais|no more results/i.test(loadDiv.textContent)) { cb(); return; }
            var b = loadDiv.querySelector('button.btn-primary');
            if (!b) { setTimeout(function() { loadAll(cb, max - 1); }, 1200); return; }
            b.click();
            setTimeout(function() { loadAll(cb, max - 1); }, 2000);
        }


        // ── v5.23: leitura da data do certificado no card ──
        // LMS Umbrella usa formato "MMM D, YYYY" (ex: "Jun 11, 2026"); rótulo <b>Concluído em:</b> + <span>
        function parseAnyDate(txt) {
            txt = String(txt || '');
            var m = txt.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
            m = txt.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);   // MMM D, YYYY
            if (m) { var d = new Date(m[0]); if (!isNaN(d.getTime())) return d; }
            m = txt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);              // dd/mm ou mm/dd
            if (m) { var a = +m[1], b = +m[2], y = +m[3]; if (a > 12) return new Date(y, b - 1, a); if (b > 12) return new Date(y, a - 1, b); return new Date(y, b - 1, a); }
            return null;
        }
        function getCardDate(card) {
            // 1) Data ao lado de um rótulo de obtenção/conclusão
            var earnedRe = /obtid|conclu|emitid|emiss|earned|complet|ganho|achiev/i;
            var labels = card.querySelectorAll('b, dt, .label, span');
            for (var i = 0; i < labels.length; i++) {
                var t = (labels[i].textContent || '').trim();
                if (!earnedRe.test(t)) continue;
                var val = '';
                var sib = labels[i].nextElementSibling;
                if (sib) val = sib.textContent;
                if (!parseAnyDate(val) && labels[i].parentElement) val = labels[i].parentElement.textContent;
                var d = parseAnyDate(val);
                if (d) return d;
            }
            // 2) Fallback: primeira data no card inteiro
            return parseAnyDate(card.textContent);
        }

        // Escolhe o próximo card elegível para revogar (respeitando o cutoff)
        function pickEligibleCard() {
            var cards = document.querySelectorAll('lms-transcript-certificate-card, .transcript-certificate-card');
            for (var i = 0; i < cards.length; i++) {
                var c = cards[i];
                if (c.getAttribute('data-ehs-skip')) continue;
                var menu = c.querySelector('.vert-menu, .mat-mdc-menu-trigger.vert-menu');
                if (!menu) continue; // já revogado (sem menu)
                if (revokeCutoff > 0) {
                    var d = getCardDate(c);
                    // Revoga apenas certificados ANTERIORES ao cutoff (data de onboarding).
                    // Mantém os obtidos na data de onboarding ou depois.
                    // Segurança: sem data legível → NÃO revoga (pula).
                    if (!d) { c.setAttribute('data-ehs-skip', 'nodate'); continue; }
                    var dm = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                    if (dm >= revokeCutoff) { c.setAttribute('data-ehs-skip', 'kept'); continue; }
                }
                return c;
            }
            return null;
        }

        // ── v5.25: Modo simulação — lista o que seria revogado, sem clicar ──
        function getCardName(card) {
            var el = card.querySelector('h1,h2,h3,h4,h5') || card.querySelector('[class*="title"]') || card.querySelector('a');
            var n = el ? el.textContent : (card.textContent || '').slice(0, 60);
            return (n || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(sem nome)';
        }
        function simEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
        function renderSimPanel(rev, keep) {
            var old = document.getElementById('fclm-sim-panel'); if (old) old.remove();
            var p = document.createElement('div');
            p.id = 'fclm-sim-panel';
            p.style.cssText = 'position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:99998;width:580px;'
                + 'max-width:94vw;max-height:72vh;overflow:auto;background:#fff;border:2px solid #5DADE2;border-radius:12px;'
                + "box-shadow:0 12px 40px rgba(0,0,0,.4);font-family:'Amazon Ember',Arial,sans-serif;";
            var rows = '';
            rev.forEach(function(r) { rows += '<tr><td style="padding:6px 10px;color:#B23A1A;font-weight:bold;white-space:nowrap;">REVOGARIA</td><td style="padding:6px 10px;">' + simEsc(r.name) + '</td><td style="padding:6px 10px;color:#555;white-space:nowrap;">' + r.date + '</td></tr>'; });
            keep.forEach(function(r) { rows += '<tr><td style="padding:6px 10px;color:#1E8449;font-weight:bold;white-space:nowrap;">manteria</td><td style="padding:6px 10px;">' + simEsc(r.name) + '</td><td style="padding:6px 10px;color:#555;white-space:nowrap;">' + r.date + '</td></tr>'; });
            p.innerHTML = '<div style="background:#5DADE2;color:#fff;padding:10px 14px;font-weight:bold;font-size:14px;">'
                + '🔍 Simulação — ' + simEsc(login) + ' · revogaria ' + rev.length + ' / manteria ' + keep.length + '</div>'
                + '<table style="width:100%;border-collapse:collapse;font-size:12px;">' + (rows || '<tr><td style="padding:12px;color:#888;">Nenhum certificado encontrado.</td></tr>') + '</table>';
            document.body.appendChild(p);
        }
        function simulateRevoke() {
            var cards = document.querySelectorAll('lms-transcript-certificate-card, .transcript-certificate-card');
            var rev = [], keep = [];
            for (var i = 0; i < cards.length; i++) {
                var c = cards[i];
                var name = getCardName(c);
                var d = getCardDate(c);
                var dStr = d ? d.toLocaleDateString('pt-BR') : 'sem data';
                var willRevoke;
                if (revokeCutoff > 0) {
                    if (!d) willRevoke = false; // segurança: sem data não revoga
                    else { var dm = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); willRevoke = dm < revokeCutoff; }
                } else { willRevoke = true; }
                (willRevoke ? rev : keep).push({ name: name, date: dStr });
            }
            renderSimPanel(rev, keep);
            try { console.log('[Perm Tags][SIM] ' + login + ' — revogaria ' + rev.length + ', manteria ' + keep.length, { rev: rev, keep: keep }); } catch (e) {}
            setQueueStatus('done', { dryRun: true, revoked: rev.length, kept: keep.length, sim: { rev: rev.slice(0, 150), keep: keep.slice(0, 150) } });
            banner.style.borderBottomColor = '#5DADE2';
            banner.innerHTML = '🔍 Simulação de <b>' + login + '</b>: ' + rev.length + ' revogaria / ' + keep.length + ' manteria. Avançando...';
            setTimeout(goNextLearner, 4500);
        }

        // Revoga 1 certificado elegível (cards revogados/pulados não são reescolhidos)
        function revokeOne(cb) {
            var card = revokeCutoff > 0 ? pickEligibleCard() : null;
            var menu;
            if (revokeCutoff > 0) {
                if (!card) { cb('no_more'); return; }
                menu = card.querySelector('.vert-menu, .mat-mdc-menu-trigger.vert-menu');
            } else {
                menu = document.querySelector('.vert-menu, .mat-mdc-menu-trigger.vert-menu');
            }
            if (!menu) { cb('no_more'); return; }
            menu.click();
            waitFor(function() {
                var items = document.querySelectorAll('.cdk-overlay-container .mat-mdc-menu-item, .cdk-overlay-container button[mat-menu-item]');
                for (var i = 0; i < items.length; i++) { if (/revogar/i.test(items[i].textContent)) return items[i]; }
                return null;
            }, 6000, function(revBtn) {
                if (!revBtn) { cb('menu_revogar'); return; }
                revBtn.click();
                waitFor(function() { return document.querySelector('.modal--show'); }, 6000, function(modal) {
                    if (!modal) { cb('modal_nao_abriu'); return; }
                    waitFor(function() { return modal.querySelector('.mat-mdc-select-trigger'); }, 5000, function(trigger) {
                        if (!trigger) { cb('select_nao_encontrado'); return; }
                        trigger.click();
                        waitFor(function() {
                            var opts = document.querySelectorAll('.cdk-overlay-container mat-option, .cdk-overlay-container .mat-mdc-option');
                            for (var i = 0; i < opts.length; i++) { if (new RegExp(REVOKE_REASON, 'i').test(opts[i].textContent)) return opts[i]; }
                            return null;
                        }, 5000, function(opt) {
                            if (!opt) { cb('motivo_nao_encontrado'); return; }
                            opt.click();
                            waitFor(function() { return modal.querySelector('textarea[formcontrolname="revocationReasonComment"]'); }, 4000, function(ta) {
                                if (!ta) { cb('textarea_nao_encontrado'); return; }
                                setTextarea(ta, revokeComment);
                                waitFor(function() {
                                    var btn = modal.querySelector('.modal__footer button[type="submit"]');
                                    return (btn && !btn.disabled) ? btn : null;
                                }, 6000, function(submitBtn) {
                                    if (!submitBtn) { cb('submit_desabilitado'); return; }
                                    submitBtn.click();
                                    waitFor(function() { return document.querySelector('.modal--show') ? null : true; }, 8000, function(closed) {
                                        if (!closed) { cb('modal_nao_fechou'); return; }
                                        if (card) card.setAttribute('data-ehs-skip', 'done');
                                        revokedCount++;
                                        banner.innerHTML = '🎓 <b>' + login + '</b> — ' + revokedCount + ' revogado(s)...';
                                        cb(null);
                                    });
                                });
                            });
                        });
                    });
                });
            });
        }


        function revokeLoop(safety) {
            if (safety === undefined) safety = 60;
            if (safety <= 0) { finish(); return; }
            revokeOne(function(err) {
                if (err === 'no_more') { finish(); return; }
                if (err) {
                    var mc = document.querySelector('.modal--show .modal-close');
                    if (mc) mc.click(); // fecha modal residual e tenta o próximo card
                    setTimeout(function() { revokeLoop(safety - 1); }, 1200);
                    return;
                }
                setTimeout(function() { revokeLoop(safety - 1); }, 1500);
            });
        }


        // v5.17: 3 estados — 'cards' (revogar), 'empty' (não encontrado/desligado), 'timeout'
        function waitForRevokeState(timeout, cb) {
            var start = Date.now();
            var emptyStreak = 0;
            var iv = setInterval(function() {
                var cards = document.querySelectorAll('lms-transcript-certificate-card, .transcript-certificate-card');
                var menu  = document.querySelector('.vert-menu');
                // 1) Tem certificados → revogar
                if (cards.length > 0 || menu) { clearInterval(iv); cb('cards'); return; }
                // 2) "no results" explícito → vazio
                if (document.querySelector('.no-results')) { clearInterval(iv); cb('empty'); return; }
                // 3) Resultado renderizou, spinner sumiu, mas 0 cards → conta estabilidade
                var resultArea = document.querySelector('lms-learner-search-result');
                var spinner    = document.querySelector('.full-screen-loading, .loader');
                if (resultArea && !spinner) {
                    emptyStreak++;
                    if (emptyStreak >= 5) { clearInterval(iv); cb('empty'); return; } // ~5×700ms estável
                } else {
                    emptyStreak = 0;
                }
                // 4) Timeout absoluto → também pula (não trava)
                if (Date.now() - start > timeout) { clearInterval(iv); cb('timeout'); return; }
            }, 700);
        }


        waitForRevokeState(30000, function(state) {
            if (state === 'cards') {
                banner.innerHTML = '🎓 Carregando todos os certificados de <b>' + login + '</b>...';
                loadAll(function() {
                    if (dryRun) { simulateRevoke(); return; }
                    if (!document.querySelector('.vert-menu')) { finish(true); return; } // sem cert → vazio
                    revokeLoop();
                });
            } else {
                // empty (não encontrado/desligado) OU timeout → pula limpo
                banner.style.borderBottomColor = '#E88B00';
                banner.innerHTML = '⚠️ <b>' + login + '</b> — não encontrado ou sem certificados. Avançando...';
                finish(true); // notFound → status 'done' com flag, revoked:0 → goNextLearner()
            }
        });
    }


    // Inicia verificação (apenas páginas FCLM — Umbrella já retornou acima)
    setTimeout(injectCertButton, 500);


    // ── Config Manager ⚙️ (v5.9) ─────────────────────────────────────────
    // LEVELS, PERM_KEY, CERT_KEY já definidos no topo da IIFE (antes das early returns)


    function readCfg(key, def) {
        try { var s = GM_getValue(key, null); if (s) { var d = JSON.parse(s); if (d && Object.keys(d).length) return d; } } catch(e) {}
        if (!def || typeof def !== 'object') return {}; // def pode ser undefined em early-exit pages
        return JSON.parse(JSON.stringify(def));
    }
    function saveCfg(key, data) { GM_setValue(key, JSON.stringify(data)); }
    function isCustomCfg(key) {
        try { var s = GM_getValue(key, null); if (!s) return false; var d = JSON.parse(s); return !!(d && Object.keys(d).length); } catch(e) { return false; }
    }


    function injectGear() {
        if (document.getElementById('fclm-cfg-gear')) return;
        var btn = document.createElement('button');
        btn.id = 'fclm-cfg-gear';
        btn.innerHTML =
            '<span class="fclm-gear-icon">⚙️</span>' +
            '<span class="fclm-gear-label">Config</span>';
        var anyCustom = isCustomCfg(PERM_KEY) || isCustomCfg(CERT_KEY);
        if (anyCustom) btn.classList.add('fclm-gear-custom');
        btn.title = 'FCLM Config Manager — Permissões & Certificados' +
                    (anyCustom ? '\n⚠ Config customizada ativa!' : '');
        btn.onclick = openCfgPanel;
        document.body.appendChild(btn);
        if (!isUmbrella) injectResetBtn(); // v5.14 — apenas FCLM
    }


    // ── v5.21: Pop-up "a partir de que dia revogar?" ─────────────────────
    function promptCertRevokeDate(onConfirm) {
        if (document.getElementById('fclm-certdate-ov')) return;
        var ov = document.createElement('div');
        ov.id = 'fclm-certdate-ov';
        ov.style.cssText = 'position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;'
            + 'background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);'
            + "font-family:'Amazon Ember',Arial,sans-serif;";
        ov.innerHTML =
            '<div style="width:460px;max-width:94vw;background:#fff;border-radius:14px;overflow:hidden;'
                + 'box-shadow:0 22px 60px rgba(0,0,0,.5);">'
            + '<div style="background:linear-gradient(135deg,#B23A1A 0%,#8B2500 100%);color:#fff;padding:16px 20px;'
                + 'border-bottom:3px solid #E88B00;font-weight:bold;font-size:15px;">🎓 Revogar Certificados — Data de Onboarding</div>'
            + '<div style="padding:20px;">'
                + '<div style="font-size:13px;color:#444;line-height:1.55;margin-bottom:14px;">'
                + 'Qual é o dia do onboarding? Serão revogados <b>apenas os certificados obtidos ANTES desta data</b>. '
                + 'Os obtidos na data de onboarding ou depois são <b>mantidos</b>.</div>'
                + '<label style="display:block;font-size:12px;font-weight:bold;color:#8B2500;margin-bottom:6px;">Data inicial</label>'
                + '<input type="date" id="fclm-certdate-in" style="width:100%;box-sizing:border-box;padding:10px 12px;'
                    + 'border:1px solid #DDD;border-radius:8px;font-size:14px;outline:none;" />'
                + '<div style="font-size:11px;color:#999;margin-top:8px;">Deixe em branco para revogar <b>todos</b> os certificados.</div>'
                + '<label style="display:block;font-size:12px;font-weight:bold;color:#8B2500;margin:16px 0 6px;">Motivo da revogação (comentário)</label>'
                + '<textarea id="fclm-cert-comment" rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;'
                    + 'border:1px solid #DDD;border-radius:8px;font-size:13px;outline:none;resize:vertical;font-family:inherit;">'
                    + String(REVOKE_COMMENT).replace(/</g, '&lt;') + '</textarea>'
                + '<label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px;color:#333;cursor:pointer;">'
                    + '<input type="checkbox" id="fclm-cert-dryrun" style="width:16px;height:16px;cursor:pointer;" />'
                    + '<span>🔍 <b>Modo simulação</b> — apenas lista o que seria revogado (não revoga nada)</span></label>'
            + '</div>'
            + '<div style="padding:14px 20px;background:#F7F7F7;border-top:1px solid #E8E8E8;display:flex;justify-content:flex-end;gap:10px;">'
                + '<button id="fclm-certdate-cancel" style="background:#fff;border:1px solid #ccc;color:#555;padding:9px 16px;'
                    + 'border-radius:8px;cursor:pointer;font-weight:bold;font-size:13px;">Cancelar</button>'
                + '<button id="fclm-certdate-ok" style="background:linear-gradient(145deg,#B23A1A,#8B2500);border:none;color:#fff;'
                    + 'padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:bold;font-size:13px;">Revogar</button>'
            + '</div></div>';
        document.body.appendChild(ov);

        var close = function() { ov.remove(); };
        ov.addEventListener('click', function(e) { if (e.target === ov) close(); });
        document.getElementById('fclm-certdate-cancel').onclick = close;
        document.getElementById('fclm-certdate-ok').onclick = function() {
            var v = document.getElementById('fclm-certdate-in').value;
            var cutoff = 0;
            if (v) {
                var m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
                if (m) cutoff = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
            }
            var comment = document.getElementById('fclm-cert-comment').value.trim() || REVOKE_COMMENT;
            GM_setValue(CERT_REVOKE_COMMENT_KEY, comment);
            GM_setValue(CERT_REVOKE_DRYRUN_KEY, document.getElementById('fclm-cert-dryrun').checked ? '1' : '0');
            close();
            onConfirm(cutoff);
        };
    }


    // ── v5.14: Reset Onboarding — Retirada de Permissões ─────────────────
    function injectResetBtn() {
        if (document.getElementById('fclm-reset-btn')) return;
        var b = document.createElement('button');
        b.id = 'fclm-reset-btn';
        b.innerHTML = '<span style="font-size:22px;line-height:1;display:block;">🔄</span>'
            + '<span style="font-size:8px;font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;'
            + 'letter-spacing:0.1em;color:#FFD700;text-transform:uppercase;">Reset</span>';
        b.title = 'Reset Onboarding — Zerar permissões';
        b.onclick = openResetModal;
        document.body.appendChild(b);
    }


    function openResetModal() {
        if (document.getElementById('fclm-reset-ov')) return;
        var whId = new URLSearchParams(window.location.search).get('warehouseId') || '';
        var ov = document.createElement('div'); ov.id = 'fclm-reset-ov';
        ov.innerHTML = '<div id="fclm-reset-panel">'
            + '<div id="fclm-reset-hdr"><span style="flex:1">🔄 Reset Onboarding — Retirada de Permissões</span>'
            + '<button id="fclm-rx" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:.8">✕</button></div>'
            + '<div id="fclm-reset-body">'
            + '<div style="background:#fff;border-radius:6px;padding:14px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);">'
            + '<b style="color:#8B2500;font-size:13px;">📎 Importar Lista</b>'
            + '<div style="font-size:11px;color:#555;margin:4px 0 10px;">CSV ou XLSX com colunas <b>Login</b> e <b>EmployeeId</b> (ou <b>EmplID</b>) &nbsp;<span style="background:#FFF3CD;color:#7B4100;border:1px solid #E88B00;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:bold;">⚠ Máx. 110 por lote</span></div>'
            + '<input type="file" id="fclm-rf" accept=".csv,.xlsx" style="font-size:12px;width:100%;box-sizing:border-box;" />'
            + '<div id="fclm-rpw" style="margin-top:10px;"></div>'
            + '<div id="fclm-rpb-wrap" style="display:none;margin-top:12px;">'
            + '<div style="font-size:12px;font-weight:bold;color:#232F3E;margin-bottom:8px;">Escolha a ação a executar:</div>'
            + '<div style="display:flex;gap:8px;">'
            + '<button id="fclm-rpb-perms" class="fclm-proc-btn" style="flex:1;margin-top:0;">🚫 Remover Permissões</button>'
            + '<button id="fclm-rpb-certs" class="fclm-proc-btn" style="flex:1;margin-top:0;background:#232F3E;color:#FEBD69;">🎓 Revogar Certificados</button>'
            + '</div></div>'
            + '</div>'
            + '<div id="fclm-rprog" style="display:none;background:#fff;border-radius:6px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);">'
            + '<b style="font-size:13px;color:#232F3E;">📋 Progresso</b>'
            + '<div id="fclm-rpl" style="margin-top:8px;"></div>'
            + '</div></div></div>';
        document.body.appendChild(ov);
        var parsedItems = [], progPoll = null, stopped = false, escHandler = null;
        function closeModal() {
            ov.remove();
            if (progPoll) clearInterval(progPoll);
            if (escHandler) document.removeEventListener('keydown', escHandler);
        }
        document.getElementById('fclm-rx').onclick = closeModal;
        ov.addEventListener('click', function(e) { if (e.target === ov) closeModal(); });
        escHandler = function(e) {
            if (e.key !== 'Escape') return;
            if (!progPoll) { closeModal(); return; } // sem processamento ativo → fecha modal
            // Para o processo
            stopped = true;
            clearInterval(progPoll); progPoll = null;
            try {
                var q2 = JSON.parse(GM_getValue(REVOKE_KEY, '[]'));
                q2.forEach(function(i) { if (i.status === 'pending') i.status = 'stopped'; });
                GM_setValue(REVOKE_KEY, JSON.stringify(q2));
                updUI(q2);
            } catch(e2) {}
            // v5.18: cancela também a fila de revogação de certificados + limpa chaves
            try {
                var qc = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]'));
                qc.forEach(function(i) { if (i.status === 'pending' || i.status === 'processing') i.status = 'stopped'; });
                GM_setValue(CERT_REVOKE_KEY, JSON.stringify(qc));
                updCertUI(qc);
            } catch(e3) {}
            GM_setValue('umb_revoke_login', '');
            GM_setValue('umb_revoke_ts', '0');
            var prog = document.getElementById('fclm-rprog');
            if (prog) {
                var msg = document.createElement('div');
                msg.style.cssText = 'background:#CC0000;color:#fff;padding:10px 14px;border-radius:6px;'
                    + 'font-size:13px;font-weight:bold;margin-top:12px;text-align:center;cursor:pointer;';
                msg.innerHTML = '⛔ Processo interrompido — pressione ESC novamente para fechar';
                msg.onclick = function() { closeModal(); };
                prog.appendChild(msg);
            }
            document.removeEventListener('keydown', escHandler);
            escHandler = function(e2) { if (e2.key === 'Escape') closeModal(); };
            document.addEventListener('keydown', escHandler);
        };
        document.addEventListener('keydown', escHandler);
        document.getElementById('fclm-rf').addEventListener('change', function(e) {
            var f = e.target.files[0]; if (!f) return;
            var rd = new FileReader();
            if (f.name.toLowerCase().endsWith('.csv')) {
                rd.onload = function(ev) { parsedItems = parseResetCSV(ev.target.result); renderPrev(); };
                rd.readAsText(f, 'UTF-8');
            } else {
                rd.onload = function(ev) { parsedItems = parseResetXLSX(new Uint8Array(ev.target.result)); renderPrev(); };
                rd.readAsArrayBuffer(f);
            }
        });
        function renderPrev() {
            var MAX_BATCH = 110;
            var w  = document.getElementById('fclm-rpw');
            var bw = document.getElementById('fclm-rpb-wrap');
            var bp = document.getElementById('fclm-rpb-perms');
            var bc = document.getElementById('fclm-rpb-certs');
            if (!parsedItems.length) {
                w.innerHTML = '<div style="color:#CC0000;font-size:12px;padding:8px;">Nenhum item encontrado. Verifique as colunas Login e EmployeeId (ou EmplID).</div>';
                bw.style.display = 'none'; return;
            }
            var truncated = parsedItems.length > MAX_BATCH;
            if (truncated) parsedItems = parsedItems.slice(0, MAX_BATCH);
            var sm = parsedItems.length > 10 ? ' style="font-size:10px;padding:4px 8px;"' : '';
            var h = '<table class="fclm-reset-tbl"><thead><tr>'
                + '<th' + sm + '>#</th><th' + sm + '>Login</th><th' + sm + '>EmployeeId</th><th' + sm + '>Status</th>'
                + '</tr></thead><tbody>';
            parsedItems.forEach(function(it, i) {
                h += '<tr>'
                    + '<td' + sm + ' class="fclm-rc-idx">' + (i+1) + '</td>'
                    + '<td' + sm + ' class="fclm-rc-login">' + it.login + '</td>'
                    + '<td' + sm + ' class="fclm-rc-id">' + it.employeeId + '</td>'
                    + '<td' + sm + ' id="fclm-rst-' + i + '"><span class="fclm-st fclm-st-wait">Aguardando</span></td>'
                    + '</tr>';
            });
            h += '</tbody></table>';
            var tableHtml = parsedItems.length > 10
                ? '<div style="max-height:240px;overflow-y:auto;border:1px solid #EEE2DF;border-radius:10px;">' + h + '</div>'
                : h;
            if (truncated) {
                tableHtml += '<div style="background:#FFF3CD;border:1px solid #E88B00;border-radius:4px;padding:8px 10px;font-size:11px;color:#7B4100;margin-top:8px;">'
                   + '⚠ Lista truncada: apenas os primeiros <b>' + MAX_BATCH + '</b> associados serão processados. Divida o restante em um novo lote.</div>';
            }
            w.innerHTML = tableHtml;
            bw.style.display = 'block';
            bp.textContent = '🚫 Remover Permissões (' + parsedItems.length + ')';
            bc.textContent = '🎓 Revogar Certificados (' + parsedItems.length + ')';
        }
        document.getElementById('fclm-rpb-perms').onclick = function() {
            var q = parsedItems.map(function(it) {
                return { login: it.login, employeeId: it.employeeId, warehouseId: whId, status: 'pending', permsDone: false, error: null };
            });
            GM_setValue(REVOKE_KEY, JSON.stringify(q));
            startQ(q);
        };
        document.getElementById('fclm-rpb-certs').onclick = function() {
            promptCertRevokeDate(function(cutoff) {
                GM_setValue(CERT_REVOKE_CUTOFF_KEY, String(cutoff || 0));
                var q = parsedItems.map(function(it) {
                    return { login: it.login, employeeId: it.employeeId, status: 'pending', revoked: 0, error: null };
                });
                GM_setValue(CERT_REVOKE_KEY, JSON.stringify(q));
                startCertQ(q);
            });
        };
        // ── v5.20: botão cruzado — ao concluir uma ação, oferece a outra na mesma lista ──
        function injectCrossButton(nextAction) {
            var prog = document.getElementById('fclm-rprog');
            if (!prog) return;
            var old = document.getElementById('fclm-cross-wrap'); if (old) old.remove();
            var wrap = document.createElement('div');
            wrap.id = 'fclm-cross-wrap';
            wrap.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px dashed #CCC;';
            var msg = document.createElement('div');
            msg.style.cssText = 'font-size:12px;color:#27AE60;font-weight:bold;margin-bottom:8px;text-align:center;';
            msg.textContent = '✅ Concluído! Deseja executar a outra ação na mesma lista?';
            wrap.appendChild(msg);
            var btn = document.createElement('button');
            btn.className = 'fclm-proc-btn'; btn.style.marginTop = '0';
            if (nextAction === 'certs') {
                btn.style.background = '#232F3E'; btn.style.color = '#FEBD69';
                btn.textContent = '🎓 Revogar Certificados (' + parsedItems.length + ')';
                btn.onclick = function() {
                    promptCertRevokeDate(function(cutoff) {
                        GM_setValue(CERT_REVOKE_CUTOFF_KEY, String(cutoff || 0));
                        var q = parsedItems.map(function(it){ return { login: it.login, employeeId: it.employeeId, status:'pending', revoked:0, error:null }; });
                        GM_setValue(CERT_REVOKE_KEY, JSON.stringify(q));
                        startCertQ(q);
                    });
                };
            } else {
                btn.textContent = '🚫 Remover Permissões (' + parsedItems.length + ')';
                btn.onclick = function() {
                    var q = parsedItems.map(function(it){ return { login: it.login, employeeId: it.employeeId, warehouseId: whId, status:'pending', permsDone:false, error:null }; });
                    GM_setValue(REVOKE_KEY, JSON.stringify(q));
                    startQ(q);
                };
            }
            wrap.appendChild(btn);
            prog.appendChild(wrap);
        }
        // ── v5.15: Fila de revogação de certificados (cross-tab Umbrella) ──
        function startCertQ(q) {
            document.getElementById('fclm-rpb-wrap').style.display = 'none';
            var prog = document.getElementById('fclm-rprog');
            prog.style.display = 'block';
            prog.innerHTML = '<b style="font-size:13px;color:#232F3E;">🎓 Revogando Certificados</b>'
                + '<div id="fclm-rpl" style="margin-top:8px;"></div>';
            updCertUI(q); nextCertQ(q);
            var wdSig = '', wdStuck = 0;   // v5.27: watchdog que PULA item travado
            progPoll = setInterval(function() {
                try { q = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]')); } catch(e) {}
                updCertUI(q);
                var proc = q.some(function(i) { return i.status === 'processing'; });
                var pend = q.some(function(i) { return i.status === 'pending'; });
                if (!proc && !pend) { clearInterval(progPoll); progPoll = null; injectCrossButton('perms'); return; }
                // Watchdog v5.27: se NENHUM status muda há ~60s (20×3s), a aba travou (redirect SSO/Umbrella sem login).
                // → marca a pessoa travada como erro e promove a próxima pendente. A fila nunca para.
                var sig = JSON.stringify(q.map(function(i) { return i.status; }));
                if (sig !== wdSig) { wdSig = sig; wdStuck = 0; }
                else if (++wdStuck >= 20) {
                    wdStuck = 0;
                    var arr; try { arr = JSON.parse(GM_getValue(CERT_REVOKE_KEY, '[]')); } catch(e) { arr = q; }
                    var st = null, nx = null, k;
                    for (k = 0; k < arr.length; k++) { if (arr[k].status === 'processing') { st = arr[k]; break; } }
                    if (st) { st.status = 'error'; if (!st.error) st.error = 'travou (pulado)'; }
                    for (k = 0; k < arr.length; k++) { if (arr[k].status === 'pending') { nx = arr[k]; break; } }
                    if (nx) {
                        nx.status = 'processing';
                        GM_setValue('umb_revoke_login', nx.login);
                        GM_setValue('umb_revoke_ts', String(Date.now()));
                    }
                    GM_setValue(CERT_REVOKE_KEY, JSON.stringify(arr));
                    if (nx) GM_openInTab(buildUmbrellaRevokeUrl(nx.login), { active: true });
                }
            }, 3000);
        }
        function nextCertQ(q) {
            for (var i = 0; i < q.length; i++) {
                if (q[i].status === 'pending') {
                    q[i].status = 'processing';
                    GM_setValue(CERT_REVOKE_KEY, JSON.stringify(q));
                    GM_setValue('umb_revoke_login', q[i].login);
                    GM_setValue('umb_revoke_ts', String(Date.now())); // v5.16: backup p/ refresher
                    GM_openInTab(buildUmbrellaRevokeUrl(q[i].login), { active: true });
                    return;
                }
            }
        }
        function updCertUI(q) {
            var el = document.getElementById('fclm-rpl'); if (!el) return;
            var escc = function(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
            el.innerHTML = q.map(function(it) {
                var ic, ms, details = '';
                if (it.dryRun && it.status === 'done') {
                    ic = '🔍';
                    ms = 'Simulação: <b>' + (it.revoked || 0) + '</b> revogaria / ' + (it.kept || 0) + ' manteria';
                    if (it.sim) {
                        var lines = '';
                        (it.sim.rev || []).forEach(function(r) { lines += '<div style="color:#B23A1A;">• REVOGARIA — ' + escc(r.name) + ' <span style="color:#999;">(' + r.date + ')</span></div>'; });
                        (it.sim.keep || []).forEach(function(r) { lines += '<div style="color:#1E8449;">• manteria — ' + escc(r.name) + ' <span style="color:#999;">(' + r.date + ')</span></div>'; });
                        if (lines) details = '<div style="margin:4px 0 6px 18px;font-size:11px;max-height:150px;overflow:auto;border-left:2px solid #DDD;padding-left:8px;">' + lines + '</div>';
                    }
                } else {
                    ic = it.status === 'pending' ? '🟡' : it.status === 'processing' ? '⏳' : it.status === 'done' ? (it.notFound ? '⚠️' : '✅') : it.status === 'stopped' ? '⛔' : '❌';
                    ms = it.status === 'done' ? (it.notFound ? 'Não encontrado / sem certificados' : (it.revoked || 0) + ' cert(s) revogado(s) ✓') : it.status === 'processing' ? 'Revogando...' : it.status === 'stopped' ? 'Interrompido' : it.status === 'error' ? '❌ ' + (it.error || 'erro') : 'Aguardando';
                }
                return '<div style="padding:5px 0;border-bottom:1px solid #EEE;font-size:12px;">' + ic + ' <b>' + it.login + '</b> (' + it.employeeId + ') — ' + ms + '</div>' + details;
            }).join('');
            q.forEach(function(it, idx) {
                var cell = document.getElementById('fclm-rst-' + idx);
                if (!cell) return;
                if      (it.dryRun && it.status === 'done') cell.innerHTML = '<span class="fclm-st fclm-st-run">🔍 ' + (it.revoked || 0) + ' revogaria</span>';
                else if (it.status === 'done')       cell.innerHTML = it.notFound ? '<span class="fclm-st fclm-st-warn">Não encontrado</span>' : '<span class="fclm-st fclm-st-ok">' + (it.revoked || 0) + ' revogado(s)</span>';
                else if (it.status === 'stopped')    cell.innerHTML = '<span class="fclm-st fclm-st-stop">Interrompido</span>';
                else if (it.status === 'error')      cell.innerHTML = '<span class="fclm-st fclm-st-err">Erro: ' + (it.error || '') + '</span>';
                else if (it.status === 'processing') cell.innerHTML = '<span class="fclm-st fclm-st-run">Revogando…</span>';
                else                                 cell.innerHTML = '<span class="fclm-st fclm-st-wait">Aguardando</span>';
            });
        }
        function startQ(q) {
            document.getElementById('fclm-rpb-wrap').style.display = 'none';
            var prog = document.getElementById('fclm-rprog');
            prog.style.display = 'block';
            // Recria #fclm-rpl — pode ter sido destruído pelo painel "Revogar Certificados" (fix v5.14.5)
            prog.innerHTML = '<b style="font-size:13px;color:#232F3E;">📋 Progresso</b>'
                + '<div id="fclm-rpl" style="margin-top:8px;"></div>';
            updUI(q); nextQ(q);
            var wdSig = '', wdStuck = 0;   // v5.27: watchdog que PULA item travado
            progPoll = setInterval(function() {
                try { q = JSON.parse(GM_getValue(REVOKE_KEY, '[]')); } catch(e) {}
                updUI(q);
                var proc = q.some(function(i) { return i.status === 'processing' || i.status === 'saving' || i.status === 'perms_done'; });
                var pend = q.some(function(i) { return i.status === 'pending'; });
                if (!proc && !pend) { clearInterval(progPoll); progPoll = null; injectCrossButton('certs'); return; }
                // Watchdog: se NENHUM status muda há ~60s, a aba travou (ex: redirect de auth sem employeeId).
                // → marca a pessoa travada como erro e promove a próxima pendente (abre nova aba). A fila nunca para.
                var sig = JSON.stringify(q.map(function(i) { return i.status; }));
                if (sig !== wdSig) { wdSig = sig; wdStuck = 0; }
                else if (++wdStuck >= 20) {
                    wdStuck = 0;
                    var arr; try { arr = JSON.parse(GM_getValue(REVOKE_KEY, '[]')); } catch(e) { arr = q; }
                    var st = null, nx = null, k;
                    for (k = 0; k < arr.length; k++) { if (arr[k].status === 'processing' || arr[k].status === 'saving') { st = arr[k]; break; } }
                    if (st) { st.status = 'error'; if (!st.error) st.error = 'travou (pulado)'; }
                    for (k = 0; k < arr.length; k++) { if (arr[k].status === 'pending') { nx = arr[k]; break; } }
                    if (nx) nx.status = 'processing';
                    GM_setValue(REVOKE_KEY, JSON.stringify(arr));
                    if (nx) GM_openInTab('https://fclm-portal.amazon.com/employee/permissions?employeeId=' + nx.employeeId + '&warehouseId=' + nx.warehouseId, { active: true });
                }
            }, 3000);
        }
        function nextQ(q) {
            for (var i = 0; i < q.length; i++) {
                if (q[i].status === 'pending') {
                    q[i].status = 'processing';
                    GM_setValue(REVOKE_KEY, JSON.stringify(q));
                    GM_openInTab('https://fclm-portal.amazon.com/employee/permissions?employeeId=' + q[i].employeeId + '&warehouseId=' + q[i].warehouseId, { active: true });
                    return;
                }
            }
        }
        function updUI(q) {
            var el = document.getElementById('fclm-rpl'); if (!el) return;
            el.innerHTML = q.map(function(it) {
                var ic = it.status === 'pending' ? '🟡' : it.status === 'processing' ? '⏳' : it.status === 'saving' ? '💾' : (it.status === 'perms_done' || it.status === 'done') ? '✅' : it.status === 'stopped' ? '⛔' : '❌';
                var ms = (it.status === 'perms_done' || it.status === 'done') ? 'Permissões zeradas ✓' : it.status === 'processing' ? 'Processando...' : it.status === 'saving' ? 'Salvando...' : it.status === 'stopped' ? 'Interrompido' : it.status === 'error' ? '❌ ' + (it.error || 'erro') : 'Aguardando';
                return '<div style="padding:5px 0;border-bottom:1px solid #EEE;font-size:12px;">' + ic + ' <b>' + it.login + '</b> (' + it.employeeId + ') — ' + ms + '</div>';
            }).join('');
            // Atualiza células de status na tabela preview (🟢 concluído / 🔴 erro)
            q.forEach(function(it, idx) {
                var cell = document.getElementById('fclm-rst-' + idx);
                if (!cell) return;
                if      (it.status === 'perms_done' || it.status === 'done') cell.innerHTML = '<span class="fclm-st fclm-st-ok">Concluído</span>';
                else if (it.status === 'stopped')    cell.innerHTML = '<span class="fclm-st fclm-st-stop">Interrompido</span>';
                else if (it.status === 'error')      cell.innerHTML = '<span class="fclm-st fclm-st-err">Erro: ' + (it.error || '') + '</span>';
                else if (it.status === 'saving')     cell.innerHTML = '<span class="fclm-st fclm-st-run">Salvando…</span>';
                else if (it.status === 'processing') cell.innerHTML = '<span class="fclm-st fclm-st-run">Processando…</span>';
                else                                 cell.innerHTML = '<span class="fclm-st fclm-st-wait">Aguardando</span>';
            });
        }
    }


    function parseResetCSV(text) {
        var lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
        if (lines.length < 2) return [];
        var hdrs = lines[0].split(',').map(function(h) { return h.trim().toLowerCase().replace(/[^a-z]/g, ''); });
        var li = -1, ei = -1;
        hdrs.forEach(function(h, i) {
            if (h.includes('login') && li < 0) li = i;
            if ((h.includes('empl') || h === 'id') && ei < 0) ei = i;   // EmployeeId / EmplID / Id
        });
        if (li < 0) li = 0; if (ei < 0 || ei === li) ei = li === 0 ? 1 : 0;
        return lines.slice(1).map(function(l) {
            var c = l.split(',');
            return { login: (c[li] || '').trim().toLowerCase(), employeeId: (c[ei] || '').trim() };
        }).filter(function(r) { return r.login && r.employeeId; });
    }


    function parseResetXLSX(buf) {
        try {
            var wb = XLSX.read(buf, { type: 'array' });
            var ws = wb.Sheets[wb.SheetNames[0]];
            var data = XLSX.utils.sheet_to_json(ws, { header: 1 });
            if (data.length < 2) return [];
            var hdrs = data[0].map(function(h) { return String(h).trim().toLowerCase().replace(/[^a-z]/g, ''); });
            var li = -1, ei = -1;
            hdrs.forEach(function(h, i) {
                if (h.includes('login') && li < 0) li = i;
                if ((h.includes('empl') || h === 'id') && ei < 0) ei = i;   // EmployeeId / EmplID / Id
            });
            if (li < 0) li = 0; if (ei < 0 || ei === li) ei = li === 0 ? 1 : 0;
            return data.slice(1).map(function(r) {
                return { login: String(r[li] || '').trim().toLowerCase(), employeeId: String(r[ei] || '').trim() };
            }).filter(function(r) { return r.login && r.employeeId; });
        } catch(e) { return []; }
    }


    // v5.29: fecha a aba atual de forma confiável. window.close() sozinho é bloqueado em abas
    // abertas por GM_openInTab; "adotar" a janela com window.open('', '_self') libera o close().
    function closeTab() {
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
        setTimeout(function () {
            try { window.open('', '_self'); window.close(); } catch (e) {}
            try { window.location.href = 'about:blank'; } catch (e) {}
        }, 300);
    }


    function runOnPermissionsRevoke() {
        var empId = new URLSearchParams(window.location.search).get('employeeId');
        if (!empId) return;
        var queue; try { queue = JSON.parse(GM_getValue(REVOKE_KEY, '[]')); } catch(e) { return; }
        var item = null;
        for (var i = 0; i < queue.length; i++) {
            var s = queue[i].status;
            if (String(queue[i].employeeId) === String(empId) && (s === 'processing' || s === 'saving')) { item = queue[i]; break; }
        }
        if (!item) return;
        // goNext: navega para próximo pendente na MESMA aba, ou fecha se não houver (v5.14.2)
        function goNext() {
            var next = null;
            for (var j = 0; j < queue.length; j++) {
                if (queue[j].status === 'pending') { next = queue[j]; break; }
            }
            if (next) {
                next.status = 'processing';
                GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                window.location.href = 'https://fclm-portal.amazon.com/employee/permissions?employeeId=' + next.employeeId + '&warehouseId=' + next.warehouseId;
            } else {
                // Todos concluídos — banner verde + tenta fechar (fallback clicável se bloqueado)
                var fin = document.createElement('div');
                fin.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
                    + 'background:#27AE60;color:#fff;padding:16px 20px;'
                    + 'font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;font-size:15px;'
                    + 'text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.4);cursor:pointer;';
                fin.innerHTML = '✅ Todos os ' + queue.length + ' associado(s) processados! Clique aqui para fechar esta aba.';
                fin.onclick = function() { closeTab(); };
                document.body.appendChild(fin);
                // v5.30: sem auto-close — a tarja fica fixa até o usuário clicar (confirma finalização)
            }
        }
        // Fix loop infinito v5.14.1: se página recarregou após Save, status já é 'saving'
        // → marca perms_done e navega para próximo — sem re-executar o processo
        if (item.status === 'saving') {
            item.status = 'perms_done'; item.permsDone = true;
            GM_setValue(REVOKE_KEY, JSON.stringify(queue));
            setTimeout(function() {
                item.status = 'done';
                GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                goNext();
            }, 400);   // v5.28: reduzido de 1000ms — verificação pós-reload mais rápida
            return;
        }
        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#232F3E;color:#fff;'
            + 'padding:12px 20px;font-family:\'Amazon Ember\',Arial,sans-serif;font-weight:bold;font-size:14px;'
            + 'text-align:center;border-bottom:4px solid #E88B00;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        banner.innerHTML = '🔄 Reset Onboarding — Zerando permissões de <b>' + item.login + '</b>...';
        document.body.appendChild(banner);
        var attempts = 0;
        var poll = setInterval(function() {
            attempts++;
            if (attempts > 30) {
                clearInterval(poll); item.status = 'error'; item.error = 'timeout';
                GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                banner.style.borderBottomColor = '#CC0000';
                banner.innerHTML = '❌ Timeout — formulário não encontrado para <b>' + item.login + '</b>. Avançando...';
                setTimeout(function() { goNext(); }, 1500);   // v5.26: não trava a fila
                return;
            }
            // Detecta "Invalid Employee ID" — associado desligado ou inexistente (v5.14.3)
            if (/Invalid Employee ID|Could not match by ID/i.test(document.body.textContent || '')) {
                clearInterval(poll);
                item.status = 'error'; item.error = 'Desligado/não encontrado';
                GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                banner.style.borderBottomColor = '#E88B00';
                banner.innerHTML = '⚠️ <b>' + item.login + '</b> — Não encontrado ou desligado. Avançando...';
                setTimeout(function() { goNext(); }, 2000);
                return;
            }
            // Seletores confirmados pelos screenshots da página edit permission
            var radios  = document.querySelectorAll('tr.perm-row input[type="radio"][value="NONE"]');
            var saveBtn = document.querySelector('a.submit-changes');
            if (!radios.length || !saveBtn) return;
            clearInterval(poll);
            // Marca 'saving' ANTES de clicar qualquer coisa — previne loop se página recarregar
            item.status = 'saving';
            GM_setValue(REVOKE_KEY, JSON.stringify(queue));
            var clicked = 0;
            radios.forEach(function(r) { if (!r.checked) { r.click(); clicked++; } });
            banner.innerHTML = '🔄 <b>' + clicked + '</b> permissões zeradas para <b>' + item.login + '</b>. Salvando...';
            setTimeout(function() {
                var btn = document.querySelector('a.submit-changes');
                if (!btn) {
                    item.status = 'error'; item.error = 'save_not_found';
                    GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                    banner.style.borderBottomColor = '#CC0000';
                    banner.innerHTML = '❌ Botão Save não encontrado para <b>' + item.login + '</b>. Avançando...';
                    setTimeout(function() { goNext(); }, 1500);   // v5.26: não trava a fila
                    return;
                }
                btn.click();
                banner.innerHTML = '⏳ Salvando permissões de <b>' + item.login + '</b>...';
                setTimeout(function() {
                    item.status = 'perms_done'; item.permsDone = true;
                    GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                    banner.style.borderBottomColor = '#27AE60';
                    var hasNext = queue.some(function(qq) { return qq.status === 'pending'; });
                    banner.innerHTML = '✅ Permissões de <b>' + item.login + '</b> zeradas! ' + (hasNext ? '⏩ Carregando próximo...' : 'Fechando...');
                    setTimeout(function() {
                        item.status = 'done';
                        GM_setValue(REVOKE_KEY, JSON.stringify(queue));
                        goNext();
                    }, 2000);
                }, 4000);
            }, 1000);
        }, 500);
    }


    // _TAB_BASE/ON/OFF: definidos antes das early returns (v5.9.2) — duplicação removida (v5.10)


    var isDirty    = false; // v5.10: rastreia alterações não salvas para aviso ao trocar de aba
    var cfgOverlay = null;
    function openCfgPanel() {
        if (document.getElementById('fclm-cfg-overlay')) return;
        isDirty = false; // reset ao abrir painel
        var anyCustom = isCustomCfg(PERM_KEY) || isCustomCfg(CERT_KEY);
        var badge = anyCustom
            ? '<span class="fclm-badge-custom">✎ Config Customizada</span>'
            : '<span class="fclm-badge-default">⬤ Usando Padrões</span>';


        cfgOverlay = document.createElement('div'); cfgOverlay.id = 'fclm-cfg-overlay';
        cfgOverlay.innerHTML =
            '<div id="fclm-cfg-panel">' +
            '<div id="fclm-cfg-hdr"><span id="fclm-cfg-hdr-title">⚙️ FCLM Config Manager</span>' + badge +
            '<button id="fclm-cfg-close" title="Fechar (Esc)" style="background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;opacity:0.7;margin-left:8px;">✕</button></div>' +
            '<div style="display:flex;background:#1A252F;border-bottom:3px solid #FF9900;flex-shrink:0;">' +
            '<button id="fclm-tab-perms" style="' + _TAB_ON  + '">🔐&nbsp; Permissões</button>' +
            '<button id="fclm-tab-certs" style="' + _TAB_OFF + '">🎓&nbsp; Certificados</button>' +
            '</div>' +
            '<div id="fclm-cfg-body" style="flex:1;overflow-y:auto;padding:14px;background:#F7F7F7;"><div id="fclm-cfg-content"></div></div>' +
            '<div id="fclm-cfg-footer" style="padding:10px 14px;background:#fff;border-top:1px solid #E8E8E8;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;">' +
            '<button id="fclm-cfg-reset" style="background:#fff;color:#555;border:1px solid #ccc;border-radius:5px;padding:6px 14px;font-size:12px;cursor:pointer;">↺ Restaurar Padrões</button>' +
            '<button id="fclm-cfg-save" style="background:#232F3E;color:#fff;border:none;border-radius:5px;padding:6px 16px;font-size:12px;font-weight:bold;cursor:pointer;">💾 Salvar Mudanças</button>' +
            '</div></div>';
        document.body.appendChild(cfgOverlay);


        document.getElementById('fclm-cfg-close').onclick = closeCfgPanel;
        cfgOverlay.addEventListener('click', function(e) { if (e.target === cfgOverlay) closeCfgPanel(); });
        document.addEventListener('keydown', cfgOnEsc);


        // ── Tab switching via getElementById + onclick + inline styles ────
        // Não usa classList nem querySelectorAll para evitar conflito com CSS da página
        function activateTab(which) {
            if (isDirty) {
                if (!confirm('Há alterações não salvas.\nTrocar de aba irá descartar as mudanças. Continuar?')) return;
                isDirty = false;
            }
            var tp = document.getElementById('fclm-tab-perms');
            var tc = document.getElementById('fclm-tab-certs');
            if (!tp || !tc) return;
            tp.style.cssText = (which === 'perms') ? _TAB_ON  : _TAB_OFF;
            tc.style.cssText = (which === 'certs') ? _TAB_ON  : _TAB_OFF;
            document.getElementById('fclm-cfg-content').innerHTML = '';
            if (which === 'perms') renderPermEditor();
            else                   renderCertEditor();
        }


        document.getElementById('fclm-tab-perms').onclick = function() { activateTab('perms'); };
        document.getElementById('fclm-tab-certs').onclick = function() { activateTab('certs'); };


        // Abre na aba Permissões
        activateTab('perms');
    }
    function closeCfgPanel() {
        if (cfgOverlay) { cfgOverlay.remove(); cfgOverlay = null; }
        document.removeEventListener('keydown', cfgOnEsc);
    }
    function cfgOnEsc(e) { if (e.key === 'Escape') closeCfgPanel(); }
    function cfgToast(msg, ok) {
        var t = document.getElementById('fclm-cfg-toast'); if (t) t.remove();
        t = document.createElement('div'); t.id = 'fclm-cfg-toast';
        t.style.borderLeftColor = ok === false ? '#CC0000' : '#27AE60';
        t.textContent = msg; document.body.appendChild(t);
        setTimeout(function() { t.style.opacity = '0'; }, 2800);
        setTimeout(function() { if (t.parentNode) t.remove(); }, 3300);
    }


    function renderPermEditor() {
        var content = document.getElementById('fclm-cfg-content');
        var data = mergeWithDefaults(PERM_DEFAULTS, PERM_KEY);
        var rows = Object.keys(data).map(function(p) {
            var pn = Object.keys(data[p])[0]; return { proc: p, perm: pn, level: data[p][pn] };
        });
        function rebuild() {
            content.innerHTML = '';
            var tbl = document.createElement('table'); tbl.id = 'fclm-perm-table';
            tbl.innerHTML = '<thead><tr><th>Processo (Badge)</th><th>Permissão FCLM</th><th>Nível Mínimo</th><th></th></tr></thead>';
            var tbody = document.createElement('tbody');
            rows.forEach(function(r, idx) {
                var tr = document.createElement('tr');
                [['fclm-in', r.proc, function(v) { r.proc = v; }],
                 ['fclm-in', r.perm, function(v) { r.perm = v; }]
                ].forEach(function(def) {
                    var td = document.createElement('td'); var inp = document.createElement('input');
                    inp.className = def[0]; inp.type = 'text'; inp.value = def[1];
                    var cb = def[2]; inp.oninput = function() { cb(this.value); isDirty = true; };
                    td.appendChild(inp); tr.appendChild(td);
                });
                var tdL = document.createElement('td'); var sel = document.createElement('select'); sel.className = 'fclm-sel';
                LEVELS.forEach(function(lv) {
                    var opt = document.createElement('option'); opt.value = lv; opt.textContent = lv;
                    if (lv === r.level) opt.selected = true; sel.appendChild(opt);
                });
                sel.onchange = function() { r.level = this.value; isDirty = true; }; tdL.appendChild(sel); tr.appendChild(tdL);
                var tdD = document.createElement('td'); var del = document.createElement('button');
                del.className = 'fclm-del'; del.innerHTML = '🗑';
                del.onclick = (function(i) { return function() { rows.splice(i, 1); isDirty = true; rebuild(); }; })(idx);
                tdD.appendChild(del); tr.appendChild(tdD); tbody.appendChild(tr);
            });
            tbl.appendChild(tbody); content.appendChild(tbl);
            var addBtn = document.createElement('button'); addBtn.className = 'fclm-add-row-btn';
            addBtn.innerHTML = '＋ Adicionar Processo';
            addBtn.onclick = function() { rows.push({ proc: '', perm: '', level: 'BEGINNER' }); isDirty = true; rebuild(); };
            content.appendChild(addBtn);
        }
        document.getElementById('fclm-cfg-save').onclick = function() {
            var nd = {};
            rows.forEach(function(r) { var p = r.proc.trim(), k = r.perm.trim(); if (p && k) { nd[p] = {}; nd[p][k] = r.level; } });
            if (!Object.keys(nd).length) {
                cfgToast('⚠ Sem processos para salvar. Use "↺ Restaurar Padrões" para voltar aos defaults.', false);
                return;
            }
            saveCfg(PERM_KEY, nd);
            isDirty = false;
            // Sync: novos processos ganham entrada vazia no CERT_MAP automaticamente
            var cd = readCfg(CERT_KEY, CERT_MAP || {}); var chg = false;
            Object.keys(nd).forEach(function(p) { if (!(p in cd)) { cd[p] = []; chg = true; } });
            if (chg) saveCfg(CERT_KEY, cd);
            cfgToast('✅ Permissões salvas! Recarregue o timeDetails para aplicar.');
        };
        document.getElementById('fclm-cfg-reset').onclick = function() {
            if (!confirm('Restaurar TODAS as permissões para os valores padrão?\nAs customizações serão perdidas.')) return;
            GM_setValue(PERM_KEY, '{}'); cfgToast('↺ Permissões resetadas. Recarregue o timeDetails.'); closeCfgPanel();
        };
        rebuild();
    }


    function renderCertEditor() {
        var content = document.getElementById('fclm-cfg-content');
        // Carrega processos de permissionsData (fonte da verdade) + qualquer extra em certData
        var permData = mergeWithDefaults(PERM_DEFAULTS, PERM_KEY);
        // certData é mutável em memória — salvo só ao clicar "Salvar Mudanças"
        var certData = mergeWithDefaults(CERT_DEFAULTS, CERT_KEY);
        var expandedProc = null; // proc com editor de UUID aberto


        function rebuild() {
            content.innerHTML = '';


            // Lista de processos: todos de permData + extras em certData não mapeados
            var procList = Object.keys(permData);
            Object.keys(certData).forEach(function(p) {
                if (procList.indexOf(p) === -1) procList.push(p);
            });


            if (!procList.length) {
                content.innerHTML = '<div style="padding:24px;text-align:center;color:#607D8B;font-size:13px;">'
                    + '⚠ Nenhum processo encontrado.<br />'
                    + '<small>Adicione permissões na aba 🔐 Permissões primeiro.</small></div>';
                return;
            }


            var tbl = document.createElement('table');
            tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;background:#fff;'
                + 'border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1);';


            var thead = document.createElement('thead');
            thead.innerHTML = '<tr>'
                + '<th style="background:#232F3E;color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;width:38%;">Processo</th>'
                + '<th style="background:#232F3E;color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;">Certificados</th>'
                + '<th style="background:#232F3E;color:#fff;padding:9px 12px;text-align:center;width:90px;"></th>'
                + '</tr>';
            tbl.appendChild(thead);


            var tbody = document.createElement('tbody');


            procList.forEach(function(proc) {
                var uuids      = certData[proc] ? certData[proc].slice() : [];
                var isExpanded = (expandedProc === proc);


                // ── Linha principal ────────────────────────────────────────
                var tr = document.createElement('tr');
                tr.style.cssText = 'border-bottom:1px solid #EBEBEB;' + (isExpanded ? 'background:#FFF8E7;' : '');
                if (!isExpanded) {
                    tr.onmouseover = function() { this.style.background = '#FAFAFA'; };
                    tr.onmouseout  = function() { this.style.background = ''; };
                }


                // Coluna: nome do processo
                var tdN = document.createElement('td');
                tdN.style.cssText = 'padding:9px 12px;font-weight:600;color:#232F3E;';
                tdN.textContent = proc;
                tr.appendChild(tdN);


                // Coluna: contagem de UUIDs
                var tdC = document.createElement('td');
                tdC.style.cssText = 'padding:9px 12px;font-size:11px;';
                tdC.innerHTML = uuids.length
                    ? '<span style="color:#27AE60;font-weight:bold;">✔ ' + uuids.length + ' UUID(s)</span>'
                    : '<span style="color:#E88B00;">⚠ Sem certificados</span>';
                tr.appendChild(tdC);


                // Coluna: botão Editar / Fechar
                var tdA = document.createElement('td');
                tdA.style.cssText = 'padding:7px 12px;text-align:center;';
                var editBtn = document.createElement('button');
                editBtn.textContent  = isExpanded ? '▲ Fechar' : '✏️ Editar';
                editBtn.style.cssText = 'background:' + (isExpanded ? '#E88B00' : '#4A86C8')
                    + ';color:#fff;border:none;border-radius:4px;padding:4px 10px;'
                    + 'font-size:11px;cursor:pointer;font-weight:bold;white-space:nowrap;transition:background .15s;';
                editBtn.onclick = (function(p) {
                    return function() { expandedProc = (expandedProc === p) ? null : p; rebuild(); };
                })(proc);
                tdA.appendChild(editBtn);
                tr.appendChild(tdA);
                tbody.appendChild(tr);


                // ── Linha expandida: editor de UUIDs ──────────────────────
                if (isExpanded) {
                    var expTr = document.createElement('tr');
                    expTr.style.cssText = 'background:#FFFBF0;border-bottom:2px solid #FF9900;';
                    var expTd = document.createElement('td');
                    expTd.colSpan = 3;
                    expTd.style.cssText = 'padding:12px 16px;';


                    // Chips dos UUIDs existentes
                    var chipsDiv = document.createElement('div');
                    chipsDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;min-height:28px;align-items:center;';


                    if (uuids.length) {
                        uuids.forEach(function(uuid, ui) {
                            var chip = document.createElement('span');
                            chip.style.cssText = 'background:#2C3E50;color:#fff;border-radius:4px;padding:3px 8px;'
                                + 'font-size:10px;font-family:monospace;display:inline-flex;align-items:center;gap:5px;';
                            chip.appendChild(document.createTextNode(uuid));
                            var x = document.createElement('button');
                            x.style.cssText = 'background:transparent;border:none;color:#FEBD69;cursor:pointer;'
                                + 'font-size:16px;padding:0;line-height:1;font-weight:bold;';
                            x.innerHTML = '×'; x.title = 'Remover UUID';
                            x.onclick = (function(p, idx) {
                                return function() {
                                    if (!certData[p]) certData[p] = [];
                                    certData[p].splice(idx, 1);
                                    isDirty = true;
                                    rebuild();
                                };
                            })(proc, ui);
                            chip.appendChild(x);
                            chipsDiv.appendChild(chip);
                        });
                    } else {
                        var empty = document.createElement('span');
                        empty.style.cssText = 'color:#999;font-size:11px;font-style:italic;';
                        empty.textContent = 'Nenhum UUID cadastrado — adicione abaixo';
                        chipsDiv.appendChild(empty);
                    }
                    expTd.appendChild(chipsDiv);


                    // Input + botão adicionar UUID
                    var addRow = document.createElement('div');
                    addRow.style.cssText = 'display:flex;gap:8px;align-items:center;';


                    var uIn = document.createElement('input');
                    uIn.type = 'text';
                    uIn.placeholder = 'Cole o UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
                    uIn.style.cssText = 'flex:1;font-family:monospace;font-size:11px;border:1.5px solid #CCC;'
                        + 'border-radius:4px;padding:6px 10px;box-sizing:border-box;outline:none;';
                    uIn.onfocus = function() { this.style.borderColor = '#FF9900'; };
                    uIn.onblur  = function() { this.style.borderColor = '#CCC'; };


                    var addBtn = document.createElement('button');
                    addBtn.textContent = '＋ Adicionar UUID';
                    addBtn.style.cssText = 'background:#232F3E;color:#fff;border:none;border-radius:4px;'
                        + 'padding:6px 14px;font-size:11px;cursor:pointer;font-weight:bold;white-space:nowrap;';
                    addBtn.onmouseover = function() { this.style.background = '#37475A'; };
                    addBtn.onmouseout  = function() { this.style.background = '#232F3E'; };


                    var cp = proc; // captura correta do proc no closure
                    addBtn.onclick = function() {
                        var v = uIn.value.trim().toLowerCase();
                        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) {
                            uIn.style.borderColor = '#CC0000';
                            cfgToast('❌ UUID inválido! Esperado: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', false);
                            return;
                        }
                        certData[cp] = certData[cp] || [];
                        if (certData[cp].indexOf(v) !== -1) { cfgToast('⚠ UUID já cadastrado!', false); return; }
                        certData[cp].push(v);
                        isDirty = true;
                        uIn.value = '';
                        rebuild();
                    };
                    uIn.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });


                    addRow.appendChild(uIn);
                    addRow.appendChild(addBtn);
                    expTd.appendChild(addRow);
                    expTr.appendChild(expTd);
                    tbody.appendChild(expTr);
                }
            });


            tbl.appendChild(tbody);
            content.appendChild(tbl);
        }


        document.getElementById('fclm-cfg-save').onclick = function() {
            var nd = {};
            // Salva todos os processos em certData, incluindo arrays [] (preserva limpeza intencional — v5.10)
            Object.keys(certData).forEach(function(p) { nd[p] = certData[p] || []; });
            saveCfg(CERT_KEY, nd);
            isDirty = false;
            cfgToast('✅ Certificados salvos! Recarregue o timeDetails para aplicar.');
        };
        document.getElementById('fclm-cfg-reset').onclick = function() {
            if (!confirm('Restaurar TODOS os certificados para os valores padrão?\nAs customizações serão perdidas.')) return;
            GM_setValue(CERT_KEY, '{}');
            cfgToast('↺ Certificados resetados. Recarregue o timeDetails.');
            closeCfgPanel();
        };


        rebuild();
    }


    // ── 5. Ponto de injeção: após body > table ────────────────────────────
    // Irmão da tabela — zero impacto na estrutura interna da tabela.
    var mainTable = document.querySelector('body > table');
    if (!mainTable) {
        console.warn('[Perm Tags] body > table não encontrada');
        return;
    }


    var label         = document.createElement('div');
    label.id          = 'perm-tags-label';
    label.textContent = 'Permissions';


    var loadingEl         = document.createElement('div');
    loadingEl.id          = 'perm-tags-loading';
    loadingEl.textContent = '⏳ Loading...';


    var container = document.createElement('div');
    container.id  = 'perm-tags-container';


    var wrapper = document.createElement('div');
    wrapper.id  = 'perm-tags-wrapper';
    wrapper.appendChild(label);
    wrapper.appendChild(loadingEl);
    wrapper.appendChild(container);


    // Insere APÓS body > table — não toca em nenhum elemento interno
    mainTable.insertAdjacentElement('afterend', wrapper);


    // ── 6. Fetch da página de permissões ──────────────────────────────────
    GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://fclm-portal.amazon.com/employee/permissions'
            + '?employeeId=' + employeeId
            + '&warehouseId=' + warehouseId,
        responseType: 'document',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        onload: function(response) {
            try {
                var doc = new DOMParser().parseFromString(response.responseText, 'text/html');
                parseAndRender(doc);
            } catch(e) {
                loadingEl.textContent = '⚠ Erro ao processar';
                console.error('[Perm Tags]', e);
            }
        },
        onerror: function(e) {
            loadingEl.textContent = '⚠ Falha ao carregar';
            console.error('[Perm Tags]', e);
        }
    });


    // ── 7. Parseia e renderiza ─────────────────────────────────────────────
    function parseAndRender(doc) {
        loadingEl.remove();


        var permRows = doc.querySelectorAll('.perm-row');
        if (!permRows.length) {
            permRows = doc.querySelectorAll(
                'body > div:nth-child(3) > div:nth-child(2) > form:nth-child(1) > table tr'
            );
        }


        function getLevel(cell) {
            var text = cell.textContent.replace(/\s+/g, ' ').trim();
            if (permLevel.includes(text)) return text;
            var opt = cell.querySelector('option[selected], option[selected="selected"]');
            if (opt) {
                var val = (opt.value || opt.textContent || '').trim();
                if (permLevel.includes(val)) return val;
            }
            var raw = (cell.innerHTML.split('>')[1] || '').split('<')[0].trim();
            if (permLevel.includes(raw)) return raw;
            for (var i = permLevel.length - 1; i > 0; i--) {
                if (text.indexOf(permLevel[i]) !== -1) return permLevel[i];
            }
            return '';
        }


        var permObj = {};
        Array.from(permRows).forEach(function(row) {
            try {
                if (!row.children[1] || !row.children[2]) return;
                var name  = row.children[1].textContent.replace(/\s+/g, ' ').trim();
                var level = getLevel(row.children[2]);
                if (name && level && level !== 'NONE') permObj[name] = level;
            } catch(e) {}
        });


        var tags = [];
        var seen = new Set();


        for (var processName in permissionsData) {
            var permReqs = permissionsData[processName];
            // OR: a tag aparece se a pessoa tiver QUALQUER uma das permissões exigidas
            // (nível >= mínimo). Mostra o MAIOR nível entre as permissões que batem.
            var bestLevel = '';
            for (var reqPerm in permReqs) {
                var minLevel    = permReqs[reqPerm];
                var actualLevel = permObj[reqPerm];
                if (!actualLevel) continue;   // não tem essa permissão → tenta a próxima
                if (permLevel.indexOf(actualLevel) >= permLevel.indexOf(minLevel)) {
                    if (!bestLevel || permLevel.indexOf(actualLevel) > permLevel.indexOf(bestLevel)) {
                        bestLevel = actualLevel;
                    }
                }
            }
            if (bestLevel) {
                var key = processName + '|' + bestLevel;
                if (!seen.has(key)) {
                    seen.add(key);
                    tags.push({ process: processName, level: bestLevel, display: levelDisplay[bestLevel] });
                }
            }
        }


        // ── Gatilho FIXO da ShipDock (Sort Center) — independe da config salva/editor ──
        // Aparece com Outbound Dock OU qualquer permissão de Sort Center. Usa o maior nível.
        if (!tags.some(function (t) { return t.process === 'ShipDock'; })) {
            var SHIPDOCK_EXTRA = ['Outbound Dock', 'Container Mgmt', 'Exception Mgmt',
                'SC Audit', 'Sort Center Support', 'Sorter Mgmt', 'Vehicle Mgmt'];
            var sdLevel = '';
            SHIPDOCK_EXTRA.forEach(function (p) {
                var lv = permObj[p];
                if (lv && permLevel.indexOf(lv) >= 0 &&
                    (!sdLevel || permLevel.indexOf(lv) > permLevel.indexOf(sdLevel))) {
                    sdLevel = lv;
                }
            });
            if (sdLevel) {
                tags.push({ process: 'ShipDock', level: sdLevel, display: levelDisplay[sdLevel] });
            }
        }


        if (tags.length === 0) {
            label.remove();
            container.innerHTML = '<span style="font-size:11px;color:#aaa;font-style:italic;font-family:Arial,sans-serif;">No permissions found</span>';
            return;
        }


        tags.sort(function(a, b) {
            return permLevel.indexOf(b.level) - permLevel.indexOf(a.level);
        });


        tags.forEach(function(tag) {
            var d     = tag.display;
            var badge = document.createElement('span');
            badge.className = 'perm-badge';
            badge.title     = tag.level;


            var left         = document.createElement('span');
            left.className   = 'perm-badge-left';
            left.textContent = tag.process;


            var right              = document.createElement('span');
            right.className        = 'perm-badge-right';
            right.style.background = d.rightBg;
            right.textContent      = d.label;


            badge.appendChild(left);
            badge.appendChild(right);


            // Wrapper vertical: badge no topo + indicador ✅/❌ centralizado abaixo (v5.11)
            var wrap = document.createElement('div');
            wrap.className = 'perm-badge-wrap';
            wrap.style.cssText = 'display:inline-flex;flex-direction:column;align-items:center;gap:3px;';
            wrap.appendChild(badge);
            container.appendChild(wrap);
        });
    }


})();

