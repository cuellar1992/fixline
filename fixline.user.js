// ==UserScript==
// @name         Fix Line Breaks - AMSPEC
// @namespace    http://tampermonkey.net/
// @version      4.13
// @description  Limpieza de nodos de texto basura + conversión de zona horaria a Sydney + Import Table de varias tablas (una sección por título)
// @match        https://update.amspec.group/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/cuellar1992/fixline/main/fixline.user.js
// @downloadURL  https://raw.githubusercontent.com/cuellar1992/fixline/main/fixline.user.js
// ==/UserScript==

(function() {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // SECCIÓN 1: LIMPIEZA DE NODOS DE TEXTO
    // Elimina espacios/saltos de línea basura del servidor en divs editables
    // ─────────────────────────────────────────────────────────────────────────

    function deepClean(node) {
        const walkers = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
        let textNode;
        const nodesToRemove = [];

        while (textNode = walkers.nextNode()) {
            if (!textNode.nodeValue.trim() && textNode.nodeValue.length > 0) {
                nodesToRemove.push(textNode);
            } else {
                textNode.nodeValue = textNode.nodeValue.replace(/^[\s\t\n]+/, "").replace(/[\s\t\n]+$/, "");
            }
        }
        nodesToRemove.forEach(n => n.parentNode && n.parentNode.removeChild(n));
    }

    // Envuelve cada línea (texto separado por <br>) en un <div> de bloque.
    // El servidor entrega el contenido como nodos de texto + <br> sueltos en la
    // RAÍZ del contenteditable. Chrome maneja mal Backspace/Delete sobre esa
    // estructura plana: colapsa TODO el contenido en un único <span> con
    // font-family (borra todo el texto y cambia la fuente). Dando estructura de
    // bloque (<div> por línea) la edición nativa funciona normal. En el envío,
    // normalizeBreaks reconvierte los <div> a <br> para el servidor.
    function structureLines(container) {
        const lines = [];
        let current = [];
        Array.from(container.childNodes).forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                lines.push(current);
                current = [];
            } else {
                current.push(node);
            }
        });
        lines.push(current);

        const fragment = document.createDocumentFragment();
        lines.forEach(nodes => {
            const line = document.createElement('div');
            if (nodes.length === 0) {
                line.appendChild(document.createElement('br'));
            } else {
                nodes.forEach(n => line.appendChild(n));
            }
            fragment.appendChild(line);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECCIÓN 2: FIX DE EDITOR CONTENTEDITABLE
    // Aplica limpieza, estilos y manejo de paste en divs .textareafalse
    // ─────────────────────────────────────────────────────────────────────────

    function applyEditFix() {
        document.querySelectorAll('.textareafalse[contenteditable="true"]').forEach(div => {
            if (div.dataset.fixApplied) return;

            deepClean(div);

            if (div.innerHTML.trim() === "") {
                div.innerHTML = "<br>";
            }

            // Dar estructura de bloque (<div> por línea) para evitar el colapso
            // catastrófico de Chrome al borrar sobre <br> sueltos en la raíz.
            structureLines(div);

            div.dataset.fixApplied = "true";
            div.style.whiteSpace = "pre-wrap";
            div.style.wordBreak = "break-word";
            // Forzar color de caret visible: por defecto hereda currentColor (color de
            // texto). Si se aplica fuente blanca/clara, el caret se vuelve invisible
            // sobre el fondo blanco. Fijarlo independiente del color de texto.
            div.style.caretColor = "#333";

            // Devuelve el <div> de línea (hijo directo de `div`) que contiene `node`,
            // subiendo por los ancestros. Usado por el paste handler y por el guard
            // de selección multilínea para saber en qué línea cae el cursor.
            function lineDivOf(node) {
                let n = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
                while (n && n.parentNode !== div) n = n.parentNode;
                return n;
            }

            // Da contenido "editable" a una línea vacía (nodo de texto vacío colapsa
            // a altura cero en algunos casos) — mismo criterio que structureLines().
            function fillLine(lineEl, text) {
                lineEl.appendChild(text ? document.createTextNode(text) : document.createElement("br"));
            }

            // true si `node` está dentro de una tabla o lista anidada en el editor.
            // Ahí un <div> raíz NO es una línea: puede contener el mensaje entero.
            function inNestedBlock(node) {
                const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
                const block = el && el.closest("table, ul, ol");
                return !!block && div.contains(block);
            }

            div.addEventListener("paste", function(e) {
                e.preventDefault();
                e.stopImmediatePropagation();

                const text = (e.clipboardData || window.clipboardData).getData("text/plain");
                if (!text) return;

                const sel = window.getSelection();
                const range = sel.getRangeAt(0);
                range.deleteContents();

                const lines = text.split(/\r?\n/);

                if (div.childNodes.length === 0) {
                    // El campo quedó completamente vacío (p.ej. Ctrl+A + pegar reemplaza
                    // todo el contenido de una vez: deleteContents() sobre esa selección
                    // deja `div` sin hijos). No hay ningún <div> de línea existente para
                    // partir — crear uno nuevo por línea directamente bajo `div`.
                    const fragment = document.createDocumentFragment();
                    lines.forEach(line => {
                        const lineDiv = document.createElement("div");
                        fillLine(lineDiv, line);
                        fragment.appendChild(lineDiv);
                    });
                    div.appendChild(fragment);

                    const lastLineDiv = div.lastChild;
                    const caretRange = document.createRange();
                    if (lastLineDiv.firstChild.nodeName === "BR") {
                        caretRange.setStartBefore(lastLineDiv.firstChild);
                    } else {
                        caretRange.setStart(lastLineDiv.firstChild, lastLineDiv.firstChild.length);
                    }
                    caretRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(caretRange);
                    return;
                }

                if (lines.length === 1) {
                    // Una sola línea: no cruza límites de <div>, insertar inline basta.
                    const textNode = document.createTextNode(lines[0]);
                    range.insertNode(textNode);
                    range.setStartAfter(textNode);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }

                // Pegado multilínea: partir el <div> de línea actual en un <div> por
                // línea pegada. Insertar <br> sueltos aquí (como antes) dejaría todo el
                // contenido dentro de UN solo <div>, la estructura plana que
                // structureLines() existe justamente para evitar (ver su comentario más
                // abajo) — y que reintroduce el riesgo de colapso catastrófico de Chrome
                // al editar sobre ese <div>.
                let lineDiv = lineDivOf(range.startContainer);
                if (!lineDiv || inNestedBlock(range.startContainer)) {
                    // Sin <div> de línea, o cursor dentro de una tabla/lista (contenido
                    // pegado como HTML que llega envuelto en <table><td>): partir el
                    // <div> raíz clonaría la tabla. Insertar texto+<br> en el sitio, que
                    // además hereda el estilo del <span> donde está el cursor.
                    const fragment = document.createDocumentFragment();
                    lines.forEach((line, i) => {
                        fragment.appendChild(document.createTextNode(line));
                        if (i < lines.length - 1) fragment.appendChild(document.createElement("br"));
                    });
                    const lastNode = fragment.lastChild;
                    range.insertNode(fragment);
                    if (lastNode) {
                        range.setStartAfter(lastNode);
                        range.collapse(true);
                    }
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }

                // Separar el contenido de lineDiv en "antes del cursor" (se queda en
                // lineDiv) y "después del cursor" (pasa a la última línea nueva).
                const afterRange = document.createRange();
                afterRange.setStart(range.startContainer, range.startOffset);
                afterRange.setEndAfter(lineDiv.lastChild);
                const afterFragment = afterRange.extractContents();

                // Si lineDiv quedó vacío (línea en blanco, placeholder <br>), limpiarlo
                // antes de escribir la primera línea pegada.
                if (lineDiv.childNodes.length === 1 && lineDiv.firstChild.nodeName === "BR") {
                    lineDiv.innerHTML = "";
                }
                lineDiv.appendChild(document.createTextNode(lines[0]));

                let insertAfter = lineDiv;
                for (let i = 1; i < lines.length - 1; i++) {
                    const newLineDiv = document.createElement("div");
                    fillLine(newLineDiv, lines[i]);
                    insertAfter.parentNode.insertBefore(newLineDiv, insertAfter.nextSibling);
                    insertAfter = newLineDiv;
                }

                const lastLineDiv = document.createElement("div");
                const lastTextNode = document.createTextNode(lines[lines.length - 1]);
                lastLineDiv.appendChild(lastTextNode);
                if (afterFragment.childNodes.length) lastLineDiv.appendChild(afterFragment);
                insertAfter.parentNode.insertBefore(lastLineDiv, insertAfter.nextSibling);

                const caretRange = document.createRange();
                caretRange.setStart(lastTextNode, lastTextNode.length);
                caretRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(caretRange);
            }, true);

            div.addEventListener("beforeinput", function(e) {
                const sel = window.getSelection();
                if (!sel.rangeCount) return;
                const range = sel.getRangeAt(0);
                if (range.collapsed) return; // sin selección: el manejo nativo (incl. Backspace en límite de línea) ya funciona bien

                // Solo escritura/borrado. Formato (Ctrl+B, etc.) y deshacer van nativos:
                // antes se interceptaban también y borraban el texto seleccionado.
                if (!/^(insert|delete)/.test(e.inputType)) return;

                const startLine = lineDivOf(range.startContainer);
                const endLine = lineDivOf(range.endContainer);
                if (!startLine || !endLine || startLine === endLine) return; // selección dentro de una sola línea: comportamiento nativo OK

                // La selección cruza más de un <div> de línea (p.ej. triple-click que se
                // extiende al <div> siguiente en vez de pararse en el límite del bloque).
                // El manejo nativo de contentEditable en ese caso fusiona los <div> de
                // forma inconsistente — a veces sin dejar separador alguno entre las dos
                // líneas — perdiendo el límite. Borramos a mano con rangos (conserva
                // negrita, spans y tablas; reconstruir con texto plano aplanaba el
                // mensaje entero cuando venía envuelto en <table>) y luego delegamos la
                // inserción en execCommand, ya con la selección colapsada.
                e.preventDefault();

                // El triple-click de Chrome a veces extiende la selección hasta el
                // inicio literal del <div> siguiente SIN seleccionar ningún carácter
                // suyo (endOffset apunta a la posición 0 de esa línea). Si tratáramos
                // eso como "línea final realmente seleccionada", su texto se pegaría
                // sin separador al reemplazar — justo el bug que se intenta evitar.
                // Detectarlo y, en ese caso, dejar endLine intacta.
                const endProbe = document.createRange();
                endProbe.setStart(endLine, 0);
                endProbe.setEnd(range.endContainer, range.endOffset);
                const endLineUntouched = endProbe.toString() === "";

                const delRange = range.cloneRange();
                if (endLineUntouched) {
                    delRange.setEnd(div, Array.prototype.indexOf.call(div.childNodes, endLine));
                }
                delRange.deleteContents();
                // deleteContents() deja el rango en el ancestro común (la raíz) cuando la
                // selección sale de una tabla; el nodo de inicio sobrevive truncado, así
                // que volver a su posición original deja el cursor dentro de la línea.
                delRange.setStart(range.startContainer, range.startOffset);
                delRange.collapse(true);

                // Fusionar lo que quedó de endLine en el punto del cursor.
                if (!endLineUntouched && endLine.parentNode === div) {
                    const rest = document.createDocumentFragment();
                    while (endLine.firstChild) rest.appendChild(endLine.firstChild);
                    div.removeChild(endLine);
                    const onlyPlaceholder = rest.childNodes.length === 1 && rest.firstChild.nodeName === "BR";
                    if (rest.childNodes.length && !onlyPlaceholder) {
                        delRange.insertNode(rest);
                        delRange.collapse(true);
                    }
                }

                if (!startLine.textContent && !startLine.querySelector("br, img, table")) {
                    startLine.innerHTML = "";
                    fillLine(startLine, "");
                    delRange.setStartBefore(startLine.firstChild);
                    delRange.collapse(true);
                }

                sel.removeAllRanges();
                sel.addRange(delRange);

                if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
                    document.execCommand(e.inputType);
                } else if (e.inputType.startsWith("insert") && e.data) {
                    document.execCommand("insertText", false, e.data);
                }
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECCIÓN 3: INTERCEPCIÓN DE ENVÍO AL SERVIDOR
    // Parchea window.preparetextarea para normalizar <br> → \n antes de enviar
    // ─────────────────────────────────────────────────────────────────────────

    // Normaliza bloques <div>/<p> → <br> conservando formato inline
    // (<b>, <i>, <u>, <span style>, <a>...). Reemplaza el antiguo innerText,
    // que aplanaba todo y borraba negrita/fuente al enviar.
    const BLOCK_TAGS = /^(DIV|P|TABLE|UL|OL|H[1-6]|BLOCKQUOTE|PRE)$/;

    // Último hijo que se ve (ignora comentarios y texto solo-espacios).
    function lastRendered(node) {
        let n = node.lastChild;
        while (n && (n.nodeType === Node.COMMENT_NODE ||
                     (n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim()))) {
            n = n.previousSibling;
        }
        return n;
    }

    // true si el contenido de `node` termina en un bloque (p.ej. una tabla):
    // lo que venga después ya empieza en línea nueva sin necesidad de <br>.
    function endsWithBlock(node) {
        let n = node;
        while (n && n.nodeType === Node.ELEMENT_NODE) {
            if (BLOCK_TAGS.test(n.tagName)) return true;
            n = lastRendered(n);
        }
        return false;
    }

    function normalizeBreaks(container) {
        // 1) Desenvolver en <br> + contenido inline SOLO los <div>/<p> de línea de la
        // raíz (los que crea structureLines o Chrome al pulsar Enter). Los bloques
        // anidados (<p> dentro de la tabla de un update pegado como HTML) se dejan
        // tal cual: el servidor los entrega y renderiza bien, y convertirlos
        // volvía visibles <p> de altura 0 y <br> finales de bloque, añadiendo
        // saltos de línea en la vista previa que la edición no tenía.
        //
        // `open` = hay una línea empezada que necesita un <br> antes de la siguiente.
        // Tras un bloque (tabla) o un <br> ya estamos a inicio de línea.
        let open = false;
        Array.from(container.childNodes).forEach(node => {
            if (node.nodeType === Node.COMMENT_NODE ||
                (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim())) return;
            if (node.nodeType !== Node.ELEMENT_NODE) { open = true; return; }
            if (node.tagName === 'BR') { open = false; return; }
            if (node.tagName !== 'DIV' && node.tagName !== 'P') {
                open = !endsWithBlock(node);
                return;
            }

            const block = node;

            // Un <br> al final de un bloque no se ve; desenvuelto sí. Quitarlo.
            let tail = lastRendered(block);
            while (tail && tail.nodeType === Node.ELEMENT_NODE &&
                   tail.tagName !== 'BR' && !BLOCK_TAGS.test(tail.tagName)) {
                tail = lastRendered(tail);
            }
            const onlyBr = block.childNodes.length === 1 && block.firstChild === tail;
            if (tail && tail.nodeName === 'BR' && !onlyBr) tail.parentNode.removeChild(tail);

            const emptyLine = !block.textContent && !block.querySelector('img, table');

            if (open) container.insertBefore(document.createElement('br'), block);

            if (emptyLine) {
                // La línea vacía queda representada por el <br> que la cierre.
                container.removeChild(block);
                open = true;
            } else {
                const last = lastRendered(block);
                open = !(last && endsWithBlock(last));
                while (block.firstChild) container.insertBefore(block.firstChild, block);
                container.removeChild(block);
            }
        });

        // 2) Convertir cualquier salto de línea literal (\n) restante en <br>
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];
        let tn;
        while (tn = walker.nextNode()) {
            if (tn.nodeValue.indexOf('\n') >= 0) textNodes.push(tn);
        }
        textNodes.forEach(node => {
            const fragment = document.createDocumentFragment();
            const parts = node.nodeValue.split('\n');
            parts.forEach((part, i) => {
                fragment.appendChild(document.createTextNode(part));
                if (i < parts.length - 1) fragment.appendChild(document.createElement('br'));
            });
            node.parentNode.replaceChild(fragment, node);
        });
    }

    function interceptPrepareTextarea() {
        if (!window.preparetextarea || window.preparetextarea._patched) return;

        const original = window.preparetextarea;
        window.preparetextarea = function() {
            document.querySelectorAll('.textareafalse').forEach(div => {
                normalizeBreaks(div);
            });
            return original.apply(this, arguments);
        };
        window.preparetextarea._patched = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECCIÓN 4: CONVERSIÓN DE ZONA HORARIA - "SENT AT"
    // Convierte timestamps UTC+8 → hora local Sydney (+8h)
    // Agrega la fecha del documento en segunda línea
    //
    // Formato resultado:
    //   Sydney NSW OPS - Sent at: 12:17 PM
    //   25 Apr 2026
    // ─────────────────────────────────────────────────────────────────────────

    function convertTimestamps(root) {
        const scope = root || document;
        const elements = root
            ? [scope, ...scope.querySelectorAll('*')]
            : scope.querySelectorAll('*');
        elements.forEach(el => {
            if (el.dataset.tzConverted) return;
            if (el.children.length > 0) return;

            const text = el.textContent.trim();
            const match = text.match(/^Sydney NSW OPS - Sent at:\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
            if (!match) return;

            // Convertir hora de UTC+8 a Sydney (+8 horas)
            let hours = parseInt(match[1]);
            const minutes = parseInt(match[2]);
            const period = match[3].toUpperCase();

            if (period === 'AM' && hours === 12) hours = 0;
            if (period === 'PM' && hours !== 12) hours += 12;

            hours += 8;
            let dayOffset = 0;
            if (hours >= 24) {
                hours -= 24;
                dayOffset = 1;
            }

            const newPeriod = hours >= 12 ? 'PM' : 'AM';
            let newHours = hours % 12;
            if (newHours === 0) newHours = 12;
            const convertedTime = `${newHours}:${minutes.toString().padStart(2, '0')} ${newPeriod}`;

            // Obtener fecha del elemento hermano (título del documento)
            let dateStr = '';
            const parent = el.parentElement;
            if (parent) {
                for (const sibling of parent.children) {
                    if (sibling === el) continue;
                    const dm = sibling.textContent.match(/\d+ - (\d{1,2} \w{3} \d{4}):/);
                    if (dm) {
                        dateStr = dm[1];
                        break;
                    }
                }
            }

            // Ajustar fecha si la conversión cruzó medianoche
            if (dateStr && dayOffset) {
                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const dm = dateStr.match(/(\d{1,2}) (\w{3}) (\d{4})/);
                if (dm) {
                    const d = new Date(parseInt(dm[3]), months.indexOf(dm[2]), parseInt(dm[1]) + 1);
                    dateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
                }
            }

            el.dataset.tzConverted = 'true';
            el.innerHTML = `Sydney NSW OPS - Sent at: ${convertedTime}${dateStr ? '<br>' + dateStr : ''}`;
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INICIALIZACIÓN
    // Ejecuta todas las funciones al cargar y ante cambios en el DOM
    // ─────────────────────────────────────────────────────────────────────────

    const init = () => {
        applyEditFix();
        interceptPrepareTextarea();
        convertTimestamps();
    };

    // Ejecutar inmediatamente si documento ya está listo
    if (document.readyState === "loading") {
        window.addEventListener("load", init);
    } else {
        init();
    }

    // También observer para cambios dinámicos
    const observer = new MutationObserver((mutations) => {
        applyEditFix();
        interceptPrepareTextarea();
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    convertTimestamps(node);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: COPY / PASTE FIELDS BETWEEN HISTORY AND EDIT FORM
// history.php → "Copy Fields" button inside #copy_btns → saves to localStorage
// edit.php    → "Paste Fields" button inside #buttonback → fills inputs
// ─────────────────────────────────────────────────────────────────────────

(function() {
    'use strict';

    const STORAGE_KEY = 'amspec_copied_fields';

    function addCopyButton() {
        const container = document.getElementById('copy_btns');
        if (!container || document.getElementById('amspec-copy-fields')) return;

        const style = document.createElement('style');
        style.textContent = `
            #amspec-copy-fields {
                border: 1px solid rgb(145, 41, 42);
                background-color: rgb(145, 41, 42);
                border-radius: 8px;
                padding: 6px 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: rgb(236, 240, 241);
                font-size: 16px;
                cursor: pointer;
            }
            #amspec-copy-fields:hover {
                background-color: rgb(179, 59, 59);
                border-color: rgb(179, 59, 59);
            }
        `;
        document.head.appendChild(style);

        const div = document.createElement('div');
        div.id = 'amspec-copy-fields';
        const span = document.createElement('span');
        span.textContent = 'Copy Fields';
        div.appendChild(span);

        div.addEventListener('click', () => {
            // Capture table fields
            const data = {};
            document.querySelectorAll('table tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                    const label = cells[0].textContent.trim();
                    const value = cells[1].textContent.trim();
                    if (label && value && !label.includes('\n')) {
                        data[label] = value;
                    }
                }
            });

            // Capture To / Cc / Bcc emails
            const emails = { to: '', cc: '', bcc: '' };
            document.querySelectorAll('td').forEach(td => {
                const labelSpan = td.querySelector('span');
                if (!labelSpan) return;
                const label = labelSpan.textContent.trim().replace(':', '').toLowerCase();
                if (!['to', 'cc', 'bcc'].includes(label)) return;
                const value = td.textContent.replace(labelSpan.textContent, '').trim();
                if (value) emails[label] = value;
            });

            if (!Object.keys(data).length && !emails.to && !emails.cc && !emails.bcc) return;

            const payload = { fields: data, emails };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

            span.textContent = '✓ Copied!';
            setTimeout(() => { span.textContent = 'Copy Fields'; }, 2000);
        });

        container.appendChild(div);
    }

    function addPasteButton() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return;
        const container = document.getElementById('buttonback');
        if (!container || document.getElementById('amspec-paste-fields')) return;

        let payload;
        try { payload = JSON.parse(stored); } catch { localStorage.removeItem(STORAGE_KEY); return; }
        const data = payload.fields || payload; // backwards compat

        const btn = document.createElement('button');
        btn.id = 'amspec-paste-fields';
        btn.className = 'buttonform';
        btn.type = 'button';
        btn.textContent = 'Paste Fields';

        btn.addEventListener('click', () => {
            document.querySelectorAll('table tr').forEach(row => {
                const select = row.querySelector('select');
                const input = row.querySelector('input[type="text"], input:not([type="hidden"]):not([type="submit"])');
                if (!select || !input) return;

                const label = select.options[0]?.text.trim();
                if (label && data[label] !== undefined) {
                    input.value = data[label];
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });

            btn.textContent = '✓ Pasted!';
            setTimeout(() => { btn.textContent = 'Paste Fields'; }, 2000);
        });

        container.appendChild(btn);
    }

    function injectEmailTags(fieldPrefix, emailsStr) {
        if (!emailsStr) return;
        const input = document.getElementById(fieldPrefix + '_input');
        if (!input) return;
        const container = input.closest('.internal_container')?.querySelector('.email-input-value_container');
        const hidden = document.getElementById(fieldPrefix + '_hidden');
        if (!container || !hidden) return;

        // Clear existing tags
        container.querySelectorAll('.email-input-value').forEach(el => el.remove());
        hidden.value = '';

        // Parse and add each email
        const emails = emailsStr.split(/[,;]\s*/).map(e => e.trim()).filter(Boolean);
        emails.forEach(email => {
            const tag = document.createElement('span');
            tag.className = 'email-input-value';
            tag.textContent = email;
            const x = document.createElement('span');
            x.className = 'remove-email';
            x.textContent = '×';
            x.addEventListener('click', () => {
                tag.remove();
                hidden.value = Array.from(container.querySelectorAll('.email-input-value'))
                    .map(t => t.childNodes[0]?.textContent?.trim())
                    .filter(Boolean).join('; ');
            });
            tag.appendChild(x);
            container.appendChild(tag);
        });

        hidden.value = emails.join('; ');
    }

    function addPasteEmailsButton() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return;
        if (document.getElementById('amspec-paste-emails')) return;

        let payload;
        try { payload = JSON.parse(stored); } catch { localStorage.removeItem(STORAGE_KEY); return; }
        const emails = payload.emails;
        if (!emails || (!emails.to && !emails.cc && !emails.bcc)) return;

        // Mirror native CSS rules used by #copy_document_div and #saveActualTemplate
        const style = document.createElement('style');
        style.textContent = `
            #templates_buttons {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 8px;
            }
            #amspec-paste-emails {
                background-color: rgb(145, 41, 42);
                color: white;
                border: 1px solid rgb(145, 41, 42);
                border-radius: 8px;
                padding: 6px 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 15px;
                transition: background-color 0.3s;
                box-shadow: rgba(0, 0, 0, 0.1) 0px 2px 4px;
                width: 170px;
            }
            #amspec-paste-emails:hover {
                background-color: rgb(192, 40, 40);
                transform: translateY(-2px);
            }
        `;
        document.head.appendChild(style);

        const div = document.createElement('div');
        div.id = 'amspec-paste-emails';
        const h3 = document.createElement('h3');
        h3.className = 'title_temp';
        h3.style.margin = '0';
        h3.textContent = 'Paste Emails';
        div.appendChild(h3);

        div.addEventListener('click', () => {
            injectEmailTags('to', emails.to);
            injectEmailTags('cc', emails.cc);
            injectEmailTags('bcc', emails.bcc);
            h3.textContent = '✓ Pasted!';
            setTimeout(() => { h3.textContent = 'Paste Emails'; }, 2000);
        });

        // Insert inside #templates_buttons so it sits beside "Save as Template" in the same flex row
        const container = document.getElementById('templates_buttons')
            || document.querySelector('.bottom_panelback');
        if (!container) return;
        container.appendChild(div);
    }

    function reorganizeButtons() {
        if (document.getElementById('amspec-btn-bar')) return;

        const goBack = document.getElementById('goback');
        const next = document.getElementById('saveinfo_btn');
        const sendForm = document.getElementById('formsendmail');
        const paste = document.getElementById('amspec-paste-fields');
        const buttonback = document.getElementById('buttonback');

        if (!buttonback || !goBack || !next) return;

        // Inject layout CSS
        const style = document.createElement('style');
        style.textContent = `
            #amspec-btn-bar {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                padding: 10px 20px;
                width: 100%;
                box-sizing: border-box;
            }
            #amspec-btn-right {
                display: flex;
                flex-direction: column;
                gap: 8px;
                align-items: flex-end;
            }
        `;
        document.head.appendChild(style);

        // Build new bar
        const bar = document.createElement('div');
        bar.id = 'amspec-btn-bar';

        const leftCol = document.createElement('div');
        leftCol.appendChild(goBack);

        const rightCol = document.createElement('div');
        rightCol.id = 'amspec-btn-right';
        rightCol.appendChild(next);
        if (sendForm) rightCol.appendChild(sendForm);
        if (paste) rightCol.appendChild(paste);

        bar.appendChild(leftCol);
        bar.appendChild(rightCol);

        buttonback.parentElement.replaceChild(bar, buttonback);
    }

    function setupCopyPaste() {
        const path = window.location.pathname;
        if (path.includes('history.php')) {
            addCopyButton();
        } else if (path.includes('edit.php')) {
            addPasteButton();
            reorganizeButtons();
        } else if (path.includes('preview.php')) {
            addPasteEmailsButton();
        }
    }

    if (document.readyState === 'loading') {
        window.addEventListener('load', setupCopyPaste);
    } else {
        setupCopyPaste();
    }

})();

// ─────────────────────────────────────────────────────────────────────────
// SECTION 6: IMPORT TABLE — VARIAS TABLAS, UNA SECCIÓN POR TÍTULO
// El "Import Table" nativo (modal de "Add Table") solo toma la PRIMERA
// <table> del portapapeles (tempDiv.querySelector('table')). Este handler
// corre antes que el nativo (click en fase capture sobre window) e importa
// TODAS las tablas del HTML copiado, agrupadas por la línea de título que
// las precede (p.ej. "Copy All" de Cargo Report Automation: "Figures
// Gasoline 91 Ron" + 3 tablas, "Figures Gasoline 95 Ron" + 3 tablas...):
//   - el primer grupo va a la sección donde se hizo clic en "Add Table"
//     (si su encabezado está vacío, recibe el título; si tiene otro texto,
//     el grupo va a una sección nueva para no mezclar);
//   - cada grupo siguiente va a una sección nueva, creada con el propio
//     botón "+" (.sumsection) de la página, con el título en su encabezado.
// Las tablas se crean con las funciones globales de la página
// extractTableData()/createTableFromClipboard(), apuntando antes las
// globales lastSection/lastDynamicContent a la sección destino (lo mismo
// que hace el botón "Add Table"). Sin títulos (copia desde Excel, o el
// "Copy" de una sola tabla) todo va a la sección actual. Si la página deja
// de exponer esas funciones, no intercepta y queda el import original.
// ─────────────────────────────────────────────────────────────────────────

(function() {
    'use strict';

    const MAX_COLUMNS = 4; // mismo límite que el import nativo

    async function readClipboardHtml() {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
            if (item.types.includes('text/html')) {
                return await (await item.getType('text/html')).text();
            }
        }
        return null;
    }

    // [{title, tables: [table, ...]}] en orden. Una tabla sin título propio
    // justo antes se suma al grupo anterior.
    function groupTablesByTitle(root) {
        const groups = [];
        let pendingTitle = null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let el;
        while ((el = walker.nextNode())) {
            if (el.tagName === 'TABLE') {
                if (el.parentElement.closest('table')) continue; // tabla anidada
                const last = groups[groups.length - 1];
                if (pendingTitle === null && last) {
                    last.tables.push(el);
                } else if (last && pendingTitle === last.title) {
                    last.tables.push(el);
                } else {
                    groups.push({ title: pendingTitle, tables: [el] });
                }
                pendingTitle = null;
            } else if (/^(P|DIV|H[1-6])$/.test(el.tagName) && !el.closest('table') &&
                       !el.querySelector('table, p, div')) {
                const text = el.textContent.replace(/ /g, ' ').trim();
                if (text) pendingTitle = text;
            }
        }
        return groups;
    }

    function sectionParts(container) {
        return {
            container,
            header: container.querySelector('.headersection'),
            content: container.querySelector('.dynamic-content'),
        };
    }

    // Nueva sección justo después de `after`, creada por el handler nativo
    // del botón "+" para que quede idéntica a una hecha a mano.
    function addSectionAfter(after) {
        const plus = after.container.querySelector('.sumsection');
        if (!plus) return null;
        plus.click();
        const created = after.container.nextElementSibling;
        return created && created.classList.contains('containerinformation')
            ? sectionParts(created) : null;
    }

    function setHeader(section, title) {
        section.header.value = title;
        section.header.dispatchEvent(new Event('input', { bubbles: true }));
        section.header.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function importAllTables() {
        let htmlText;
        try {
            htmlText = await readClipboardHtml();
        } catch (err) {
            alert('Failed to read clipboard contents: ' + err);
            return;
        }
        if (htmlText === null) return; // sin HTML: el nativo tampoco hace nada

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlText;
        const groups = groupTablesByTitle(tempDiv)
            .map(g => ({ title: g.title, data: g.tables.map(t => window.extractTableData(t)).filter(d => d.length) }))
            .filter(g => g.data.length);
        if (!groups.length) {
            alert('No table found in clipboard!');
            return;
        }

        // Validar todo antes de crear nada: no dejar el import a medias.
        const all = groups.flatMap(g => g.data);
        const tooWide = all.findIndex(d => (d[0]?.length || 0) > MAX_COLUMNS);
        if (tooWide >= 0) {
            alert(`⚠️ Table ${tooWide + 1} of ${all.length} has more than ${MAX_COLUMNS} columns — nothing was imported.`);
            return;
        }

        const start = window.lastSection && window.lastSection.closest
            ? window.lastSection.closest('.containerinformation') : null;
        if (!start) {
            alert('Table creation section not found!');
            return;
        }

        let section = sectionParts(start);
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (group.title) {
                const current = section.header.value.trim();
                const reuse = i === 0 && (current === '' || current === group.title);
                if (!reuse) {
                    const next = addSectionAfter(section);
                    if (!next) {
                        alert('Could not create a new section — import stopped.');
                        return;
                    }
                    section = next;
                }
                if (section.header.value.trim() !== group.title) setHeader(section, group.title);
            }
            window.lastSection = section.header;
            window.lastDynamicContent = section.content;
            group.data.forEach(data => window.createTableFromClipboard(data));
        }

        const modal = document.getElementById('disposeModal');
        if (modal) modal.style.display = 'none';
    }

    window.addEventListener('click', function(e) {
        if (!e.target.closest || !e.target.closest('#importTable')) return;
        if (typeof window.extractTableData !== 'function' ||
            typeof window.createTableFromClipboard !== 'function') return;

        e.preventDefault();
        e.stopImmediatePropagation();
        importAllTables();
    }, true);

})();
