// ==UserScript==
// @name         FCLM - Process Path Rollup (Leitor de Linhas)
// @namespace    http://tampermonkey.net/
// @version      2.9
// @description  Lê linhas específicas (Line Items) do processPathRollup e mostra a linha inteira de cada uma num painel.
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/reports/processPathRollup*
// @grant        none
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
        GAP(), GAP(), GAP(),
        { key: 'pVar',    label: 'Plan Variance (Hrs)' },
        { key: 'pToPlan', label: '% to Plan' },
    ];

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
                    const raw = it[col.key];
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
            r.items.forEach(it => rows.push(ORANGE.map(c => String(it[c.key] == null ? '' : it[c.key]).replace(/,/g, '')).join('\t')));
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

    // ── Botão flutuante FIXO (canto inferior direito) + balão de ajuda ──
    function injectButton() {
        if (document.getElementById('ppr-wrap')) return;
        const wrap = document.createElement('div');
        wrap.id = 'ppr-wrap';
        wrap.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:99990;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-family:'Amazon Ember',Arial,sans-serif;`;

        // Balão de ajuda (aparece ao passar o mouse no "?")
        const bubble = document.createElement('div');
        bubble.textContent = 'Este painel lê e filtra as informações contidas nesta página (Process Path Rollup): mostra as linhas selecionadas, os gráficos por área e permite copiar/baixar os dados.';
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
        btn.title = 'Ler as linhas da página';
        btn.style.cssText = `background:${C.btnGrad};color:#fff;border:2px solid ${C.accent};border-radius:12px;padding:11px 22px;font-size:15px;font-weight:800;letter-spacing:.05em;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.35);`;
        btn.onmouseenter = () => { btn.style.background = C.btnGradH; btn.style.borderColor = C.gold; };
        btn.onmouseleave = () => { btn.style.background = C.btnGrad; btn.style.borderColor = C.accent; };
        btn.onclick = () => showModal(parseRollup(document));

        wrap.appendChild(bubble);
        wrap.appendChild(help);
        wrap.appendChild(btn);
        document.body.appendChild(wrap);
    }

    function init() {
        injectUICss();
        setTimeout(injectButton, 800);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    new MutationObserver(() => injectButton()).observe(document.body, { childList: true });
})();
