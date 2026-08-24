// ==UserScript==
// @name         FCLM - Badge Barcode + Photo (GRU5)
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  No employeeRoster: digite/cole logins ou Employee IDs (ou importe um CSV com as colunas A e B). Pesquisar recarrega o relatório completo do GRU5 e devolve, numa tabela, o Badge Barcode ID em número, o código de barras Code 128 e a foto do crachá. Clique no cabeçalho da coluna para copiar os valores dela. Injeta também a coluna de barcode na tabela do FCLM. Fora do roster completo, "Pesquisar" carrega o link filtrado do GRU5 e a busca roda sozinha ao abrir.
// @author       ladislke
// @icon         https://fclm-portal.amazon.com/resources/images/icon.jpg
// @match        https://fclm-portal.amazon.com/employee/employeeRoster*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==
(function () {
    'use strict';
    if (window.top !== window.self) return;
    if (!/^\/employee\/employeeRoster/i.test(location.pathname)) return;

    // ── Identidade visual (Amazon) ───────────────────────────────────────
    const C = {
        orange: '#FF9900', orangeH: '#E88B00', navy: '#131921', header: '#232F3E',
        bg: '#EAEDED', card: '#FFFFFF', text: '#0F1111', sub: '#6B7178', red: '#D13212',
        border: '#D5D9D9', green: '#067D62',
        headerGrad: 'linear-gradient(135deg,#2C3E50 0%,#232F3E 55%,#131921 100%)',
        ballGrad: 'linear-gradient(145deg,#FFB84D 0%,#FF9900 55%,#E88B00 100%)',
    };
    const FONT = "'Segoe UI',Roboto,Arial,sans-serif";
    const MONO = "Consolas,'Courier New',monospace";

    const K_W = 'bt_panel_w', K_OPEN = 'bt_open', K_PEND = 'bt_pending';

    // Configuração fixa do barcode (sem controles na tela).
    // Para trocar a simbologia, use 'code39' ou 'itf' em SYM.
    const SYM = 'code128';
    const MODULE = 2;        // largura do módulo (px)
    const BC_H = 46;         // altura do barcode no painel
    const PAGE_BC_H = 40;    // altura do barcode na coluna da tabela do FCLM
    const PHOTO_W = 72;      // largura da miniatura da foto no painel

    const PHOTO_BASE = 'https://badgephotos.corp.amazon.com/?employeeid=';

    // Roster do GRU5 já filtrado (Active/LOA/Exempt · AMZN/Temp/3P), só com as colunas úteis
    const ROSTER_URL = 'https://fclm-portal.amazon.com/employee/employeeRoster?reportFormat=HTML&warehouseId=GRU5' +
        '&employeeStatusActive=true&_employeeStatusActive=on&employeeStatusLeaveOfAbsence=true&_employeeStatusLeaveOfAbsence=on' +
        '&employeeStatusExempt=true&_employeeStatusExempt=on&employeeTypeAmzn=true&_employeeTypeAmzn=on' +
        '&employeeTypeTemp=true&_employeeTypeTemp=on&employeeType3Pty=true&_employeeType3Pty=on' +
        '&Employee+ID=Employee+ID&User+ID=User+ID&Employee+Name=Employee+Name&Badge+Barcode+ID=Badge+Barcode+ID' +
        '&Department+ID=Department+ID&Employment+Start+Date=Employment+Start+Date&Employment+Type=Employment+Type' +
        '&Employee+Status=Employee+Status&Manager+Name=Manager+Name&Temp+Agency+Code=Temp+Agency+Code' +
        '&hideColumns=Photo%2CJob+Title%2CManagement+Area+ID%2CShift+Pattern%2CBadge+RFID%2CExempt&submit=true';

    // Pesquisar SEMPRE recarrega a tela no ROSTER_URL (dados novos) levando a busca
    // guardada; quando a página abre, a pesquisa roda sozinha.

    const gv = (k, d) => { try { const v = GM_getValue(k, d); return v == null ? d : v; } catch (e) { return d; } };
    const sv = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };

    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const key = s => String(s == null ? '' : s).replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const photoUrl = empId => PHOTO_BASE + encodeURIComponent(empId);

    // ════════════════════════════════════════════════════════════════════
    // 1) Motor de código de barras (sem dependência externa / sem CDN)
    //    Cada simbologia devolve uma lista de segmentos {w: módulos, bar: bool}
    // ════════════════════════════════════════════════════════════════════

    // Code 128: 107 padrões (0..105 = dados, 106 = stop). Cada dígito = largura
    // de um elemento, alternando barra/espaço começando por barra.
    const C128 = [
        '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
        '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
        '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
        '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
        '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
        '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
        '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
        '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
        '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
        '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
        '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
    ];

    // Estratégia: só dígitos → Code C (par) ou B+switch C (ímpar); resto → Code B.
    function c128Values(data) {
        const vals = [];
        if (/^\d+$/.test(data)) {
            let s = data;
            if (s.length % 2 === 1) { vals.push(104); vals.push(s.charCodeAt(0) - 32); vals.push(99); s = s.slice(1); }
            else vals.push(105);
            for (let i = 0; i < s.length; i += 2) vals.push(parseInt(s.substr(i, 2), 10));
        } else {
            vals.push(104);
            for (const ch of data) { let c = ch.charCodeAt(0); if (c < 32 || c > 126) c = 63; vals.push(c - 32); }
        }
        let sum = vals[0];
        for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
        vals.push(sum % 103);
        vals.push(106);
        return vals;
    }
    function enc128(data) {
        const segs = [];
        c128Values(data).forEach(v => {
            const p = C128[v]; if (!p) return;
            for (let i = 0; i < p.length; i++) segs.push({ w: +p[i], bar: i % 2 === 0 });
        });
        return segs;
    }

    // Code 39 (n = estreito, w = largo, ratio 1:3), start/stop '*', separador estreito.
    const C39 = {
        '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
        '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
        'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
        'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
        'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
        'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
        'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
        'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
        '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
    };
    function enc39(data) {
        const chars = ('*' + String(data).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '') + '*').split('');
        const segs = [];
        chars.forEach((ch, ci) => {
            const p = C39[ch]; if (!p) return;
            for (let i = 0; i < p.length; i++) segs.push({ w: p[i] === 'w' ? 3 : 1, bar: i % 2 === 0 });
            if (ci < chars.length - 1) segs.push({ w: 1, bar: false });
        });
        return segs;
    }

    // Interleaved 2 of 5 (só dígitos, quantidade par → completa com zero à esquerda)
    const ITF = { '0': 'nnwwn', '1': 'wnnnw', '2': 'nwnnw', '3': 'wwnnn', '4': 'nnwnw', '5': 'wnwnn', '6': 'nwwnn', '7': 'nnnww', '8': 'wnnwn', '9': 'nwnwn' };
    function encItf(data) {
        let s = String(data).replace(/\D/g, '');
        if (!s) return [];
        if (s.length % 2 === 1) s = '0' + s;
        const segs = [{ w: 1, bar: true }, { w: 1, bar: false }, { w: 1, bar: true }, { w: 1, bar: false }];
        for (let i = 0; i < s.length; i += 2) {
            const a = ITF[s[i]], b = ITF[s[i + 1]];
            for (let j = 0; j < 5; j++) {
                segs.push({ w: a[j] === 'w' ? 3 : 1, bar: true });
                segs.push({ w: b[j] === 'w' ? 3 : 1, bar: false });
            }
        }
        segs.push({ w: 3, bar: true }, { w: 1, bar: false }, { w: 1, bar: true });
        return segs;
    }

    const SYMS = {
        code128: { label: 'Code 128', enc: enc128, ok: v => v.length > 0 },
        code39: { label: 'Code 39', enc: enc39, ok: v => /^[0-9A-Za-z\-. $/+%]+$/.test(v) },
        itf: { label: 'ITF (2 de 5)', enc: encItf, ok: v => /^\d+$/.test(v) },
    };
    const symLabel = () => (SYMS[SYM] || {}).label || SYM;
    function encode(value, sym) {
        const s = SYMS[sym] || SYMS.code128;
        const v = norm(value);
        if (!v || !s.ok(v)) return null;
        try { const segs = s.enc(v); return segs && segs.length ? segs : null; } catch (e) { return null; }
    }

    // Renderiza os segmentos em SVG (vetorial, imprime nítido em qualquer tamanho)
    function barcodeSVG(segs, opt) {
        opt = opt || {};
        const m = opt.module || 2, h = opt.height || 60, quiet = opt.quiet == null ? 10 : opt.quiet;
        const text = opt.text == null ? '' : String(opt.text), fs = opt.fontSize || 15;
        const units = segs.reduce((a, s) => a + s.w, 0) + quiet * 2;
        const W = units * m, tH = text ? fs + 6 : 0, H = h + tH;
        let x = quiet * m, rects = '';
        segs.forEach(s => {
            const w = s.w * m;
            if (s.bar) rects += '<rect x="' + x.toFixed(2) + '" y="0" width="' + w.toFixed(2) + '" height="' + h + '"/>';
            x += w;
        });
        const label = text ? '<text x="' + (W / 2).toFixed(2) + '" y="' + (h + fs) + '" text-anchor="middle" font-family="' + MONO + '" font-size="' + fs + '" letter-spacing="2">' + esc(text) + '</text>' : '';
        return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W.toFixed(0) + '" height="' + H.toFixed(0) + '" viewBox="0 0 ' + W.toFixed(2) + ' ' + H + '" role="img" aria-label="Código de barras ' + esc(text || '') + '">' +
            '<rect x="0" y="0" width="' + W.toFixed(2) + '" height="' + H + '" fill="#fff"/><g fill="#000">' + rects + '</g>' + label + '</svg>';
    }

    // ════════════════════════════════════════════════════════════════════
    // 2) Leitura da tabela inteira do employeeRoster
    // ════════════════════════════════════════════════════════════════════
    const FIELDS = [
        { k: 'empId', re: /^employee id$/ },
        { k: 'userId', re: /^user id$/ },
        { k: 'name', re: /^employee name$/ },
        { k: 'badge', re: /badge barcode/ },
        { k: 'dept', re: /department id/ },
        { k: 'start', re: /employment start/ },
        { k: 'type', re: /employment type/ },
        { k: 'status', re: /employee status/ },
        { k: 'manager', re: /manager name/ },
        { k: 'agency', re: /temp agency/ },
        { k: 'title', re: /job title/ },
        { k: 'shift', re: /shift pattern/ },
        { k: 'rfid', re: /badge rfid/ },
    ];

    function pickTable() {
        let best = null, bestScore = 0;
        [...document.querySelectorAll('table')].forEach(t => {
            const head = key(t.textContent.slice(0, 1200));
            let sc = 0;
            if (/employee id/.test(head)) sc += 4;
            if (/user id/.test(head)) sc += 3;
            if (/employee name/.test(head)) sc += 2;
            if (/badge barcode/.test(head)) sc += 2;
            sc += Math.min(3, t.querySelectorAll('tr').length / 10);
            if (sc > bestScore) { bestScore = sc; best = t; }
        });
        return bestScore >= 6 ? best : null;
    }

    function headerRow(table) {
        let best = null, bestScore = -1;
        [...table.querySelectorAll('tr')].slice(0, 6).forEach(r => {
            const k = key(r.textContent);
            const sc = (/employee id/.test(k) ? 4 : 0) + (/user id/.test(k) ? 3 : 0) +
                (/badge barcode/.test(k) ? 2 : 0) + r.querySelectorAll('th').length * 0.1;
            if (sc > bestScore) { bestScore = sc; best = r; }
        });
        return bestScore > 0 ? best : null;
    }

    function readRoster() {
        const table = pickTable();
        if (!table) return { ok: false, error: 'Tabela do roster não encontrada nesta página.' };
        const hr = headerRow(table);
        if (!hr) return { ok: false, error: 'Cabeçalho da tabela não reconhecido.' };
        const heads = [...hr.children].map(c => key(c.textContent));
        const map = {};
        FIELDS.forEach(f => { const i = heads.findIndex(h => f.re.test(h)); if (i >= 0) map[f.k] = i; });
        if (map.empId == null && heads.length >= 1) map.empId = 0;
        if (map.userId == null && heads.length >= 2) map.userId = 1;
        if (map.name == null && heads.length >= 3) map.name = 2;
        if (map.badge == null && heads.length >= 4) map.badge = 3;

        const rows = [];
        [...table.querySelectorAll('tr')].filter(r => r !== hr && r.querySelector('td')).forEach((tr, i) => {
            const tds = [...tr.children];
            if (tds.length < 3) return;
            const get = k => (map[k] != null && tds[map[k]]) ? norm(tds[map[k]].textContent) : '';
            const o = { i: i, el: tr };
            FIELDS.forEach(f => { o[f.k] = get(f.k); });
            if (!o.empId && !o.userId) return;
            rows.push(o);
        });
        if (!rows.length) return { ok: false, error: 'Tabela encontrada, mas sem linhas de dados.' };
        return { ok: true, rows: rows, map: map, table: table, hasBadge: rows.some(r => r.badge) };
    }

    function buildIndex(rows) {
        const byEmp = new Map(), byUser = new Map();
        rows.forEach(r => {
            if (r.empId) byEmp.set(r.empId.toLowerCase(), r);
            if (r.userId) byUser.set(r.userId.toLowerCase(), r);
        });
        return { byEmp, byUser };
    }

    // Employee ID exato → User ID exato → prefixo/nome
    function resolveToken(tok, rows, idx) {
        const t = norm(tok);
        if (!t) return null;
        const low = t.toLowerCase();
        if (idx.byEmp.has(low)) return { kind: 'ok', row: idx.byEmp.get(low), token: t };
        if (idx.byUser.has(low)) return { kind: 'ok', row: idx.byUser.get(low), token: t };
        const digits = low.replace(/^0+/, '');
        if (digits && idx.byEmp.has(digits)) return { kind: 'ok', row: idx.byEmp.get(digits), token: t };
        if (low.length >= 3) {
            const hits = rows.filter(r => (r.empId || '').toLowerCase().indexOf(low) === 0 ||
                (r.userId || '').toLowerCase().indexOf(low) === 0 ||
                (r.name || '').toLowerCase().indexOf(low) >= 0);
            if (hits.length === 1) return { kind: 'ok', row: hits[0], token: t };
            if (hits.length > 1) return { kind: 'many', hits: hits.slice(0, 8), total: hits.length, token: t };
        }
        return { kind: 'none', token: t };
    }

    // ════════════════════════════════════════════════════════════════════
    // 3) CSV: procura o ID na coluna A e na coluna B
    //    Tem gente que só tem Employee ID e gente que só tem login, então cada
    //    linha do CSV é resolvida pelas duas células; se as duas apontarem para a
    //    mesma pessoa, sai um resultado só.
    // ════════════════════════════════════════════════════════════════════
    function splitCsvLine(line, delim) {
        const out = [];
        let cur = '', inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line.charAt(i);
            if (inQ) {
                if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else inQ = false; }
                else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === delim) { out.push(cur); cur = ''; }
            else cur += ch;
        }
        out.push(cur);
        return out;
    }

    const HEADER_RE = /^(employee|employees|emp|user|users|login|logins|id|ids|badge|matricula|matrícula|nome|name|funcionario|funcionário)\b/i;
    const looksHeader = cells => cells.slice(0, 2).some(c => {
        const v = norm(c);
        return !!v && (/\s/.test(v) || HEADER_RE.test(v));   // ID válido nunca tem espaço
    });

    function csvPairs(text) {
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
        if (!lines.length) return [];
        const counts = { ';': 0, ',': 0, '\t': 0 };
        let inQ = false;
        for (const ch of lines[0]) {
            if (ch === '"') inQ = !inQ;
            else if (!inQ && counts[ch] != null) counts[ch]++;
        }
        const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        const rows = lines.map(l => splitCsvLine(l, delim));
        if (rows.length && looksHeader(rows[0])) rows.shift();
        return rows.map(cells => ({ a: norm(cells[0] || ''), b: norm(cells[1] || '') }))
                   .filter(p => p.a || p.b);
    }

    // Resolve pares (coluna A / coluna B) e remove pessoas repetidas
    function resolvePairs(pairs) {
        const out = [], seenRow = new Set(), seenTok = new Set();
        pairs.forEach(pr => {
            const cands = [pr.a, pr.b].map(norm).filter(Boolean);
            if (!cands.length) return;
            let hit = null, many = null;
            for (const c of cands) {
                const r = resolveToken(c, ROSTER.rows, IDX);
                if (r && r.kind === 'ok') { hit = r; break; }
                if (r && r.kind === 'many' && !many) many = r;
            }
            if (hit) {
                const k = (hit.row.empId || hit.row.userId || '').toLowerCase();
                if (seenRow.has(k)) return;          // mesma pessoa vinda de A e de B
                seenRow.add(k);
                hit.token = cands.join(' / ');
                out.push(hit);
                return;
            }
            if (many) { out.push(many); return; }
            const tok = cands.join(' / ');
            if (seenTok.has(tok.toLowerCase())) return;
            seenTok.add(tok.toLowerCase());
            out.push({ kind: 'none', token: tok });
        });
        return out;
    }

    // Texto colado: cada termo é um "par" com só a coluna A (o dedupe por pessoa
    // continua valendo, então colar 113156306 e bsllcami dá um resultado só).
    const textPairs = text => String(text || '').split(/[\s,;\r\n\t]+/).map(norm).filter(Boolean).map(t => ({ a: t, b: '' }));

    function readCsvFile(file, cb) {
        if (!file) return;
        const fr = new FileReader();
        fr.onload = () => {
            const pairs = csvPairs(fr.result);
            if (!pairs.length) { toast('Nenhum ID nas colunas A/B do arquivo', true); return; }
            cb(pairs, file.name);
        };
        fr.onerror = () => toast('Não consegui ler o arquivo', true);
        fr.readAsText(file, 'UTF-8');
    }

    // ════════════════════════════════════════════════════════════════════
    // 4) Estilos
    // ════════════════════════════════════════════════════════════════════
    function injectCSS() {
        if (document.getElementById('btCss')) return;
        const st = document.createElement('style');
        st.id = 'btCss';
        st.textContent = `
#btPanel{position:fixed;top:0;right:0;height:100vh;width:560px;min-width:360px;max-width:1000px;z-index:2147483000;
  display:flex;flex-direction:column;background:${C.bg};color:${C.text};font-family:${FONT};font-size:13px;
  border-left:1px solid ${C.border};box-shadow:-6px 0 22px rgba(0,0,0,.18);box-sizing:border-box}
#btPanel *{box-sizing:border-box}
#btGrip{position:absolute;left:0;top:0;width:6px;height:100%;cursor:col-resize}
#btGrip:hover{background:${C.orange}55}
#btHead{background:${C.headerGrad};color:#fff;padding:10px 12px;display:flex;align-items:center;gap:8px;flex:0 0 auto}
#btHead .t{font-weight:700;font-size:14px}
#btHead .s{font-size:11px;color:#C9CFD6}
#btHead .sp{flex:1}
.btX{background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:15px;line-height:1}
.btX:hover{background:rgba(255,255,255,.25)}
#btBody{flex:1;overflow:auto;padding:10px}
#btFoot{flex:0 0 auto;background:${C.card};border-top:1px solid ${C.border};padding:6px 10px;font-size:11px;color:${C.sub}}
.btCard{background:${C.card};border:1px solid ${C.border};border-radius:8px;padding:10px;margin-bottom:10px}
.btRow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.btLbl{font-size:11px;font-weight:700;color:${C.sub};text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
.btTa{width:100%;border:1px solid ${C.border};border-radius:6px;padding:7px 9px;font-family:${MONO};font-size:13px;
  background:#fff;color:${C.text};min-height:74px;resize:vertical}
.btTa:focus{outline:2px solid ${C.orange}55;border-color:${C.orange}}
.btBtn{background:${C.orange};color:${C.navy};border:0;border-radius:6px;padding:8px 12px;font-family:${FONT};font-size:13px;font-weight:700;cursor:pointer}
.btBtn:hover{background:${C.orangeH}}
.btBtn.g{background:#fff;color:${C.text};border:1px solid ${C.border};font-weight:600}
.btBtn.g:hover{background:#F3F4F4}
.btBtn:disabled{opacity:.5;cursor:not-allowed}
.btMini{font-size:11px;padding:4px 8px}
label.btBtn{display:inline-block;line-height:normal}
.btFile{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.btTblWrap{background:${C.card};border:1px solid ${C.border};border-radius:8px;overflow:auto}
.btTbl{width:100%;border-collapse:collapse;background:${C.card};font-size:12px}
.btTbl th{position:sticky;top:0;background:${C.header};color:#fff;font-size:11px;text-align:left;padding:6px;font-weight:600;z-index:1;white-space:nowrap}
.btTbl th.btColCopy{cursor:pointer;text-decoration:underline dotted rgba(255,255,255,.5);text-underline-offset:3px}
.btTbl th.btColCopy:hover{color:${C.orange};text-decoration-color:${C.orange}}
.btTbl th.btColCopy:active{color:#fff}
.btTbl td{padding:5px 6px;border-bottom:1px solid #EDEFEF;vertical-align:middle}
.btTbl tbody tr:hover td{background:#FFF6E6}
.btTbl tr.no td{background:#FDECEA}
.btPhCell{width:${PHOTO_W + 12}px;text-align:center;padding:4px !important}
.btPh{width:${PHOTO_W}px;height:auto;display:block;margin:0 auto;border-radius:4px;background:#F3F4F4;cursor:zoom-in}
.btPhNo{font-size:10px;color:${C.sub};line-height:1.2}
.btBcCell{padding:3px 4px !important;text-align:center;background:#fff}
.btBcCell svg{display:block;margin:0 auto}
.btMonoB{font-family:${MONO};font-weight:700}
.btNum{font-family:${MONO};font-weight:700;font-size:13px;color:${C.navy};white-space:nowrap;cursor:pointer}
.btSm{font-size:11px;color:${C.sub}}
.btErr{background:#FDECEA;border:1px solid #F5C6C0;color:${C.red};border-radius:8px;padding:9px;margin-bottom:10px}
.btPill{display:inline-block;background:#EDEFEF;border-radius:10px;padding:1px 7px;font-size:10px;color:${C.sub}}
.btPill.ok{background:#E4F5EF;color:${C.green}}
.btPill.no{background:#FDECEA;color:${C.red}}
#btBall{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:2147483000;width:46px;height:46px;border-radius:50%;
  border:0;cursor:pointer;background:${C.ballGrad};color:${C.navy};font-family:${FONT};font-weight:800;font-size:11px;
  box-shadow:0 4px 14px rgba(0,0,0,.28)}
#btBall:hover{filter:brightness(1.05)}
#btZoom{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;cursor:zoom-out}
#btZoom img{max-width:92vw;max-height:92vh;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.5)}
.btPageTh{white-space:nowrap}
.btPageTd{text-align:center !important;white-space:nowrap;padding:2px 4px !important}
.btPageTd svg{display:block;margin:0 auto}
`;
        document.head.appendChild(st);
    }

    // ════════════════════════════════════════════════════════════════════
    // 5) Estado + painel
    // ════════════════════════════════════════════════════════════════════
    let ROSTER = { ok: false, rows: [] }, IDX = { byEmp: new Map(), byUser: new Map() };
    let LAST = [], PENDING = '';
    let panel = null, ball = null;
    const state = { width: clamp(+gv(K_W, 560), 360, 1000), bulk: '' };

    function setOpen(open) {
        sv(K_OPEN, !!open);
        if (panel) panel.style.display = open ? 'flex' : 'none';
        if (ball) ball.style.display = open ? 'none' : 'block';
        document.body.style.paddingRight = open ? state.width + 'px' : '';
    }

    function toast(msg, bad) {
        const f = panel && panel.querySelector('#btFootTxt');
        if (!f) return;
        f.textContent = msg;
        f.style.color = bad ? C.red : C.green;
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { f.textContent = ''; f.style.color = C.sub; }, 4000);
    }

    function build() {
        injectCSS();
        panel = document.createElement('div');
        panel.id = 'btPanel';
        panel.style.width = state.width + 'px';
        panel.innerHTML = `
<div id="btGrip" title="Arraste para redimensionar"></div>
<div id="btHead">
  <div>
    <div class="t">Badge Barcode + Photo</div>
    <div class="s" id="btCount">lendo tabela…</div>
  </div>
  <div class="sp"></div>
  <button class="btX" id="btGoRoster" title="Abrir o roster do GRU5 filtrado">⤓</button>
  <button class="btX" id="btReload" title="Reler a tabela desta página">⟳</button>
  <button class="btX" id="btClose" title="Fechar painel">✕</button>
</div>
<div id="btBody"></div>
<div id="btFoot"><span id="btFootTxt"></span></div>`;
        document.body.appendChild(panel);

        ball = document.createElement('button');
        ball.id = 'btBall';
        ball.title = 'Abrir Badge Barcode + Photo';
        ball.textContent = 'BADGE';
        ball.onclick = () => setOpen(true);
        document.body.appendChild(ball);

        panel.querySelector('#btClose').onclick = () => setOpen(false);
        panel.querySelector('#btReload').onclick = () => load();
        panel.querySelector('#btGoRoster').onclick = () => { toast('Abrindo o roster do GRU5…'); location.href = ROSTER_URL; };

        const grip = panel.querySelector('#btGrip');
        grip.addEventListener('mousedown', e => {
            e.preventDefault();
            const x0 = e.clientX, w0 = panel.offsetWidth;
            const mv = ev => {
                state.width = clamp(w0 + (x0 - ev.clientX), 360, 1000);
                panel.style.width = state.width + 'px';
                document.body.style.paddingRight = state.width + 'px';
            };
            const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); sv(K_W, state.width); };
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });

        setOpen(gv(K_OPEN, true) !== false);
    }

    // ── Utilidades ──────────────────────────────────────────────────────
    function copyText(t, label) {
        const lines = String(t).split(/\r?\n/).filter(Boolean);
        const done = () => toast(label || ('Copiado: ' + (lines.length > 1 ? lines.length + ' valores' : t)));
        try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(done, fb); } catch (e) {}
        fb();
        function fb() {
            const ta = document.createElement('textarea');
            ta.value = t; ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { toast('Não consegui copiar', true); }
            ta.remove();
        }
    }
    function zoom(url, alt) {
        const ov = document.createElement('div');
        ov.id = 'btZoom';
        ov.innerHTML = '<img src="' + esc(url) + '" alt="' + esc(alt || '') + '">';
        const off = e => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', off); } };
        ov.onclick = () => { ov.remove(); document.removeEventListener('keydown', off); };
        document.addEventListener('keydown', off);
        document.body.appendChild(ov);
    }

    // ── Busca guardada entre navegações (5 min) ─────────────────────────
    function savePending(q) { try { GM_setValue(K_PEND, JSON.stringify({ t: Date.now(), q: String(q || '') })); } catch (e) {} }
    function takePending() {
        let raw = null;
        try { raw = GM_getValue(K_PEND, ''); } catch (e) {}
        try { GM_deleteValue(K_PEND); } catch (e) { try { GM_setValue(K_PEND, ''); } catch (e2) {} }
        if (!raw) return '';
        try { const o = JSON.parse(raw); return (Date.now() - (o.t || 0) < 300000) ? (o.q || '') : ''; } catch (e) { return ''; }
    }
    // Guarda a busca e recarrega o relatório completo do GRU5. Mesmo já estando
    // nessa URL, atribuir de novo recarrega a página, então os dados vêm frescos.
    function goFull(q) {
        savePending(q);
        toast('Atualizando o roster do GRU5…');
        location.href = ROSTER_URL;
    }

    // ── Pesquisa ────────────────────────────────────────────────────────
    function searchPairs(pairs) { LAST = resolvePairs(pairs); render(); }
    function searchText(text) { searchPairs(textPairs(text)); }

    // ── Coluna de barcode DENTRO da tabela da página ────────────────────
    // Render lazy: as 60 primeiras desenham na hora, o resto entra no scroll.
    const EAGER = 60;
    let pageObs = null;

    function fillPageCell(td) {
        if (!td || td.dataset.btDone) return;
        const v = td.getAttribute('data-badge');
        td.innerHTML = v ? bcCell(v, PAGE_BC_H) : '';
        td.dataset.btDone = '1';
    }
    function removePageCol() {
        if (pageObs) { try { pageObs.disconnect(); } catch (e) {} pageObs = null; }
        document.querySelectorAll('.btPageTh,.btPageTd').forEach(e => e.remove());
    }
    function injectPageCol() {
        removePageCol();
        if (!ROSTER.ok) return;
        const hr = headerRow(ROSTER.table);
        if (!hr) return;
        const nCols = hr.children.length;
        const at = clamp((ROSTER.map.badge != null ? ROSTER.map.badge + 1 : nCols), 0, nCols);

        const model = hr.children[Math.min(at, nCols - 1)];
        const th = model ? model.cloneNode(false) : document.createElement('th');
        ['id', 'onclick', 'href', 'title', 'sorttable_customkey'].forEach(a => th.removeAttribute(a));
        th.className = ((model && model.className) || '') + ' btPageTh';
        th.textContent = symLabel();
        hr.insertBefore(th, hr.children[at] || null);

        const cells = [];
        ROSTER.rows.forEach(r => {
            if (!r.el || !r.el.parentNode) return;
            const td = document.createElement('td');
            td.className = 'btPageTd';
            if (r.badge) td.setAttribute('data-badge', r.badge);
            r.el.insertBefore(td, r.el.children[at] || null);
            cells.push(td);
        });
        cells.slice(0, EAGER).forEach(fillPageCell);
        const rest = cells.slice(EAGER);
        if (!rest.length) return;
        if (typeof IntersectionObserver === 'function') {
            pageObs = new IntersectionObserver(es => es.forEach(e => {
                if (e.isIntersecting) { fillPageCell(e.target); pageObs.unobserve(e.target); }
            }), { rootMargin: '400px 0px' });
            rest.forEach(td => pageObs.observe(td));
        } else {
            rest.forEach(fillPageCell);
        }
    }

    // Barcode para célula de tabela (sem número embaixo: o número tem coluna própria)
    function bcCell(value, h) {
        const segs = encode(value, SYM);
        if (!segs) return '<span class="btPill no">inválido p/ ' + esc(symLabel()) + '</span>';
        return barcodeSVG(segs, { module: MODULE, height: h || BC_H, text: '', quiet: 6 });
    }

    // ════════════════════════════════════════════════════════════════════
    // 6) Render
    // ════════════════════════════════════════════════════════════════════
    function render() {
        if (!panel) return;
        const body = panel.querySelector('#btBody');
        panel.querySelector('#btCount').textContent = ROSTER.ok ? (ROSTER.rows.length + ' funcionários no roster') : 'roster não carregado';
        if (ROSTER.ok) { body.innerHTML = searchHTML(); wireSearch(body); }
        else { body.innerHTML = loadHTML(); wireLoad(body); }
        body.scrollTop = 0;
    }

    const CSV_BTN = '<label class="btBtn g" for="btCsvIn" title="CSV/TXT com os IDs nas colunas A e B (também aceita arrastar o arquivo no campo)">Importar CSV</label>' +
        '<input type="file" id="btCsvIn" class="btFile" accept=".csv,.txt,text/csv,text/plain">';

    function loadHTML() {
        return `
<div class="btCard">
  <div class="btLbl">Roster do GRU5</div>
  <div class="btSm" style="margin-bottom:10px">
    Nenhuma tabela de funcionários nesta página. Carregue o <b>employeeRoster</b> filtrado do GRU5
    para eu converter login ↔ Employee ID e trazer o barcode e a foto.
  </div>
  <button class="btBtn" id="btLoad" style="width:100%;padding:12px;font-size:14px">Carregar roster</button>
</div>
<div class="btCard">
  <div class="btLbl">Já quer pesquisar? Cole os IDs ou importe o CSV</div>
  <textarea class="btTa" id="btBulk" placeholder="113156306&#10;bsllcami&#10;202994355, aolivepa">${esc(state.bulk)}</textarea>
  <div class="btRow" style="margin-top:8px">
    <button class="btBtn" id="btGoSearch" style="flex:1">Carregar e pesquisar</button>
    ${CSV_BTN}
  </div>
  <div class="btSm" style="margin-top:6px">Abre o roster filtrado e já mostra o barcode e a foto desses IDs.</div>
</div>`;
    }

    function wireLoad(body) {
        const ta = body.querySelector('#btBulk');
        ta.addEventListener('input', () => { state.bulk = ta.value; });
        body.querySelector('#btLoad').onclick = () => { toast('Abrindo o roster do GRU5…'); location.href = ROSTER_URL; };
        body.querySelector('#btGoSearch').onclick = () => {
            if (!norm(ta.value)) { toast('Cole pelo menos um ID ou importe um CSV', true); return; }
            goFull(ta.value);
        };
        wireCsv(body, ta, pairs => goFull(pairs.map(p => [p.a, p.b].filter(Boolean).join(' ')).join('\n')));
    }

    function searchHTML() {
        const oks = LAST.filter(r => r.kind === 'ok');
        const withBadge = oks.filter(r => r.row.badge);
        const miss = LAST.filter(r => r.kind === 'none');

        const rowHTML = r => {
            if (r.kind === 'ok') {
                const row = r.row;
                const st = /active/i.test(row.status || '') ? 'ok' : 'no';
                const url = row.empId ? photoUrl(row.empId) : '';
                return '<tr>' +
                    '<td class="btPhCell">' + (url
                        ? '<img class="btPh" src="' + esc(url) + '" alt="Foto de ' + esc(row.name || row.userId || row.empId) + '" data-zoom="' + esc(url) + '" data-alt="' + esc(row.name || '') + '">'
                        : '<span class="btSm">sem ID</span>') + '</td>' +
                    '<td class="btMonoB">' + esc(row.empId || '—') + '<div class="btSm">' + esc(row.userId || '—') + '</div></td>' +
                    '<td>' + esc(row.name || '—') + '<div class="btSm"><span class="btPill ' + st + '">' + esc(row.status || '—') + '</span></div></td>' +
                    (row.badge
                        ? '<td><span class="btNum" data-copy="' + esc(row.badge) + '" title="Clique para copiar">' + esc(row.badge) + '</span></td>' +
                          '<td class="btBcCell">' + bcCell(row.badge) + '</td>'
                        : '<td colspan="2"><span class="btPill no">sem Badge Barcode ID no roster</span></td>') +
                    '</tr>';
            }
            if (r.kind === 'many') {
                return '<tr><td class="btMonoB" colspan="2">' + esc(r.token) + '</td><td colspan="3">' +
                    '<div class="btSm" style="margin-bottom:4px">' + r.total + ' correspondências — escolha:</div><div class="btRow">' +
                    r.hits.map(h => '<button class="btBtn g btMini" data-pick="' + esc(h.empId || h.userId) + '">' + esc((h.empId || '—') + ' · ' + (h.userId || '—') + ' · ' + (h.name || '')) + '</button>').join('') +
                    '</div></td></tr>';
            }
            return '<tr class="no"><td class="btMonoB" colspan="2">' + esc(r.token) + '</td>' +
                '<td colspan="3"><span class="btPill no">não existe no roster</span> ' +
                '<span class="btSm">este Employee ID / login não está na tabela do GRU5</span></td></tr>';
        };

        const results = LAST.length ? `
<div class="btTblWrap">
<table class="btTbl">
  <thead><tr>
    <th>Foto</th>
    <th class="btColCopy" data-col="emp" title="Clique para copiar os Employee IDs">Emp ID / User</th>
    <th class="btColCopy" data-col="name" title="Clique para copiar os nomes">Nome</th>
    <th class="btColCopy" data-col="badge" title="Clique para copiar os Badge Barcode IDs">Badge</th>
    <th>${esc(symLabel())}</th>
  </tr></thead>
  <tbody>${LAST.map(rowHTML).join('')}</tbody>
</table>
</div>` : '<div class="btSm">Cole os IDs (ou importe um CSV) e clique em <b>Pesquisar</b>. Cada pessoa vira uma linha com a foto do crachá, o Badge Barcode ID e o código de barras. Quem não estiver no roster aparece marcado em vermelho.</div>';

        return `
<div class="btCard">
  <div class="btLbl">Employee IDs ou logins (um por linha, separados por espaço/vírgula, ou CSV com colunas A e B)</div>
  <textarea class="btTa" id="btBulk" placeholder="113156306&#10;bsllcami&#10;202994355, aolivepa">${esc(state.bulk)}</textarea>
  <div class="btRow" style="margin-top:10px">
    <button class="btBtn" id="btGo">Pesquisar</button>
    ${CSV_BTN}
    <button class="btBtn g" id="btClear">Limpar</button>
  </div>
  <div class="btSm" style="margin-top:8px">Pesquisar recarrega o relatório completo do GRU5 (filtrado) e busca nos dados novos.</div>
  ${LAST.length ? '<div class="btSm" style="margin-top:8px">' + oks.length + ' pessoa(s) · ' + withBadge.length + ' com barcode · ' + miss.length + ' fora do roster · ' + LAST.length + ' linha(s)</div>' +
        '<div class="btSm" style="margin-top:4px">Clique no cabeçalho <b>Emp ID / User</b>, <b>Nome</b> ou <b>Badge</b> para copiar a coluna inteira.</div>' : ''}
</div>
${results}`;
    }

    function wireSearch(body) {
        const ta = body.querySelector('#btBulk');
        const go = () => {
            state.bulk = ta.value;
            if (!norm(ta.value)) { toast('Cole pelo menos um ID ou importe um CSV', true); return; }
            goFull(ta.value);   // recarrega o relatório e pesquisa nos dados novos
        };
        ta.addEventListener('input', () => { state.bulk = ta.value; });
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
        body.querySelector('#btGo').onclick = go;
        body.querySelector('#btClear').onclick = () => { state.bulk = ''; LAST = []; render(); };

        // Clique no cabeçalho copia a coluna inteira (Foto e Code 128 não copiam)
        const COL = {
            emp: { get: r => r.row.empId || r.row.userId || '', lbl: 'Employee ID(s)' },
            name: { get: r => r.row.name || '', lbl: 'nome(s)' },
            badge: { get: r => r.row.badge || '', lbl: 'Badge Barcode ID(s)' },
        };
        body.querySelectorAll('th[data-col]').forEach(th => th.onclick = () => {
            const c = COL[th.dataset.col];
            if (!c) return;
            const vals = LAST.filter(r => r.kind === 'ok').map(c.get).filter(Boolean);
            if (!vals.length) { toast('Nada para copiar nessa coluna', true); return; }
            copyText(vals.join('\r\n'), vals.length + ' ' + c.lbl + ' copiado(s)');
        });

        body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));
        body.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { state.bulk = b.dataset.pick; searchText(state.bulk); });
        body.querySelectorAll('img.btPh').forEach(img => {
            img.onclick = () => zoom(img.dataset.zoom, img.dataset.alt);
            img.onerror = () => {
                const td = img.parentNode;
                if (!td) return;
                td.innerHTML = '<div class="btPhNo">sem foto<br><a href="' + esc(img.dataset.zoom) + '" target="_blank" rel="noreferrer">abrir</a></div>';
            };
        });
        wireCsv(body, ta, pairs => goFull(pairs.map(p => [p.a, p.b].filter(Boolean).join(' ')).join('\n')));
    }

    // Importar CSV (botão + arrastar no textarea) — usa colunas A e B
    function wireCsv(body, ta, go) {
        const inp = body.querySelector('#btCsvIn');
        const apply = (pairs, name) => {
            if (pairs.length > 800 && !confirm(pairs.length + ' linhas em ' + name + '. Pesquisar todas?')) return;
            ta.value = pairs.map(p => [p.a, p.b].filter(Boolean).join(' ')).join('\n');
            state.bulk = ta.value;
            toast(pairs.length + ' linha(s) importada(s) de ' + name);
            go(pairs, name);
        };
        if (inp) inp.onchange = e => { readCsvFile(e.target.files[0], apply); e.target.value = ''; };
        ['dragenter', 'dragover'].forEach(t => ta.addEventListener(t, e => { e.preventDefault(); ta.style.borderColor = C.orange; }));
        ta.addEventListener('dragleave', () => { ta.style.borderColor = ''; });
        ta.addEventListener('drop', e => {
            ta.style.borderColor = '';
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!f) return;
            e.preventDefault();
            readCsvFile(f, apply);
        });
    }

    // ════════════════════════════════════════════════════════════════════
    // 7) Carga / init
    // ════════════════════════════════════════════════════════════════════
    function load() {
        removePageCol();
        ROSTER = readRoster();
        IDX = ROSTER.ok ? buildIndex(ROSTER.rows) : { byEmp: new Map(), byUser: new Map() };
        if (ROSTER.ok && !ROSTER.hasBadge) toast('Tabela lida, mas nenhuma linha tem Badge Barcode ID', true);
        else if (ROSTER.ok) toast(ROSTER.rows.length + ' funcionários lidos');
        if (ROSTER.ok && PENDING) {
            state.bulk = PENDING;
            PENDING = '';
            searchText(state.bulk);   // já chama render()
        } else {
            render();
        }
        injectPageCol();
    }

    function init() {
        build();
        PENDING = takePending();
        if (PENDING) state.bulk = PENDING;
        load();
        // No relatório a tabela pode ainda estar renderizando: tenta reler por alguns segundos.
        if (!ROSTER.ok) {
            let tries = 0;
            const t = setInterval(() => { tries++; if (ROSTER.ok || tries > 10) { clearInterval(t); return; } load(); }, 800);
        }
        window.addEventListener('beforeunload', () => { document.body.style.paddingRight = ''; });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
