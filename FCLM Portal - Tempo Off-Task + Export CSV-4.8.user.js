// ==UserScript==
// @name         FCLM Portal - Tempo Off-Task + Export CSV
// @namespace    http://tampermonkey.net/
// @version      4.8
// @description  Exibe tempo off-task, exporta CSV, Amazon table style, setas sort — timeOnTask e ppaTimeOnTask
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/timeOnTask*
// @match        https://fclm-portal.amazon.com/reports/ppaTimeOnTask*
// @grant        none
// @run-at       document-end
// ==/UserScript==
// v3.5 — injectTableStyle + applyTableStyle: Amazon design igual PPA AttendanceA
// v3.6 — applyTableStyle: coluna Time Off Task injetada com color coding; getCsvData filtra data-ot-col
// v3.7 — Time Off Task: text-align center; somatório injetado/atualizado na linha Total Time
// v3.8 — Remove somatório da linha Total Time; mantém coluna TOT centralizada
// v3.9 — Persistência do filtro managerNameFilter via localStorage por warehouse
// v4.0 — Suporte a ppaTimeOnTask: coluna Inferred Time; índices dinâmicos; destaque Inferred >= 0.75
// v4.1 — ot-low verde→âmbar (todo off-task é negativo); setas ▲▼ de ordenação nos headers
// v4.2 — Fix: className→class no innerHTML das setas; setas menores e cor laranja dimmed
// v4.3 — Fix definitivo: innerHTML→createElement para spans das setas; font-size 5px/6px
// v4.4 — Setas: injetadas dentro do <a> (inline com texto); cor inativa rgba(255,153,0,0.65)
// v4.5 — Fix posição setas: FCLM usa div.tablesorter-header-inner (não <a>); target corrigido
// v4.6 — Estilização Amazon (tabela, setas, ot-row-offtrack) restrita ao ppaTimeOnTask
// v4.7 — Coluna "Time Off Task" (th + td + CSV) restrita ao ppaTimeOnTask
// v4.8 — Overlay ocultado no ppaTimeOnTask (apenas timeOnTask)


