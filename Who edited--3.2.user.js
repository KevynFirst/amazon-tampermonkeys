// ==UserScript==
// @name         Who edited?
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Shows who was the last person to code someone's time
// @author       aljrmi
// @downloadURL  https://tamarin.aces.amazon.dev/scripts/fclm-who-edited/install.user.js
// @updateURL    https://tamarin.aces.amazon.dev/scripts/fclm-who-edited/install.user.js
// @match        https://fclm-portal.amazon.com/employee/timeDetails?*
// @match        https://fclm-portal.amazon.com/employee/ppaTimeDetails?*
// @match        https://fclm-portal-iad.iad.proxy.amazon.com/employee/timeDetails?*
// @match        https://fclm-portal-iad.iad.proxy.amazon.com/employee/ppaTimeDetails?*
// @match        https://fclm-portal-dub.dub.proxy.amazon.com/employee/timeDetails?*
// @match        https://fclm-portal-dub.dub.proxy.amazon.com/employee/ppaTimeDetails?*
// @match        https://fclm-portal-nrt.nrt.proxy.amazon.com/employee/timeDetails?*
// @match        https://fclm-portal-nrt.nrt.proxy.amazon.com/employee/ppaTimeDetails?*
// @grant        GM_xmlhttpRequest
// ==/UserScript==


