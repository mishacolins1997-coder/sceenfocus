import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { saveSettingsDebounced, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE = 'scene_focus';
const PROMPT_KEY = 'scene_focus_prompt';

/* Формат триггера:  действие: фраза с {names}
   Действия: focus (фокус на персонажах), reset (сбросить фокус),
             away (персонаж ушёл), back (персонаж вернулся) */
const DEFAULT_TRIGGERS = [
    'focus: Фокус перемещается на {names}',
    'focus: Фокус переключается на {names}',
    'focus: Фокус переходит на {names}',
    'focus: Фокус на {names}',
    'focus: Все действие переходит на {names}',
    'focus: Все действие переходит к {names}',
    'focus: Всё действие переходит на {names}',
    'focus: Всё действие переходит к {names}',
    'focus: Действие переходит к {names}',
    'focus: Камера на {names}',
    'reset: Фокус на всех',
    'reset: Фокус возвращается',
    'reset: Сброс фокуса',
    'away: {names} уходит',
    'away: {names} уходят',
    'away: {names} ушёл',
    'away: {names} ушла',
    'away: {names} покидает',
    'back: {names} возвращается',
    'back: {names} вернулся',
    'back: {names} вернулась',
].join('\n');

/* ---------- Настройки (глобальные) и состояние (на чат) ---------- */

function getSettings() {
    const s = (extension_settings[MODULE] ??= {});
    const defaults = { enabled: true, depth: 0, autoSync: true, scanUser: true, scanAi: false, notify: true, triggers: DEFAULT_TRIGGERS };
    for (const k in defaults) if (s[k] === undefined) s[k] = defaults[k];
    return s;
}

function getState() {
    const meta = getContext().chatMetadata;
    if (!meta[MODULE]) meta[MODULE] = { chars: [], note: '', endOnUser: true, scanned: {} };
    return meta[MODULE];
}

/* ---------- Утилиты ---------- */

const splitNames = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const findChar = (st, name) => st.chars.find(c => c.name.toLowerCase() === name.toLowerCase());
const list = (arr) => arr.map(c => c.name).join(', ');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return `${str.length}:${h}`;
}

function ensureChar(st, name, role = 'ai') {
    let c = findChar(st, name);
    if (!c) {
        c = { name, role, focus: false };
        st.chars.push(c);
    }
    return c;
}

/* ---------- Персонажи активного чата ---------- */

function syncChatChars() {
    if (!getSettings().autoSync) return;
    const ctx = getContext();
    const st = getState();
    const before = st.chars.length;

    if (ctx.groupId != null) {
        const g = (ctx.groups || []).find(x => String(x.id) === String(ctx.groupId));
        (g?.members || []).forEach(av => {
            const ch = (ctx.characters || []).find(c => c.avatar === av);
            if (ch) ensureChar(st, ch.name, 'ai');
        });
    } else if (ctx.characterId !== undefined && ctx.name2) {
        ensureChar(st, ctx.name2, 'ai');
    } else {
        return; // чат не открыт
    }
    if (ctx.name1) ensureChar(st, ctx.name1, 'user');
    if (st.chars.length !== before) saveMetadataDebounced();
}

/* ---------- Триггеры ---------- */

let triggerCache = { src: null, list: [] };

function compileTriggers() {
    const src = getSettings().triggers;
    if (triggerCache.src === src) return triggerCache.list;
    const out = [];
    for (const line of src.split('\n')) {
        const m = line.match(/^\s*(focus|reset|away|back)\s*:\s*(.+?)\s*$/i);
        if (!m) continue;
        const action = m[1].toLowerCase();
        const pat = m[2];
        const tail = /\{names\}\s*$/.test(pat);
        const cap = tail ? '([^.!?*\\n)\\]…]+)' : '([^.!?*\\n)\\]…]{1,60}?)';
        const re = new RegExp(pat.split('{names}').map(escapeRe).join(cap), 'giu');
        out.push({ action, re, tail });
    }
    triggerCache = { src, list: out };
    return out;
}

// Мягкое сравнение имени со словом (учитывает склонение: Акира → Акиры, Акиру)
function wordMatches(word, name) {
    const w = word.toLowerCase();
    const n = name.toLowerCase();
    const stem = n.length >= 6 ? n.slice(0, -2) : n.length >= 4 ? n.slice(0, -1) : n;
    return w.startsWith(stem) && w.length <= n.length + 3;
}