(function() {
    'use strict';


    // === Parâmetros da URL ===
    const urlParams          = new URLSearchParams(window.location.search);
    const warehouseId        = urlParams.get('warehouseId') || 'UNKNOWN';
    const MANAGER_FILTER_KEY = `ot_manager_${warehouseId}`; // chave por warehouse


    // === Configurações ===
    const OVERLAY_ID    = 'off-task-overlay';
    const POLL_INTERVAL = 3000;


    // === Detecção de página — ppaTimeOnTask tem coluna "Inferred Time" extra (v4.0) ===
    const isPPA        = window.location.pathname.includes('ppaTimeOnTask');
    const TOTAL_COL    = isPPA ? 5 : 4;  // índice de "Total Time"
    const PERCENT_COL  = isPPA ? 6 : 5;  // índice de "Percent Time on Task"
    const INFERRED_COL = 4;              // índice de "Inferred Time" (só ppaTimeOnTask)
    const MIN_COLS     = isPPA ? 7 : 6;  // mínimo de colunas para linha de dados


    // === Parsing ===
    function parseHours(value) {
        return parseFloat(value.replace(/,/g, '').trim()) || 0;
    }


    function parsePercentage(value) {
        return parseFloat(value.replace(/,/g, '').trim()) || 0;
    }


    // === Escapar campo para CSV ===
    function escapeCSVField(field) {
        if (/[,"\n]/.test(field)) {
            return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
    }


    // === Extrair valor da célula — preserva link como fórmula HYPERLINK (Excel) ===
    // Qualquer célula que contenha <a href> será formatada como:
    // "=HYPERLINK(""url"",""texto"")"  → clicável direto no Excel
    function getCellValue(cell) {
        const anchor = cell.querySelector('a');
        if (anchor && anchor.href) {
            const text = anchor.textContent.trim().replace(/"/g, '""'); // escapa aspas internas
            const url  = anchor.href.replace(/"/g, '""');
            // Fórmula Excel: =HYPERLINK("url","texto") — envolta em aspas CSV
            return `"=HYPERLINK(""${url}"",""${text}"")"`;
        }
        return escapeCSVField(cell.textContent.trim());
    }


    // === Coletar dados para CSV ===
    function getCsvData() {
        const tableContainer = document.getElementById('content-penal');
        if (!tableContainer) return { headers: [], rows: [] };


        const table = tableContainer.querySelector('table');
        if (!table)  return { headers: [], rows: [] };


        // Cabeçalho — ignora <th> injetado (data-ot-col)
        const headers = [];
        const headerRow = table.querySelector('tr');
        if (headerRow) {
            headerRow.querySelectorAll('th, td').forEach(cell => {
                if (cell.dataset.otCol) return; // pula coluna injetada
                headers.push(escapeCSVField(cell.textContent.trim()));
            });
        }
        headers.push(escapeCSVField('Time Off Task'));


        // Linhas (apenas onde % < 100) — filtra células injetadas
        const rows = [];
        table.querySelectorAll('tr').forEach(row => {
            const allCells = row.querySelectorAll('td');
            const cells    = Array.from(allCells).filter(c => !c.dataset.otCol);
            if (cells.length < MIN_COLS) return;


            try {
                const percentTimeOnTask = parsePercentage(cells[PERCENT_COL].textContent);
                if (percentTimeOnTask >= 100) return;


                const rowData = cells.map(cell => getCellValue(cell));


                // Time Off Task = Total Time - Time On Task (- Inferred Time em ppaTimeOnTask)
                const totalTime   = parseHours(cells[TOTAL_COL].textContent);
                const timeOnTask  = parseHours(cells[3].textContent);
                const inferred    = isPPA ? parseHours(cells[INFERRED_COL].textContent) : 0;
                const timeOffTask = (totalTime - timeOnTask - inferred).toFixed(4);


                rowData.push(escapeCSVField(timeOffTask.toString()));
                rows.push(rowData);
            } catch (e) {
                console.warn('[CSV] Erro ao processar linha:', e);
            }
        });


        return { headers, rows };
    }


    // === Gerar e baixar CSV ===
    function exportToCsv() {
        const { headers, rows } = getCsvData();


        if (headers.length === 0 || rows.length === 0) {
            alert('Nenhum dado para exportar!');
            return;
        }


        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');


        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `relatorio_off_task_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);


        // Feedback visual no overlay
        const overlay = document.getElementById(OVERLAY_ID);
        if (overlay) {
            const original = overlay.innerHTML;
            overlay.style.backgroundColor = '#067D62';
            overlay.innerHTML = `✓ CSV exportado com ${rows.length} linha(s)!`;
            setTimeout(() => {
                overlay.style.backgroundColor = '#232F3E';
                overlay.innerHTML = original;
            }, 2500);
        }
    }


    // === Criar overlay ===
    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;


        // ── Estilos Amazon ──
        Object.assign(overlay.style, {
            position:        'fixed',
            bottom:          '20px',
            right:           '20px',
            backgroundColor: '#232F3E',
            color:           '#FFFFFF',
            padding:         '12px 20px',
            borderRadius:    '8px',
            boxShadow:       '0 4px 14px rgba(0,0,0,0.3)',
            zIndex:          '9999',
            fontWeight:      'bold',
            fontSize:        '13px',
            fontFamily:      "'Amazon Ember', Arial, sans-serif",
            cursor:          'pointer',
            transition:      'background-color 0.2s ease, box-shadow 0.2s ease',
            borderLeft:      '4px solid #FF9900',
            userSelect:      'none',
        });


        overlay.innerHTML = `🕒 OFF-TASK TOTAL: <span id="off-task-value">Carregando...</span>
            <div style="font-size:10px; font-weight:normal; color:#FEBD69; margin-top:3px;">
                Clique para exportar CSV ↓
            </div>`;


        // Hover
        overlay.addEventListener('mouseenter', () => {
            overlay.style.backgroundColor = '#37475A';
            overlay.style.boxShadow = '0 6px 18px rgba(0,0,0,0.4)';
        });
        overlay.addEventListener('mouseleave', () => {
            overlay.style.backgroundColor = '#232F3E';
            overlay.style.boxShadow = '0 4px 14px rgba(0,0,0,0.3)';
        });


        // Clique → exportar
        overlay.addEventListener('click', exportToCsv);


        document.body.appendChild(overlay);
        return overlay;
    }


    // === Atualizar valor no overlay ===
    function updateOverlay() {
        const valueEl = document.getElementById('off-task-value');
        if (!valueEl) return;


        const tableContainer = document.getElementById('content-penal');
        if (!tableContainer) return;


        const totalOffTask = Array.from(tableContainer.querySelectorAll('tr')).reduce((acc, row) => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= MIN_COLS) {
                const percent = parsePercentage(cells[PERCENT_COL].textContent);
                if (percent < 100) {
                    const inferred = isPPA ? parseHours(cells[INFERRED_COL].textContent) : 0;
                    return acc + (parseHours(cells[TOTAL_COL].textContent) - parseHours(cells[3].textContent) - inferred);
                }
            }
            return acc;
        }, 0);


        // Conta associados off-task
        const offTaskCount = Array.from(tableContainer.querySelectorAll('tr')).filter(row => {
            const cells = row.querySelectorAll('td');
            return cells.length >= MIN_COLS && parsePercentage(cells[PERCENT_COL].textContent) < 100;
        }).length;


        valueEl.textContent = `${totalOffTask.toFixed(2)}h (${offTaskCount} assoc.)`;


        // Cor do valor baseada na gravidade
        if (totalOffTask > 5) {
            valueEl.style.color = '#FF6B6B';
        } else if (totalOffTask > 2) {
            valueEl.style.color = '#FEBD69';
        } else {
            valueEl.style.color = '#67D171';
        }
    }


    // === Amazon table style — igual PPA Attendance (v3.5) ===
    function injectTableStyle() {
        if (document.getElementById('ot-table-style')) return;
        const s  = document.createElement('style');
        s.id     = 'ot-table-style';
        s.innerHTML = `
            /* ── Overflow horizontal ── */
            #content-penal { overflow-x:auto; -webkit-overflow-scrolling:touch; max-width:100%; }


            /* ── Tabela principal ── */
            table.ot-style-table {
                font-family: 'Amazon Ember', Arial, sans-serif;
                font-size: 11px;
                border-collapse: collapse;
                box-shadow: 0 2px 8px rgba(0,0,0,0.12);
                width: auto;
                max-width: 100%;
                margin: 0 auto;
            }


            /* ── Header — #232F3E fundo + #FF9900 borda inferior ── */
            table.ot-style-table thead th,
            table.ot-style-table thead td {
                background-color: #232F3E !important;
                color: #FFFFFF !important;
                font-family: 'Amazon Ember', Arial, sans-serif;
                font-size: 11px;
                font-weight: bold;
                padding: 7px 10px;
                box-shadow: inset 0 -2px 0 0 #FF9900;
                white-space: nowrap;
            }
            table.ot-style-table thead th a,
            table.ot-style-table thead td a {
                color: #FEBD69 !important;
                text-decoration: none;
            }
            table.ot-style-table thead th a:hover,
            table.ot-style-table thead td a:hover {
                color: #FF9900 !important;
                text-decoration: underline;
            }


            /* Fallback: tabela sem <thead> explícito */
            table.ot-style-table > tr:first-child > th,
            table.ot-style-table > tr:first-child > td {
                background-color: #232F3E !important;
                color: #FFFFFF !important;
                font-size: 11px;
                font-weight: bold;
                padding: 7px 10px;
                box-shadow: inset 0 -2px 0 0 #FF9900;
                white-space: nowrap;
            }


            /* ── Linhas alternadas ── */
            table.ot-style-table tbody tr:nth-child(odd)  { background-color: #FFFFFF; }
            table.ot-style-table tbody tr:nth-child(even) { background-color: #F7F7F7; }
            table.ot-style-table tbody tr {
                border-bottom: 1px solid #E8E8E8;
                transition: background-color 0.1s ease;
            }
            table.ot-style-table tbody tr:hover { background-color: #FFF3CD !important; }


            /* ── Células ── */
            table.ot-style-table tbody td {
                padding: 4px 8px;
                vertical-align: middle;
                white-space: nowrap;
            }


            /* Links Employee ID — teal Amazon */
            table.ot-style-table tbody td a {
                color: #007185;
                text-decoration: none;
            }
            table.ot-style-table tbody td a:hover {
                color: #C45500;
                text-decoration: underline;
            }


            /* ── Linha off-task (% < 100) — borda vermelha esquerda ── */
            table.ot-style-table tbody tr.ot-row-offtrack {
                border-left: 3px solid #CC0000 !important;
            }
            table.ot-style-table tbody tr.ot-row-offtrack:hover {
                background-color: #FFF0F0 !important;
            }


            /* ── Coluna Time Off Task injetada (v3.6) ── */
            table.ot-style-table th[data-ot-col] {
                text-align: center;
                background-color: #2E4A5A !important;  /* tom levemente diferente para destacar */
            }
            table.ot-style-table td.ot-cell-offtask {
                text-align: center;
                font-weight: bold;
            }
            table.ot-style-table td.ot-high   { color: #CC0000; }   /* > 2h    — vermelho  */
            table.ot-style-table td.ot-medium  { color: #E88B00; }   /* 0.5–2h  — âmbar    */
            table.ot-style-table td.ot-low     { color: #E88B00; }   /* < 0.5h  — âmbar (todo off-task é ruim) */
            table.ot-style-table td.ot-none    { color: #AAAAAA; font-weight: normal; } /* on-task */
            table.ot-style-table td.ot-total   { color: #232F3E; font-size: 12px; }     /* somatório */


            /* ── Inferred Time >= 0.75 (ppaTimeOnTask) — destaque vermelho (v4.0) ── */
            table.ot-style-table td.ot-inferred-high {
                color: #CC0000 !important;
                font-weight: bold;
                background-color: #FFF0F0 !important;
            }


            /* ── Sort arrows ▲▼ nos headers (v4.1 / ajustado v4.2) ── */
            .ot-sort-arrows {
                display: inline-flex;
                flex-direction: column;
                margin-left: 3px;
                gap: 0px;
                vertical-align: middle;
                line-height: 1;
            }
            .ot-arrow-up,
            .ot-arrow-down {
                display: block;
                font-size: 6px;
                color: rgba(255,153,0,0.65);
                line-height: 1;
                font-weight: normal;
                font-style: normal;
            }
            /* Ascending — ▲ laranja vivo */
            table.ot-style-table thead th.tablesorter-headerAsc .ot-arrow-up,
            table.ot-style-table thead td.tablesorter-headerAsc .ot-arrow-up {
                color: #FF9900;
                font-size: 7px;
            }
            /* Descending — ▼ laranja vivo */
            table.ot-style-table thead th.tablesorter-headerDesc .ot-arrow-down,
            table.ot-style-table thead td.tablesorter-headerDesc .ot-arrow-down {
                color: #FF9900;
                font-size: 7px;
            }
        `;
        document.head.appendChild(s);
    }


    // === Aplica classes de linha + coluna Time Off Task (v3.6 / centralizado v3.7) ===
    function applyTableStyle() {
        const container = document.getElementById('content-penal');
        if (!container) return;
        const table = container.querySelector('table');
        if (!table) return;


        if (isPPA) table.classList.add('ot-style-table'); // v4.6 — sem Amazon style no timeOnTask


        // v4.7 — Coluna "Time Off Task" só no ppaTimeOnTask
        if (isPPA) {
            const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
            if (headerRow && !headerRow.querySelector('[data-ot-col]')) {
                const th = document.createElement('th');
                th.textContent   = 'Time Off Task';
                th.dataset.otCol = 'true';
                headerRow.appendChild(th);
            }
        }


        // v4.6 — Setas ▲▼ apenas no ppaTimeOnTask (timeOnTask tem outro script ativo)
        if (isPPA) {
            const allHeaderCells = table.querySelectorAll('thead th, thead td');
            const headerCells = allHeaderCells.length
                ? Array.from(allHeaderCells)
                : Array.from((table.querySelector('tr') || document.createElement('tr')).querySelectorAll('th, td'));
            headerCells.forEach(th => {
                if (th.dataset.otCol) return;
                if (th.querySelector('.ot-sort-arrows')) return;


                const arrows = document.createElement('span');
                arrows.className = 'ot-sort-arrows';


                const up = document.createElement('span');
                up.className   = 'ot-arrow-up';
                up.textContent = '▲';


                const down = document.createElement('span');
                down.className   = 'ot-arrow-down';
                down.textContent = '▼';


                arrows.appendChild(up);
                arrows.appendChild(down);


                const target = th.querySelector('.tablesorter-header-inner')
                            || th.querySelector('a')
                            || th;
                target.appendChild(arrows);
            });
        }


        // Suporta tabelas com ou sem <tbody>
        const bodyRows = table.querySelectorAll('tbody tr');
        const rows = bodyRows.length
            ? Array.from(bodyRows)
            : Array.from(table.querySelectorAll('tr')).slice(1); // pula header


        rows.forEach(row => {
            const allCells  = row.querySelectorAll('td');
            const realCells = Array.from(allCells).filter(c => !c.dataset.otCol);
            if (realCells.length < MIN_COLS) return;


            const percent = parsePercentage(realCells[PERCENT_COL].textContent);
            if (isPPA) row.classList.toggle('ot-row-offtrack', percent < 100); // v4.6


            // v4.0 — Destaca Inferred Time >= 0.75 (apenas ppaTimeOnTask)
            if (isPPA && realCells[INFERRED_COL]) {
                const inferred = parseHours(realCells[INFERRED_COL].textContent);
                realCells[INFERRED_COL].classList.toggle('ot-inferred-high', inferred >= 0.75);
            }


            // v4.7 — Célula Time Off Task só no ppaTimeOnTask
            if (isPPA) {
                if (row.querySelector('[data-ot-col]')) return;


                const totalTime  = parseHours(realCells[TOTAL_COL].textContent);
                const timeOnTask = parseHours(realCells[3].textContent);
                const inferred   = isPPA ? parseHours(realCells[INFERRED_COL].textContent) : 0;
                const offTask    = totalTime - timeOnTask - inferred;


                const td = document.createElement('td');
                td.dataset.otCol = 'true';
                td.classList.add('ot-cell-offtask');


                if (percent >= 100) {
                    td.textContent = '—';
                    td.classList.add('ot-none');
                } else {
                    td.textContent = offTask.toFixed(2) + 'h';
                    if      (offTask > 2)   td.classList.add('ot-high');
                    else if (offTask > 0.5) td.classList.add('ot-medium');
                    else                    td.classList.add('ot-low');
                }


                row.appendChild(td);
            }
        });
    }


    // === Persistência do filtro managerNameFilter (v3.9) ===
    function injectManagerFilterPersistence() {
        const fp = setInterval(() => {
            const sel = document.getElementById('managerNameFilter');
            if (!sel) return;
            // Aguarda opções serem carregadas (FCLM popula o select dinamicamente)
            if (sel.tagName === 'SELECT' && sel.options.length <= 1) return;
            clearInterval(fp);


            // Salva ao mudar
            sel.addEventListener('change', () => {
                if (sel.value) {
                    localStorage.setItem(MANAGER_FILTER_KEY, sel.value);
                } else {
                    localStorage.removeItem(MANAGER_FILTER_KEY);
                }
            });


            // Restaura último valor salvo e aciona o filtro
            const saved = localStorage.getItem(MANAGER_FILTER_KEY);
            if (saved) {
                sel.value = saved;
                if (sel.value === saved) { // confirma que a opção existe
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }, 300);
    }


    // === Iniciar monitoramento ===
    function startMonitoring() {
        const existing = document.getElementById(OVERLAY_ID);
        if (existing) existing.remove();


        if (isPPA) injectTableStyle(); // v4.6 — Amazon table style só no ppaTimeOnTask


        // v4.8 — Overlay ocultado no ppaTimeOnTask (apenas timeOnTask exibe)
        if (!isPPA) {
            createOverlay();
            updateOverlay();
        }


        applyTableStyle();
        injectManagerFilterPersistence(); // v3.9


        // MutationObserver para atualizações dinâmicas
        const targetNode = document.getElementById('content-penal') || document.body;
        const observer   = new MutationObserver(() => { updateOverlay(); applyTableStyle(); });
        observer.observe(targetNode, { childList: true, subtree: true });


        // Backup polling
        setInterval(() => { updateOverlay(); applyTableStyle(); }, POLL_INTERVAL);
    }


    // === Aguardar DOM ===
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startMonitoring);
    } else {
        startMonitoring();
    }
})();