(function() {
    'use strict';


    const CURRENT_VERSION = '3.2';


    // ── Injeta estilos Amazon ─────────────────────────────────────────────
    const styleTag = document.createElement('style');
    styleTag.innerHTML = `
        .we-header {
            background-color: #232F3E !important;
            color: #FFFFFF !important;
            font-family: 'Amazon Ember', Arial, sans-serif !important;
            font-size: 12px !important;
            font-weight: bold !important;
            padding: 8px 12px !important;
            white-space: nowrap;
        }
        .we-cell {
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 12px;
            padding: 5px 10px;
            vertical-align: middle;
        }
        .we-edited-by  { color: #007185; font-weight: bold; }
        .we-prev-bucket { color: #565959; font-style: italic; }
        .we-time-edited { color: #232F3E; }
        .we-select {
            border: 1px solid #A9A9A9;
            border-radius: 4px;
            padding: 4px 8px;
            font-family: Arial, sans-serif;
            font-size: 11px;
            background: #FFFFFF;
            cursor: pointer;
            width: 100%;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .we-select:focus {
            outline: none;
            border-color: #FF9900;
            box-shadow: 0 0 0 2px rgba(255,153,0,0.25);
        }
        .we-select:hover { border-color: #FF9900; }
        #we-update-toast {
            position: fixed;
            top: 16px;
            right: 16px;
            background-color: #232F3E;
            color: #FFFFFF;
            padding: 12px 18px;
            border-radius: 6px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.3);
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 12px;
            z-index: 99999;
            border-left: 4px solid #FF9900;
            cursor: pointer;
            transition: background-color 0.2s ease, opacity 0.3s ease;
            max-width: 280px;
            line-height: 1.5;
        }
        #we-update-toast:hover { background-color: #37475A; }
        #we-update-toast a { color: #FEBD69; font-weight: bold; text-decoration: underline; }
        #we-update-toast-close { float: right; margin-left: 10px; opacity: 0.6; font-size: 14px; }
        #we-update-toast-close:hover { opacity: 1; }


        /* ── Tabela ganttChart — design Amazon ──────────────────────────── */
        table.ganttChart {
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 12px;
            border-collapse: separate;
            border-spacing: 0;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
        /* 1ª linha do thead: data/range (substituí o fundo verde original) */
        table.ganttChart thead tr:first-child td {
            background-color: #232F3E !important;
            color: #FFFFFF !important;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-weight: bold;
            padding: 7px 12px;
            border-bottom: 2px solid #FF9900;
        }
        /* 2ª linha do thead: headers de coluna (title, start, end, duration...) */
        table.ganttChart thead tr:nth-child(2) th,
        table.ganttChart thead tr:nth-child(2) td {
            background-color: #232F3E !important;
            color: #FFFFFF !important;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 12px;
            font-weight: bold;
            padding: 7px 10px;
            border-bottom: 2px solid #FF9900;
        }
        /* Linhas do corpo — alternadas */
        table.ganttChart tbody tr:nth-child(odd)  { background-color: #FFFFFF; }
        table.ganttChart tbody tr:nth-child(even) { background-color: #F7F7F7; }
        table.ganttChart tbody tr {
            border-bottom: 1px solid #E8E8E8;
            transition: background-color 0.1s ease;
        }
        table.ganttChart tbody tr:hover { background-color: #FFF3CD !important; }
        /* Células de texto */
        table.ganttChart tbody td {
            padding: 4px 8px;
            font-family: 'Amazon Ember', Arial, sans-serif;
            font-size: 12px;
            vertical-align: middle;
        }


        /* ── Destaque de linhas OnClock / OffClock ───────────────────────── */
        table.ganttChart tbody tr.we-row-onclock {
            background-color: #D6EAF8 !important;
        }
        table.ganttChart tbody tr.we-row-onclock:hover {
            background-color: #BDD7F0 !important;
        }
        table.ganttChart tbody tr.we-row-offclock {
            background-color: #E0E0E0 !important;
        }
        table.ganttChart tbody tr.we-row-offclock:hover {
            background-color: #CFCFCF !important;
        }


    `;
    document.head.appendChild(styleTag);


    // ── Ajuste de largura ─────────────────────────────────────────────────
    const empTimeDetailsElement = document.querySelector('.empTimeDetails');
    if (empTimeDetailsElement) {
        const currentStyle = window.getComputedStyle(empTimeDetailsElement);
        if (currentStyle.maxWidth === '1100px') {
            empTimeDetailsElement.style.maxWidth = '90%';
        }
    }


    // ── Verificação de versão (toast, sem abrir aba automaticamente) ──────
    function isNewerVersion(remote, local) {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        for (let i = 0; i < Math.max(r.length, l.length); i++) {
            if ((r[i] || 0) > (l[i] || 0)) return true;
            if ((r[i] || 0) < (l[i] || 0)) return false;
        }
        return false;
    }


    GM_xmlhttpRequest({
        method: "GET",
        url: 'https://tamarin.aces.amazon.dev/scripts/fclm-who-edited/install.user.js',
        onload: function(response) {
            try {
                const latestVersion = response.responseText.split('@version')[1].split('//')[0].trim();
                if (isNewerVersion(latestVersion, CURRENT_VERSION)) {
                    const toast = document.createElement('div');
                    toast.id = 'we-update-toast';
                    toast.innerHTML = `
                        <span id="we-update-toast-close" onclick="this.parentElement.remove()">✕</span>
                        🔔 <strong>Who edited?</strong> — Nova versão disponível (v${latestVersion})<br />
                        <a href="https://tamarin.aces.amazon.dev/scripts/fclm-who-edited/install.user.js"
                           target="_blank">Clique para atualizar ↗</a>
                    `;
                    document.body.appendChild(toast);
                    setTimeout(() => {
                        toast.style.opacity = '0';
                        setTimeout(() => toast.remove(), 300);
                    }, 10000);
                }
            } catch(e) {}
        }
    });


    // ── Lógica original intacta ───────────────────────────────────────────
    function fetchAuditReport(url) {
        return fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to fetch audit report');
                }
                return response.text();
            });
    }


    function getYearFromTable() {
        const startDateDayInput = document.querySelector('input[name="startDateDay"]');
        if (startDateDayInput) {
            const fullDate = startDateDayInput.value;
            return fullDate.split('/')[0];
        }
        return new Date().getFullYear().toString();
    }


    function formatDate(timestampString) {
        const [datePart, timePart] = timestampString.split('-');
        const [month, day] = datePart.split('/');
        const [hours, minutes, seconds] = timePart.split(':');
        const year = getYearFromTable();
        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
    }


    function parseAuditReportAndPopulateTable(responseText) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(responseText, 'text/html');
        var auditRows = doc.querySelectorAll('#auditDetails tr');


        auditRows.forEach(auditRow => {
            ['3', '4', '8'].forEach(index => {
                var cell = auditRow.querySelectorAll('td')[index];
                if (cell) {
                    var time = cell.textContent.trim();
                    cell.textContent = time.slice(0, -4);
                }
            });
        });


        var functionRows = document.querySelectorAll('tbody tr.function-seg.edited');


        functionRows.forEach(originalRow => {
            var editedTimeCell = originalRow.querySelector('td:nth-child(2)');
            var editedTime = editedTimeCell.textContent.trim();
            editedTime = formatDate(editedTime);


            var matchingAuditRows = Array.from(auditRows).filter(auditRow => {
                var auditEditedTime = auditRow.querySelectorAll('td')[3].textContent.trim();
                return auditEditedTime === editedTime;
            });


            matchingAuditRows.sort((a, b) => {
                var timeA = new Date(a.querySelectorAll('td')[8].textContent.trim());
                var timeB = new Date(b.querySelectorAll('td')[8].textContent.trim());
                return timeB - timeA;
            });


            if (matchingAuditRows.length > 0) {
                var latestEdit = matchingAuditRows[0];
                var editedByUser = latestEdit.querySelectorAll('td')[7].textContent.trim();
                var editedAtTime = latestEdit.querySelectorAll('td')[8].textContent.trim();


                var previousBucket = '';
                if (matchingAuditRows.length > 1) {
                    var prevBucketCode = matchingAuditRows[1].querySelectorAll('td')[5].textContent.trim();
                    var prevBucketDesc = matchingAuditRows[1].querySelectorAll('td')[6].textContent.trim();
                    previousBucket = prevBucketCode === '[100]' || prevBucketCode === '[0]' ?
                        'BB / TOT' : `${prevBucketCode} ${prevBucketDesc}`;
                } else {
                    previousBucket = 'Original';
                }


                // ── Células com classes Amazon ────────────────────────────
                var editedByCell = document.createElement('td');
                editedByCell.className = 'we-cell we-edited-by';
                editedByCell.textContent = editedByUser;
                originalRow.appendChild(editedByCell);


                var previousBucketCell = document.createElement('td');
                previousBucketCell.className = 'we-cell we-prev-bucket';
                previousBucketCell.textContent = previousBucket;
                originalRow.appendChild(previousBucketCell);


                var editHistoryCell = document.createElement('td');
                editHistoryCell.className = 'we-cell we-time-edited';


                if (matchingAuditRows.length > 1) {
                    var select = document.createElement('select');
                    select.className = 'we-select';


                    matchingAuditRows.forEach((auditRow, index) => {
                        var option = document.createElement('option');
                        var editor = auditRow.querySelectorAll('td')[7].textContent.trim();
                        var time   = auditRow.querySelectorAll('td')[8].textContent.trim();


                        var prev = 'Original';
                        if (index < matchingAuditRows.length - 1) {
                            var prevCode = matchingAuditRows[index + 1].querySelectorAll('td')[5].textContent.trim();
                            var prevDesc = matchingAuditRows[index + 1].querySelectorAll('td')[6].textContent.trim();
                            prev = prevCode === '[100]' || prevCode === '[0]' ?
                                'BB / TOT' : `${prevCode} ${prevDesc}`;
                        }


                        option.value = index;
                        option.textContent = `${time} - ${editor} (Previous: ${prev})`;
                        select.appendChild(option);
                    });


                    select.addEventListener('change', function() {
                        var selectedIndex = this.value;
                        var selectedAudit = matchingAuditRows[selectedIndex];
                        var nextAudit     = matchingAuditRows[parseInt(selectedIndex) + 1];


                        editedByCell.textContent = selectedAudit.querySelectorAll('td')[7].textContent.trim();


                        if (nextAudit) {
                            var nextCode = nextAudit.querySelectorAll('td')[5].textContent.trim();
                            var nextDesc = nextAudit.querySelectorAll('td')[6].textContent.trim();
                            previousBucketCell.textContent = nextCode === '[100]' || nextCode === '[0]' ?
                                'BB / TOT' : `${nextCode} ${nextDesc}`;
                        } else {
                            previousBucketCell.textContent = 'Original';
                        }
                    });


                    editHistoryCell.appendChild(select);
                } else {
                    editHistoryCell.textContent = editedAtTime;
                }


                originalRow.appendChild(editHistoryCell);
            }
        });
    }


    // ── Seletores originais ───────────────────────────────────────────────
    var employeeID = document.querySelector('.employeeInfo dd:nth-child(4)').textContent.trim();
    var fc         = document.querySelector('.employeeInfo dd:nth-child(10)').textContent.split(' (')[0].trim();
    var table      = document.querySelector('table.ganttChart');


    if (!table) {
        console.error('Gantt chart table not found');
        return;
    }


    var dateRows = table.querySelectorAll('thead tr:first-child, thead tr:first-child + tr');
    if (dateRows.length !== 2) {
        console.error('Invalid date rows');
        return;
    }


    function formatDateForURL(dateString) {
        const [year, month, day] = dateString.split('/');
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }


    var dateString   = dateRows[0].textContent.trim();
    var dateParts    = dateString.split('-').map(part => part.trim());
    var earliestDate = formatDateForURL(dateParts[0].split(' ')[0]);
    var latestDate   = formatDateForURL(dateParts[1].split(' ')[0]);


    var secondHeaderRow = table.querySelector('thead tr:nth-child(2)');
    if (!secondHeaderRow) {
        console.error('Second header row not found');
        return;
    }


    // ── Cabeçalhos com design Amazon ──────────────────────────────────────
    ['Edited by', 'Previous Bucket', 'Time Edited'].forEach(label => {
        var th = document.createElement('th');
        th.textContent = label;
        th.className = 'we-header';
        secondHeaderRow.appendChild(th);
    });


    // ── Célula "Who edited?" na 1ª linha do thead (acima das novas colunas) ──
    var firstHeaderRow = table.querySelector('thead tr:first-child');
    if (firstHeaderRow) {
        var whoEditedCell = document.createElement('td');
        whoEditedCell.colSpan = 3;
        whoEditedCell.textContent = 'Who edited?';
        whoEditedCell.style.cssText = [
            'background-color: #232F3E !important',
            'color: #FFFFFF',
            'font-family: "Amazon Ember", Arial, sans-serif',
            'font-weight: bold',
            'font-size: 13px',
            'text-align: center',
            'padding: 7px 12px',
            'border-bottom: 2px solid #FF9900',
            'letter-spacing: 0.03em'
        ].join(';');
        firstHeaderRow.appendChild(whoEditedCell);
    }


    var ToTurl = `https://fclm-portal.amazon.com/reports/audit/timeOnTask?reportFormat=HTML&warehouseId=${fc}&startDate=${earliestDate}&endDate=${latestDate}&employeeId=${employeeID}`;


    // ── Destaque de linhas OnClock/Paid (azul) e OffClock/UnPaid (cinza) ──
    document.querySelectorAll('table.ganttChart tbody tr').forEach(function(row) {
        var firstCell = row.querySelector('td:first-child');
        if (!firstCell) return;
        var text = firstCell.textContent.trim();
        if (text.startsWith('OnClock'))       row.classList.add('we-row-onclock');
        else if (text.startsWith('OffClock')) row.classList.add('we-row-offclock');
    });


    fetchAuditReport(ToTurl)
        .then(parseAuditReportAndPopulateTable)
        .catch(error => console.error(error));
})();

