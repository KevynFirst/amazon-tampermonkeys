// ==UserScript==
// @name         FCLM Intradays
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Add intraday(s) buttons + SELECT ALL no employeeRoster + link TOT/HC + ícones de busca no Time Details
// @author       ladislke
// @match        https://fclm-portal.amazon.com/*
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @grant        none
// ==/UserScript==
// v2.x — Botões Day -1 / Day Shift / Night Shift com estilo Amazon; active-shift outline
// v2.6 — Autor ladislke; exclusão ppaTimeOnTask do interval
// v2.7 — SELECT ALL no employeeRoster: seleciona todos os filtros e navega com warehouseId
// v2.8 — Remove exclusão timeOnTask (Off-Task v4.6+ não conflita); botões link TOT e ppaTimeOnTask
// v2.9 — Remove exclusão ppaTimeOnTask; botão único ⏱ TIME ON TASK → ppaTimeOnTask
// v3.0 — btn_tot: float right (próximo do CSV) + paleta preta #232F3E
// v3.1 — btn_tot: float left com divisória vertical após shift buttons
// v3.2 — Fix padding shift buttons (simétrico, sem ícone); botão 👤 HC → ppaAttendance; visibilidade condicional
// v3.3 — All Shift azul claro #4A86C8; TOT e HC cinza #607D8B
// v3.4 — ppaTimeOnTask: oculta shift buttons + divider (já tem Day/Night Range nativos)
// v3.5 — Correção: shift buttons + divider ocultados no ppaAttendance (não ppaTimeOnTask)
// v3.6 — Re-exclui ppaAttendance/employeeAttendance (TOT button vai direto no script PPA v4.9)
// v3.8 — Time Details: 3 ícones de busca (📦 Guided Coaching / 🛒 Picking Console / � FMC Inbound Stow)
//        com o login do associado, iguais aos do Acompanhamento LC. Login lido do XPath
//        /html/body/table/tbody/tr[2]/td[2]/div/dl[1]/dd[1]; warehouseId vem da URL.
//        Também mostra o login do manager na frente do nome (dd[6]/a) — buscado na
//        própria página do manager, já que o href só traz o ID — com botão de copiar.


// Horários dos turnos
// DS (Day Shift):   06:00 → 18:00
// NS (Night Shift): 18:00 → 06:00


            var ds_start_hour = 6;
            var ds_start_minute = 0;
            var ds_end_hour = 18;
            var ds_end_minute = 0;


            var ns_start_hour = 18;
            var ns_start_minute = 0;
            var ns_end_hour = 6;
            var ns_end_minute = 0;


