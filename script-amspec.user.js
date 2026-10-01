// ==UserScript==
// @name         Fix Line Breaks - AMSPEC
// @namespace    http://tampermonkey.net/
// @version      4.9
// @description  Limpieza de nodos de texto basura + conversión de zona horaria a Sydney
// @match        https://update.amspec.group/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/cuellar1992/script-amspec/main/script-amspec.user.js
// @downloadURL  https://raw.githubusercontent.com/cuellar1992/script-amspec/main/script-amspec.user.js
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
                if (!lineDiv) {
                    // Fallback defensivo (no debería ocurrir tras applyEditFix): insertar
                    // como texto+<br> plano igual que antes.
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

                const startLine = lineDivOf(range.startContainer);
                const endLine = lineDivOf(range.endContainer);
                if (!startLine || !endLine || startLine === endLine) return; // selección dentro de una sola línea: comportamiento nativo OK

                // La selección cruza más de un <div> de línea (p.ej. triple-click que se
                // extiende al <div> siguiente en vez de pararse en el límite del bloque).
                // El manejo nativo de contentEditable en ese caso fusiona los <div> de
                // forma inconsistente — a veces sin dejar separador alguno entre las dos
                // líneas — perdiendo el límite. Reemplazamos el contenido a mano para
                // garantizar que el resultado quede en <div> por línea correctos.
                e.preventDefault();

                const beforeRange = document.createRange();
                beforeRange.setStart(startLine, 0);
                beforeRange.setEnd(range.startContainer, range.startOffset);
                const beforeText = beforeRange.toString();

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

                const afterText = endLineUntouched ? "" : (function() {
                    const afterRange = document.createRange();
                    afterRange.setStart(range.endContainer, range.endOffset);
                    afterRange.setEnd(endLine, endLine.childNodes.length);
                    return afterRange.toString();
                })();

                // Quitar los <div> de línea desde el siguiente a startLine hasta endLine
                // (incluido, salvo que endLine no tuviera nada realmente seleccionado).
                let node = startLine.nextSibling;
                while (node) {
                    const next = node.nextSibling;
                    if (endLineUntouched && node === endLine) break;
                    div.removeChild(node);
                    if (node === endLine) break;
                    node = next;
                }

                const isNewline = e.inputType === "insertParagraph" || e.inputType === "insertLineBreak";
                const typed = isNewline ? "" : (e.data != null ? e.data : "");

                startLine.innerHTML = "";
                fillLine(startLine, beforeText + typed);

                let caretRange = document.createRange();

                if (isNewline) {
                    const newLine = document.createElement("div");
                    fillLine(newLine, afterText);
                    startLine.parentNode.insertBefore(newLine, startLine.nextSibling);
                    caretRange.setStart(newLine.firstChild, 0);
                } else if (startLine.firstChild.nodeName === "BR") {
                    // startLine quedó vacío (beforeText+typed === ""): el caret va antes del texto restante.
                    const afterNode = document.createTextNode(afterText);
                    startLine.innerHTML = "";
                    startLine.appendChild(afterNode);
                    caretRange.setStart(afterNode, 0);
                } else {
                    const startText = beforeText + typed;
                    startLine.appendChild(document.createTextNode(afterText));
                    caretRange.setStart(startLine.firstChild, startText.length);
                }

                caretRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(caretRange);
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
    function normalizeBreaks(container) {
        // 1) Desenvolver cada bloque en <br> + su contenido inline
        container.querySelectorAll('div, p').forEach(block => {
            const parent = block.parentNode;
            if (!parent) return;

            const kids = Array.from(block.childNodes);
            const emptyLine = kids.length === 0 ||
                (kids.length === 1 && kids[0].nodeType === Node.ELEMENT_NODE && kids[0].tagName === 'BR');

            // Separador de línea antes del bloque (salvo si es el primer nodo del editor)
            if (block.previousSibling || parent !== container) {
                parent.insertBefore(document.createElement('br'), block);
            }

            if (emptyLine) {
                // El separador ya representa la línea vacía; no duplicar el <br> interno
                parent.removeChild(block);
            } else {
                while (block.firstChild) parent.insertBefore(block.firstChild, block);
                parent.removeChild(block);
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
