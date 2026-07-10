// ==UserScript==
// @name         Guided Coaching - Copiar Logins
// @namespace    http://tampermonkey.net/
// @version      2.11
// @description  Copiar login + botão Pick Console (só nas telas de detalhe, como "Pick?"), filtro por Location/Localização, destaque do Current Location / Local atual e gerador de nota de coaching
// @author       ladislke
// @icon         https://guided-coaching.corp.amazon.com/static-content/favicon/favicon-32x32.png
// @match        https://guided-coaching.corp.amazon.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

// v2.11 — Botão Pick removido da LISTAGEM (que tem filtro de processo). Agora ele aparece
//         apenas nas 2 telas de detalhe (transcript e view-coaching-instance) como "🛒 Pick?".
// v2.10 — Destaque do Current Location agora reconhece a versão BR "Local atual".
// v2.9 — Nas telas de detalhe (transcript e view-coaching-instance), que não têm filtro de
//        processo, o botão do Pick Console vira "🛒 Pick?" e fica sempre visível. Na listagem
//        segue "🛒 Pick", visível só quando o filtro Process = apenas Pick/Separar.
// v2.8 — Filtro por Location e destaque agora reconhecem também a versão BR "Localização"
//        (e "Localização atual" para o Current Location), com/sem acento.
// v2.7 — Detecção do Pick também reconhece "Separar" (versão BR do processo) via PICK_LABELS.
// v2.6 — Botão "🛒 Pick" agora só aparece quando o filtro Process está com APENAS "Pick"
//        marcado (isOnlyPickSelected + updatePickVisibility no ciclo de injeção).
// v2.5 — Botão "🛒 Pick" ao lado do Copiar: abre o Pick Console (GRU5) já filtrado pelo
//        userId do associado (pick-workforce). URL montada via JSON+encode (PICK_WAREHOUSE).
// v2.4 — Motivo do ASIN agora tem fechamentos próprios com tom de que NÃO é necessário
//        coaching (associado sem culpa), em vez de "não foi possível realizar".
// v2.3 — Gerador de nota no #/view-coaching-instance: botão abaixo do dropdown de motivo
//        que insere na textarea das Notas do coach um texto em português (com o login do
//        associado), com ~288 variações por motivo (chaveado pelo value da option, PT/EN).
// v2.2 — Texto do botão "Copiar" agora é branco (antes preto sobre o laranja).
// v2.1 — Destaque do "Current Location:" em laranja claro (fundo) + laranja escuro
//        (fonte/borda), fonte maior, badge justo ao texto e margin de 5px.
// v2.0 — Destaque do "Current Location:" mais elegante (azul claro discreto).
// v1.9 — Destaca a linha "Current Location:" no transcript pra ficar mais evidente.
// v1.8 — O botão de copiar login também funciona na tela #/view-coaching-instance
//        (mesmo layout de detalhe do associado).
// v1.6 — Cards sem Location (ou "Unknown") agora são detectados e agrupados numa
//        opção "Unknown" no seletor. Antes eles não eram pegos (faltava "Location:")
//        e ficavam aparecendo aleatoriamente em qualquer filtragem. Detecção do card
//        passou a ser o maior ancestral com um único instance-link (independe de Location).
// v1.5 — Corrige o filtro que escondia quase todos os cards: a detecção do card agora
//        usa só o span.list-entry-instance-link (1 por card) e ignora ancestrais que
//        englobam mais de um card, evitando pegar o container da lista inteira.
// v1.4 — Filtro por Location vira um SELETOR (dropdown) encaixado na toolbar, ao lado
//        do Auto Refresh/Refresh. Mapeia as Locations automaticamente (MutationObserver)
//        e remapeia ao clicar no Refresh (apply-filter-button).
// v1.3 — Adiciona uma barra de FILTRO POR LOCATION na listagem: esconde os cards
//        cujo "Location:" não bate com o filtro. (input de texto — substituído na 1.4)
// v1.2 — Adiciona suporte à tela de detalhe (#/employee-transcript): coloca o botão
//        ao lado do login do associado (link após o label "Login:"), sem o "@".
//        Ignora o link do Supervisor. Mantém o botão por card da listagem.
// v1.1 — Botão POR CARD, ao lado do login: copia só o texto do login, SEM o "@".
//        Trata a lista dinâmica (Angular) via MutationObserver + varredura periódica.
// v1.0 — Botão flutuante único que coletava todos os logins.