var interval = setInterval(function(){
    // Não rodar no employeeRoster, ppaAttendance nem employeeAttendance
    if (window.location.pathname.startsWith('/employee/employeeRoster')        ||
        window.location.pathname.startsWith('/reports/ppaAttendance')          ||
        window.location.pathname.startsWith('/reports/employeeAttendance')) {
        clearInterval(interval);
        return;
    }
    if(document.getElementsByClassName("cp-submit-row")[0] != undefined && document.getElementsByTagName("table")[0] != undefined)
    {
        if(document.getElementById("intradays_div") == undefined)
        {


            // ── Injeta estilos Amazon elegantes ──────────────────────────────
            var styleTag = document.createElement('style');
            styleTag.innerHTML = `
                /* ── Botões de turno ── */
                #ds_wczoraj, #ds_dzisiaj, #ns_dzisiaj {
                    transition: all 0.15s ease;
                    border-radius: 6px;
                    padding: 5px 12px;
                    font-family: 'Amazon Ember', Arial, sans-serif;
                    font-weight: bold;
                    font-size: 11px;
                    cursor: pointer;
                    margin-right: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                    float: left;
                    line-height: 1.4;
                }
                /* Day -1 — cinza (turno passado) */
                #ds_wczoraj {
                    background-color: #4A86C8;
                    color: #FFFFFF;
                    border: 1px solid #3A76B8;
                }
                #ds_wczoraj:hover {
                    background-color: #3A76B8;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.25);
                    transform: translateY(-1px);
                    outline: 2px solid #2E5F92;
                    outline-offset: 2px;
                }
                /* Day Shift — laranja claro */
                #ds_dzisiaj {
                    background-color: #FFE0A3;
                    color: #111111;
                    border: 1px solid #FFBB44;
                }
                #ds_dzisiaj:hover {
                    background-color: #FFCC6E;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.2);
                    transform: translateY(-1px);
                    outline: 2px solid #E88B00;
                    outline-offset: 2px;
                }
                /* Night Shift — azul escuro Amazon */
                #ns_dzisiaj {
                    background-color: #232F3E;
                    color: #FFFFFF;
                    border: 1px solid #131921;
                }
                #ns_dzisiaj:hover {
                    background-color: #37475A;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.35);
                    transform: translateY(-1px);
                    outline: 2px solid #6B8EAE;
                    outline-offset: 2px;
                }
                /* Turno ativo: destaque com outline laranja */
                .active-shift {
                    outline: 3px solid #FF9900;
                    outline-offset: 2px;
                }
                /* ── Botão TIME ON TASK — preto Amazon, float left com divisória ── */
                #intradays-divider {
                    display: inline-block;
                    width: 1px;
                    height: 22px;
                    background: rgba(0,0,0,0.18);
                    margin: 0 10px;
                    vertical-align: middle;
                    float: left;
                }
                #btn_tot {
                    transition: all 0.15s ease;
                    border-radius: 6px;
                    padding: 5px 10px;
                    font-family: 'Amazon Ember', Arial, sans-serif;
                    font-weight: bold;
                    font-size: 11px;
                    cursor: pointer;
                    margin-right: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                    float: left;
                    line-height: 1.4;
                    border: 1px solid #4A6572;
                    background-color: #607D8B;
                    color: #FFFFFF;
                }
                #btn_tot:hover {
                    background-color: #4A6572;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.25);
                    transform: translateY(-1px);
                    outline: 2px solid #37474F;
                    outline-offset: 2px;
                }
                /* ── Botão HC — cinza → ppaAttendance ── */
                #btn_hc {
                    transition: all 0.15s ease;
                    border-radius: 6px;
                    padding: 5px 10px;
                    font-family: 'Amazon Ember', Arial, sans-serif;
                    font-weight: bold;
                    font-size: 11px;
                    cursor: pointer;
                    margin-right: 8px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                    float: left;
                    line-height: 1.4;
                    border: 1px solid #4A6572;
                    background-color: #607D8B;
                    color: #FFFFFF;
                }
                #btn_hc:hover {
                    background-color: #4A6572;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.25);
                    transform: translateY(-1px);
                    outline: 2px solid #37474F;
                    outline-offset: 2px;
                }
            `;
            document.head.appendChild(styleTag);
            // ────────────────────────────────────────────────────────────────


            // Ajusta largura da tabela para 800px
            for (var i = 0; i < document.getElementsByTagName("table").length; i++)
            {
                if(document.getElementsByTagName("table")[i].className == "")
                {
                    document.getElementsByTagName("table")[i].style.width = "800px";
                    i = 50;
                }
            }


            // Remove link legado
            if(document.getElementsByClassName("legacy-link")[0] != undefined)
            {
                document.getElementsByClassName("legacy-link")[0].remove();
            }


            // Remove aviso amarelo
            if(document.getElementsByClassName("disclaimer")[0] != undefined)
            {
                document.getElementsByClassName("disclaimer")[0].style.display = "none";
            }


            // ✅ Botões: Day -1 | Day Shift | Night Shift
            var intradays_div = document.createElement('div');
            intradays_div.id = "intradays_div";
            intradays_div.style = "display:contents;";
            intradays_div.innerHTML =
                '<input type="button" id="ds_wczoraj" value="🌍 All Shift" />' +
                '<input type="button" id="ds_dzisiaj" value="\u2600 Day Shift" />' +
                '<input type="button" id="ns_dzisiaj" value="\uD83C\uDF19 Night Shift" />';
            document.getElementsByClassName("cp-submit-row")[0].appendChild(intradays_div);


            document.getElementById("ds_wczoraj").addEventListener("click", ButtonClick_ds_wczoraj, false);
            document.getElementById("ds_dzisiaj").addEventListener("click", ButtonClick_ds_dzisiaj, false);
            document.getElementById("ns_dzisiaj").addEventListener("click", ButtonClick_ns_dzisiaj, false);


            // Datas
            var temp = new Date();
            var temp2 = new Date();
            var dzisiaj = new Date();
            var wczoraj = new Date(temp2.setDate(temp2.getDate() - 1));
            var jutro = new Date(temp.setDate(temp.getDate() + 1));


            var dd, mm, yyyy;


            dd = String(dzisiaj.getDate()).padStart(2, '0');
            mm = String(dzisiaj.getMonth() + 1).padStart(2, '0');
            yyyy = dzisiaj.getFullYear();
            var dzisiaj_str = yyyy + '/' + mm + '/' + dd;


            dd = String(wczoraj.getDate()).padStart(2, '0');
            mm = String(wczoraj.getMonth() + 1).padStart(2, '0');
            yyyy = wczoraj.getFullYear();
            var wczoraj_str = yyyy + '/' + mm + '/' + dd;


            dd = String(jutro.getDate()).padStart(2, '0');
            mm = String(jutro.getMonth() + 1).padStart(2, '0');
            yyyy = jutro.getFullYear();
            var jutro_str = yyyy + '/' + mm + '/' + dd;


            // ✅ Destaca turno ativo com outline laranja Amazon
            var godzina = dzisiaj.getHours();
            if(godzina >= 6 && godzina < 18)
            {
                document.getElementById("ds_dzisiaj").classList.add("active-shift");
            }
            else
            {
                document.getElementById("ns_dzisiaj").classList.add("active-shift");
            }


            // ✅ Day -1: ontem 06:00 → hoje 06:00
            function ButtonClick_ds_wczoraj (zEvent)
            {
                if(document.getElementsByName("spanType").length > 0)
                {
                    document.getElementsByName("spanType")[document.getElementsByName("spanType").length-1].checked = true;
                }
                document.getElementById("startDateIntraday").value = wczoraj_str;
                document.getElementById("endDateIntraday").value = dzisiaj_str;
                document.getElementById("startHourIntraday").selectedIndex = ds_start_hour;   // 06:00
                document.getElementById("startMinuteIntraday").selectedIndex = ds_start_minute;
                document.getElementById("endHourIntraday").selectedIndex = ds_start_hour;     // 06:00 (não 18!)
                document.getElementById("endMinuteIntraday").selectedIndex = ds_start_minute;
            }


            // ✅ Day Shift: hoje 06:00 → hoje 18:00
            function ButtonClick_ds_dzisiaj (zEvent)
            {
                if(document.getElementsByName("spanType").length > 0)
                {
                    document.getElementsByName("spanType")[document.getElementsByName("spanType").length-1].checked = true;
                }
                document.getElementById("startDateIntraday").value = dzisiaj_str;
                document.getElementById("endDateIntraday").value = dzisiaj_str;
                document.getElementById("startHourIntraday").selectedIndex = ds_start_hour;
                document.getElementById("startMinuteIntraday").selectedIndex = ds_start_minute;
                document.getElementById("endHourIntraday").selectedIndex = ds_end_hour;
                document.getElementById("endMinuteIntraday").selectedIndex = ds_end_minute;
            }


            // ✅ Night Shift: hoje 18:00 → amanhã 06:00
            function ButtonClick_ns_dzisiaj (zEvent)
            {
                if(document.getElementsByName("spanType").length > 0)
                {
                    document.getElementsByName("spanType")[document.getElementsByName("spanType").length-1].checked = true;
                }
                document.getElementById("startDateIntraday").value = dzisiaj_str;
                document.getElementById("endDateIntraday").value = jutro_str;
                document.getElementById("startHourIntraday").selectedIndex = ns_start_hour;
                document.getElementById("startMinuteIntraday").selectedIndex = ns_start_minute;
                document.getElementById("endHourIntraday").selectedIndex = ns_end_hour;
                document.getElementById("endMinuteIntraday").selectedIndex = ns_end_minute;
            }


            // ── v3.2: getWarehouseId + divisória + botões TOT e HC ──────────
            function getWarehouseId() {
                var wh = new URLSearchParams(window.location.search).get('warehouseId');
                if (!wh) {
                    var sel = document.getElementById('warehouseId') || document.querySelector('select[name="warehouseId"]');
                    if (sel) wh = sel.value;
                }
                return wh || '';
            }


            var divider = document.createElement('span');
            divider.id = 'intradays-divider';
            document.getElementsByClassName("cp-submit-row")[0].appendChild(divider);


            var btnTot = document.createElement('input');
            btnTot.type  = 'button';
            btnTot.id    = 'btn_tot';
            btnTot.value = 'Time On Task';
            btnTot.addEventListener('click', function() {
                var wh  = getWarehouseId();
                var url = 'https://fclm-portal.amazon.com/reports/ppaTimeOnTask';
                if (wh) url += '?warehouseId=' + encodeURIComponent(wh);
                window.location.href = url;
            });
            document.getElementsByClassName("cp-submit-row")[0].appendChild(btnTot);


            var btnHc = document.createElement('input');
            btnHc.type  = 'button';
            btnHc.id    = 'btn_hc';
            btnHc.value = 'Head Count';
            btnHc.addEventListener('click', function() {
                var wh  = getWarehouseId();
                var url = 'https://fclm-portal.amazon.com/reports/ppaAttendance';
                if (wh) url += '?warehouseId=' + encodeURIComponent(wh);
                window.location.href = url;
            });
            document.getElementsByClassName("cp-submit-row")[0].appendChild(btnHc);


            // Visibilidade condicional — v3.6
            var onPpaTot = window.location.pathname.includes('ppaTimeOnTask');
            if (onPpaTot) {
                // ppaTimeOnTask: oculta só o botão TOT (já estamos na página)
                btnTot.style.display = 'none';
            }


            // Para o intervalo de verificação
            clearInterval(interval);
        }
    }
},100);