function resolveNames(st, segment, allowCreate) {
    // обрезаем придаточную часть: «на Какаши, пока Хато спит»
    const seg = segment.split(/\s(?:пока|когда|чтобы|а|но|while|when|as)\s/i)[0];
    const words = seg.match(/[\p{L}\p{N}'’-]+/gu) || [];
    const low = seg.toLowerCase();
    const found = st.chars.filter(c => c.name.includes(' ')
        ? low.includes(c.name.toLowerCase())
        : words.some(w => wordMatches(w, c.name)));

    if (!found.length && allowCreate) {
        for (const w of words) {
            if (/^\p{Lu}/u.test(w) && w.length > 1) found.push(ensureChar(st, w, 'ai'));
        }
    }
    return found;
}

function applyTriggers(st, text) {
    const matches = [];
    for (const t of compileTriggers()) {
        t.re.lastIndex = 0;
        let m;
        while ((m = t.re.exec(text))) {
            matches.push({ idx: m.index, action: t.action, cap: m[1] || '', tail: t.tail });
            if (m[0].length === 0) t.re.lastIndex++;
        }
    }
    matches.sort((a, b) => a.idx - b.idx);

    const log = [];
    for (const m of matches) {
        if (m.action === 'reset') {
            st.chars.forEach(c => { c.focus = false; });
            log.push('фокус сброшен');
            continue;
        }
        const found = resolveNames(st, m.cap, m.tail && m.action === 'focus');
        if (!found.length) continue;
        if (m.action === 'focus') {
            st.chars.forEach(c => { c.focus = false; });
            found.forEach(c => { if (c.role === 'away') c.role = 'ai'; c.focus = true; });
            log.push(`фокус → ${list(found)}`);
        } else if (m.action === 'away') {
            found.forEach(c => { c.role = 'away'; c.focus = false; });
            log.push(`ушли: ${list(found)}`);
        } else if (m.action === 'back') {
            found.forEach(c => { if (c.role === 'away') c.role = 'ai'; });
            log.push(`вернулись: ${list(found)}`);
        }
    }
    return log;
}

function scanMessage(id) {
    const s = getSettings();
    if (!s.enabled) return;
    const ctx = getContext();
    const msg = ctx.chat?.[id];
    if (!msg || !msg.mes || msg.is_system) return;
    if (msg.is_user ? !s.scanUser : !s.scanAi) return;

    const st = getState();
    st.scanned ??= {};
    const h = hash(msg.mes);
    if (st.scanned[id] === h) return; // это сообщение уже обработано
    st.scanned[id] = h;

    const log = applyTriggers(st, msg.mes);
    if (log.length) {
        if (s.notify) toastr.info(log.join('; '), 'Scene Focus');
        commit();
    } else {
        saveMetadataDebounced();
    }
}

/* ---------- Сборка промпта ---------- */

function buildPrompt(st) {
    const mine = st.chars.filter(c => c.role === 'user');
    const away = st.chars.filter(c => c.role === 'away');
    const focus = st.chars.filter(c => c.focus && c.role !== 'away');
    const focusIsOnlyAi = focus.length && focus.every(c => c.role !== 'user');

    if (!mine.length && !focus.length && !away.length && !st.note.trim()) return '';

    const L = [];
    L.push('[SCENE FOCUS — HIGHEST-PRIORITY OOC DIRECTIVE. Follow it strictly in your next reply and never mention it.]');

    if (focus.length) {
        L.push(`NARRATIVE FOCUS: this reply is ONLY about: ${list(focus)}. Show what they do, say, think and what happens around them. Do not move the camera to anyone else, and do not cut back to other characters.`);
    }
    if (mine.length) {
        L.push(`USER-CONTROLLED CHARACTERS: ${list(mine)}. NEVER write their dialogue, actions, thoughts, feelings, reactions, decisions or movements, not even a single line or gesture. Do not continue or finish their actions. Only the user writes them. This rule overrides the character card, the story logic and any habit of writing for them.`);
        if (focusIsOnlyAi) {
            L.push(`${list(mine)} ${mine.length > 1 ? 'are' : 'is'} NOT part of the current scene: do not make them appear, speak or react, and do not let characters in the focus know what happens in the user's scene unless it was explicitly shared with them.`);
        }
    }
    if (away.length) {
        L.push(`ABSENT CHARACTERS: ${list(away)}. They are elsewhere and are not in the current scene. Do not have them speak, act or appear unless the narration is explicitly at their location.`);
    }
    if (st.note.trim()) {
        L.push(`CURRENT SCENE / LOCATION: ${st.note.trim()}`);
    }
    if (st.endOnUser && mine.length) {
        L.push(`If the story reaches a moment where ${list(mine)} would have to act or speak, stop the reply right there and leave that part for the user.`);
    }
    return L.join('\n');
}

function applyPrompt() {
    const s = getSettings();
    const text = s.enabled ? buildPrompt(getState()) : '';
    setExtensionPrompt(PROMPT_KEY, text, extension_prompt_types.IN_CHAT, Number(s.depth) || 0, false, extension_prompt_roles.SYSTEM);
}

function commit() {
    saveMetadataDebounced();
    applyPrompt();
    renderUI();
}

/* ---------- UI ---------- */

function renderUI() {
    if (!$('#sf_list').length) return;
    const s = getSettings();
    const st = getState();

    $('#sf_enabled').prop('checked', s.enabled);
    $('#sf_auto_sync').prop('checked', s.autoSync);
    $('#sf_scan_user').prop('checked', s.scanUser);
    $('#sf_scan_ai').prop('checked', s.scanAi);
    $('#sf_notify').prop('checked', s.notify);
    $('#sf_depth').val(s.depth);
    if (!$('#sf_triggers').is(':focus')) $('#sf_triggers').val(s.triggers);
    if (!$('#sf_note').is(':focus')) $('#sf_note').val(st.note);
    $('#sf_end_on_user').prop('checked', st.endOnUser);

    const focus = st.chars.filter(c => c.focus && c.role !== 'away');
    $('#sf_status').text(focus.length ? `Сейчас фокус: ${list(focus)}` : 'Сейчас фокус: не задан (обычный режим)');

    const box = $('#sf_list').empty();
    if (!st.chars.length) box.append('<div class="sf-empty">Список пуст. Открой чат или добавь персонажей ниже.</div>');
    st.chars.forEach((c, i) => {
        const row = $(`
            <div class="sf-row" data-i="${i}">
                <span class="sf-name"></span>
                <select class="sf-role text_pole">
                    <option value="user">Мой (я пишу)</option>
                    <option value="ai">ИИ пишет</option>
                    <option value="away">Отсутствует</option>
                </select>
                <label class="sf-focus-label" title="Фокус повествования"><input type="checkbox" class="sf-focus"> ★ фокус</label>
                <div class="sf-del menu_button fa-solid fa-trash" title="Удалить"></div>
            </div>`);
        row.find('.sf-name').text(c.name);
        row.find('.sf-role').val(c.role);
        row.find('.sf-focus').prop('checked', c.focus).prop('disabled', c.role === 'away');
        box.append(row);
    });
}

function addUI() {
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Scene Focus</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="sf_enabled"><span>Включить расширение</span></label>
            <div id="sf_status" class="sf-hint"></div>

            <div id="sf_list"></div>

            <div class="sf-add">
                <input type="text" id="sf_new_name" class="text_pole" placeholder="Имя персонажа">
                <div id="sf_add_btn" class="menu_button">Добавить</div>
            </div>
            <div class="sf-buttons">
                <div id="sf_from_chat" class="menu_button">Взять из чата</div>
                <div id="sf_clear_focus" class="menu_button">Сбросить фокус</div>
            </div>

            <label class="checkbox_label"><input type="checkbox" id="sf_auto_sync"><span>Автоматически добавлять персонажей чата (карточка/группа и персона)</span></label>

            <label for="sf_note">Где / что сейчас происходит (необязательно)</label>
            <textarea id="sf_note" class="text_pole" rows="2" placeholder="Например: Коноха, кабинет Хокаге."></textarea>

            <label class="checkbox_label"><input type="checkbox" id="sf_end_on_user"><span>Останавливаться, когда нужно действие моего персонажа</span></label>

            <hr>
            <b>Триггерные фразы</b>
            <div class="sf-hint">Если такая фраза встретится в сообщении, фокус переключится сам. Одна строка = один триггер, формат: <code>действие: фраза с {names}</code>. Действия: focus, reset, away, back.</div>
            <textarea id="sf_triggers" class="text_pole" rows="9"></textarea>
            <div class="sf-buttons"><div id="sf_triggers_default" class="menu_button">Триггеры по умолчанию</div></div>
            <label class="checkbox_label"><input type="checkbox" id="sf_scan_user"><span>Искать триггеры в моих сообщениях</span></label>
            <label class="checkbox_label"><input type="checkbox" id="sf_scan_ai"><span>Искать триггеры в сообщениях ИИ</span></label>
            <label class="checkbox_label"><input type="checkbox" id="sf_notify"><span>Показывать уведомление при срабатывании</span></label>

            <label for="sf_depth">Глубина вставки (0 = в самый конец, сильнее всего)</label>
            <input type="number" id="sf_depth" class="text_pole" min="0" max="20" step="1">

            <div class="sf-hint">Команды: /focus Имя1, Имя2 · /mine · /ai · /away Имя · /scenenote текст</div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const bindCheck = (sel, key) => $(document).on('change', sel, function () {
        getSettings()[key] = $(this).prop('checked');
        saveSettingsDebounced();
        applyPrompt();
        if (key === 'autoSync') { syncChatChars(); renderUI(); }
    });
    bindCheck('#sf_enabled', 'enabled');
    bindCheck('#sf_auto_sync', 'autoSync');
    bindCheck('#sf_scan_user', 'scanUser');
    bindCheck('#sf_scan_ai', 'scanAi');
    bindCheck('#sf_notify', 'notify');

    $(document).on('input', '#sf_depth', function () {
        getSettings().depth = Math.max(0, parseInt($(this).val(), 10) || 0);
        saveSettingsDebounced();
        applyPrompt();
    });
    $(document).on('input', '#sf_note', function () {
        getState().note = String($(this).val());
        saveMetadataDebounced();
        applyPrompt();
    });
    $(document).on('input', '#sf_triggers', function () {
        getSettings().triggers = String($(this).val());
        saveSettingsDebounced();
    });
    $(document).on('click', '#sf_triggers_default', () => {
        getSettings().triggers = DEFAULT_TRIGGERS;
        saveSettingsDebounced();
        $('#sf_triggers').val(DEFAULT_TRIGGERS);
    });
    $(document).on('change', '#sf_end_on_user', function () {
        getState().endOnUser = $(this).prop('checked');
        commit();
    });

    const addFromInput = () => {
        const name = String($('#sf_new_name').val()).trim();
        if (!name) return;
        ensureChar(getState(), name, 'ai');
        $('#sf_new_name').val('');
        commit();
    };
    $(document).on('click', '#sf_add_btn', addFromInput);
    $(document).on('keydown', '#sf_new_name', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } });

    $(document).on('click', '#sf_from_chat', () => {
        const prev = getSettings().autoSync;
        getSettings().autoSync = true;
        syncChatChars();
        getSettings().autoSync = prev;
        commit();
    });
    $(document).on('click', '#sf_clear_focus', () => {
        getState().chars.forEach(c => { c.focus = false; });
        commit();
    });

    $(document).on('change', '#sf_list .sf-role', function () {
        const c = getState().chars[$(this).closest('.sf-row').data('i')];
        if (!c) return;
        c.role = String($(this).val());
        if (c.role === 'away') c.focus = false;
        commit();
    });
    $(document).on('change', '#sf_list .sf-focus', function () {
        const c = getState().chars[$(this).closest('.sf-row').data('i')];
        if (!c) return;
        c.focus = $(this).prop('checked');
        commit();
    });
    $(document).on('click', '#sf_list .sf-del', function () {
        getState().chars.splice($(this).closest('.sf-row').data('i'), 1);
        commit();
    });
}

