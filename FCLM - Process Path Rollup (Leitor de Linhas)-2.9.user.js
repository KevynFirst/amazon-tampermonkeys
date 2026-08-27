// ==UserScript==
// @name         FCLM - Process Path Rollup (DDD)
// @namespace    http://tampermonkey.net/
// @version      3.13
// @description  Lê linhas específicas (Line Items) do processPathRollup e mostra a linha inteira de cada uma num painel. No dashboard do QuickSight (DDD), o mesmo botão lê o visual "Rate na LC por Processo" e devolve os process paths na ordem do DDD (o que não achar vem como N/I), e uma segunda visão conta as pessoas acima e abaixo de 100% no Rate LC por Processo × Turno, com gráficos salváveis em PNG.
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/processPathRollup*
// @match        https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/70d2ff95-0852-4002-8afb-8d9c0cff2218*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20-%20Process%20Path%20Rollup%20(DDD)-3.0.user.js
// @downloadURL  https://raw.githubusercontent.com/KevynFirst/amazon-tampermonkeys/main/FCLM%20-%20Process%20Path%20Rollup%20(DDD)-3.0.user.js
// ==/UserScript==
(function () {
    'use strict';
    if (window.top !== window.self) return;

    // ── Paleta Amazon ────────────────────────────────────────────────────
    const C = {
        dark: '#232F3E', accent: '#FF9900', gold: '#FEBD69', blue: '#4A86C8',
        grey: '#607D8B', red: '#CC0000', green: '#27AE60', white: '#FFFFFF',
        light: '#F7F7F7', border: '#E8E8E8', bodyBg: '#EEF1F4',
        headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
        btnGrad: 'linear-gradient(145deg,#37475A 0%,#232F3E 100%)',
        btnGradH: 'linear-gradient(145deg,#4A5D72 0%,#37475A 100%)',
    };
    const POSKEY = 'fclm_ppr_pos';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Chave canônica: normaliza traços (– — − → -), espaços e caixa.
    const canon = (s) => String(s || '').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
    // Cria elemento com estilo inline e texto opcional (usado nos painéis).
    function el(tag, cssText, text) {
        const e = document.createElement(tag);
        if (cssText) e.style.cssText = cssText;
        if (text != null) e.textContent = text;
        return e;
    }

    // Detecta o separador decimal a partir de um número com os DOIS separadores
    // (ex.: "5,189.49" → decimal '.'  ·  "5.189,49" → decimal ',').
    const detectDecSep = (text) => {
        const m = String(text || '').match(/\d[.,]\d{3}[.,]\d/);
        if (m) return m[0].lastIndexOf(',') > m[0].lastIndexOf('.') ? ',' : '.';
        return '.';
    };
    // Remove separador de milhar e devolve decimal com ponto (nunca vírgula).
    const cleanNumber = (s, dec) => {
        s = norm(s);
        if (!/\d/.test(s)) return s;                 // não é número → mantém
        const pct = s.includes('%');
        const sign = /^\s*-/.test(s) ? '-' : '';
        let x = s.replace(/[^\d.,]/g, '');
        const thou = dec === ',' ? '.' : ',';
        x = x.split(thou).join('');                  // tira milhar
        if (dec === ',') x = x.replace(',', '.');    // decimal vírgula → ponto
        return sign + x + (pct ? '%' : '');
    };

    // ── Line Items alvo (ordem de exibição) ──────────────────────────────
    const TARGETS = [
        'Customer Returns - Total',
        'Vendor Returns - Total',
        'Warehouse Deals - Total',
        'Admin/HR/IT',
        'On Boarding',
        'Non_FC_Controllable',
        'IC/QA/CS',
        'Facilities',
        'Transfer-In',
        'Total Inbound',
        'Outbound',
        'Transfer-Out',
        'Reverse Logistics',
        'Support',
        'Time Off Task',
        'THROUGHPUT',
    ];
    const TARGET_INDEX = {};      // key -> ordem
    const TARGET_NAME = {};       // key -> nome original
    TARGETS.forEach((t, i) => { TARGET_INDEX[canon(t)] = i; TARGET_NAME[canon(t)] = t; });
    const TARGET_SET = new Set(Object.keys(TARGET_INDEX));

    // ── CSS ──────────────────────────────────────────────────────────────
    function injectUICss() {
        if (document.getElementById('ppr-ui-css')) return;
        const st = document.createElement('style');
        st.id = 'ppr-ui-css';
        st.textContent =
            '@keyframes pprFade{from{opacity:0}to{opacity:1}}' +
            '@keyframes pprPop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}' +
            '#ppr-modal ::-webkit-scrollbar{width:10px;height:10px}' +
            '#ppr-modal ::-webkit-scrollbar-thumb{background:#C5CDD4;border-radius:8px;border:2px solid transparent;background-clip:padding-box}';
        document.head.appendChild(st);
    }

    // ── Parsing ──────────────────────────────────────────────────────────
    // Acha a tabela principal (a que contém "Line Items" / mais alvos).
    function findMainTable(doc) {
        let best = null, bestScore = -1;
        doc.querySelectorAll('table').forEach(tb => {
            const txt = tb.textContent.toLowerCase();
            let score = 0;
            if (txt.includes('line items')) score += 3;
            TARGETS.forEach(t => { if (txt.includes(t.toLowerCase())) score++; });
            if (score > bestScore) { bestScore = score; best = tb; }
        });
        return bestScore > 0 ? best : null;
    }

    // Colunas de saída (ordem do print desejado).
    const OUT = [
        { key: 'name',    label: 'Lineitem Name' },
        { key: 'main',    label: 'Main Process' },
        { key: 'core',    label: 'Core Process' },
        { key: 'unit',    label: 'Unit Type' },
        { key: 'aVol',    label: 'Actual Volume' },
        { key: 'aHrs',    label: 'Actual Hours' },
        { key: 'aRate',   label: 'Actual Rate' },
        { key: 'pRate',   label: 'Plan Productivity' },
        { key: 'pHrs',    label: 'Hours @ Plan Rate' },
        { key: 'pVar',    label: 'Plan Variance (Hrs)' },
        { key: 'pToPlan', label: '% to Plan' },
    ];
    // Layout de saída pedido (posições preservadas, colunas do meio em branco):
    // Lineitem Name | - | - | - | Actual Volume | Actual Hours | - | - | - | Plan Variance | % to Plan
    // As colunas "_gap" ficam vazias: traço na tabela e célula vazia no Copiar (alinha com a planilha).
    const GAP = () => ({ key: '_gap', label: '-' });
    const ORANGE = [
        { key: 'name',    label: 'Lineitem Name' },
        GAP(), GAP(), GAP(),
        { key: 'aVol',    label: 'Actual Volume' },
        { key: 'aHrs',    label: 'Actual Hours' },
        { key: 'aRate',   label: 'Actual Rate', tpOnly: true },   // preenchido só na linha THROUGHPUT
        { key: 'pRate',   label: 'Plan Rate',   tpOnly: true },   // preenchido só na linha THROUGHPUT
        GAP(),
        { key: 'pVar',    label: 'Plan Variance (Hrs)' },
        { key: 'pToPlan', label: '% to Plan' },
    ];
    // Valor da célula respeitando colunas "tpOnly" (só valem para a linha THROUGHPUT).
    const cellValue = (it, col) => (col.tpOnly && canon(it.name) !== 'throughput') ? '' : it[col.key];

    // string numérica → número (para os gráficos).
    const toNum = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; };

    // Reconstrói a tabela em matriz [linha][coluna], respeitando rowspan/colspan
    // (Main/Core Process são células mescladas que se repetem nas linhas de baixo).
    function buildMatrix(table) {
        const grid = [];
        const carry = {}; // coluna -> { text, rem }
        [...table.querySelectorAll('tr')].forEach((tr, r) => {
            if (!grid[r]) grid[r] = [];
            const cells = [...tr.children].filter(el => el.tagName === 'TD' || el.tagName === 'TH');
            let c = 0, ci = 0;
            while (ci < cells.length || (carry[c] && carry[c].rem > 0)) {
                if (carry[c] && carry[c].rem > 0) { grid[r][c] = carry[c].text; carry[c].rem--; c++; continue; }
                if (ci >= cells.length) break;
                const cell = cells[ci++];
                const cs = parseInt(cell.getAttribute('colspan') || '1', 10);
                const rs = parseInt(cell.getAttribute('rowspan') || '1', 10);
                const text = norm(cell.textContent);
                for (let k = 0; k < cs; k++) { grid[r][c] = text; if (rs > 1) carry[c] = { text, rem: rs - 1 }; c++; }
            }
        });
        return grid;
    }

    function parseRollup(doc) {
        const table = findMainTable(doc);
        if (!table) return { items: [], missing: TARGETS.slice() };
        const grid = buildMatrix(table);
        const maxC = Math.max(0, ...grid.map(row => row.length));

        // leafRow = linha com "Line Items / Vol / Hrs / Rate ..." (rótulos por coluna)
        // groupRow = linha ACIMA com os grupos "Actual / Plan / YOY Improvement"
        let leafRow = grid.findIndex(row => row.some(x => canon(x) === 'line items'));
        if (leafRow < 0) leafRow = 1;
        let groupRow = grid.findIndex(row => row.some(x => canon(x) === 'actual'));
        if (groupRow < 0) groupRow = Math.max(0, leafRow - 1);

        const findCol = pred => {
            for (let c = 0; c < maxC; c++) {
                const g = canon(grid[groupRow] && grid[groupRow][c]);
                const l = canon(grid[leafRow] && grid[leafRow][c]);
                if (pred(g, l)) return c;
            }
            return -1;
        };
        const col = {
            main:    findCol((g, l) => g === 'main processes' || l === 'main processes'),
            core:    findCol((g, l) => g === 'core processes' || l === 'core processes'),
            name:    findCol((g, l) => g === 'line items' || l === 'line items'),
            unit:    findCol((g, l) => g === 'unit' || l === 'unit'),
            aVol:    findCol((g, l) => g === 'actual' && l === 'vol'),
            aHrs:    findCol((g, l) => g === 'actual' && l === 'hrs'),
            aRate:   findCol((g, l) => g === 'actual' && l === 'rate'),
            pRate:   findCol((g, l) => g === 'plan' && l === 'rate'),
            pHrs:    findCol((g, l) => g === 'plan' && l === 'hrs'),
            pVar:    findCol((g, l) => g === 'plan' && l.includes('to plan') && l.includes('hrs')),
            pToPlan: findCol((g, l) => g === 'plan' && l.includes('% to plan')),
        };

        const decSep = detectDecSep(table.textContent);
        const get = (row, c) => (c >= 0 && row[c] != null) ? norm(row[c]) : '';
        const numv = (row, c) => cleanNumber(get(row, c), decSep);   // milhar removido, decimal com ponto
        // % to Plan como FRAÇÃO decimal (ex.: "66.23%" → 0.6623).
        const pct = (row, c) => {
            const raw = cleanNumber(get(row, c), decSep).replace('%', '');
            if (raw === '' || isNaN(parseFloat(raw))) return '';
            const n = parseFloat(raw) / 100;
            return String(Math.round(n * 1e6) / 1e6); // sem ruído de ponto flutuante
        };
        const found = {};
        for (let r = leafRow + 1; r < grid.length; r++) {
            const row = grid[r]; if (!row) continue;
            const nm = get(row, col.name);
            const key = canon(nm);
            if (!TARGET_SET.has(key) || found[key]) continue;
            found[key] = {
                name: TARGET_NAME[key],
                main: get(row, col.main), core: get(row, col.core), unit: get(row, col.unit),
                aVol: numv(row, col.aVol), aHrs: numv(row, col.aHrs), aRate: numv(row, col.aRate),
                pRate: numv(row, col.pRate), pHrs: numv(row, col.pHrs),
                pVar: numv(row, col.pVar), pToPlan: pct(row, col.pToPlan),
            };
        }
        const items = Object.keys(found).sort((a, b) => TARGET_INDEX[a] - TARGET_INDEX[b]).map(k => found[k]);
        const missing = TARGETS.filter(t => !found[canon(t)]);
        try { console.log('[PPR] colunas:', col, 'groupRow', groupRow, 'leafRow', leafRow, 'itens', items.length); } catch (e) {}
        return { items, missing };
    }

    // spanType da URL (day/week) para nomear os PNGs.
    function spanLabel() {
        const s = (new URLSearchParams(location.search).get('spanType') || '').toLowerCase();
        if (s === 'week') return 'week';
        if (s === 'day') return 'day';
        return s || 'day';
    }
    // Converte um <svg> do DOM em PNG e dispara o download.
    function svgToPng(svgEl, filename) {
        const w = (svgEl.width && svgEl.width.baseVal && svgEl.width.baseVal.value) || 800;
        const h = (svgEl.height && svgEl.height.baseVal && svgEl.height.baseVal.value) || 340;
        const xml = new XMLSerializer().serializeToString(svgEl);
        const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
        const img = new Image();
        img.onload = () => {
            const scale = 2;
            const canvas = document.createElement('canvas');
            canvas.width = w * scale; canvas.height = h * scale;
            const ctx = canvas.getContext('2d');
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 1500);
            }, 'image/png');
        };
        img.src = url;
    }

    // ── Gráficos (waterfall do Plan Variance por grupo) ──────────────────
    const CHART_GROUPS = [
        { title: 'FC Total', totalName: 'THROUGHPUT', totalLabel: 'FC Hours',
          steps: ['Transfer-In', 'Total Inbound', 'Outbound', 'Transfer-Out', 'Reverse Logistics', 'Support', 'Time Off Task'] },
        { title: 'Support', totalName: 'Support', totalLabel: 'Total Support',
          steps: ['Admin/HR/IT', 'On Boarding', 'Non_FC_Controllable', 'IC/QA/CS', 'Facilities'] },
        { title: 'Reverse Logistics', totalName: 'Reverse Logistics', totalLabel: 'Total Reverse',
          steps: ['Customer Returns - Total', 'Vendor Returns - Total', 'Warehouse Deals - Total'] },
    ];

    // Desenha um gráfico waterfall em SVG.
    function waterfallSVG(steps, total, totalFirst) {
        const bars = [];
        const totalBar = { label: total.label, start: 0, end: total.value, value: total.value, isTotal: true };
        if (totalFirst) bars.push(totalBar);
        let c = 0;
        steps.forEach(s => { bars.push({ label: s.label, start: c, end: c + s.value, value: s.value }); c += s.value; });
        if (!totalFirst) bars.push(totalBar);

        const H = 340, padT = 24, padB = 96, padL = 56, padR = 20;
        const plotH = H - padT - padB;
        const vals = [0, ...bars.flatMap(b => [b.start, b.end])];
        let ymax = Math.max(...vals), ymin = Math.min(...vals);
        if (ymax === ymin) { ymax += 1; ymin -= 1; }
        const pad = (ymax - ymin) * 0.1 || 1; ymax += pad; ymin -= pad;
        const range = ymax - ymin;
        const n = bars.length;
        const W = Math.max(560, padL + padR + n * 92);
        const step = (W - padL - padR) / n;
        const bw = step * 0.55;
        const y = v => padT + (ymax - v) / range * plotH;

        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:Arial;font-size:11px;background:#fff;">`;
        svg += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="#bbb"/>`;
        bars.forEach((b, i) => {
            const cx = padL + step * i + step / 2;
            const top = y(Math.max(b.start, b.end));
            const bot = y(Math.min(b.start, b.end));
            const h = Math.max(2, bot - top);
            const fill = b.isTotal ? '#8B0000' : (b.value < 0 ? '#E60000' : '#2E7D32');
            if (b.isTotal) { const dx = totalFirst ? padL + step * (i + 1) : padL + step * i; svg += `<line x1="${dx}" y1="${padT}" x2="${dx}" y2="${H - padB}" stroke="#000" stroke-width="2"/>`; }
            svg += `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${h}" fill="${fill}"/>`;
            svg += `<text x="${cx}" y="${b.value < 0 ? bot + 13 : top - 5}" text-anchor="middle" fill="#333" font-weight="bold">${b.value.toFixed(2)}</text>`;
            const lbl = b.label.length > 16 ? b.label.slice(0, 15) + '…' : b.label;
            svg += `<text x="${cx}" y="${H - padB + 16}" text-anchor="end" fill="#555" transform="rotate(-35 ${cx} ${H - padB + 16})">${esc(lbl)}</text>`;
        });
        svg += `</svg>`;
        return svg;
    }

    function calloutTable(steps, totalValue, opts) {
        opts = opts || {};
        const clampPos = !!opts.clampPos;         // positivos viram 0 (exceto Reverse)
        const decimals = opts.decimals || 0;       // casas do %
        const cv = x => clampPos ? Math.min(0, x) : x;
        const denom = steps.reduce((s, x) => s + Math.abs(cv(x.value)), 0) || 1;
        const fmtPct = p => (decimals > 0 ? p.toFixed(decimals) : String(Math.round(p))) + '%';
        let html = `<table style="border-collapse:collapse;font-size:13px;width:100%;background:#fff;border:1px solid ${C.border};border-radius:8px;overflow:hidden;"><tbody>`;
        // Cabeçalho opcional (ex.: FC HOURS / FC TPH%)
        (opts.header || []).forEach(h => {
            const hv = h.isPct ? h.value.toFixed(2) + '%' : h.value.toFixed(2);
            html += `<tr style="border-bottom:1px solid ${C.border};">
                <td colspan="2" style="padding:6px 12px;font-weight:800;color:${C.dark};">${esc(h.label)}</td>
                <td style="padding:6px 12px;text-align:right;font-weight:800;color:${C.dark};">${hv}</td></tr>`;
        });
        html += `<tr style="background:${C.light};"><td colspan="3" style="padding:8px 12px;text-align:center;font-weight:700;color:${C.dark};">${esc(opts.title || 'Call Out')}</td></tr>`;
        steps.forEach(s => {
            const value = cv(s.value);
            const pctv = fmtPct(Math.abs(value) / denom * 100);
            html += `<tr style="border-top:1px solid ${C.border};">
                <td style="padding:6px 12px;color:${C.dark};">${esc(s.label)}</td>
                <td style="padding:6px 12px;text-align:right;color:${C.dark};">${value.toFixed(2)}</td>
                <td style="padding:6px 12px;text-align:right;color:${C.grey};">${pctv}</td></tr>`;
        });
        const totShown = steps.reduce((s, x) => s + cv(x.value), 0);
        html += `<tr style="border-top:2px solid ${C.dark};font-weight:800;background:${C.light};">
            <td style="padding:7px 12px;">Total</td>
            <td style="padding:7px 12px;text-align:right;">${totShown.toFixed(2)}</td>
            <td style="padding:7px 12px;text-align:right;">100%</td></tr>`;
        html += `</tbody></table>`;
        return html;
    }

    // Texto das mensagens de Call Out (FC HOURS/TPH% + FC block + Support block).
    function calloutText(r) {
        const val = {}, ahrs = {}, ptp = {};
        r.items.forEach(it => { val[canon(it.name)] = toNum(it.pVar); ahrs[canon(it.name)] = toNum(it.aHrs); ptp[canon(it.name)] = toNum(it.pToPlan); });
        const g = name => { const k = canon(name); if (k === 'time off task') return -Math.abs(ahrs[k] || 0); return val[k] || 0; };
        const clamp = v => (v > 0 ? 0 : v); // variação positiva não é call-out → 0

        const tp = canon('THROUGHPUT');
        const fcHours = val[tp] || 0;
        const fcTph = (ptp[tp] || 0) * 100;

        const lines = [];
        lines.push(`FC HOURS\t${fcHours.toFixed(2)}`);
        lines.push(`FC TPH%\t${fcTph.toFixed(2)}%`);

        const fc = [['Transfer-In', 'Transfer-In'], ['Total Inbound', 'Inbound'], ['Outbound', 'Outbound'],
                    ['Transfer-Out', 'Transfer-Out'], ['Reverse Logistics', 'Reverse Logistics'],
                    ['Support', 'Support'], ['Time Off Task', 'Time Off Task']];
        const fcv = fc.map(([n, l]) => ({ l, v: clamp(g(n)) }));
        const fcSum = fcv.reduce((s, x) => s + Math.abs(x.v), 0) || 1;
        fcv.forEach(x => lines.push(`${x.l}\t${x.v.toFixed(2)}\t${(Math.abs(x.v) / fcSum * 100).toFixed(2)}%`));

        const sup = ['Admin/HR/IT', 'On Boarding', 'Non_FC_Controllable', 'IC/QA/CS', 'Facilities'];
        const sv = sup.map(n => ({ l: n, v: clamp(g(n)) }));
        const sSum = sv.reduce((s, x) => s + Math.abs(x.v), 0) || 1;
        sv.forEach(x => lines.push(`${x.l}\t${x.v.toFixed(2)}\t${Math.round(Math.abs(x.v) / sSum * 100)}%`));

        return lines.join('\n');
    }

    function showCharts(r) {
        document.getElementById('ppr-charts')?.remove();
        const val = {}, ahrs = {}, ptp = {};
        r.items.forEach(it => { val[canon(it.name)] = toNum(it.pVar); ahrs[canon(it.name)] = toNum(it.aHrs); ptp[canon(it.name)] = toNum(it.pToPlan); });
        const disp = nm => nm === 'Total Inbound' ? 'Inbound' : nm; // rótulo amigável
        const g = name => {
            const k = canon(name);
            // Time Off Task não tem plano → usa o Actual Hours negativo.
            if (k === 'time off task') return -Math.abs(ahrs[k] || 0);
            return val[k] || 0;
        };

        const span = spanLabel();
        const isDay = span === 'day';
        const spanTxt = span === 'week' ? 'Week' : (span === 'day' ? 'Day' : span.toUpperCase());

        const modal = document.createElement('div');
        modal.id = 'ppr-charts';
        modal.style.cssText = `position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:'Amazon Ember',Arial,sans-serif;animation:pprFade .18s ease;`;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        const box = document.createElement('div');
        box.style.cssText = `background:#fff;border-radius:16px;overflow:hidden;width:96%;max-width:1000px;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:pprPop .24s ease;`;
        const head = document.createElement('div');
        head.style.cssText = `background:${C.headerGrad};color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${C.accent};`;
        head.innerHTML = `<div style="font-size:16px;font-weight:700;">📊 Gráficos — Plan Variance (Hrs) <span style="font-size:12px;font-weight:700;color:#232F3E;background:${C.accent};padding:2px 10px;border-radius:20px;margin-left:6px;">${isDay ? '☀️ Day' : '📅 ' + spanTxt}</span></div>`;
        const x = document.createElement('button');
        x.textContent = '✖';
        x.style.cssText = `background:rgba(255,255,255,0.08);color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;`;
        x.onclick = () => modal.remove();
        head.appendChild(x);

        try { console.log('[PPR] valores Plan Variance:', val); } catch (e) {}
        const body = document.createElement('div');
        body.style.cssText = `overflow:auto;max-height:calc(90vh - 90px);padding:18px 20px;background:${C.bodyBg};`;
        let html = '';
        // Reverse Logistics só aparece no Day.
        const groups = CHART_GROUPS.filter(gr => isDay || gr.title !== 'Reverse Logistics');
        const tpK = canon('THROUGHPUT');
        groups.forEach(gr => {
            const steps = gr.steps.map(nm => ({ label: disp(nm), value: g(nm) }));
            const total = { label: gr.totalLabel, value: g(gr.totalName) };
            let opts;
            if (gr.title === 'FC Total') {
                opts = { clampPos: true, decimals: 2, title: 'Call Out FC',
                    header: [{ label: 'FC HOURS', value: val[tpK] || 0 }, { label: 'FC TPH%', value: (ptp[tpK] || 0) * 100, isPct: true }] };
            } else if (gr.title === 'Reverse Logistics') {
                opts = { clampPos: false, decimals: 0, title: 'Call Out' };
            } else {
                opts = { clampPos: true, decimals: 0, title: 'Call Out' };
            }
            html += `<div class="ppr-group" style="background:#fff;border:1px solid ${C.border};border-radius:12px;padding:16px;margin-bottom:18px;box-shadow:0 2px 10px rgba(35,47,62,0.06);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <div style="font-size:15px;font-weight:800;color:${C.dark};">🎯 ${esc(gr.title)}</div>
                    <button class="ppr-dl" data-title="${esc(gr.title)}" style="background:${C.accent};color:#232F3E;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;">⬇️ Baixar PNG</button>
                </div>
                <div class="ppr-svg" style="overflow:auto;">${waterfallSVG(steps, total, gr.startWithTotal)}</div>
                <div style="margin-top:12px;">${calloutTable(steps, total.value, opts)}</div>
            </div>`;
        });
        body.innerHTML = html;

        // Rodapé: baixar tudo + copiar call out
        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:12px 20px;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;`;
        const btnAll = document.createElement('button');
        btnAll.innerHTML = '⬇️ Baixar tudo (PNG)';
        btnAll.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;`;
        const btnCopyCO = document.createElement('button');
        btnCopyCO.innerHTML = '📋 Copiar Call Out';
        btnCopyCO.style.cssText = `background:${C.accent};color:#232F3E;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;`;
        foot.appendChild(btnAll);
        if (isDay) foot.appendChild(btnCopyCO); // Call Out só no Day

        box.appendChild(head); box.appendChild(body); box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);

        // Download PNG por gráfico (nome: "<grupo> - <day|week>.png")
        body.querySelectorAll('.ppr-dl').forEach(btn => {
            btn.onclick = () => {
                const group = btn.closest('.ppr-group');
                const svg = group && group.querySelector('svg');
                if (!svg) return;
                svgToPng(svg, `${btn.getAttribute('data-title').toLowerCase()} - ${span}.png`);
            };
        });
        // Baixar todos os gráficos (com pequeno intervalo entre downloads)
        btnAll.onclick = () => {
            const groups = [...body.querySelectorAll('.ppr-group')];
            groups.forEach((group, i) => {
                const svg = group.querySelector('svg');
                const t = group.querySelector('.ppr-dl').getAttribute('data-title').toLowerCase();
                if (svg) setTimeout(() => svgToPng(svg, `${t} - ${span}.png`), i * 500);
            });
        };
        // Copiar mensagens de Call Out
        btnCopyCO.onclick = () => {
            navigator.clipboard.writeText(calloutText(r)).then(() => {
                btnCopyCO.innerHTML = '✅ Copiado!';
                setTimeout(() => btnCopyCO.innerHTML = '📋 Copiar Call Out', 2000);
            });
        };
    }

    // ── Painel com as linhas ─────────────────────────────────────────────
    function showModal(r) {
        try { console.log('[PPR] resultado:', r); } catch (e) {}
        document.getElementById('ppr-modal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'ppr-modal';
        modal.style.cssText = `position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:'Amazon Ember',Arial,sans-serif;animation:pprFade .18s ease;`;
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        const box = document.createElement('div');
        box.style.cssText = `background:#fff;border-radius:16px;overflow:hidden;width:96%;max-width:1200px;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:pprPop .24s cubic-bezier(.18,.9,.32,1.2);`;

        const head = document.createElement('div');
        head.style.cssText = `background:${C.headerGrad};color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${C.accent};flex-shrink:0;`;
        const _sp = spanLabel(); const _spTxt = _sp === 'week' ? '📅 Week' : (_sp === 'day' ? '☀️ Day' : _sp.toUpperCase());
        head.innerHTML = `<div><div style="font-size:16px;font-weight:700;">📈 Process Path Rollup — Linhas <span style="font-size:12px;font-weight:700;color:#232F3E;background:${C.accent};padding:2px 10px;border-radius:20px;margin-left:6px;">${_spTxt}</span></div><div style="font-size:11px;color:${C.gold};margin-top:3px;">${r.items.length} de ${TARGETS.length} item(ns) encontrado(s)</div></div>`;
        const x = document.createElement('button');
        x.textContent = '✖';
        x.style.cssText = `background:rgba(255,255,255,0.08);color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;`;
        x.onclick = () => modal.remove();
        head.appendChild(x);

        const body = document.createElement('div');
        body.style.cssText = `overflow:auto;max-height:calc(90vh - 150px);padding:18px 20px;background:${C.bodyBg};`;

        if (!r.items.length) {
            body.innerHTML = `<div style="font-size:14px;color:${C.grey};">Nenhum dos Line Items alvo foi encontrado nesta página.<br>Confirme que está no relatório processPathRollup em HTML.</div>`;
        } else {
            let html = `<div style="background:#fff;border:1px solid ${C.border};border-radius:12px;overflow:auto;box-shadow:0 2px 10px rgba(35,47,62,0.06);">
                <table style="border-collapse:collapse;font-size:13px;white-space:nowrap;width:100%;">
                <thead><tr style="background:${C.headerGrad};color:#fff;">`;
            ORANGE.forEach((col, ci) => {
                const sticky = ci === 0 ? `position:sticky;left:0;background:#232F3E;z-index:1;` : '';
                const align = ci === 0 ? 'left' : 'center';
                html += `<th style="padding:10px 12px;text-align:${align};font-weight:600;${sticky}">${esc(col.label)}</th>`;
            });
            html += `</tr></thead><tbody>`;
            r.items.forEach((it, i) => {
                const bg = i % 2 === 0 ? '#fff' : C.light;
                html += `<tr style="background:${bg};border-bottom:1px solid ${C.border};">`;
                ORANGE.forEach((col, ci) => {
                    const raw = cellValue(it, col);
                    const v = String(raw == null ? '' : raw).replace(/,/g, ''); // sem vírgulas
                    const sticky = ci === 0 ? `position:sticky;left:0;background:${bg};` : '';
                    const align = ci === 0 ? 'left' : 'center';
                    const weight = ci === 0 ? 'font-weight:700;' : '';
                    html += `<td style="padding:8px 12px;text-align:${align};color:${C.dark};${weight}${sticky}">${esc(v === '' ? '—' : v)}</td>`;
                });
                html += `</tr>`;
            });
            html += `</tbody></table></div>`;

            if (r.missing.length) {
                html += `<div style="margin-top:14px;background:rgba(232,139,0,0.08);border:1px solid ${C.gold};border-radius:10px;padding:12px 14px;font-size:12px;color:${C.dark};">
                    ⚠️ Não encontrados: <strong>${esc(r.missing.join(', '))}</strong></div>`;
            }
            body.innerHTML = html; // <-- faltava inserir a tabela no painel
        }
        box.appendChild(head);
        box.appendChild(body);

        // Footer: copiar
        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:12px 20px;display:flex;justify-content:flex-end;flex-shrink:0;`;
        const btnCopy = document.createElement('button');
        btnCopy.innerHTML = '📋 Copiar (TSV)';
        btnCopy.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};padding:9px 20px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;`;
        btnCopy.onclick = () => {
            const rows = []; // sem cabeçalho
            r.items.forEach(it => rows.push(ORANGE.map(c => { const val = cellValue(it, c); return String(val == null ? '' : val).replace(/,/g, ''); }).join('\t')));
            navigator.clipboard.writeText(rows.join('\n')).then(() => {
                btnCopy.innerHTML = '✅ Copiado!';
                setTimeout(() => btnCopy.innerHTML = '📋 Copiar (TSV)', 2000);
            });
        };
        const btnCharts = document.createElement('button');
        btnCharts.innerHTML = '📊 Gráficos';
        btnCharts.style.cssText = `background:${C.accent};color:#232F3E;border:none;padding:9px 20px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;margin-right:8px;`;
        btnCharts.onclick = () => showCharts(r);
        foot.appendChild(btnCharts);
        foot.appendChild(btnCopy);
        box.appendChild(foot);

        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // ════════════════════════════════════════════════════════════════════
    // QuickSight (DDD) — lê o visual do dashboard e devolve os process paths
    // na ordem pedida, com Copiar (TSV). Mesmo botão/painel do lado do FCLM.
    // ════════════════════════════════════════════════════════════════════
    const IS_QS = /quicksight\.aws\.amazon\.com$/i.test(location.hostname);

    // Ordem de saída pedida (uma linha por process path).
    const QS_TARGETS = [
        'Each-Receive',
        'Each Transfer In',
        'Prep Recorder',
        'C- Returns Processed',
        'Sort-Batch',
        'Pick',
        'Transfer Out Pick',
        'Pack Multis',
        'Pack Singles',
    ];
    // Chave tolerante: ignora hífen, espaço e caixa ("C- Returns Processed",
    // "C-Returns Processed" e "c returns processed" viram a mesma chave).
    const qsKey = (s) => String(s || '').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[^a-z0-9]+/gi, '').toLowerCase();
    const QS_NAME = {}, QS_ORDER = {};
    QS_TARGETS.forEach((t, i) => { QS_NAME[qsKey(t)] = t; QS_ORDER[qsKey(t)] = i; });
    const QS_KEYSET = new Set(Object.keys(QS_NAME));

    // XPath do visual informado. É a âncora principal, mas o QuickSight é SPA e
    // reescreve a árvore, então existe um fallback por nome mais abaixo.
    const QS_XPATH = '/html/body/div[4]/div/div[2]/div[1]/div/div/div/div/div[2]/div[2]/div[2]/div/div[2]/div/div/div[3]/div/div/div[2]/div/div[2]/div[1]/div[1]';

    function xpathEl(xp) {
        try { return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return null; }
    }
    // Quantos nomes alvo aparecem no texto deste elemento.
    function qsCountNames(el) {
        if (!el) return 0;
        const t = qsKey(el.textContent || '');
        let n = 0;
        QS_KEYSET.forEach(k => { if (t.indexOf(k) >= 0) n++; });
        return n;
    }
    // Primeiro elemento cujo texto é exatamente um dos nomes alvo (semente do fallback).
    function qsSeed() {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = w.nextNode())) {
            const k = qsKey(node.nodeValue);
            if (k && QS_KEYSET.has(k)) return node.parentElement;
        }
        return null;
    }
    // O visual é uma tabela dinâmica do QuickSight (".sn-table"). Ela NÃO é um
    // <table>: os NOMES das linhas ficam em .row-headers-container e os VALORES em
    // .fixed-grid-wrapper .grid, em containers separados e posicionados por CSS.
    // O que liga nome e valor é a POSIÇÃO VERTICAL (style.top), medida a partir do
    // mesmo zero nos dois containers. Como reforço existe o par de índices
    // data-row-index (nome) → data-row-path (valor), que é o índice + "0".
    // ── Achar cada visual pelo TÍTULO ────────────────────────────────────
    // Os índices do XPath mudam a cada painel aberto/filtro aplicado, mas o
    // título do visual fica no DOM (h2.visual-title-label + data-automation-context).
    // Por isso o título é a âncora principal e o XPath só a reserva.
    const TITLE_PIVOT = /rate\s*na\s*lc\s*por\s*processo/i;      // tabela dinâmica (percentuais)
    const TITLE_ASSOC = /rate\s*dos\s*associados\s*por\s*dia/i;  // tabela dos associados (gráficos)
    // Visuais que NUNCA devem ser lidos aqui (mesmo que tenham a mesma
    // estrutura de tabela dinâmica com process paths e percentuais). O
    // "Share de horas em cada Learning Curve" é a armadilha real: ele também
    // lista os process paths como linhas com valores em %, então sem essa
    // exclusão o painel podia "roubar" a leitura dele em vez do Rate na LC.
    // "UPH na LC por Processo" é outra armadilha do mesmo tipo: mesmos process
    // paths como linhas, mas o valor é produtividade (UPH), não percentual do
    // Rate na LC. "Rate dos Associados por Dia" e "Total de Associados por
    // Processo" também listam os process paths, mas com CONTAGEM de pessoas
    // (não percentual) — essa contagem é usada só na 2ª visão (via CSV), nunca
    // aqui. Só o "Rate na LC por Processo" é a fonte usada nesta leitura.
    const TITLE_EXCLUDE = /share\s*de\s*horas|uph\s*na\s*lc\s*por\s*processo|rate\s*dos\s*associados\s*por\s*dia|total\s*de\s*associados\s*por\s*processo/i;

    // Tabelas dinâmicas cujo visual tem título batendo com `re` (usado para
    // EXCLUIR candidatas, ao contrário de qsTableByTitle que busca UMA para usar).
    function qsExcludedTables(re) {
        const out = new Set();
        document.querySelectorAll('[data-automation-id="analysis_visual_title_label"], .visual-title-label').forEach(n => {
            const t = norm(n.getAttribute('data-automation-context') || n.textContent || '');
            if (!re.test(t)) return;
            const wrap = n.closest('.visual-view') || n.closest('.widget-container') || n.closest('[data-automation-id="grid-block"]');
            if (!wrap) return;
            wrap.querySelectorAll('.sn-table').forEach(tb => out.add(tb));
        });
        return out;
    }

    function qsTableByTitle(re) {
        const nodes = document.querySelectorAll('[data-automation-id="analysis_visual_title_label"], .visual-title-label');
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const t = norm(n.getAttribute('data-automation-context') || n.textContent || '');
            if (!re.test(t)) continue;
            const wrap = n.closest('.visual-view') || n.closest('.widget-container') || n.closest('[data-automation-id="grid-block"]');
            const tb = wrap && [...wrap.querySelectorAll('.sn-table')].filter(isRealTable)[0];
            if (tb) return tb;
        }
        return null;
    }
    // Descarta o "ruler" invisível que o QuickSight mantém para medir colunas.
    function isRealTable(t) { return !!t && !t.querySelector('#ruler-cell') && t.style.visibility !== 'hidden'; }
    // Assinatura de tabela DINÂMICA: tem nomes de linha em .row-headers-container.
    function isPivotTable(t) { return isRealTable(t) && !!t.querySelector('.row-headers-container .row[data-row-index]'); }

    // Que fração das células de valor está em percentual? A tabela "Rate na LC
    // por Processo" é 100% percentual; uma tabela de contagem é 0%. É esse teste
    // que impede o painel de trazer 43/10/52 (contagem) em vez de 113,1%/68,67%.
    function pctShare(t) {
        const cells = [...t.querySelectorAll('.grid .cell[data-row-path]')]
            .map(c => norm(c.getAttribute('title') || c.textContent))
            .filter(v => v !== '');
        if (!cells.length) return 0;
        return cells.filter(v => v.indexOf('%') >= 0).length / cells.length;
    }
    // Candidatas a tabela dinâmica, em ordem de confiança:
    // título → XPath → demais, priorizando as que têm valores em %.
    // Tabelas de visuais em TITLE_EXCLUDE (ex.: "Share de horas em cada Learning
    // Curve") nunca entram na lista, mesmo que pareçam ter os process paths.
    function qsPivotCandidates() {
        const excluded = qsExcludedTables(TITLE_EXCLUDE);
        const out = [];
        const push = (t) => { if (t && !excluded.has(t) && isPivotTable(t) && out.indexOf(t) < 0) out.push(t); };
        push(qsTableByTitle(TITLE_PIVOT));
        const byXp = xpathEl(QS_XPATH);
        push(byXp && (byXp.closest('.sn-table') || byXp.querySelector('.sn-table')));
        const rest = [];
        document.querySelectorAll('.sn-table').forEach(t => {
            if (excluded.has(t) || !isPivotTable(t) || out.indexOf(t) >= 0) return;
            rest.push({ t: t, pct: pctShare(t), n: qsCountNames(t) });
        });
        rest.sort((a, b) => (b.pct - a.pct) || (b.n - a.n));
        rest.forEach(x => out.push(x.t));
        return out;
    }

    // Nomes que a tabela usa internamente e não representam uma linha real.
    const QS_SKIP_NAME = new Set(['', 'undefined', '__hidden-subtotal__']);
    const pxOf = (el, prop) => { const v = parseFloat((el.style && el.style[prop]) || ''); return isNaN(v) ? null : Math.round(v); };

    // Nomes das linhas (só os visíveis e reais), com a posição vertical.
    function qsRowHeaders(root) {
        const out = [];
        root.querySelectorAll('.row-headers-container .row[data-row-index]').forEach(r => {
            if ((r.style.display || '') === 'none') return;         // linhas de apoio ocultas
            const span = r.querySelector('.row-name .title');
            const nm = norm(r.getAttribute('title') || (span ? span.textContent : ''));
            if (QS_SKIP_NAME.has(nm)) return;
            const top = pxOf(r, 'top');
            if (top == null) return;
            out.push({ name: nm, top: top, path: r.getAttribute('data-row-index') || '' });
        });
        return out;
    }
    // Células de valor, com posição e o texto (que o QuickSight repete no title).
    function qsValueCells(root) {
        const out = [];
        root.querySelectorAll('.grid .cell[data-row-path]').forEach(c => {
            const top = pxOf(c, 'top');
            if (top == null) return;
            const inner = c.querySelector('.printable-cell');
            const txt = norm(c.getAttribute('title') || (inner ? inner.textContent : c.textContent));
            out.push({ top: top, left: pxOf(c, 'left') || 0, text: txt,
                       path: c.getAttribute('data-row-path') || '' });
        });
        return out;
    }
    // Valores de uma linha: casa pela posição; se não achar, tenta pelo índice.
    function qsValuesFor(hdr, cells, dec) {
        let hit = cells.filter(c => Math.abs(c.top - hdr.top) <= 2);
        if (!hit.length) hit = cells.filter(c => c.path === hdr.path + '0' || c.path === hdr.path);
        return hit.sort((a, b) => a.left - b.left)
                  .map(c => cleanNumber(c.text, dec))
                  .filter(t => norm(t) !== '');
    }

    // Tenta cada candidata e fica com a PRIMEIRA que devolve percentuais.
    // Sem isso, uma tabela dinâmica de contagem na mesma aba "ganha" a leitura.
    function qsParse() {
        const cands = qsPivotCandidates();
        if (!cands.length) {
            return { items: [], missing: QS_TARGETS.slice(), all: [], mode: '—',
                     error: 'Não achei a tabela dinâmica na página. Espere o visual "Rate na LC por Processo" carregar e clique de novo.' };
        }
        let semPct = null;
        for (let i = 0; i < cands.length; i++) {
            const res = qsParseOne(cands[i]);
            if (!res.items.length) continue;
            const temPct = res.items.some(it => it.values.some(v => String(v).indexOf('%') >= 0));
            if (temPct) return res;
            if (!semPct) semPct = res;
        }
        if (semPct) {
            semPct.warn = 'Os valores lidos não estão em percentual — provavelmente peguei outra tabela dinâmica da aba '
                + '(uma de contagem). Confirme que o visual "Rate na LC por Processo" está visível e clique de novo.';
            return semPct;
        }
        return { items: [], missing: QS_TARGETS.slice(), all: [], mode: '—',
                 error: 'Achei tabelas dinâmicas na página, mas nenhuma tinha os process paths esperados.' };
    }

    function qsParseOne(root) {
        const headers = qsRowHeaders(root);
        const cells = qsValueCells(root);
        const dec = detectDecSep(root.textContent || '');

        // Todas as linhas lidas, na ordem em que aparecem na tela (a ordem do DOM
        // não é a visual). Serve para conferir nomes e ver o que está disponível.
        const all = headers.slice().sort((a, b) => a.top - b.top)
            .map(h => ({ name: h.name, values: qsValuesFor(h, cells, dec) }));

        const found = {};
        all.forEach(row => {
            const k = qsKey(row.name);
            if (!QS_KEYSET.has(k) || found[k]) return;
            found[k] = { name: QS_NAME[k], values: row.values, shown: row.name };
        });

        const items = QS_TARGETS.map(qsKey).filter(k => found[k]).map(k => found[k]);
        const missing = QS_TARGETS.filter(t => !found[qsKey(t)]);
        const mode = 'pivot (' + headers.length + ' linhas / ' + cells.length + ' células)';
        try { console.log('[PPR/QS]', mode, '| root:', root, '| lidas:', all, '| alvos:', items, '| faltando:', missing); } catch (e) {}
        return { items: items, missing: missing, all: all, mode: mode };
    }

    // ════════════════════════════════════════════════════════════════════
    // QuickSight · visão "Rate dos Associados por Dia"
    // Conta, por Processo × Turno, quantas PESSOAS estão acima e abaixo de
    // 100% no Rate LC, e gera gráficos salváveis em PNG (igual ao FCLM).
    // ════════════════════════════════════════════════════════════════════
    const QS_ASSOC_XPATH = '/html/body/div[4]/div/div[2]/div[1]/div/div/div/div/div[2]/div[2]/div[2]/div/div[2]/div/div/div[11]/div/div/div[2]/div';
    const ASSOC_NEED = ['Processo', 'Turno', 'Rate LC'];

    // Títulos das colunas → índice (data-col-index bate com o data-col-path das células).
    function qsHeaderMap(root) {
        const map = {};
        root.querySelectorAll('.column-headers .column[data-col-index]').forEach(c => {
            const t = norm(c.getAttribute('title') || '');
            if (t) map[canon(t)] = c.getAttribute('data-col-index');
        });
        return map;
    }
    // Tem todas as colunas pedidas? (assinatura da tabela dos associados)
    function hasCols(t, names) {
        if (!isRealTable(t)) return false;
        const H = qsHeaderMap(t);
        return Object.keys(H).length > 0 && names.every(x => H[canon(x)] != null);
    }
    // A .sn-table com todas as colunas pedidas (a mais completa, se houver várias).
    function qsTableByColumns(names) {
        let best = null, bestN = 0;
        document.querySelectorAll('.sn-table').forEach(t => {
            if (!hasCols(t, names)) return;
            const n = Object.keys(qsHeaderMap(t)).length;
            if (n > bestN) { bestN = n; best = t; }
        });
        return best;
    }
    // Os GRÁFICOS saem sempre desta tabela ("Rate dos Associados por Dia"):
    // título → XPath → assinatura de colunas. Nunca cai na tabela dinâmica,
    // porque ela não tem as colunas Processo/Turno/Rate LC.
    function qsAssocRoot() {
        const byTitle = qsTableByTitle(TITLE_ASSOC);
        if (hasCols(byTitle, ASSOC_NEED)) return byTitle;
        const byXp = xpathEl(QS_ASSOC_XPATH);
        const fromXp = byXp && (byXp.querySelector('.sn-table') || byXp.closest('.sn-table'));
        if (hasCols(fromXp, ASSOC_NEED)) return fromXp;
        return qsTableByColumns(ASSOC_NEED);
    }

    // "82.77%" e "115,84%" convivem na MESMA tabela, então o último separador
    // é sempre tratado como decimal (percentuais têm 1–2 casas).
    function pctToNum(s) {
        let t = norm(s);
        if (!t || !/\d/.test(t)) return null;
        const neg = /^-/.test(t);
        t = t.replace(/[^\d.,]/g, '');
        const cut = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
        if (cut >= 0) t = t.slice(0, cut).replace(/[.,]/g, '') + '.' + t.slice(cut + 1);
        const n = parseFloat(t);
        if (isNaN(n)) return null;
        return neg ? -n : n;
    }

    // Junta as células visíveis no acumulador (row-path → { col-path: texto }).
    function assocHarvest(root, acc) {
        root.querySelectorAll('.grid .cell[data-row-path][data-col-path]').forEach(c => {
            const r = c.getAttribute('data-row-path'), k = c.getAttribute('data-col-path');
            if (r == null || k == null) return;
            if (!acc[r]) acc[r] = {};
            const inner = c.querySelector('.printable-cell');
            acc[r][k] = norm(c.getAttribute('title') || (inner ? inner.textContent : c.textContent));
        });
    }
    // O QuickSight VIRTUALIZA as linhas: só o que está na viewport existe no DOM.
    // Então rolamos a grade em passos, acumulando por data-row-path, e no fim
    // devolvemos a rolagem para onde estava.
    function assocScrollAll(root, onProgress) {
        return new Promise(resolve => {
            const acc = {};
            const sc = root.querySelector('.grid-container');
            const sizer = root.querySelector('.sizing-element');
            if (!sc) { assocHarvest(root, acc); resolve(acc); return; }
            const totalPx = (sizer && parseFloat(sizer.style.height)) || sc.scrollHeight || 0;
            const estRows = Math.max(1, Math.round(totalPx / 25));
            const step = Math.max(120, (sc.clientHeight || 300) - 60);
            const back = sc.scrollTop;
            let y = 0, guard = 0;
            const tick = () => {
                assocHarvest(root, acc);
                const got = Object.keys(acc).length;
                if (onProgress) onProgress(got, estRows);
                if (y >= totalPx || guard++ > 600) {
                    sc.scrollTop = back;
                    setTimeout(() => { assocHarvest(root, acc); resolve(acc); }, 120);
                    return;
                }
                y += step;
                sc.scrollTop = y;
                setTimeout(tick, 110);
            };
            tick();
        });
    }

    // Linhas úteis: Processo, Turno, Rate LC e quem é a pessoa.
    function assocRows(root, acc) {
        const H = qsHeaderMap(root);
        const cProc = H[canon('Processo')], cTurno = H[canon('Turno')], cRate = H[canon('Rate LC')];
        const cEmp = H[canon('Employee_ID')], cLogin = H[canon('Login')];
        const out = [];
        Object.keys(acc).forEach(r => {
            const row = acc[r];
            const proc = norm(row[cProc] || ''), turno = norm(row[cTurno] || '');
            const rate = pctToNum(row[cRate]);
            if (!proc || !turno || rate == null) return;
            out.push({ proc: proc, turno: turno, rate: rate, who: norm(row[cLogin] || row[cEmp] || ('#' + r)) });
        });
        return out;
    }
    // Agrupa por Processo × Turno contando PESSOAS (a mesma pessoa repetida no
    // grupo conta uma vez, pelo maior Rate LC dela).
    // Conta LOGINS (coluna D) por Processo (F) × Turno (E): quantos estão abaixo
    // de 100% no Rate LC (K) e o total. Login repetido no mesmo grupo conta uma
    // vez, pelo maior Rate LC dele.
    function assocAgg(rows) {
        const g = {};
        rows.forEach(r => {
            const k = r.proc + '||' + r.turno;
            if (!g[k]) g[k] = { proc: r.proc, turno: r.turno, who: {} };
            const cur = g[k].who[r.who];
            if (cur == null || r.rate > cur) g[k].who[r.who] = r.rate;
        });
        return Object.keys(g).map(k => {
            const o = g[k], vals = Object.keys(o.who).map(w => o.who[w]);
            const total = vals.length;
            const abaixo = vals.filter(v => v < 100).length;   // 100% = 1 no CSV
            const acima = total - abaixo;
            return { proc: o.proc, turno: o.turno, total: total, acima: acima, abaixo: abaixo,
                     pctAbaixo: total ? abaixo / total : 0, compliance: total ? acima / total : 0 };
        });
    }
    // Uma entrada por PROCESSO, com os turnos dentro. A ordem segue a lista do
    // DDD; processos fora dela vão para o fim, marcados como extra.
    function assocByProc(agg) {
        const g = {};
        agg.forEach(a => {
            if (!g[a.proc]) g[a.proc] = { proc: a.proc, turnos: [], total: 0, abaixo: 0 };
            g[a.proc].turnos.push(a);
            g[a.proc].total += a.total;
            g[a.proc].abaixo += a.abaixo;
        });
        const list = Object.keys(g).map(k => {
            const o = g[k];
            o.turnos.sort((x, y) => (x.turno < y.turno ? -1 : x.turno > y.turno ? 1 : 0));
            o.acima = o.total - o.abaixo;
            o.pctAbaixo = o.total ? o.abaixo / o.total : 0;
            o.compliance = o.total ? o.acima / o.total : 0;
            const ord = QS_ORDER[qsKey(o.proc)];
            o.rank = (ord == null) ? 900 : ord;
            o.extra = (ord == null);
            return o;
        });
        list.sort((a, b) => a.rank - b.rank || (a.proc < b.proc ? -1 : 1));
        return list;
    }

    // Mede o texto com um canvas 2D real (o script roda no browser), para
    // posicionar o resumo exatamente depois do título, sem sobrepor.
    let __measureCtx = null;
    function textWidth(text, font) {
        try {
            if (!__measureCtx) __measureCtx = document.createElement('canvas').getContext('2d');
            __measureCtx.font = font;
            return __measureCtx.measureText(String(text)).width;
        } catch (e) { return String(text).length * 11; }   // reserva: chute por caractere
    }

    // Uma imagem por PROCESSO: uma barra por turno, empilhada
    // (verde = atingiu 100%, vermelho = abaixo), com o % que atingiu o esperado.
    function procChartSVG(p, note) {
        const rows = p.turnos;
        const W = 900, padL = 160, padR = 250, padT = 104, rowH = 30, gap = 12, padB = 46;
        const H = padT + Math.max(1, rows.length) * (rowH + gap) + padB;
        const barW = W - padL - padR;
        const maxT = Math.max(1, ...rows.map(r => r.total));
        const fnt = "font-family='Amazon Ember,Segoe UI,Arial,sans-serif'";
        const comp = (p.compliance * 100).toFixed(1) + '%';
        const compColor = p.compliance >= 1 ? '#27AE60' : (p.compliance >= 0.8 ? '#E88B00' : '#CC0000');
        let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">';
        s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>';
        // Título do processo + o resumo ("X de Y atingiram · Z abaixo") na mesma linha.
        const titleFont = "700 21px Amazon Ember,Segoe UI,Arial,sans-serif";
        s += '<text x="24" y="36" ' + fnt + ' font-size="21" font-weight="700" fill="#232F3E">' + esc(p.proc) + '</text>';
        const resumoX = 24 + textWidth(p.proc, titleFont) + 16;
        s += '<text x="' + resumoX + '" y="36" ' + fnt + ' font-size="12.5" fill="#607D8B">'
           + p.acima + ' de ' + p.total + ' atingiram · ' + p.abaixo + ' abaixo</text>';
        s += '<text x="24" y="58" ' + fnt + ' font-size="12" fill="#607D8B">Logins por turno · abaixo de 100% no Rate LC</text>';
        // Cartão com o % que atingiu o esperado (100% no Rate LC)
        s += '<rect x="' + (W - 216) + '" y="18" width="192" height="62" rx="10" fill="#F7F7F7" stroke="#E8E8E8"/>';
        s += '<text x="' + (W - 204) + '" y="38" ' + fnt + ' font-size="11" fill="#607D8B">% ATINGIRAM O ESPERADO</text>';
        s += '<text x="' + (W - 204) + '" y="65" ' + fnt + ' font-size="24" font-weight="800" fill="' + compColor + '">' + comp + '</text>';
        // Legenda
        s += '<rect x="24" y="' + (padT - 26) + '" width="11" height="11" fill="#27AE60"/>'
           + '<text x="40" y="' + (padT - 16) + '" ' + fnt + ' font-size="11" fill="#607D8B">atingiu 100%</text>'
           + '<rect x="132" y="' + (padT - 26) + '" width="11" height="11" fill="#CC0000"/>'
           + '<text x="148" y="' + (padT - 16) + '" ' + fnt + ' font-size="11" fill="#607D8B">abaixo de 100%</text>';
        rows.forEach((r, i) => {
            const y = padT + i * (rowH + gap);
            const wA = Math.round(r.acima / maxT * barW);
            const wB = Math.round(r.abaixo / maxT * barW);
            s += '<text x="' + (padL - 12) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" ' + fnt
               + ' font-size="12.5" font-weight="700" fill="#232F3E">' + esc(r.turno) + '</text>';
            s += '<rect x="' + padL + '" y="' + y + '" width="' + barW + '" height="' + rowH + '" fill="#EEF1F4"/>';
            if (wA > 0) s += '<rect x="' + padL + '" y="' + y + '" width="' + wA + '" height="' + rowH + '" fill="#27AE60"/>';
            if (wB > 0) s += '<rect x="' + (padL + wA) + '" y="' + y + '" width="' + wB + '" height="' + rowH + '" fill="#CC0000"/>';
            if (wA >= 24) s += '<text x="' + (padL + wA / 2) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="middle" ' + fnt
                + ' font-size="11.5" font-weight="700" fill="#fff">' + r.acima + '</text>';
            if (wB >= 24) s += '<text x="' + (padL + wA + wB / 2) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="middle" ' + fnt
                + ' font-size="11.5" font-weight="700" fill="#fff">' + r.abaixo + '</text>';
            s += '<text x="' + (padL + barW + 12) + '" y="' + (y + rowH / 2 + 4) + '" ' + fnt + ' font-size="11.5" fill="#232F3E">'
               + '<tspan font-weight="700" fill="#CC0000">' + r.abaixo + '</tspan> de ' + r.total
               + ' abaixo · compliance <tspan font-weight="700">' + (r.compliance * 100).toFixed(1) + '%</tspan></text>';
        });
        if (!rows.length) s += '<text x="24" y="' + (padT + 20) + '" ' + fnt + ' font-size="13" fill="#607D8B">Sem dados.</text>';
        s += '<text x="24" y="' + (H - 16) + '" ' + fnt + ' font-size="11" fill="#607D8B">'
           + esc(note || '') + '</text>';
        s += '</svg>';
        return s;
    }

    // Overlay de progresso enquanto a grade é rolada.
    function assocProgress() {
        const ov = el('div', 'position:fixed;inset:0;z-index:100050;display:flex;align-items:center;justify-content:center;'
            + 'background:rgba(13,19,26,.6);font-family:\'Amazon Ember\',Arial,sans-serif;');
        const box = el('div', 'background:#fff;border-radius:14px;padding:22px 26px;min-width:320px;text-align:center;'
            + 'box-shadow:0 20px 60px rgba(0,0,0,.5);');
        box.appendChild(el('div', 'font-size:15px;font-weight:700;color:' + C.dark + ';margin-bottom:6px;', '📊 Lendo a tabela de associados…'));
        const txt = el('div', 'font-size:12px;color:' + C.grey + ';', 'preparando…');
        box.appendChild(txt);
        box.appendChild(el('div', 'font-size:11px;color:' + C.grey + ';margin-top:10px;line-height:1.5;',
            'O QuickSight só mantém no DOM as linhas visíveis, então preciso rolar a grade até o fim para contar todo mundo.'));
        ov.appendChild(box);
        document.body.appendChild(ov);
        return { set: (a, b) => { txt.textContent = a + ' de ~' + b + ' linha(s) lidas'; }, done: () => ov.remove() };
    }

    // ── Fonte alternativa: CSV exportado do próprio visual ───────────────
    // Ler o DOM do QuickSight é frágil (virtualização, SPA, paginação de 500).
    // O CSV do "Exportar para CSV" do visual traz a tabela COMPLETA, então ele é
    // o caminho confiável: mesmo agrupamento, mesmos gráficos, mesmo PNG.
    function csvSplitLine(line, d) {
        const out = []; let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line.charAt(i);
            if (inQ) {
                if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else inQ = false; }
                else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === d) { out.push(cur); cur = ''; }
            else cur += ch;
        }
        out.push(cur);
        return out;
    }
    function csvParse(text) {
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
        if (!lines.length) return { head: [], rows: [] };
        // Delimitador: conta fora das aspas na 1ª linha.
        const cnt = { ',': 0, ';': 0, '\t': 0 };
        let inQ = false;
        for (const ch of lines[0]) {
            if (ch === '"') inQ = !inQ;
            else if (!inQ && cnt[ch] != null) cnt[ch]++;
        }
        const d = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
        const head = csvSplitLine(lines[0], d).map(norm);
        const rows = lines.slice(1).map(l => csvSplitLine(l, d));
        return { head: head, rows: rows };
    }
    function assocRowsFromCsv(text) {
        const p = csvParse(text);
        if (!p.head.length) return { error: 'Arquivo vazio.' };
        const idx = {};
        p.head.forEach((h, i) => { idx[qsKey(h)] = i; });
        const iProc = idx['processo'], iTurno = idx['turno'], iRate = idx['ratelc'];
        const iEmp = idx['employeeid'], iLogin = idx['login'];
        if (iProc == null || iTurno == null || iRate == null) {
            return { error: 'O CSV precisa ter as colunas Processo, Turno e Rate LC.\nColunas encontradas: ' + p.head.join(' · ') };
        }
        const raw = [];
        p.rows.forEach((c, k) => {
            const proc = norm(c[iProc] || ''), turno = norm(c[iTurno] || '');
            const txt = c[iRate];
            const n = pctToNum(txt);
            if (!proc || !turno || n == null) return;
            // A contagem é por LOGIN (coluna D); Employee_ID só se o login faltar.
            const who = norm((iLogin != null && c[iLogin]) || (iEmp != null && c[iEmp]) || ('#' + k));
            raw.push({ proc: proc, turno: turno, n: n, pct: /%/.test(String(txt || '')), who: who });
        });
        if (!raw.length) return { error: 'Nenhuma linha com Processo, Turno e Rate LC preenchidos.' };
        // O export pode vir como percentual (82,77%) ou como fração (0,8277).
        // A decisão é pela COLUNA inteira, não célula a célula.
        // O export do QuickSight traz fração (1 = 100%); a tela traz "82,77%".
        // Se nenhuma célula tem % e o maior valor é pequeno, é fração → ×100.
        const anyPct = raw.some(r => r.pct);
        const maxAbs = raw.reduce((a, r) => Math.max(a, Math.abs(r.n)), 0);
        const scale = (!anyPct && maxAbs <= 20) ? 100 : 1;
        return { rows: raw.map(r => ({ proc: r.proc, turno: r.turno, rate: r.n * scale, who: r.who })), scaled: scale === 100 };
    }
    // ── Cache do CSV importado ────────────────────────────────────────────
    // Guarda as linhas já processadas (proc/turno/rate/login), não o agregado,
    // para poder reagrupar sem precisar reimportar. Fica em localStorage, então
    // sobrevive a reloads da SPA do QuickSight. Um evento avisa qualquer bloco
    // de status (o do rodapé do painel) para se atualizar quando o cache mudar.
    const ASSOC_CACHE_KEY = 'ppr_ddd_assoc_cache_v1';
    const ASSOC_CACHE_EVENT = 'ppr-assoc-cache-changed';
    function assocCacheGet() {
        try {
            const raw = localStorage.getItem(ASSOC_CACHE_KEY);
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !Array.isArray(o.rows) || !o.rows.length) return null;
            return o;
        } catch (e) { return null; }
    }
    function assocCacheSet(fileName, rows, scaled) {
        try { localStorage.setItem(ASSOC_CACHE_KEY, JSON.stringify({ fileName: fileName, rows: rows, scaled: !!scaled, savedAt: Date.now() })); } catch (e) {}
        try { document.dispatchEvent(new CustomEvent(ASSOC_CACHE_EVENT)); } catch (e) {}
    }
    function assocCacheClear() {
        try { localStorage.removeItem(ASSOC_CACHE_KEY); } catch (e) {}
        try { document.dispatchEvent(new CustomEvent(ASSOC_CACHE_EVENT)); } catch (e) {}
    }

    function openAssocFromCsv() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.csv,.txt,text/csv,text/plain';
        inp.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;';
        document.body.appendChild(inp);
        inp.onchange = () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (!f) return;
            const fr = new FileReader();
            fr.onload = () => {
                // Sem este try/catch, qualquer erro aqui deixava a tela "sem
                // reação" (foi o que aconteceu até a 3.6, com um ReferenceError).
                try {
                    const res = assocRowsFromCsv(String(fr.result || ''));
                    if (res.error) { alert('⚠️ ' + res.error); return; }
                    try { console.log('[PPR/QS-Assoc] CSV', f.name, res.rows.length, 'linha(s), escala', res.scaled ? 'fração→%' : '1:1'); } catch (e) {}
                    assocCacheSet(f.name, res.rows, res.scaled);   // guarda p/ reabrir sem reimportar
                    showAssocCharts(assocAgg(res.rows), res.rows.length, res.rows.length,
                        '📄 ' + f.name + (res.scaled ? ' · Rate LC lido como fração (×100)' : ''));
                } catch (err) {
                    try { console.error('[PPR/QS-Assoc] falha ao montar as imagens:', err); } catch (_) {}
                    alert('⚠️ Erro ao montar as imagens: ' + (err && err.message ? err.message : err)
                        + '\n\nO detalhe completo está no console (F12), com o prefixo [PPR/QS-Assoc].');
                }
            };
            fr.onerror = () => alert('Não consegui ler o arquivo.');
            fr.readAsText(f, 'UTF-8');
        };
        inp.click();
    }

    function openAssocCharts() {
        const root = qsAssocRoot();
        if (!root) {
            // Sem a tabela na página: abre a visão já pedindo o CSV.
            showAssocCharts([], 0, 0, 'tabela não encontrada na página');
            return;
        }
        const pg = assocProgress();
        assocScrollAll(root, pg.set).then(acc => {
            pg.done();
            const rows = assocRows(root, acc);
            const agg = assocAgg(rows);
            try { console.log('[PPR/QS-Assoc] linhas:', rows.length, '| grupos:', agg); } catch (e) {}
            showAssocCharts(agg, rows.length, Object.keys(acc).length, 'tabela do dashboard');
        }).catch(e => {
            pg.done();
            try { console.error('[PPR/QS-Assoc]', e); } catch (_) {}
            showAssocCharts([], 0, 0, 'erro ao ler a tabela');
        });
    }

    function showAssocCharts(agg, nRows, nRaw, source) {
        document.getElementById('ppr-assoc')?.remove();
        const modal = el('div', 'position:fixed;inset:0;z-index:100040;display:flex;align-items:center;justify-content:center;'
            + 'background:rgba(13,19,26,.62);backdrop-filter:blur(3px);font-family:\'Amazon Ember\',Arial,sans-serif;');
        modal.id = 'ppr-assoc';
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        const box = el('div', 'background:#fff;border-radius:16px;overflow:hidden;width:96%;max-width:1080px;max-height:92vh;'
            + 'display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.5);');
        const head = el('div', 'background:' + C.headerGrad + ';color:#fff;padding:16px 22px;display:flex;'
            + 'justify-content:space-between;align-items:center;border-bottom:3px solid ' + C.accent + ';flex-shrink:0;');
        head.innerHTML = '<div><div style="font-size:16px;font-weight:700;">📊 Rate LC — Processo × Turno</div>'
            + '<div style="font-size:11px;color:' + C.gold + ';margin-top:3px;">'
            + (agg.length ? (nRows + ' linha(s) válidas de ' + nRaw + ' lida(s) · pessoas acima e abaixo de 100%')
                          : 'sem dados carregados')
            + (source ? ' · fonte: ' + esc(source) : '') + '</div></div>';
        const x = el('button', 'background:rgba(255,255,255,.08);color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;', '✖');
        x.onclick = () => modal.remove();
        head.appendChild(x);

        const body = el('div', 'overflow:auto;padding:18px 20px;background:' + C.bodyBg + ';flex:1 1 auto;min-height:0;');

        // Sem dados: a visão abre pedindo o CSV do visual (caminho confiável).
        if (!agg.length) {
            body.innerHTML = '<div style="background:#fff;border:1px solid ' + C.border + ';border-radius:12px;padding:22px;">'
                + '<div style="font-size:14px;font-weight:700;color:' + C.dark + ';margin-bottom:8px;">Carregue os dados da tabela</div>'
                + '<div style="font-size:12.5px;color:' + C.grey + ';line-height:1.6;">'
                + 'Não consegui ler a tabela direto da página (' + esc(source || 'sem fonte') + ').<br><br>'
                + 'No visual <b>“Rate dos Associados por Dia”</b>, abra o menu do visual (⋮) → <b>Exportar para CSV</b> '
                + 'e carregue o arquivo aqui. O CSV traz a tabela inteira, sem o corte da virtualização e sem depender do layout do QuickSight.<br><br>'
                + 'Colunas necessárias: <b>Processo</b> (F), <b>Turno</b> (E), <b>Rate LC</b> (K) e <b>Login</b> (D).'
                + '</div></div>';
            const big = el('button', 'width:100%;margin-top:14px;background:' + C.accent + ';color:#232F3E;border:none;'
                + 'border-radius:10px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;', '📄 Carregar CSV do visual');
            big.onclick = () => openAssocFromCsv();
            body.appendChild(big);
            const retry = el('button', 'width:100%;margin-top:8px;background:#fff;border:1px solid ' + C.border
                + ';color:' + C.dark + ';border-radius:10px;padding:10px;font-size:12.5px;font-weight:700;cursor:pointer;',
                '↻ Tentar ler a tabela da página de novo');
            retry.onclick = () => { modal.remove(); openAssocCharts(); };
            body.appendChild(retry);
            box.appendChild(head); box.appendChild(body);
            modal.appendChild(box);
            document.body.appendChild(modal);
            return;
        }

        // UMA IMAGEM POR PROCESSO, com uma barra por turno dentro.
        const procs = assocByProc(agg);
        const note = 'Fonte: ' + (source || '—') + ' · abaixo de 100% = Rate LC < 1';
        const semDados = QS_TARGETS.filter(t => !procs.some(p => qsKey(p.proc) === qsKey(t)));

        let html = '';
        procs.forEach(p => {
            const tag = p.extra
                ? '<span style="font-size:10px;font-weight:800;color:' + C.grey + ';background:#EEF1F4;border-radius:6px;padding:2px 7px;margin-left:8px;">fora da lista do DDD</span>'
                : '';
            html += '<div class="ppr-agroup" style="background:#fff;border:1px solid ' + C.border + ';border-radius:12px;padding:14px;margin-bottom:14px;">'
                + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">'
                + '<div style="font-size:15px;font-weight:800;color:' + C.dark + ';">🎯 ' + esc(p.proc) + tag + '</div>'
                + '<button class="ppr-adl" data-title="' + esc(p.proc) + '" style="background:' + C.accent
                + ';color:#232F3E;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;">⬇️ Baixar PNG</button>'
                + '</div><div class="ppr-svg" style="overflow:auto;">' + procChartSVG(p, note) + '</div></div>';
        });
        if (semDados.length) {
            html += '<div style="margin-bottom:14px;background:rgba(232,139,0,0.08);border:1px solid ' + C.gold
                + ';border-radius:10px;padding:12px 14px;font-size:12px;color:' + C.dark + ';line-height:1.5;">'
                + 'ℹ️ Sem linhas no CSV para: <strong>' + esc(semDados.join(', ')) + '</strong> — nenhuma imagem gerada para esses processos.</div>';
        }

        // Tabela com os números (Processo × Turno).
        html += '<div style="background:#fff;border:1px solid ' + C.border + ';border-radius:12px;overflow:auto;">'
            + '<table style="border-collapse:collapse;font-size:12.5px;width:100%;white-space:nowrap;">'
            + '<thead><tr style="background:' + C.headerGrad + ';color:#fff;">'
            + '<th style="padding:9px 12px;text-align:left;">Processo</th><th style="padding:9px 12px;text-align:left;">Turno</th>'
            + '<th style="padding:9px 12px;text-align:center;">Logins</th>'
            + '<th style="padding:9px 12px;text-align:center;">Abaixo 100%</th>'
            + '<th style="padding:9px 12px;text-align:center;">Atingiu 100%</th>'
            + '<th style="padding:9px 12px;text-align:center;">% abaixo</th>'
            + '<th style="padding:9px 12px;text-align:center;">Compliance</th></tr></thead><tbody>';
        procs.forEach(p => {
            // Linha do processo (total) e depois cada turno.
            html += '<tr style="background:#F0F3F6;border-bottom:1px solid ' + C.border + ';">'
                + '<td style="padding:7px 12px;font-weight:800;color:' + C.dark + ';">' + esc(p.proc) + '</td>'
                + '<td style="padding:7px 12px;color:' + C.grey + ';font-size:11px;">TOTAL</td>'
                + '<td style="padding:7px 12px;text-align:center;font-weight:800;color:' + C.dark + ';">' + p.total + '</td>'
                + '<td style="padding:7px 12px;text-align:center;font-weight:800;color:' + C.red + ';">' + p.abaixo + '</td>'
                + '<td style="padding:7px 12px;text-align:center;font-weight:800;color:' + C.green + ';">' + p.acima + '</td>'
                + '<td style="padding:7px 12px;text-align:center;font-weight:800;color:' + C.red + ';">' + (p.pctAbaixo * 100).toFixed(1) + '%</td>'
                + '<td style="padding:7px 12px;text-align:center;font-weight:800;color:' + C.green + ';">' + (p.compliance * 100).toFixed(1) + '%</td></tr>';
            p.turnos.forEach(a => {
                html += '<tr style="background:#fff;border-bottom:1px solid ' + C.border + ';">'
                    + '<td style="padding:6px 12px 6px 26px;color:' + C.grey + ';">↳</td>'
                    + '<td style="padding:6px 12px;color:' + C.dark + ';">' + esc(a.turno) + '</td>'
                    + '<td style="padding:6px 12px;text-align:center;color:' + C.dark + ';">' + a.total + '</td>'
                    + '<td style="padding:6px 12px;text-align:center;color:' + C.red + ';">' + a.abaixo + '</td>'
                    + '<td style="padding:6px 12px;text-align:center;color:' + C.green + ';">' + a.acima + '</td>'
                    + '<td style="padding:6px 12px;text-align:center;color:' + C.red + ';">' + (a.pctAbaixo * 100).toFixed(1) + '%</td>'
                    + '<td style="padding:6px 12px;text-align:center;color:' + C.green + ';">' + (a.compliance * 100).toFixed(1) + '%</td></tr>';
            });
        });
        html += '</tbody></table></div>';
        body.innerHTML = html;

        const foot = el('div', 'background:#fff;border-top:1px solid ' + C.border + ';padding:12px 20px;display:flex;'
            + 'justify-content:flex-end;gap:8px;flex-shrink:0;');
        const hint = el('div', 'flex:1;font-size:11px;color:' + C.grey + ';align-self:center;line-height:1.4;',
            'Compliance = logins que atingiram 100% ÷ total de logins. Login repetido no mesmo processo e turno conta uma vez.');
        const btnAll = el('button', 'background:' + C.btnGrad + ';color:#fff;border:2px solid ' + C.accent
            + ';padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;', '⬇️ Baixar tudo (PNG)');
        const btnLoad = el('button', 'background:#fff;border:1px solid ' + C.border + ';color:' + C.dark
            + ';padding:9px 16px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;', '📄 Trocar por CSV');
        btnLoad.title = 'Usar o CSV exportado do visual (dados completos, sem virtualização)';
        btnLoad.onclick = () => openAssocFromCsv();
        const btnDom = el('button', 'background:#fff;border:1px solid ' + C.border + ';color:' + C.grey
            + ';padding:9px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12.5px;', '↻ Ler da página');
        btnDom.title = 'Tentar ler a tabela direto do dashboard (pode ser cortada pela virtualização)';
        btnDom.onclick = () => { modal.remove(); openAssocCharts(); };
        const btnCsv = el('button', 'background:' + C.accent + ';color:#232F3E;border:none;padding:9px 18px;'
            + 'border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;', '📋 Copiar (TSV)');
        btnCsv.onclick = () => {
            const lines = [['Processo', 'Turno', 'Logins', 'Abaixo 100%', 'Atingiu 100%', '% abaixo', 'Compliance'].join('\t')];
            procs.forEach(p => {
                lines.push([p.proc, 'TOTAL', p.total, p.abaixo, p.acima,
                    (p.pctAbaixo * 100).toFixed(1) + '%', (p.compliance * 100).toFixed(1) + '%'].join('\t'));
                p.turnos.forEach(a => lines.push([p.proc, a.turno, a.total, a.abaixo, a.acima,
                    (a.pctAbaixo * 100).toFixed(1) + '%', (a.compliance * 100).toFixed(1) + '%'].join('\t')));
            });
            navigator.clipboard.writeText(lines.join('\n')).then(() => {
                btnCsv.innerHTML = '✅ Copiado!';
                setTimeout(() => btnCsv.innerHTML = '📋 Copiar (TSV)', 2000);
            });
        };
        foot.appendChild(hint); foot.appendChild(btnDom); foot.appendChild(btnLoad);
        foot.appendChild(btnCsv); foot.appendChild(btnAll);

        box.appendChild(head); box.appendChild(body); box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);

        body.querySelectorAll('.ppr-adl').forEach(btn => {
            btn.onclick = () => {
                const grp = btn.closest('.ppr-agroup');
                const svg = grp && grp.querySelector('svg');
                if (svg) svgToPng(svg, 'rate lc - ' + btn.getAttribute('data-title').toLowerCase().replace(/[\\/:*?"<>|]/g, '') + '.png');
            };
        });
        btnAll.onclick = () => {
            [...body.querySelectorAll('.ppr-agroup')].forEach((g, i) => {
                const svg = g.querySelector('svg');
                const dl = g.querySelector('.ppr-adl');
                const t = dl ? dl.getAttribute('data-title') : ('grafico ' + (i + 1));
                if (svg) setTimeout(() => svgToPng(svg, 'rate lc - ' + String(t).toLowerCase() + '.png'), i * 500);
            });
        };
    }

    // ── Painel do QuickSight ─────────────────────────────────────────────
    function qsShowModal(r) {
        document.getElementById('ppr-modal')?.remove();
        const nCols = Math.max(1, ...r.items.map(it => it.values.length));
        const modal = document.createElement('div');
        modal.id = 'ppr-modal';
        modal.style.cssText = `position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(13,19,26,0.62);backdrop-filter:blur(3px);font-family:'Amazon Ember',Arial,sans-serif;animation:pprFade .18s ease;`;
        // Fecho único (backdrop e ✖ passam por aqui) para nunca deixar o
        // listener do cache do CSV (ASSOC_CACHE_EVENT) vazando quando o modal fecha.
        const closeModal = () => { document.removeEventListener(ASSOC_CACHE_EVENT, renderAssocBox); modal.remove(); };
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

        const box = document.createElement('div');
        box.style.cssText = `background:#fff;border-radius:16px;overflow:hidden;width:96%;max-width:1000px;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:pprPop .24s cubic-bezier(.18,.9,.32,1.2);`;

        const head = document.createElement('div');
        head.style.cssText = `background:${C.headerGrad};color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid ${C.accent};flex-shrink:0;`;
        head.innerHTML = `<div><div style="font-size:16px;font-weight:700;">📊 QuickSight — Process Paths <span style="font-size:12px;font-weight:700;color:#232F3E;background:${C.accent};padding:2px 10px;border-radius:20px;margin-left:6px;">DDD</span></div>`
            + `<div style="font-size:11px;color:${C.gold};margin-top:3px;">${r.items.length} de ${QS_TARGETS.length} process path(s) encontrado(s) · leitura por ${esc(r.mode)}</div></div>`;
        const x = document.createElement('button');
        x.textContent = '✖';
        x.style.cssText = `background:rgba(255,255,255,0.08);color:#fff;border:none;border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:14px;`;
        x.onclick = () => closeModal();
        head.appendChild(x);

        const body = document.createElement('div');
        body.style.cssText = `overflow:auto;max-height:calc(90vh - 150px);padding:18px 20px;background:${C.bodyBg};`;

        let html = '';
        if (r.error) {
            html += `<div style="font-size:13px;color:${C.grey};line-height:1.6;margin-bottom:14px;">${esc(r.error)}</div>`;
        }
        if (r.warn) {
            html += `<div style="margin-bottom:14px;background:rgba(204,0,0,0.06);border:1px solid ${C.red};border-radius:10px;`
                + `padding:12px 14px;font-size:12.5px;color:${C.dark};line-height:1.5;">⚠️ ${esc(r.warn)}</div>`;
        }
        // Tabela com as 9 linhas SEMPRE na ordem pedida. O que não foi lido vira N/I.
        {
            const byK = {};
            r.items.forEach(it => { byK[qsKey(it.name)] = it; });
            html += `<div style="background:#fff;border:1px solid ${C.border};border-radius:12px;overflow:auto;box-shadow:0 2px 10px rgba(35,47,62,0.06);">
                <table style="border-collapse:collapse;font-size:13px;white-space:nowrap;width:100%;">
                <thead><tr style="background:${C.headerGrad};color:#fff;">
                <th style="padding:10px 12px;text-align:left;font-weight:600;position:sticky;left:0;background:#232F3E;z-index:1;">Process Path</th>`;
            for (let i = 0; i < nCols; i++) html += `<th style="padding:10px 12px;text-align:center;font-weight:600;">Valor ${i + 1}</th>`;
            html += `</tr></thead><tbody>`;
            QS_TARGETS.forEach((t, i) => {
                const it = byK[qsKey(t)];
                const vals = it ? it.values : [];
                const bg = i % 2 === 0 ? '#fff' : C.light;
                html += `<tr style="background:${bg};border-bottom:1px solid ${C.border};">`
                    + `<td style="padding:8px 12px;text-align:left;color:${C.dark};font-weight:700;position:sticky;left:0;background:${bg};">${esc(t)}</td>`;
                if (!vals.length) {
                    const why = it ? 'linha expandida ou subtotal desligado' : 'grupo recolhido no visual';
                    html += `<td colspan="${nCols}" style="padding:8px 12px;text-align:center;color:${C.grey};">`
                        + `<strong style="color:${C.red};">N/I</strong> <span style="font-size:11px;">(${esc(why)})</span></td>`;
                } else {
                    for (let c = 0; c < nCols; c++) {
                        const v = vals[c];
                        html += `<td style="padding:8px 12px;text-align:center;color:${C.dark};">${esc(v == null || v === '' ? 'N/I' : v)}</td>`;
                    }
                }
                html += `</tr>`;
            });
            html += `</tbody></table></div>`;
        }
        if (r.missing.length) {
            html += `<div style="margin-top:14px;background:rgba(232,139,0,0.08);border:1px solid ${C.gold};border-radius:10px;padding:12px 14px;font-size:12px;color:${C.dark};line-height:1.5;">
                ⚠️ Saíram como <strong>N/I</strong>: ${esc(r.missing.join(', '))}<br>
                Esses process paths só aparecem quando o grupo correspondente está expandido no visual. Expanda o grupo (botão +) e clique no DDD de novo.</div>`;
        }
        // O espelho "Todas as linhas lidas do visual" foi retirado da tela: ele
        // mostrava também o Share de horas em cada Learning Curve (DA/Inbound/
        // Outbound, sem %) misturado com os process paths do Rate na LC — o que
        // confundia a leitura, já que só o Rate na LC por Processo é o dado usado
        // aqui. O r.all continua disponível só no console (F12 → [PPR/QS]) para
        // depuração, sem aparecer na tela.
        if (!html) {
            html = `<div style="font-size:14px;color:${C.grey};line-height:1.6;">Não consegui ler nada do visual.<br><br>`
                + `Abra o console (F12) e procure por <strong>[PPR/QS]</strong>: ele mostra a tabela que encontrei e o que foi extraído.</div>`;
        }
        body.innerHTML = html;
        box.appendChild(head);
        box.appendChild(body);

        // Footer: copiar nome + valores, ou só os valores (na ordem pedida).
        const foot = document.createElement('div');
        foot.style.cssText = `background:#fff;border-top:1px solid ${C.border};padding:12px 20px;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;`;
        const mkCopy = (label, fn) => {
            const b = document.createElement('button');
            b.innerHTML = label;
            b.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};padding:9px 20px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;`;
            b.onclick = () => navigator.clipboard.writeText(fn()).then(() => {
                b.innerHTML = '✅ Copiado!';
                setTimeout(() => b.innerHTML = label, 2000);
            });
            return b;
        };
        // A cópia sai SEMPRE com as 9 linhas na ordem pedida: o que não foi
        // encontrado vira linha vazia, para não desalinhar a colagem na planilha.
        const byKey = {};
        r.items.forEach(it => { byKey[qsKey(it.name)] = it; });
        // Sem valor lido → 'N/I' (uma célula), para a coluna nunca ficar vazia.
        const valsOf = (t) => { const it = byKey[qsKey(t)]; return (it && it.values.length) ? it.values : ['N/I']; };
        const onlyVals = () => QS_TARGETS.map(t => valsOf(t).join('\t')).join('\n');
        const withName = () => QS_TARGETS.map(t => [t].concat(valsOf(t)).join('\t')).join('\n');
        const bVals = mkCopy('📋 Copiar só os valores', onlyVals);
        bVals.style.background = C.accent; bVals.style.color = '#232F3E'; bVals.style.border = 'none';
        const hint = document.createElement('div');
        hint.textContent = 'A cópia sai com as 9 linhas na ordem do DDD; o que não foi lido vem como N/I.';
        hint.style.cssText = `flex:1;font-size:11px;color:${C.grey};align-self:center;`;
        foot.appendChild(hint);
        // Status do CSV da visão "Rate dos Associados por Dia": um único bloco
        // que reflete se já há dados carregados (cache) ou não.
        //   • sem cache  → botão "📄 Importar CSV" (abre o seletor de arquivo).
        //   • com cache  → nome do arquivo (clicável, reabre os gráficos já
        //     gerados sem reimportar) + botão "🗑 Limpar" ao lado.
        const assocBox = document.createElement('div');
        assocBox.style.cssText = `display:flex;align-items:center;gap:6px;`;
        function renderAssocBox() {
            assocBox.textContent = '';
            const cache = assocCacheGet();
            if (!cache) {
                const bImport = document.createElement('button');
                bImport.innerHTML = '📄 Importar CSV';
                bImport.title = 'Importar o CSV do visual "Rate dos Associados por Dia": conta os logins abaixo de 100% no Rate LC por processo e turno e gera um PNG por processo';
                bImport.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.gold};padding:9px 16px;`
                    + `border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;`;
                bImport.onclick = () => openAssocFromCsv();
                assocBox.appendChild(bImport);
                return;
            }
            const bShow = document.createElement('button');
            bShow.innerHTML = '📊 ' + esc(cache.fileName) + ' — ver gráficos';
            bShow.title = 'Dados já carregados. Clique para ver os gráficos por processo (sem reimportar).';
            bShow.style.cssText = `background:${C.accent};color:#232F3E;border:none;padding:9px 16px;`
                + `border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;max-width:260px;`
                + `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
            bShow.onclick = () => showAssocCharts(assocAgg(cache.rows), cache.rows.length, cache.rows.length,
                '📄 ' + cache.fileName + (cache.scaled ? ' · Rate LC lido como fração (×100)' : ''));
            const bClear = document.createElement('button');
            bClear.innerHTML = '🗑';
            bClear.title = 'Limpar os dados carregados e importar um novo CSV';
            bClear.style.cssText = `background:#fff;border:1.5px solid ${C.red};color:${C.red};width:38px;height:38px;`
                + `border-radius:8px;cursor:pointer;font-weight:800;font-size:14px;flex:none;`;
            bClear.onclick = () => { assocCacheClear(); document.getElementById('ppr-assoc')?.remove(); };
            assocBox.appendChild(bShow);
            assocBox.appendChild(bClear);
        }
        renderAssocBox();
        // O cartão se atualiza sozinho se o cache mudar por outra via (ex.: o
        // usuário limpou/importou pela própria visão de gráficos aberta).
        // O listener é removido em closeModal(), definido no topo da função.
        document.addEventListener(ASSOC_CACHE_EVENT, renderAssocBox);

        foot.appendChild(assocBox);
        foot.appendChild(bVals);
        foot.appendChild(mkCopy('📋 Copiar nome + valores', withName));
        box.appendChild(foot);

        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // No QuickSight a 1ª tabela dinâmica ("Rate na LC por Processo") só
    // carrega com a página no topo, e o CSV do "Rate dos Associados por Dia"
    // fica no fim da página — então rolar manualmente toda vez é chato.
    // Tenta rolar a WINDOW (caso comum) e também um container interno com
    // rolagem própria, se existir (alguns dashboards do QuickSight rolam a
    // folha dentro de uma div, não a window).
    function qsScrollRoot() {
        const anchor = document.querySelector('.visual-view');
        let node = anchor && anchor.parentElement;
        while (node && node !== document.documentElement) {
            if (node.scrollHeight - node.clientHeight > 80) {
                const cs = getComputedStyle(node);
                if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return node;
            }
            node = node.parentElement;
        }
        return null;
    }
    function qsScrollPage(pos) {
        const top = pos === 'top';
        const inner = qsScrollRoot();
        if (inner) {
            try { inner.scrollTo({ top: top ? 0 : inner.scrollHeight, behavior: 'smooth' }); }
            catch (e) { inner.scrollTop = top ? 0 : inner.scrollHeight; }
        }
        try { window.scrollTo({ top: top ? 0 : document.body.scrollHeight, behavior: 'smooth' }); }
        catch (e) { window.scrollTo(0, top ? 0 : document.body.scrollHeight); }
        const de = document.scrollingElement || document.documentElement;
        if (de) de.scrollTop = top ? 0 : de.scrollHeight;
    }

    // ── Botão flutuante FIXO (canto inferior direito) + balão de ajuda ──
    function injectButton() {
        if (document.getElementById('ppr-wrap')) return;
        const wrap = document.createElement('div');
        wrap.id = 'ppr-wrap';
        wrap.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:99990;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-family:'Amazon Ember',Arial,sans-serif;`;

        // Balão de ajuda (aparece ao passar o mouse no "?")
        const bubble = document.createElement('div');
        bubble.textContent = IS_QS
            ? 'Este painel lê o visual deste dashboard do QuickSight e devolve os process paths na ordem do DDD (Each-Receive, Each Transfer In, Prep Recorder, C- Returns Processed, Sort-Batch, Pick, Transfer Out Pick, Pack Multis, Pack Singles), prontos para copiar.'
            : 'Este painel lê e filtra as informações contidas nesta página (Process Path Rollup): mostra as linhas selecionadas, os gráficos por área e permite copiar/baixar os dados.';
        bubble.style.cssText = `display:none;max-width:250px;background:#232F3E;color:#fff;font-size:11px;line-height:1.45;padding:9px 11px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,0.35);border:1px solid ${C.accent};`;

        const help = document.createElement('div');
        help.textContent = '?';
        help.title = 'O que é isso?';
        help.style.cssText = `width:22px;height:22px;border-radius:50%;background:${C.accent};color:#232F3E;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;cursor:help;box-shadow:0 2px 6px rgba(0,0,0,0.3);`;
        help.onmouseenter = () => { bubble.style.display = 'block'; };
        help.onmouseleave = () => { bubble.style.display = 'none'; };

        const btn = document.createElement('button');
        btn.id = 'ppr-btn';
        btn.textContent = 'DDD';
        btn.title = IS_QS ? 'Ler os process paths do visual do QuickSight' : 'Ler as linhas da página';
        btn.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};border-radius:12px;padding:11px 22px;font-size:15px;font-weight:800;letter-spacing:.05em;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.35);`;
        btn.onmouseenter = () => { btn.style.background = C.btnGradH; btn.style.borderColor = C.gold; };
        btn.onmouseleave = () => { btn.style.background = C.btnGrad; btn.style.borderColor = C.accent; };
        btn.onclick = () => IS_QS ? qsShowModal(qsParse()) : showModal(parseRollup(document));

        wrap.appendChild(bubble);
        wrap.appendChild(help);

        // No QuickSight: subir/descer a página inteira, porque a 1ª tabela
        // dinâmica só carrega no topo e o CSV do "Rate dos Associados por
        // Dia" fica no fim — sem isso é preciso rolar manualmente toda vez.
        if (IS_QS) {
            const scrollRow = document.createElement('div');
            scrollRow.style.cssText = `display:flex;gap:6px;`;

            const mkScrollBtn = (label, title, pos) => {
                const b = document.createElement('button');
                b.textContent = label;
                b.title = title;
                b.style.cssText = `background:#fff;border:2px solid ${C.accent};color:${C.dark};border-radius:10px;width:40px;height:38px;font-size:16px;font-weight:800;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,0.25);`;
                b.onmouseenter = () => { b.style.background = C.light; };
                b.onmouseleave = () => { b.style.background = '#fff'; };
                b.onclick = () => qsScrollPage(pos);
                return b;
            };
            scrollRow.appendChild(mkScrollBtn('⬆️', 'Subir toda a página (carregar a 1ª tabela dinâmica)', 'top'));
            scrollRow.appendChild(mkScrollBtn('⬇️', 'Descer toda a página (chegar no CSV do fim)', 'bottom'));
            wrap.appendChild(scrollRow);
        }

        wrap.appendChild(btn);
        document.body.appendChild(wrap);
    }

    function init() {
        injectUICss();
        setTimeout(injectButton, IS_QS ? 2500 : 800);   // QuickSight demora a montar o visual
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    // O QuickSight muda o DOM sem parar, então aqui o re-injetar é debounced.
    let reinj = 0;
    new MutationObserver(() => {
        if (document.getElementById('ppr-wrap')) return;
        clearTimeout(reinj);
        reinj = setTimeout(injectButton, IS_QS ? 600 : 0);
    }).observe(document.body, { childList: true });
})();