// ── v2.7: SELECT ALL no employeeRoster ──────────────────────────────────
// Injeta botão abaixo do checkbox 3PTY. Ao clicar, lê o warehouseId do
// formulário e navega para o Roster com todos os filtros selecionados.
(function injectRosterSelectAll() {
    if (!window.location.pathname.startsWith('/employee/employeeRoster')) return;


    var rStyle = document.createElement('style');
    rStyle.innerHTML = `
        #roster-select-all-wrapper {
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px dashed rgba(255,153,0,0.5);
        }
        #roster-select-all-btn {
            background: linear-gradient(135deg, #1A73E8 0%, #1557B0 100%);
            color: #FFFFFF;
            border: 2px solid #1557B0;
            border-radius: 6px;
            padding: 6px 14px;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-weight: bold;
            font-size: 11px;
            cursor: pointer;
            letter-spacing: 0.05em;
            transition: all 0.15s ease;
            box-shadow: 0 2px 6px rgba(26,115,232,0.3);
            width: 100%;
        }
        #roster-select-all-btn:hover {
            background: linear-gradient(135deg, #1557B0 0%, #0D47A1 100%);
            color: #FFFFFF;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(26,115,232,0.5);
        }
        #roster-select-all-btn:active { transform: translateY(0); }
    `;
    document.head.appendChild(rStyle);


    var rPoll = setInterval(function() {
        var cb3pty = document.querySelector('input[name="employeeType3Pty"]');
        if (!cb3pty || document.getElementById('roster-select-all-btn')) return;
        clearInterval(rPoll);


        var wrapper = document.createElement('div');
        wrapper.id = 'roster-select-all-wrapper';


        var btn = document.createElement('button');
        btn.id   = 'roster-select-all-btn';
        btn.type = 'button';
        btn.textContent = '✓ SELECT ALL';


        btn.addEventListener('click', function() {
            var sel = document.querySelector('select[name="warehouseId"]');
            var wh  = sel ? sel.value : '';
            var url = 'https://fclm-portal.amazon.com/employee/employeeRoster'
                + '?reportFormat=HTML'
                + (wh ? '&warehouseId=' + encodeURIComponent(wh) : '')
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
                + '&hideColumns=Photo&submit=true';
            window.location.href = url;
        });


        wrapper.appendChild(btn);


        // Insere logo após o <span className="cp-line"> que contém o 3PTY
        var parent3pty = cb3pty.closest('.cp-line') || cb3pty.parentElement;
        parent3pty.parentNode.insertBefore(wrapper, parent3pty.nextSibling);
    }, 300);
})();



