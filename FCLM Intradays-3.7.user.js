// ==UserScript==
// @name         FCLM Intradays
// @namespace    http://tampermonkey.net/
// @version      3.7
// @description  Add intraday(s) buttons + SELECT ALL no employeeRoster + link TOT/HC
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