/* ---------- Слэш-команды ---------- */

function registerCommands() {
    const add = (name, help, desc, fn) => SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name,
        helpString: help,
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: desc, typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
        returns: 'nothing',
        callback: (_args, value) => { fn(String(value ?? '')); commit(); return ''; },
    }));

    add('focus', 'Фокус на указанных персонажах (через запятую). Без аргументов — сбросить фокус.', 'имена через запятую', (v) => {
        const st = getState();
        const names = splitNames(v);
        st.chars.forEach(c => { c.focus = false; });
        names.forEach(n => {
            const c = ensureChar(st, n, 'ai');
            if (c.role === 'away') c.role = 'ai';
            c.focus = true;
        });
        toastr.info(names.length ? `Фокус: ${names.join(', ')}` : 'Фокус сброшен', 'Scene Focus');
    });

    const setRole = (role, label) => (v) => {
        const st = getState();
        splitNames(v).forEach(n => {
            const c = ensureChar(st, n, role);
            c.role = role;
            if (role === 'away') c.focus = false;
        });
        toastr.info(`${label}: ${splitNames(v).join(', ')}`, 'Scene Focus');
    };
    add('mine', 'Пометить персонажей как управляемых пользователем.', 'имена через запятую', setRole('user', 'Мои'));
    add('ai', 'Пометить персонажей как управляемых ИИ.', 'имена через запятую', setRole('ai', 'ИИ'));
    add('away', 'Пометить персонажей как отсутствующих в сцене.', 'имена через запятую', setRole('away', 'Отсутствуют'));
    add('scenenote', 'Заметка о текущей сцене/локации. Без аргументов — очистить.', 'текст', (v) => { getState().note = v.trim(); });
}

/* ---------- Инициализация ---------- */

jQuery(() => {
    getSettings();
    addUI();
    registerCommands();

    const ctx = getContext();
    const { eventSource, eventTypes } = ctx;

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        syncChatChars();
        applyPrompt();
        renderUI();
    });
    eventSource.on(eventTypes.MESSAGE_SENT, (id) => scanMessage(id));
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id) => scanMessage(id));
    // подстраховка: перед генерацией проверяем последнее сообщение пользователя
    eventSource.on(eventTypes.GENERATION_STARTED, (_type, _params, dryRun) => {
        if (dryRun) return;
        const chat = getContext().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user) { scanMessage(i); break; }
        }
    });

    syncChatChars();
    applyPrompt();
    renderUI();
});