// ── v3.8: Ícones de busca (login) na página Time Details ────────────────
// Na página /employee/timeDetails, injeta 3 ícones ao lado do login do
// associado, abrindo as MESMAS ferramentas de busca do Acompanhamento LC:
//   📦 Guided Coaching (transcript)  🛒 Picking Console  � FMC Inbound (Stow)
// O login é lido do XPath informado; o warehouseId (FC) vem da URL.
(function injectTimeDetailsSearch() {
    if (!window.location.pathname.startsWith('/employee/timeDetails')) return;

    var LOGIN_XPATH = '/html/body/table/tbody/tr[2]/td[2]/div/dl[1]/dd[1]';

    function getWarehouseId() {
        var wh = new URLSearchParams(window.location.search).get('warehouseId');
        return (wh || 'GRU9').trim();
    }

    function getLoginNode() {
        try {
            return document.evaluate(
                LOGIN_XPATH, document, null,
                XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
        } catch (e) { return null; }
    }

    function getLogin(node) {
        var t = node ? String(node.textContent || '').trim() : '';
        if (t) return t;
        // fallback: parâmetro employeeId da URL
        return String(new URLSearchParams(window.location.search).get('employeeId') || '').trim();
    }

    // Link do NOME do manager. O href tem só o ID numérico; o LOGIN (alias) aparece
    // na própria página do manager (mesmo XPath do associado, dd[1]).
    var MANAGER_XPATH = '/html/body/table/tbody/tr[2]/td[2]/div/dl[1]/dd[6]/a';
    function getManagerNode() {
        try {
            return document.evaluate(
                MANAGER_XPATH, document, null,
                XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
        } catch (e) { return null; }
    }

    // "login-like" = tem letra e não é só número (evita pegar o ID numérico).
    function pareceLogin(v) { return !!v && /[a-zA-Z]/.test(v) && !/^\d+$/.test(v); }

    // Tenta achar um login (alias) SÓ em parâmetros da query que tenham letras.
    // No FCLM o href traz employeeId NUMÉRICO (Empl ID), então normalmente não há
    // login aqui — o login real está na página do manager (buscado via fetch).
    // (NÃO usar segmento do path: "…/employee/timeDetails" cairia em "timeDetails".)
    function loginDoHref(href) {
        if (!href) return '';
        try {
            var u = new URL(href, window.location.origin);
            var keys = ['employeeLogin', 'login', 'alias', 'user'];
            for (var i = 0; i < keys.length; i++) {
                var v = u.searchParams.get(keys[i]);
                if (pareceLogin(v)) return v.trim();
            }
        } catch (e) {}
        return '';
    }

    // Abre a página do manager (mesma origem FCLM) e lê o login do dd[1], igual ao associado.
    function loginDaPaginaManager(href) {
        return new Promise(function (resolve) {
            var abs;
            try { abs = new URL(href, window.location.origin).href; }
            catch (e) { resolve(''); return; }
            fetch(abs, { credentials: 'include' })
                .then(function (r) { return r.ok ? r.text() : ''; })
                .then(function (html) {
                    if (!html) { resolve(''); return; }
                    try {
                        var doc = new DOMParser().parseFromString(html, 'text/html');
                        var n = doc.evaluate(
                            LOGIN_XPATH, doc, null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE, null
                        ).singleNodeValue;
                        resolve(n ? String(n.textContent || '').trim() : '');
                    } catch (e) { resolve(''); }
                })
                .catch(function () { resolve(''); });
        });
    }

    // Copia texto para a área de transferência com feedback visual no botão.
    function fallbackCopy(txt) {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
    }
    function copiarTexto(txt, el) {
        function feito() {
            el.classList.add('ok');
            setTimeout(function () { el.classList.remove('ok'); }, 900);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(feito).catch(function () { fallbackCopy(txt); feito(); });
        } else { fallbackCopy(txt); feito(); }
    }

    // Mostra o login do manager (texto puro, FORA do link) na frente do nome padrão,
    // seguido de um botão de copiar. Mantém o link/nome original intactos.
    function enriquecerManager() {
        var mgr = getManagerNode();
        if (!mgr || mgr.getAttribute('data-lc-login')) return;
        var parent = mgr.parentNode;
        if (!parent || parent.querySelector('.lc-mgr-login')) return;
        var href = mgr.getAttribute('href') || '';

        var aplicar = function (mlogin) {
            if (!mlogin) return;
            if (parent.querySelector('.lc-mgr-login')) return;
            mgr.setAttribute('data-lc-login', mlogin);

            // "tag" (chip) clicável com o login — clicar copia o login do manager
            var tag = document.createElement('span');
            tag.className = 'lc-mgr-tag';
            tag.title = 'Clique para copiar o login do manager (' + mlogin + ')';

            var span = document.createElement('span');
            span.className = 'lc-mgr-login';
            span.textContent = mlogin;
            tag.appendChild(span);

            tag.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation();
                copiarTexto(mlogin, tag);
            });

            // a tag vem DEPOIS do nome
            var ref = mgr.nextSibling;
            parent.insertBefore(document.createTextNode(' '), ref);
            parent.insertBefore(tag, ref);
        };

        var direto = loginDoHref(href); // raro no FCLM (employeeId é numérico)
        if (direto) { aplicar(direto); return; }
        // Busca o login na própria página do manager (campo Login = dd[1]).
        loginDaPaginaManager(href).then(aplicar);
    }

    // Monta as 3 ferramentas de busca por login (mesmas do Acompanhamento LC).
    function ferramentas(login, fc) {
        var lg = encodeURIComponent(login);
        return [
            {
                icon: '\uD83D\uDCE6', // 📦
                nome: 'Guided Coaching (transcript)',
                url: 'https://guided-coaching.corp.amazon.com/#/employee-transcript/' + lg
            },
            {
                icon: '\uD83D\uDED2', // 🛒
                nome: 'Picking Console',
                url: 'https://picking-console.na.picking.aft.a2z.com/fc/' + encodeURIComponent(fc) +
                     '/pick-workforce?tableFilters=%7B%22tokens%22%3A%5B%7B%22propertyKey%22%3A%22userId%22%2C%22propertyLabel%22%3A%22User+Id%22%2C%22value%22%3A%22' +
                     lg + '%22%2C%22label%22%3A%22' + lg + '%22%2C%22negated%22%3Afalse%7D%5D%2C%22operation%22%3A%22or%22%7D'
            },
            {
                icon: '\uD83D\uDCE5', // �
                nome: 'FMC Inbound (Stow)',
                url: 'https://na.prod.fmc.aft.amazon.dev/' + encodeURIComponent(fc) + '/inbound-flow?selected-tab=VL_STOW'
            }
        ];
    }

    var tdStyle = document.createElement('style');
    tdStyle.innerHTML = `
        .lc-td-tools { display:inline-flex; gap:6px; margin-left:10px; vertical-align:middle; }
        .lc-td-tools a {
            text-decoration:none; font-size:15px; line-height:1;
            padding:3px 6px; border-radius:6px;
            border:1px solid rgba(0,0,0,0.15); background:#f4f7fc;
            box-shadow:0 1px 3px rgba(0,0,0,0.15); transition:all .15s ease;
        }
        .lc-td-tools a:hover {
            background:#e3edfb; transform:translateY(-1px);
            box-shadow:0 3px 8px rgba(0,0,0,0.2);
        }
        /* "tag" (chip) clicável com o login — clicar copia */
        .lc-mgr-tag {
            display:inline-flex; align-items:center;
            padding:2px 9px; margin-left:6px; vertical-align:middle;
            border:1px solid #cdd8e8; border-radius:12px; background:#f4f7fc;
            box-shadow:0 1px 3px rgba(0,0,0,0.12);
            cursor:pointer; transition:all .15s ease; user-select:none;
        }
        .lc-mgr-tag:hover { background:#e3edfb; transform:translateY(-1px); }
        .lc-mgr-tag:active { transform:translateY(0); }
        .lc-mgr-tag.ok { background:#d7f5df; border-color:#7fd39b; }
        .lc-mgr-login { color:#232F3E; font-size:12.5px; line-height:1.4; }
    `;
    document.head.appendChild(tdStyle);

    var poll = setInterval(function() {
        if (document.getElementById('lc-td-tools')) { clearInterval(poll); return; }
        var node = getLoginNode();
        if (!node) return; // ainda carregando

        var login = getLogin(node);
        clearInterval(poll);
        if (!login) return;

        var fc = getWarehouseId();
        var wrap = document.createElement('span');
        wrap.id = 'lc-td-tools';
        wrap.className = 'lc-td-tools';
        wrap.innerHTML = ferramentas(login, fc).map(function(f) {
            return '<a href="' + f.url + '" target="_blank" rel="noopener noreferrer" ' +
                   'title="' + f.nome + ' — ' + login + '">' + f.icon + '</a>';
        }).join('');

        node.appendChild(wrap);

        // Login do manager na frente do nome + botão de copiar.
        enriquecerManager();
    }, 300);
})();