(function () {
    'use strict';

    // Login do ASSOCIADO (coachee) na LISTAGEM: tem a classe ng-scope.
    // O link de supervisor NÃO tem ng-scope, então não recebe botão.
    var LIST_SELECTOR = 'a.list-entry-phonetool-link.ng-binding.ng-scope';

    function extractLogin(a) {
        // Texto do link vem como "login@" → remove o @ final.
        var t = (a.textContent || '').trim().replace(/@+\s*$/, '').trim();
        if (t) return t;
        // Fallback: href .../users/<login>
        var href = a.getAttribute('href') || a.getAttribute('ng-href') || '';
        var m = href.match(/\/users\/([^/?#]+)/);
        return m ? m[1] : '';
    }

    // Rótulo imediatamente ANTES de um elemento (ex.: "Login:", "Supervisor:").
    // Caminha pelos irmãos anteriores e, se necessário, sobe para o nó pai.
    function nearestLabelBefore(el) {
        var node = el.previousSibling;
        var guard = 0;
        while (guard++ < 300) {
            while (node) {
                if (node.nodeType === 1) {                        // elemento
                    var t = (node.textContent || '').trim();
                    if (/@$/.test(t)) return '';                  // é outro valor (login) → sem rótulo
                    if (/:\s*$/.test(t)) return t;                // rótulo tipo "Login:"
                } else if (node.nodeType === 3) {                 // texto puro
                    var m = (node.nodeValue || '').match(/([A-Za-z ]+):\s*$/);
                    if (m) return m[1].trim() + ':';
                }
                node = node.previousSibling;
            }
            el = el.parentNode;
            if (!el || el === document.body) break;
            node = el.previousSibling;
        }
        return '';
    }

    function copyText(text) {
        try {
            if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' }); return Promise.resolve(true); }
        } catch (e) {}
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; });
        }
        try {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.focus(); ta.select();
            var ok = document.execCommand('copy'); ta.remove();
            return Promise.resolve(ok);
        } catch (e) { return Promise.resolve(false); }
    }

    function makeButton(login) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'gc-copy-login-btn';
        b.textContent = '\uD83D\uDCCB Copiar';
        b.title = 'Copiar login "' + login + '" (sem @)';
        b.style.cssText =
            'display:inline-flex;align-items:center;gap:4px;margin-left:8px;padding:2px 10px;' +
            'font-size:12px;font-weight:bold;font-family:\'Amazon Ember\',Arial,sans-serif;' +
            'color:#fff;background:#FF9900;border:none;border-radius:20px;cursor:pointer;' +
            'vertical-align:middle;position:relative;z-index:20;box-shadow:0 1px 3px rgba(0,0,0,0.25);' +
            'transition:background 0.15s ease,transform 0.1s ease;';
        b.addEventListener('mouseenter', function () { b.style.background = '#FEBD69'; });
        b.addEventListener('mouseleave', function () { if (b.textContent.indexOf('Copiar') !== -1) b.style.background = '#FF9900'; });

        // Impede que o clique navegue (o card tem um link-overlay por cima).
        function stop(e) { e.preventDefault(); e.stopPropagation(); }
        b.addEventListener('mousedown', stop, true);
        b.addEventListener('click', function (e) {
            stop(e);
            copyText(login).then(function (ok) {
                var prev = '\uD83D\uDCCB Copiar';
                b.textContent = ok ? '\u2705 Copiado!' : '\u274C Erro';
                b.style.background = ok ? '#27AE60' : '#CC0000';
                b.style.color = '#fff';
                b.style.transform = 'scale(1.05)';
                setTimeout(function () {
                    b.textContent = prev;
                    b.style.background = '#FF9900';
                    b.style.color = '#fff';
                    b.style.transform = 'none';
                }, 1200);
            });
        });
        return b;
    }

    // Monta a URL do Pick Console (GRU5) filtrando pelo userId = login.
    var PICK_WAREHOUSE = 'GRU5';
    function pickConsoleUrl(login) {
        var filter = {
            tokens: [{
                propertyKey: 'userId',
                propertyLabel: 'User Id',
                value: login,
                label: login,
                negated: false
            }],
            operation: 'or'
        };
        return 'https://picking-console.na.picking.aft.a2z.com/fc/' + PICK_WAREHOUSE
             + '/pick-workforce?tableFilters=' + encodeURIComponent(JSON.stringify(filter));
    }

    function makePickButton(login) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'gc-pick-btn';
        // Nas telas de detalhe não há filtro de processo → rótulo em forma de pergunta "Pick?".
        var q = isDetailPage();
        b.textContent = q ? '\uD83D\uDED2 Pick?' : '\uD83D\uDED2 Pick';   // 🛒
        b.title = (q ? 'Abrir no Pick Console (confira se é Pick) — ' : 'Abrir "' + login + '" no Pick Console — ')
                + login + ' (' + PICK_WAREHOUSE + ')';
        b.style.cssText =
            'display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:2px 10px;' +
            'font-size:12px;font-weight:bold;font-family:\'Amazon Ember\',Arial,sans-serif;' +
            'color:#fff;background:#146EB4;border:none;border-radius:20px;cursor:pointer;' +
            'vertical-align:middle;position:relative;z-index:20;box-shadow:0 1px 3px rgba(0,0,0,0.25);' +
            'transition:background 0.15s ease,transform 0.1s ease;';
        b.addEventListener('mouseenter', function () { b.style.background = '#1B8BD0'; });
        b.addEventListener('mouseleave', function () { b.style.background = '#146EB4'; });

        // Impede que o clique navegue no card (link-overlay por cima).
        function stop(e) { e.preventDefault(); e.stopPropagation(); }
        b.addEventListener('mousedown', stop, true);
        b.addEventListener('click', function (e) {
            stop(e);
            window.open(pickConsoleUrl(login), '_blank');
        });
        return b;
    }

    function attach(a, login) {
        if (a.getAttribute('data-gc-copy') === '1') return;
        a.setAttribute('data-gc-copy', '1');
        var copyBtn = makeButton(login);
        a.insertAdjacentElement('afterend', copyBtn);
        // Botão Pick SÓ nas telas de detalhe (transcript / view-coaching-instance).
        // Na listagem (que tem filtro de processo) o Pick não é mais exibido.
        if (isDetailPage()) {
            copyBtn.insertAdjacentElement('afterend', makePickButton(login));
        }
    }

    // ── Visibilidade do botão Pick conforme o filtro "Process" ──────────
    // Nomes do filtro Process (para ignorar checkboxes de outras partes da página).
    // Inclui "separar" = versão BR de "Pick".
    var PROCESS_LABELS = ['show all', 'stow', 'pick', 'separar', 'induct', 'rebin', 'receive', 'icqa',
        'pack', 'reverse logistics', 'space management', 'outbound problem solve',
        'inbound problem solve', 'decant', 'ship', 'fc amnesty'];
    // Rótulos que representam o processo Pick (EN + BR).
    var PICK_LABELS = ['pick', 'separar'];

    function checkboxLabel(cb) {
        if (cb.id) {
            var lf = document.querySelector('label[for="' + cb.id + '"]');
            if (lf) return (lf.textContent || '').replace(/\s+/g, ' ').trim();
        }
        var al = cb.getAttribute('aria-label');
        if (al) return al.trim();
        var node = cb.parentElement;
        for (var i = 0; i < 4 && node; i++) {
            var t = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && t.length <= 30) return t;
            node = node.parentElement;
        }
        return '';
    }

    // true só quando o filtro Process está com APENAS "Pick" marcado.
    function isOnlyPickSelected() {
        var sawPick = false, pickChecked = false, otherChecked = false;
        document.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
            var lbl = checkboxLabel(cb).toLowerCase();
            if (PROCESS_LABELS.indexOf(lbl) === -1) return;   // não é do filtro Process
            if (PICK_LABELS.indexOf(lbl) !== -1) { sawPick = true; if (cb.checked) pickChecked = true; }
            else if (cb.checked) otherChecked = true;
        });
        return sawPick && pickChecked && !otherChecked;
    }

    function updatePickVisibility() {
        // Telas de detalhe (sem filtro): sempre mostra ("Pick?"). Listagem: só com filtro = Pick.
        var show = isDetailPage() ? true : isOnlyPickSelected();
        document.querySelectorAll('.gc-pick-btn').forEach(function (b) {
            b.style.display = show ? 'inline-flex' : 'none';
        });
    }

    // ---------------------------------------------------------------
    // FILTRO POR LOCATION (listagem)
    // ---------------------------------------------------------------
    // Marcador confiável de cada card: span.list-entry-instance-link (um por card).
    var CARD_LINK_SELECTOR = 'span.list-entry-instance-link';
    var UNKNOWN = '__gc_unknown__';   // valor-sentinela para "sem Location / Unknown"

    // O card é o MAIOR ancestral que ainda contém apenas UM instance-link.
    // (Não depende de existir "Location:", então cards Unknown também entram.)
    function getCards() {
        var cards = [];
        document.querySelectorAll(CARD_LINK_SELECTOR).forEach(function (link) {
            var node = link;
            var parent = node.parentElement;
            var guard = 0;
            while (parent && parent !== document.body && guard++ < 20 &&
                   parent.querySelectorAll(CARD_LINK_SELECTOR).length === 1) {
                node = parent;
                parent = node.parentElement;
            }
            if (cards.indexOf(node) === -1) cards.push(node);
        });
        return cards;
    }

    // Location "normalizada": '' quando não há Location ou quando é "Unknown".
    function getLocation(card) {
        // "Location:" (EN) ou "Localização:"/"Localizacao:" (BR)
        var m = (card.textContent || '').match(/(?:Location|Localiza[çc][ãa]o)\s*:\s*([A-Za-z0-9._\/\-]+)/i);
        var v = m ? m[1] : '';
        if (!v || /^unknown$/i.test(v)) return '';
        return v;
    }

    // Acha a toolbar do topo (onde ficam Auto Refresh / Refresh).
    function findToolbar() {
        var c = document.querySelector('.filter-refresh-container');
        if (c) return c;
        // Fallback: container do rótulo "Auto Refresh".
        var els = document.querySelectorAll('label, span, div');
        for (var i = 0; i < els.length; i++) {
            if (/auto\s*refresh/i.test(els[i].textContent || '') &&
                (els[i].textContent || '').length < 40) {
                return els[i].parentElement;
            }
        }
        return null;
    }

    function ensureFilterBar() {
        // Se já existe e continua no DOM, nada a fazer.
        var existing = document.getElementById('gc-loc-filter');
        if (existing && document.body.contains(existing)) return existing;

        var toolbar = findToolbar();
        if (!toolbar) return null;

        var bar = document.createElement('span');
        bar.id = 'gc-loc-filter';
        bar.style.cssText =
            'display:inline-flex;align-items:center;gap:6px;margin-right:12px;vertical-align:middle;' +
            'font-family:\'Amazon Ember\',Arial,sans-serif;font-size:13px;color:#232F3E;';

        var label = document.createElement('span');
        label.textContent = '\uD83D\uDD0D Location:';
        label.style.cssText = 'font-weight:bold;white-space:nowrap;';

        var select = document.createElement('select');
        select.id = 'gc-loc-select';
        select.style.cssText =
            'padding:4px 8px;border:1px solid #aab7b8;border-radius:6px;font-size:13px;' +
            'background:#fff;color:#232F3E;cursor:pointer;max-width:200px;outline:none;';
        select.addEventListener('change', applyFilter);

        var count = document.createElement('span');
        count.id = 'gc-loc-count';
        count.style.cssText = 'font-size:12px;opacity:0.75;white-space:nowrap;';

        bar.appendChild(label);
        bar.appendChild(select);
        bar.appendChild(count);
        // Coloca antes do resto da toolbar (à esquerda do Auto Refresh).
        toolbar.insertBefore(bar, toolbar.firstChild);

        hookRefreshButton();
        return bar;
    }

    // Ao clicar em Refresh (apply-filter-button), remapeia as Locations depois do reload.
    function hookRefreshButton() {
        var btn = document.querySelector('apply-filter-button');
        if (!btn || btn.getAttribute('data-gc-hooked') === '1') return;
        btn.setAttribute('data-gc-hooked', '1');
        btn.addEventListener('click', function () {
            // Angular recarrega os cards de forma assíncrona; remapeia algumas vezes.
            [400, 1000, 2000].forEach(function (t) {
                setTimeout(function () { refreshLocations(true); applyFilter(); }, t);
            });
        }, true);
    }

    // Monta/atualiza as opções do select com as Locations existentes.
    // force=true reescreve mesmo que o conjunto pareça igual.
    function refreshLocations(force) {
        var select = document.getElementById('gc-loc-select');
        if (!select) return;
        var seen = {};
        var hasUnknown = false;
        getCards().forEach(function (card) {
            var loc = getLocation(card);
            if (loc) seen[loc] = true; else hasUnknown = true;
        });
        var opts = Object.keys(seen).sort();
        var key = opts.join('|') + (hasUnknown ? '|__U__' : '');
        if (!force && select.getAttribute('data-keys') === key) return;
        select.setAttribute('data-keys', key);

        var current = select.value;                 // preserva a seleção atual
        var totalTypes = opts.length + (hasUnknown ? 1 : 0);
        select.innerHTML = '';
        var all = document.createElement('option');
        all.value = '';
        all.textContent = 'Todas (' + totalTypes + ')';
        select.appendChild(all);
        opts.forEach(function (v) {
            var o = document.createElement('option');
            o.value = v;
            o.textContent = v;
            select.appendChild(o);
        });
        if (hasUnknown) {
            var u = document.createElement('option');
            u.value = UNKNOWN;
            u.textContent = 'Unknown';
            select.appendChild(u);
        }
        // Mantém a seleção se ainda for válida; senão volta pra "Todas".
        var stillValid = (current === UNKNOWN && hasUnknown) || (current && seen[current]);
        select.value = stillValid ? current : '';
    }

    function applyFilter() {
        var select = document.getElementById('gc-loc-select');
        var count = document.getElementById('gc-loc-count');
        if (!select) return;
        var q = select.value;                       // seleção exata da lista
        var cards = getCards();
        var shown = 0, total = 0;
        cards.forEach(function (card) {
            total++;
            var loc = getLocation(card);
            var match = !q || (q === UNKNOWN ? loc === '' : loc === q);
            card.style.display = match ? '' : 'none';
            if (match) shown++;
        });
        if (count) count.textContent = q ? (shown + ' / ' + total) : (total + ' cards');
    }

    // Telas de detalhe do associado (mesmo layout: Login:/Supervisor: como links).
    function isDetailPage() {
        var h = location.hash || '';
        return h.indexOf('employee-transcript') !== -1 ||
               h.indexOf('view-coaching-instance') !== -1;
    }

    function injectLocationFilter() {
        var bar = document.getElementById('gc-loc-filter');
        var hasCards = getCards().length > 0;

        if (isDetailPage() || !hasCards) {          // sem cards com Location → esconde a barra
            if (bar) bar.style.display = 'none';
            return;
        }
        bar = ensureFilterBar();
        if (!bar) return;                           // toolbar ainda não existe
        bar.style.display = 'inline-flex';
        hookRefreshButton();
        refreshLocations(false);
        applyFilter();
    }

    function injectList() {
        document.querySelectorAll(LIST_SELECTOR).forEach(function (a) {
            var login = extractLogin(a);
            if (login) attach(a, login);
        });
    }

    function injectTranscript() {
        // Telas de detalhe: employee-transcript e view-coaching-instance.
        if (!isDetailPage()) return;

        // Os logins são links cujo texto termina em "@" (ex.: nmmlrani@).
        document.querySelectorAll('a').forEach(function (a) {
            if (a.getAttribute('data-gc-copy') === '1') return;
            if (!/[A-Za-z0-9._-]+@\s*$/.test(a.textContent || '')) return;

            // Só o campo "Login:" — ignora "Supervisor:" e outros links.
            var label = nearestLabelBefore(a);
            if (!/login/i.test(label) || /supervisor/i.test(label)) return;

            var login = extractLogin(a);
            if (login) attach(a, login);   // botão logo depois do link do login
        });
    }

    // Destaca a linha "Current Location:" nas telas de detalhe.
    function highlightCurrentLocation() {
        if (!isDetailPage()) return;

        var best = null;
        document.querySelectorAll('b, strong, span, label, div, td, th, p, li').forEach(function (el) {
            var t = (el.textContent || '').trim();
            if (!/^(?:current location|local atual|localiza[çc][ãa]o atual)\s*:/i.test(t) || t.length > 80) return;
            if (!best || t.length < best.textContent.trim().length) best = el;
        });
        if (!best) return;

        // Se o menor elemento é só o rótulo ("Current Location:"/"Local atual:"), usa o pai.
        var line = /^(?:current location|local atual|localiza[çc][ãa]o atual)\s*:?\s*$/i.test(best.textContent.trim())
            ? (best.parentElement || best)
            : best;

        if (line.getAttribute('data-gc-loc-hl') === '1') return;
        line.setAttribute('data-gc-loc-hl', '1');
        line.style.cssText += ';display:inline-block;background:#ffe8cc;color:#b35900;' +
            'font-weight:700;font-size:17px;padding:6px 12px;border-radius:6px;margin:5px;' +
            'border-left:5px solid #b35900;box-shadow:0 1px 2px rgba(0,0,0,0.08);';
    }

    // ---------------------------------------------------------------
    // GERADOR DE NOTA (view-coaching-instance)
    // ---------------------------------------------------------------
    // Aberturas (contêm {login}) e fechamentos são compartilhados; o núcleo é
    // específico de cada motivo (chaveado pelo value da <option>, independe do idioma).
    var GEN_OPENINGS = [
        'O(a) associado(a) {login} ',
        'Verifiquei que o(a) associado(a) {login} ',
        'No momento da observação, o(a) associado(a) {login} ',
        'Constatei que o(a) associado(a) {login} ',
        'Durante a verificação, o(a) associado(a) {login} ',
        'Conforme apurado, o(a) associado(a) {login} ',
        'Após análise da ocorrência, o(a) associado(a) {login} ',
        'Na data da observação, o(a) associado(a) {login} '
    ];

    var GEN_CLOSINGS = [
        ', motivo pelo qual não foi possível realizar a conversa de coaching.',
        ', não sendo possível conduzir a conversa de coaching no momento.',
        ', o que inviabilizou a conversa de coaching.',
        '. Dessa forma, a conversa de coaching não pôde ser realizada.',
        ', razão pela qual o coaching não foi realizado.',
        '. Por esse motivo, a conversa de coaching não foi conduzida.'
    ];

    var GEN_CORES = {
        ASSOCIATE_NOT_IN_PROCESS: [
            'não estava alocado(a) no mesmo processo da ocorrência',
            'não se encontrava no processo relacionado ao registro',
            'atuava em outro processo no período analisado',
            'havia sido movimentado(a) para um processo diferente',
            'não fazia parte do mesmo processo no momento',
            'estava designado(a) a outro processo'
        ],
        ASSOCIATE_NOT_AT_FAULT_PROCESS_ISSUE: [
            'não teve responsabilidade sobre a ocorrência, decorrente de uma falha do processo',
            'não cometeu erro, tratando-se de um problema do próprio processo',
            'não deu causa ao ocorrido, originado por uma inconsistência do processo',
            'não foi responsável, sendo o registro proveniente de um problema de processo',
            'agiu corretamente, tendo a ocorrência sido causada por uma falha no processo',
            'não incorreu em erro, pois a situação decorreu de um problema do processo'
        ],
        ASSOCIATE_NOT_AVAILABLE_AISLE_CLOSED: [
            'estava indisponível em razão do corredor estar fechado',
            'não pôde ser localizado(a), pois o corredor encontrava-se fechado',
            'estava impossibilitado(a) de atuar devido ao fechamento do corredor',
            'não estava disponível porque o corredor estava interditado',
            'não pôde ser abordado(a), uma vez que o corredor estava fechado',
            'encontrava-se indisponível por conta do corredor fechado'
        ],
        ASSOCIATE_NOT_AT_FAULT_MACHINE_TOOL_ISSUE: [
            'não teve responsabilidade, tratando-se de um problema na máquina/ferramenta',
            'não cometeu erro, sendo a ocorrência causada por falha de máquina/ferramenta',
            'não deu causa ao ocorrido, originado por um defeito na máquina/ferramenta',
            'agiu corretamente, tendo o problema partido da máquina/ferramenta',
            'não foi responsável, pois houve uma falha na máquina/ferramenta',
            'não incorreu em erro, decorrente de um problema na máquina/ferramenta'
        ],
        ASSOCIATE_NOT_AT_FAULT_ASIN_ISSUE: [
            'não deu causa à ocorrência, originada por um problema no ASIN',
            'não gerou o registro, decorrente de uma inconsistência no ASIN',
            'não foi responsável pela divergência, relacionada a um problema no ASIN',
            'não contribuiu para o erro, ocasionado por uma falha no cadastro do ASIN',
            'não teve participação na ocorrência, originada por um problema no ASIN',
            'não provocou a divergência, decorrente de um problema no ASIN'
        ]
    };

    // Fechamentos específicos por motivo. Se o motivo não estiver aqui, usa GEN_CLOSINGS.
    // ASIN: tom de que NÃO é necessário coaching, pois o associado não teve culpa.
    var GEN_CLOSINGS_BY_VALUE = {
        ASSOCIATE_NOT_AT_FAULT_ASIN_ISSUE: [
            '. Não há necessidade de coaching, uma vez que não houve culpa do(a) associado(a).',
            ', não sendo necessária conversa de coaching, pois não houve responsabilidade do(a) associado(a).',
            '. Portanto, não se aplica coaching, já que o(a) associado(a) não teve culpa.',
            ', dispensando a conversa de coaching, dado que não houve falha do(a) associado(a).',
            '. Dessa forma, não é necessário coaching, pois a responsabilidade não foi do(a) associado(a).',
            ', não cabendo coaching, uma vez que o problema não decorreu de ação do(a) associado(a).'
        ]
    };

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function generateNote(value, optionText, login) {
        var cores = GEN_CORES[value];
        var core = cores ? pick(cores)
            : ('teve a seguinte situação registrada: ' + (optionText || '').trim());
        var closings = GEN_CLOSINGS_BY_VALUE[value] || GEN_CLOSINGS;
        var text = pick(GEN_OPENINGS).replace('{login}', login || '') + core + pick(closings);
        return text.replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
    }

    // Login do associado nas telas de detalhe (mesmo campo do botão Copiar).
    function getAssociateLogin() {
        var found = '';
        var links = document.querySelectorAll('a');
        for (var i = 0; i < links.length && !found; i++) {
            var a = links[i];
            if (!/[A-Za-z0-9._-]+@\s*$/.test(a.textContent || '')) continue;
            var label = nearestLabelBefore(a);
            if (/login/i.test(label) && !/supervisor/i.test(label)) found = extractLogin(a);
        }
        return found;
    }

    // Textarea das Notas do coach (a primeira textarea visível).
    function findCoachTextarea() {
        var tas = document.querySelectorAll('textarea');
        for (var i = 0; i < tas.length; i++) {
            if (tas[i].offsetParent !== null) return tas[i];
        }
        return tas[0] || null;
    }

    // Seta o valor respeitando o ng-model do Angular (dispara input/change nativos).
    function setTextareaValue(ta, text) {
        try {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, text);
        } catch (e) { ta.value = text; }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function injectNoteGenerator() {
        if (!isDetailPage()) return;
        var select = document.getElementById('closed-reason-selector');
        var existing = document.getElementById('gc-note-gen');

        if (!select) {                              // dropdown some (radio não marcado)
            if (existing) existing.remove();
            return;
        }
        if (existing && document.body.contains(existing)) return;

        var wrap = document.createElement('div');
        wrap.id = 'gc-note-gen';
        wrap.style.cssText = 'margin:8px 0;display:flex;align-items:center;gap:10px;';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '\u2728 Gerar nota';
        btn.style.cssText =
            'padding:5px 14px;font-size:13px;font-weight:bold;font-family:\'Amazon Ember\',Arial,sans-serif;' +
            'color:#fff;background:#FF9900;border:none;border-radius:20px;cursor:pointer;' +
            'box-shadow:0 1px 3px rgba(0,0,0,0.25);';
        btn.addEventListener('mouseenter', function () { btn.style.background = '#FEBD69'; });
        btn.addEventListener('mouseleave', function () { btn.style.background = '#FF9900'; });

        var status = document.createElement('span');
        status.style.cssText = 'font-size:12px;color:#555;';

        btn.addEventListener('click', function () {
            var value = select.value;
            var opt = select.options[select.selectedIndex];
            if (!value || (opt && !opt.value)) {
                status.textContent = 'Selecione um motivo primeiro.';
                status.style.color = '#CC0000';
                return;
            }
            var ta = findCoachTextarea();
            if (!ta) {
                status.textContent = 'Textarea de notas não encontrada.';
                status.style.color = '#CC0000';
                return;
            }
            var note = generateNote(value, opt ? opt.textContent : '', getAssociateLogin());
            setTextareaValue(ta, note);
            status.textContent = '\u2705 Nota inserida';
            status.style.color = '#27AE60';
        });

        wrap.appendChild(btn);
        wrap.appendChild(status);
        select.insertAdjacentElement('afterend', wrap);
    }

    function inject() {
        injectList();
        injectTranscript();
        injectLocationFilter();
        highlightCurrentLocation();
        injectNoteGenerator();
        updatePickVisibility();
    }

    // Primeira injeção + re-injeção quando o DOM muda (filtros, refresh, navegação SPA).
    inject();
    var scheduled = false;
    function schedule() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { scheduled = false; inject(); }, 250);
    }
    try {
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    window.addEventListener('hashchange', schedule);
    // Rede de segurança para SPA/Angular
    setInterval(inject, 2000);
})();
