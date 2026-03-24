// MVR — 4-track chop sampler inspired by MLR

import * as os from 'os';

// costanti inline (no import da input_filter.mjs che rompe move_midi_internal_send)
var Black = 0, White = 120;
var BrightRed = 1, DeepRed = 65, Cyan = 14, TealGreen = 12;
var HotMagenta = 21, MutedViolet = 105, Bright = 3, BurntOrange = 28;
var MoveShift = 49, MoveBack = 51, MoveMainKnob = 14, MoveMainButton = 3, MoveMaster = 79;
var MoveRowButtons = [43, 42, 41, 40]; /* row A=43, B=42, C=41, D=40 */
var MoveLeft  = 62;  /* freccia sinistra — pagina precedente */
var MoveRight = 63;  /* freccia destra — pagina successiva */
var MoveCopy  = 60;  /* tasto copy */

var MVR_CMD_PATH   = "/data/UserData/schwung/modules/tools/mvr/cmd";
var MVR_STATE_PATH = "/data/UserData/schwung/modules/tools/mvr/state.json";

function writeCmd(cmd) {
    try {
        var s = cmd + "\n";
        var buf = new ArrayBuffer(s.length);
        var view = new Uint8Array(buf);
        for (var i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
        var fd = os.open(MVR_CMD_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666);
        if (fd >= 0) { os.write(fd, buf, 0, s.length); os.close(fd); }
    } catch(e) {}
}

/* Scrive più comandi in un'unica scrittura (il DSP legge tutte le righe) */
function writeCmdMulti(lines) {
    try {
        var s = lines.join("\n") + "\n";
        var buf = new ArrayBuffer(s.length);
        var view = new Uint8Array(buf);
        for (var i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
        var fd = os.open(MVR_CMD_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666);
        if (fd >= 0) { os.write(fd, buf, 0, s.length); os.close(fd); }
    } catch(e) {}
}

/* Salva i path dei sample caricati */
var savedPaths   = ["", "", "", ""];
var dspLoadedPath = ["", "", "", ""];  /* path effettivamente caricato nel DSP per ogni traccia */

/* ─── Pagine ─────────────────────────────────────────────────────────────── */
var currentPage = 0;
var pages = [
    { paths: ["","","",""], bars: [0,0,0,0], vol: [100,100,100,100] },
    { paths: ["","","",""], bars: [0,0,0,0], vol: [100,100,100,100] },
    { paths: ["","","",""], bars: [0,0,0,0], vol: [100,100,100,100] },
    { paths: ["","","",""], bars: [0,0,0,0], vol: [100,100,100,100] }
];

function saveState() {
    try {
        /* sync working vars → pages[currentPage] */
        var cp = pages[currentPage];
        cp.paths = savedPaths.slice();
        cp.bars  = trackBars.slice();
        cp.vol   = trackVol.slice();
        var pagesData = [];
        for (var _pi = 0; _pi < NUM_PAGES; _pi++) {
            var pg = pages[_pi];
            pagesData.push({ samples: pg.paths.slice(), bars: pg.bars.slice(), vol: pg.vol.slice() });
        }
        var s = JSON.stringify({ bpm: bpm, quant: quant, mvol: masterVol, loopMode: loopMode, currentPage: currentPage, pages: pagesData });
        var buf = new ArrayBuffer(s.length);
        var view = new Uint8Array(buf);
        for (var i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
        var fd = os.open(MVR_STATE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666);
        if (fd >= 0) { os.write(fd, buf, 0, s.length); os.close(fd); }
    } catch(e) {}
}

function loadState() {
    try {
        var fd = os.open(MVR_STATE_PATH, os.O_RDONLY, 0);
        if (fd < 0) return;
        var buf = new ArrayBuffer(8192);
        var n = os.read(fd, buf, 0, 8192);
        os.close(fd);
        if (n <= 0) return;
        var s = "";
        var view = new Uint8Array(buf);
        for (var i = 0; i < n; i++) s += String.fromCharCode(view[i]);
        var obj = JSON.parse(s);
        if (!obj) return;
        if (typeof obj.bpm === "number" && obj.bpm >= 40 && obj.bpm <= 200)
            bpm = obj.bpm;
        if (typeof obj.quant === "number" && QUANT_OPTIONS.indexOf(obj.quant) >= 0)
            quant = obj.quant;
        if (typeof obj.mvol === "number" && obj.mvol >= 0 && obj.mvol <= 200)
            masterVol = obj.mvol;
        if (typeof obj.loopMode === "boolean")
            loopMode = obj.loopMode;
        /* currentPage: sempre pagina 1 all'avvio — non ripristinare */
        /* carica pagine */
        if (Array.isArray(obj.pages)) {
            for (var _pi = 0; _pi < NUM_PAGES && _pi < obj.pages.length; _pi++) {
                var pg = obj.pages[_pi];
                if (!pg) continue;
                if (Array.isArray(pg.samples)) {
                    for (var r = 0; r < NUM_ROWS; r++) pages[_pi].paths[r] = pg.samples[r] || "";
                }
                if (Array.isArray(pg.bars)) {
                    for (var r = 0; r < NUM_ROWS; r++) if (pg.bars[r]) pages[_pi].bars[r] = pg.bars[r];
                }
                if (Array.isArray(pg.vol)) {
                    for (var r = 0; r < NUM_ROWS; r++) if (typeof pg.vol[r] === "number") pages[_pi].vol[r] = pg.vol[r];
                }
            }
        } else if (Array.isArray(obj.samples)) {
            /* compatibilità con stato precedente a pagine singole */
            for (var r = 0; r < NUM_ROWS; r++) pages[0].paths[r] = obj.samples[r] || "";
            if (Array.isArray(obj.bars)) for (var r = 0; r < NUM_ROWS; r++) if (obj.bars[r]) pages[0].bars[r] = obj.bars[r];
            if (Array.isArray(obj.vol)) for (var r = 0; r < NUM_ROWS; r++) if (typeof obj.vol[r] === "number") pages[0].vol[r] = obj.vol[r];
        }
        /* sync pagina corrente → working vars */
        var cp = pages[currentPage];
        savedPaths = cp.paths.slice();
        trackBars  = cp.bars.slice();
        trackVol   = cp.vol.slice();
        for (var r = 0; r < NUM_ROWS; r++) {
            if (cp.paths[r]) {
                sampleNames[r]  = cp.paths[r].split("/").pop().replace(/\.wav$/i, "").slice(0, 10);
                sampleLoaded[r] = true;
            }
        }
        /* invia comandi DSP */
        var cmds = [];
        cmds.push("bpm:" + bpm.toFixed(1));
        cmds.push("quant:" + quant.toFixed(2));
        for (var r = 0; r < NUM_ROWS; r++)
            cmds.push("tvol:" + String(r) + ":" + String(trackVol[r]));
        cmds.push("vol:" + String(masterVol));
        for (var r = 0; r < NUM_ROWS; r++) {
            if (savedPaths[r]) {
                cmds.push("load:" + String(r) + ":" + savedPaths[r]);
                dspLoadedPath[r] = savedPaths[r];
            }
        }
        /* bars DOPO i load: sovrascrive l'auto-detect solo se valore salvato > 0 */
        for (var r = 0; r < NUM_ROWS; r++)
            if (trackBars[r] > 0) cmds.push("bars:" + String(r) + ":" + String(trackBars[r]));
        writeCmdMulti(cmds);
    } catch(e) {}
}

var ROW_BASE_NOTES = [92, 84, 76, 68];
var NUM_ROWS  = 4;
var NUM_CHOPS = 8;
var NUM_PAGES = 4;
var ROW_LABELS = ["A", "B", "C", "D"];

var ROW_COLORS_IDLE   = [TealGreen, MutedViolet, BurntOrange, DeepRed];
var ROW_COLORS_ACTIVE = [Cyan,      HotMagenta,  Bright,      BrightRed];

// ─── Stato ────────────────────────────────────────────────────────────────────

var mode = "browser";
var shiftHeld = false;
var shiftUsed = false;   /* true se shift è stato usato per BPM/bars (non toggle browser) */
var masterVol = 100;     /* 0-200, 100 = unity */

var bpm = 120;           /* BPM target (40-200) */
var previewDetectedBpm = 0; /* BPM originale del sample in preview (0 = non disponibile) */
var previewDetectedKey = ""; /* tonalità del sample in preview (es. "Cmaj", "Dmin") */
var loopMode = true;     /* true = loop chop, false = one-shot */
var loopLedSent = false; /* invia il LED del loop button al primo tick */
var trackVol   = [100, 100, 100, 100]; /* volume per traccia 0-200 */
var filterVal  = [100, 100, 100, 100]; /* DJ filter 0=LP 100=flat 200=HP */
var reverbVal   = [0, 0, 0, 0];        /* reverb wet 0=dry 200=full wet */
var reverbFading = false;              /* fade-out attivo dopo rilascio step2 */
var step1Held  = false;
var step2Held  = false;
var MoveKnobs  = [71, 72, 73, 74];    /* CC knob 1-4 */
var MoveStep1  = 16;                  /* step button 1, nota 0x90 */
var MoveStep2  = 17;                  /* step button 2, nota 0x90 */
var trackBars = [0, 0, 0, 0]; /* bars per traccia: 0=auto-detect in attesa */
var BARS_CYCLE = [0.25, 1, 2, 4, 8, 16];
var quant = 0;               /* beat quantizzazione: 0=free */
var QUANT_OPTIONS = [0, 0.125, 0.25, 0.5, 1, 2, 4, 8];
var QUANT_LABELS  = ["free", "1/32", "1/16", "1/8", "1/4", "1/2", "1bar", "2bar"];

var activeChop   = [-1, -1, -1, -1];
var heldPad      = [-1, -1, -1, -1];  /* pad attualmente tenuto premuto per row */
var rangeStart   = [-1, -1, -1, -1];  /* range attivo: chop iniziale */
var rangeEnd     = [-1, -1, -1, -1];  /* range attivo: chop finale */
var expectedChop = [-1, -1, -1, -1];  /* chop atteso dal DSP dopo play/range/stop */
var stopPending  = [false, false, false, false]; /* stop quantizzato in attesa di conferma DSP */
var dspBeatEpoch = 0;  /* timestamp ms dell'ultimo boundary del quantize (da beat_phase DSP) */
var madeRange    = [false, false, false, false]; /* range creato mentre tenevo il pad */

// ─── MIDI Recorder (MLR-style esatto) ─────────────────────────────────────────
// stati: 0=idle  1=armed (aspetta prima nota)  2=recording  3=playing
// Identico all'originale MLR monome: capture arma, prima nota avvia rec,
// prossimo chop 0 chiude il loop e avvia playback.
var REC_PAD      = 0x34;
var recState     = 0;
var recBuf       = [];   /* eventi registrati: [{row,col,t,on}] timestamp assoluto */
var recEvents    = [];   /* eventi compilati per playback (timestamp relativo) */
var recOverBuf   = [];   /* overdub buffer: eventi registrati durante il playback */
var recDuration  = 0;
var recRecStart  = 0;    /* timestamp prima nota premuta (inizio registrazione) */
var recPlayStart = 0;
var recPlayPos   = 0;
var recPlayIdx   = 0;
var recPlayRow   = -1;
var recPlayRows  = {};   /* righe attivate dal recorder: {row: true} */
var recBarCount  = 0;    /* bar contati dal DSP chop 0 dall'ultimo loop start */
var recBarMs     = 0;    /* durata 1 bar in ms (calibrato da chop 0 crossings) */
var recLastChop0 = 0;    /* timestamp assoluto ultimo chop 0 crossing */
var recLedVal    = 0;    /* valore LED attuale (evita messaggi MIDI ridondanti) */
var recTickMs    = 30;   /* intervallo tick misurato in ms (auto-calibrato) */
var recLastTick  = 0;    /* timestamp ultimo tick */
var sampleNames  = ["---", "---", "---", "---"];
var sampleLoaded = [false, false, false, false];

// copy mode
var copyMode         = false;
var copySourcePage   = -1;
var copyDestPage     = -1;
var copySelectedRows = [false, false, false, false];

// browser state
var assigningRow  = -1;   // -1 = scegli riga; >= 0 = file browser attivo
var lastLoadPath  = "";
var browserDir    = "";
var browserItems  = [];   // [{name, isDir, path}]
var browserSelIdx = 0;
var BROWSER_ROOT  = "/data/UserData/UserLibrary/Samples";
var ITEMS_VISIBLE = 4;

// ─── Command queue — flush in tick() per evitare sovrascritture O_TRUNC ──────

var cmdQueue = [];

function queueCmd(cmd) {
    cmdQueue.push(cmd);
}

function flushCmds() {
    if (cmdQueue.length === 0) return;
    writeCmdMulti(cmdQueue);
    cmdQueue = [];
}

// ─── LED queue — 8 per tick ───────────────────────────────────────────────────

var ledQueue    = [];
var ledQueueIdx = 0;

function padLed(note, color) {
    move_midi_internal_send([0x09, 0x90, note, color]);
}

function buttonLed(cc, color) {
    move_midi_internal_send([0x0b, 0xB0, cc, color]);
}

function scheduleLEDs() {
    ledQueue    = [];
    ledQueueIdx = 0;
    for (var r = 0; r < NUM_ROWS; r++) {
        var rowColor = activeChop[r] >= 0 ? ROW_COLORS_ACTIVE[r] : Black;
        buttonLed(MoveRowButtons[r], rowColor);
    }
    for (var r = 0; r < NUM_ROWS; r++) {
        for (var c = 0; c < NUM_CHOPS; c++) {
            var note  = ROW_BASE_NOTES[r] + c;
            var color;
            if (mode === "browser" && assigningRow === -1) {
                /* fase 1: col 0 colorata per scegliere la riga */
                color = c === 0 ? ROW_COLORS_ACTIVE[r] : Black;
            } else if (mode === "browser") {
                /* fase 2: solo chop attivo, resto nero */
                color = activeChop[r] === c ? ROW_COLORS_ACTIVE[r] : Black;
            } else {
                /* player: logica MLR completa con range idle */
                if (rangeStart[r] >= 0 && c >= rangeStart[r] && c <= rangeEnd[r]) {
                    color = (activeChop[r] === c) ? ROW_COLORS_ACTIVE[r] : ROW_COLORS_IDLE[r];
                } else {
                    color = activeChop[r] === c ? ROW_COLORS_ACTIVE[r] : Black;
                }
            }
            /* UNA sola entry per pad — nessun duplicato Black + colored */
            ledQueue.push([note, color]);
        }
    }
}

function flushLEDs() {
    if (ledQueueIdx >= ledQueue.length) return;
    var end = Math.min(ledQueueIdx + 8, ledQueue.length);
    for (var i = ledQueueIdx; i < end; i++) {
        padLed(ledQueue[i][0], ledQueue[i][1]);
    }
    ledQueueIdx = end;
}

function refreshAllLEDs() {
    scheduleLEDs();
}

function setPadLED(row, col, active) {
    padLed(ROW_BASE_NOTES[row] + col, active ? ROW_COLORS_ACTIVE[row] : Black);
}

function setRowButtonLED(row, playing) {
    buttonLed(MoveRowButtons[row], playing ? ROW_COLORS_ACTIVE[row] : Black);
}

// ─── Filesystem ───────────────────────────────────────────────────────────────

function decodeDelta(vel) {
    return vel > 64 ? vel - 128 : vel;
}

function checkIsDir(path) {
    try {
        var st = os.stat(path);
        if (!st) return false;
        var obj = Array.isArray(st) ? st[0] : st;
        if (!obj || typeof obj !== "object") return false;
        if (typeof obj.mode === "number") {
            return (obj.mode & 0o170000) === 0o040000;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function readDir(path) {
    var items = [];
    try {
        var out = os.readdir(path);
        var names;
        if (Array.isArray(out) && Array.isArray(out[0])) names = out[0];
        else if (Array.isArray(out)) names = out;
        else return items;

        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (!name || name === "." || name === "..") continue;
            if (name.charAt(0) === ".") continue;
            var fullPath = path + "/" + name;
            var isDir = checkIsDir(fullPath);
            var isWav = !isDir && name.toLowerCase().slice(-4) === ".wav";
            if (isDir || isWav) {
                items.push({ name: name, isDir: isDir, path: fullPath });
            }
        }
        items.sort(function(a, b) {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            var an = a.name.toLowerCase(), bn = b.name.toLowerCase();
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
    } catch (e) {}
    return items;
}

function enterDir(path) {
    browserDir         = path;
    browserItems       = readDir(path);
    browserSelIdx      = 0;
    previewDetectedBpm = 0;
    previewDetectedKey = "";
}

function syncPageOut() {
    var p = pages[currentPage];
    p.paths = savedPaths.slice();
    p.bars  = trackBars.slice();
    p.vol   = trackVol.slice();
}

function syncPageIn() {
    var p = pages[currentPage];
    savedPaths   = p.paths.slice();
    trackBars    = p.bars.slice();
    trackVol     = p.vol.slice();
    filterVal    = [100, 100, 100, 100];
    reverbVal    = [0, 0, 0, 0];
    for (var r = 0; r < NUM_ROWS; r++) {
        if (p.paths[r]) {
            sampleNames[r]  = p.paths[r].split("/").pop().replace(/\.wav$/i, "").slice(0, 10);
            sampleLoaded[r] = true;
        } else {
            sampleNames[r]  = "---";
            sampleLoaded[r] = false;
        }
    }
}

function switchPage(dir) {
    syncPageOut();
    /* salva quali tracce stanno suonando PRIMA di syncPageIn */
    var wasPlaying = [];
    for (var r = 0; r < NUM_ROWS; r++) wasPlaying[r] = (activeChop[r] >= 0);
    currentPage = (currentPage + dir + NUM_PAGES) % NUM_PAGES;
    syncPageIn();
    var cmds = [];
    cmds.push("bpm:" + bpm.toFixed(1));
    for (var r = 0; r < NUM_ROWS; r++) {
        cmds.push("tvol:" + r + ":" + trackVol[r]);
        if (!wasPlaying[r]) {
            /* traccia ferma: stop + carica nuovo sample subito, reset runtime */
            cmds.push("stop:" + r);
            activeChop[r]   = -1;
            heldPad[r]      = -1;
            rangeStart[r]   = -1;
            rangeEnd[r]     = -1;
            expectedChop[r] = -1;
            stopPending[r]  = false;
            madeRange[r]    = false;
            setRowButtonLED(r, false);
            if (savedPaths[r]) {
                cmds.push("load:" + r + ":" + savedPaths[r]);
                if (trackBars[r] > 0) cmds.push("bars:" + r + ":" + trackBars[r]);
                dspLoadedPath[r] = savedPaths[r];
            } else {
                dspLoadedPath[r] = "";
            }
        } else {
            /* traccia in play: continua a suonare, LED restano aggiornati dal tick */
            heldPad[r]      = -1;
            rangeStart[r]   = -1;
            rangeEnd[r]     = -1;
            stopPending[r]  = false;
            madeRange[r]    = false;
        }
    }
    if (cmds.length > 0) writeCmdMulti(cmds);
    /* annulla recorder */
    recState  = 0;
    recBuf    = [];
    recEvents = [];
    recOverBuf = [];
    recLedVal = 0;
    move_midi_internal_send([0x0b, 0xB0, REC_PAD, 0]);
    /* torna a player */
    mode         = "player";
    assigningRow = -1;
    reverbFading = false;
    step1Held    = false;
    step2Held    = false;
    saveState();
    refreshAllLEDs();
    drawPlayer();
}

// ─── Player ───────────────────────────────────────────────────────────────────

function jumpToChop(row, col, loop) {
    madeRange[row] = false;
    ledQueue = []; ledQueueIdx = 0;
    /* Spegni tutti i pad del range precedente (o il singolo chop) */
    if (rangeStart[row] >= 0) {
        for (var c = rangeStart[row]; c <= rangeEnd[row]; c++)
            padLed(ROW_BASE_NOTES[row] + c, Black);
    } else if (activeChop[row] >= 0) {
        setPadLED(row, activeChop[row], false);
    }
    rangeStart[row] = -1;
    rangeEnd[row]   = -1;
    activeChop[row]   = col;
    expectedChop[row] = col;
    setPadLED(row, col, true);
    setRowButtonLED(row, true);
    queueCmd((loop ? "loop:" : "play:") + String(row) + ":" + String(col));
}

function makeRange(row, col1, col2) {
    madeRange[row] = true;
    ledQueue = []; ledQueueIdx = 0;
    /* spegni range/chop precedente */
    if (rangeStart[row] >= 0) {
        for (var c = rangeStart[row]; c <= rangeEnd[row]; c++)
            padLed(ROW_BASE_NOTES[row] + c, Black);
    } else if (activeChop[row] >= 0) {
        padLed(ROW_BASE_NOTES[row] + activeChop[row], Black);
    }
    var sc  = Math.min(col1, col2);
    var ec  = Math.max(col1, col2);
    var rev = (col1 > col2) ? 1 : 0;  /* tenuto a destra, premuto a sinistra = reverse */
    rangeStart[row] = sc;
    rangeEnd[row]   = ec;
    /* Illumina subito tutti i pad del range */
    var startPad = rev ? ec : sc;  /* pad da cui si inizia a suonare */
    for (var c = sc; c <= ec; c++)
        padLed(ROW_BASE_NOTES[row] + c, c === startPad ? ROW_COLORS_ACTIVE[row] : ROW_COLORS_IDLE[row]);
    activeChop[row]   = startPad;
    expectedChop[row] = startPad;
    setRowButtonLED(row, true);
    queueCmd("range:" + String(row) + ":" + String(sc) + ":" + String(ec) + ":" + String(rev));
}

/* Snap un timestamp assoluto al prossimo boundary di quantize (come MLR: event_record al boundary).
 * Feature 3: usa dspBeatEpoch (dal beat_phase del DSP) se disponibile — epoch allineata all'audio. */
function quantSnapMs(absT, epochT) {
    if (!quant || quant <= 0) return absT;
    var quantMs = quant * 60000 / bpm;
    var ep = (dspBeatEpoch > 0) ? dspBeatEpoch : epochT;
    return ep + Math.ceil((absT - ep) / quantMs) * quantMs;
}

function compileRecording() {
    var _now = Date.now();
    /* durata = tempo esatto dal primo press al capture */
    recDuration = Math.max(100, _now - recRecStart);
    recEvents = [];
    for (var _ei = 0; _ei < recBuf.length; _ei++) {
        var _eb = recBuf[_ei];
        recEvents.push({
            row:  _eb.row,
            col:  _eb.col,
            t:    Math.max(0, _eb.t - recRecStart),
            on:   _eb.on,
            play: _eb.play
        });
    }
    recEvents.sort(function(a, b) { return a.t - b.t; });
    /* single mode: sintetizza note-off per pad ancora tenuti */
    if (!loopMode) {
        var _open = {};
        for (var _ci = 0; _ci < recEvents.length; _ci++) {
            if (recEvents[_ci].on) _open[recEvents[_ci].row] = recEvents[_ci].col;
            else delete _open[recEvents[_ci].row];
        }
        for (var _cr in _open)
            recEvents.push({ row: parseInt(_cr), col: _open[_cr], t: recDuration - 1, on: false });
        recEvents.sort(function(a, b) { return a.t - b.t; });
    }
    recState     = recEvents.length > 0 ? 3 : 0;
    recPlayStart = _now;
    recPlayPos   = 0;
    recPlayIdx   = 0;
    recBarCount  = 0;
    recLedVal    = recState === 3 ? 127 : 0;
    move_midi_internal_send([0x0b, 0xB0, REC_PAD, recLedVal]);
}

function stopChop(row) {
    ledQueue = []; ledQueueIdx = 0;
    var prev = activeChop[row];
    if (prev === -1) return;
    /* Spegni tutti i pad del range (o il singolo chop) */
    var rs = rangeStart[row] >= 0 ? rangeStart[row] : prev;
    var re = rangeEnd[row]   >= 0 ? rangeEnd[row]   : prev;
    for (var c = rs; c <= re; c++) padLed(ROW_BASE_NOTES[row] + c, Black);
    activeChop[row]   = -1;
    expectedChop[row] = -2;   /* -2 = in attesa di stop dal DSP */
    heldPad[row]      = -1;
    rangeStart[row]   = -1;
    rangeEnd[row]     = -1;
    setRowButtonLED(row, false);
    queueCmd("stop:" + String(row));
}

/* Deferred stop (Feature 2 — MLR: stop quantizzato al boundary).
 * Non tocca LED/activeChop: il tick li pulisce quando il DSP conferma chop=-1. */
function deferStop(row) {
    ledQueue = []; ledQueueIdx = 0;
    heldPad[row]    = -1;
    madeRange[row]  = false;
    stopPending[row] = true;
    queueCmd("stop:" + String(row));
}

// ─── Browser ──────────────────────────────────────────────────────────────────

function loadSample(row, filePath) {
    sampleNames[row] = filePath.split("/").pop().replace(/\.wav$/i, "").slice(0, 10);
    sampleLoaded[row] = true;
    lastLoadPath = filePath;
    savedPaths[row] = filePath;
    dspLoadedPath[row] = filePath;
    saveState();
    /* preview_stop + load in un'unica scrittura — nessuna sovrascrittura */
    writeCmdMulti(["preview_stop", "load:" + String(row) + ":" + filePath]);
}

// ─── Display ──────────────────────────────────────────────────────────────────

function drawReverbPage() {
    clear_screen();
    print(2, 1, "REVERB", 1);
    print(96, 1, "dry-->wet", 1);
    fill_rect(0, 9, 128, 1, 1);
    for (var r = 0; r < NUM_ROWS; r++) {
        var y      = 12 + r * 13;
        var barX   = 12;
        var barW   = 112;
        var barH   = 7;
        var innerX = barX + 1;
        var innerW = barW - 2;
        print(2, y, ROW_LABELS[r], 1);
        fill_rect(barX, y, barW, barH, 1);
        fill_rect(innerX, y + 1, innerW, barH - 2, 0);
        var fw = Math.round(reverbVal[r] / 200 * innerW);
        if (fw > 0) fill_rect(innerX, y + 1, fw, barH - 2, 1);
    }
    fill_rect(0, 55, 128, 1, 1);
    print(2, 57, "knob=wet  rel=off", 1);
    host_flush_display();
}

function drawFilterPage() {
    clear_screen();
    print(2, 1, "FILTER", 1);
    print(78, 1, "LP<--[+]-->HP", 1);
    fill_rect(0, 9, 128, 1, 1);
    for (var r = 0; r < NUM_ROWS; r++) {
        var y      = 12 + r * 13;
        var barX   = 12;
        var barW   = 112;
        var barH   = 7;
        var innerX = barX + 1;
        var innerW = barW - 2;
        var cOff   = Math.floor(innerW / 2);  /* offset del flat nel inner */
        print(2, y, ROW_LABELS[r], 1);
        fill_rect(barX, y, barW, barH, 1);          /* bordo */
        fill_rect(innerX, y + 1, innerW, barH - 2, 0); /* interno nero */
        fill_rect(innerX + cOff, y, 1, barH, 1);    /* segno flat (1px) */
        var pos = Math.round(filterVal[r] / 200 * innerW); /* 0-innerW */
        if (filterVal[r] < 99) {
            var fw = cOff - pos;
            if (fw > 0) fill_rect(innerX + pos, y + 1, fw, barH - 2, 1);
        } else if (filterVal[r] > 101) {
            var fw = pos - cOff;
            if (fw > 0) fill_rect(innerX + cOff + 1, y + 1, fw, barH - 2, 1);
        }
    }
    fill_rect(0, 55, 128, 1, 1);
    print(2, 57, "LP", 1);
    print(114, 57, "HP", 1);
    host_flush_display();
}

function drawPlayer() {
    clear_screen();
    var qi = QUANT_OPTIONS.indexOf(quant);
    var ql = qi >= 0 ? QUANT_LABELS[qi] : "?";
    var loopStr = loopMode ? "LP" : "1S";
    print(2, 2, "MVR" + String(currentPage+1) + " " + String(bpm) + "bpm " + ql + " " + loopStr, 1);
    fill_rect(0, 11, 128, 1, 1);
    for (var r = 0; r < NUM_ROWS; r++) {
        var y = 15 + r * 12;
        var name = (sampleLoaded[r] ? sampleNames[r] : "---").slice(0, 9);
        var bars = trackBars[r] > 0 ? (trackBars[r] === 0.25 ? "1/4b" : String(trackBars[r]) + "b") : "?b";
        print(2, y, ROW_LABELS[r] + ":" + name, 1);
        /* VU meter ridotto — 12px inner per fare spazio alla key */
        var barMax = 12;
        var barW   = Math.round(trackVol[r] * barMax / 200);
        fill_rect(70, y,     barMax + 2, 7, 1);   /* bordo */
        fill_rect(71, y + 1, barMax,     5, 0);   /* interno nero */
        if (barW > 0) fill_rect(71, y + 1, barW,  5, 1);  /* fill bianco */
        /* chop indicator: 1px tab sopra VU */
        if (sampleLoaded[r] && activeChop[r] >= 0)
            fill_rect(71 + activeChop[r], y - 1, 1, 2, 1);
        /* bars a x=86, key a x=98 */
        print(86, y, bars, 1);
        var kRaw = (typeof host_module_get_param === "function" && sampleLoaded[r])
            ? (host_module_get_param("key_" + String(r)) || "") : "";
        if (kRaw && kRaw !== "---")
            print(98, y, kRaw.replace("maj", " maj").replace("min", " min"), 1);
    }
    host_flush_display();
}

function drawRowPicker() {
    clear_screen();
    var st  = typeof host_module_get_param === "function" ? (host_module_get_param("status")||"?") : "no";
    var err = typeof host_module_get_param === "function" ? (host_module_get_param("error")||"") : "";
    print(2, 2, st, 1);
    if (err && err !== "ok") print(2, 14, err.slice(0, 21), 1);
    fill_rect(0, 11, 128, 1, 1);
    for (var r = 0; r < NUM_ROWS; r++) {
        var y = 15 + r * 12;
        print(4, y, ROW_LABELS[r] + ": " + sampleNames[r], 1);
        if (sampleLoaded[r] && typeof host_module_get_param === "function") {
            var k = host_module_get_param("key_" + String(r)) || "---";
            if (k && k !== "---") print(100, y, k, 1);
        }
    }
    fill_rect(0, 55, 128, 1, 1);
    print(2, 57, "pad: carica / rimuovi", 1);
    host_flush_display();
}

function drawFileBrowser() {
    clear_screen();

    // Header: row label + folder name
    var parts = browserDir.split("/");
    var dirName = parts[parts.length - 1] || "UserLibrary";
    print(2, 2, ("R" + ROW_LABELS[assigningRow] + " " + dirName).slice(0, 18), 1);
    // item count top-right
    var total = browserItems.length;
    if (total > ITEMS_VISIBLE) {
        var cs = (browserSelIdx + 1) + "/" + total;
        print(128 - cs.length * 6 - 2, 2, cs, 1);
    }
    fill_rect(0, 11, 128, 1, 1);

    if (total === 0) {
        print(4, 28, "(vuota)", 1);
    } else {
        var scrollOffset = browserSelIdx >= ITEMS_VISIBLE ? browserSelIdx - ITEMS_VISIBLE + 1 : 0;
        for (var i = 0; i < ITEMS_VISIBLE; i++) {
            var idx = scrollOffset + i;
            if (idx >= total) break;
            var item = browserItems[idx];
            var label = (item.isDir ? "[" : " ") + item.name;
            label = label.slice(0, 19);
            var y = 14 + i * 10;
            if (idx === browserSelIdx) {
                fill_rect(0, y - 1, 124, 10, 1);
                print(2, y, label, 0);
            } else {
                print(2, y, label, 1);
            }
        }
        // scroll indicator
        if (total > ITEMS_VISIBLE) {
            var trackH = ITEMS_VISIBLE * 10;
            var barH = Math.max(4, Math.floor((ITEMS_VISIBLE / total) * trackH));
            var maxScroll = total - ITEMS_VISIBLE;
            var barY = 13 + Math.floor((scrollOffset / maxScroll) * (trackH - barH));
            fill_rect(126, barY, 2, barH, 1);
        }
    }

    fill_rect(0, 55, 128, 1, 1);
    var sel = browserItems[browserSelIdx];
    if (sel && !sel.isDir && (previewDetectedKey || previewDetectedBpm > 0)) {
        var keyStr = previewDetectedKey
            ? previewDetectedKey.replace("maj", " maj").replace("min", " min")
            : "";
        var bpmStr = previewDetectedBpm > 0
            ? Math.round(previewDetectedBpm) + "->" + Math.round(bpm) + "bpm"
            : "";
        var infoStr = keyStr && bpmStr ? keyStr + "  " + bpmStr : keyStr || bpmStr;
        print(2, 57, infoStr.slice(0, 21), 1);
    } else {
        print(2, 57, "click=ok  back=su", 1);
    }
    host_flush_display();
}

function drawCopyMode() {
    clear_screen();
    print(2, 2, "COPY  P" + (copySourcePage+1) + " --> P" + (copyDestPage+1), 1);
    fill_rect(0, 11, 128, 1, 1);
    for (var r = 0; r < NUM_ROWS; r++) {
        var y = 15 + r * 12;
        var pg = pages[copySourcePage];
        var name = pg.paths[r]
            ? pg.paths[r].split("/").pop().replace(/\.wav$/i, "").slice(0, 12)
            : "---";
        var sel = copySelectedRows[r] ? "[x]" : "[ ]";
        print(2, y, sel + ROW_LABELS[r] + ":" + name, 1);
    }
    fill_rect(0, 55, 128, 1, 1);
    print(2, 57, "row=sel  </>=pag  copy=ok", 1);
    host_flush_display();
}

// ─── Modalita' ────────────────────────────────────────────────────────────────

function enterBrowser() {
    mode         = "browser";
    assigningRow = -1;
    refreshAllLEDs();
    drawRowPicker();
}

function exitBrowser(stopPreview) {
    mode         = "player";
    if (stopPreview) writeCmd("preview_stop");
    /* reset range su tutte le righe — la preview aveva messo 0:7 su tutti */
    for (var _r = 0; _r < NUM_ROWS; _r++) {
        rangeStart[_r] = -1;
        rangeEnd[_r]   = -1;
    }
    assigningRow = -1;
    refreshAllLEDs();
    drawPlayer();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

globalThis.init = function() {
    currentPage  = 0;
    activeChop   = [-1, -1, -1, -1];
    heldPad      = [-1, -1, -1, -1];
    rangeStart   = [-1, -1, -1, -1];
    rangeEnd     = [-1, -1, -1, -1];
    expectedChop = [-1, -1, -1, -1];
    sampleNames  = ["---", "---", "---", "---"];
    sampleLoaded = [false, false, false, false];
    savedPaths   = ["", "", "", ""];
    dspLoadedPath = ["", "", "", ""];
    loopLedSent  = false;
    loadState();
    /* stop esplicito di tutte le tracce all'avvio */
    var _sc = [];
    for (var r = 0; r < NUM_ROWS; r++) _sc.push("stop:" + r);
    writeCmdMulti(_sc);
    exitBrowser();
};

globalThis.tick = function() {
  try {
    /* Calibra intervallo tick */
    var _tNow = Date.now();
    if (recLastTick > 0) {
        var _dt = _tNow - recLastTick;
        if (_dt > 5 && _dt < 200)
            recTickMs = Math.round((recTickMs * 7 + _dt) / 8);
    }
    recLastTick = _tNow;
    /* Playback recorder (state=3) */
    if (recState === 3 && recEvents.length > 0 && recDuration > 0) {
        var _rnow = Date.now();
        {
        var _rpos = (_rnow - recPlayStart) % recDuration;
        if (_rpos < recPlayPos) {
            recPlayIdx = 0;
            /* merge overdub al seam del loop */
            if (recOverBuf.length > 0) {
                for (var _oi = 0; _oi < recOverBuf.length; _oi++)
                    recEvents.push(recOverBuf[_oi]);
                recOverBuf = [];
                recEvents.sort(function(a, b) { return a.t - b.t; });
            }
        }
        recPlayPos = _rpos;
        while (recPlayIdx < recEvents.length && recEvents[recPlayIdx].t <= _rpos) {
            var _rev = recEvents[recPlayIdx];
            if (sampleLoaded[_rev.row]) {
                if (_rev.on) {
                    ledQueue = []; ledQueueIdx = 0;
                    if (activeChop[_rev.row] >= 0) setPadLED(_rev.row, activeChop[_rev.row], false);
                    activeChop[_rev.row]   = _rev.col;
                    expectedChop[_rev.row] = _rev.col;
                    setPadLED(_rev.row, _rev.col, true);
                    setRowButtonLED(_rev.row, true);
                    queueCmd((_rev.play ? "play:" : "loop:") + String(_rev.row) + ":" + String(_rev.col));
                    recPlayRow = _rev.row;
                    recPlayRows[_rev.row] = true;
                } else {
                    stopChop(_rev.row);
                }
            }
            recPlayIdx++;
        }
        } /* end else (attesa quantize) */
    }
    /* Pruning rolling buffer: solo durante registrazione */
    if (recState === 2) {
        var _pruneCutoff = Date.now() - (recBarMs > 0 ? recBarMs * 4 + 2000 : 32000);
        while (recBuf.length > 0 && recBuf[0].t < _pruneCutoff) recBuf.shift();
    }
    /* Sync Loop button LED al primo tick (init è troppo presto per il MIDI HW) */
    if (!loopLedSent) {
        loopLedSent = true;
        move_midi_internal_send([0x0b, 0xB0, 0x3A, loopMode ? 127 : 0]);
        recLedVal = 0;
        move_midi_internal_send([0x0b, 0xB0, REC_PAD, 0]);
        move_midi_internal_send([0x0b, 0xB0, MoveLeft,  White]);
        move_midi_internal_send([0x0b, 0xB0, MoveRight, White]);
        move_midi_internal_send([0x0b, 0xB0, MoveShift, White]);
        move_midi_internal_send([0x0b, 0xB0, MoveCopy,  White]);
        padLed(MoveStep1, Cyan);
        padLed(MoveStep2, Cyan);
        for (var _ki = 0; _ki < NUM_ROWS; _ki++)
            buttonLed(MoveKnobs[_ki], ROW_COLORS_IDLE[_ki]);
        buttonLed(78, White);
    }
    /* Fade-out reverb: accoda PRIMA di flushCmds per batching unico */
    if (reverbFading) {
        var _done = true;
        for (var _r = 0; _r < NUM_ROWS; _r++) {
            if (reverbVal[_r] > 0) {
                reverbVal[_r] = Math.max(0, reverbVal[_r] - 2);
                queueCmd("reverb:" + String(_r) + ":" + String(reverbVal[_r]));
                if (reverbVal[_r] > 0) _done = false;
            }
        }
        if (_done) reverbFading = false;
    }
    flushCmds();  /* un'unica scrittura per tutti i comandi del tick */
    flushLEDs();  /* prima passata */
    /* Leggi BPM e tonalità del sample in preview */
    if (typeof host_module_get_param === "function" && mode === "browser") {
        var pbRaw = host_module_get_param("preview_bpm");
        var pbVal = pbRaw ? parseFloat(pbRaw) : 0;
        var pkRaw = host_module_get_param("preview_key") || "";
        if (pbVal !== previewDetectedBpm || pkRaw !== previewDetectedKey) {
            previewDetectedBpm = pbVal;
            previewDetectedKey = pkRaw;
            if (assigningRow !== -1) drawFileBrowser();
        }
    }
    /* Feature 3: leggi beat_phase dal DSP — calcola epoch allineato ai boundary audio */
    if (typeof host_module_get_param === "function" && quant > 0 && bpm > 0) {
        var _bp = parseFloat(host_module_get_param("beat_phase") || "0");
        if (_bp >= 0) {
            var _qms = quant * 60000 / bpm;
            dspBeatEpoch = Date.now() - ((_bp % quant) / quant) * _qms;
        }
    }
    /* Sincronizza LED chop e bars con il DSP — funziona in qualsiasi mode */
    if (typeof host_module_get_param === "function") {
        for (var r = 0; r < NUM_ROWS; r++) {
            /* bars: solo se DSP ha il sample della pagina corrente */
            if (sampleLoaded[r] && savedPaths[r] && dspLoadedPath[r] === savedPaths[r]) {
                var barsRaw = host_module_get_param("bars_" + String(r));
                if (barsRaw !== null && barsRaw !== undefined) {
                    var newBars = parseFloat(barsRaw);
                    if (Math.abs(newBars - trackBars[r]) > 0.01 && newBars >= 0.1 && newBars <= 64) {
                        trackBars[r] = newBars;
                        saveState();
                    }
                }
            }
            /* LED chop: aggiorna sempre se il DSP ha qualcosa caricato (anche da pagina precedente) */
            if (!dspLoadedPath[r]) continue;
            var c = parseInt(host_module_get_param("chop_" + String(r)) || "-2");
            if (expectedChop[r] === -2) {
                if (c === -1) expectedChop[r] = -1;
                continue;
            }
            if (expectedChop[r] >= 0) {
                if (c === expectedChop[r] || c === 0) expectedChop[r] = -1;
                else continue;
            }
            /* salta chop fuori range (solo se c è valido) */
            if (c >= 0 && rangeStart[r] >= 0 && (c < rangeStart[r] || c > rangeEnd[r])) continue;
            if (c >= 0 && c !== activeChop[r]) {
                /* chop 0 crossing — calibra barMs e triggera playback */
                if (c === 0 && activeChop[r] > 0) {
                    var _now = Date.now();
                    /* calibra durata bar */
                    if (recLastChop0 > 0) {
                        var _bms = _now - recLastChop0;
                        if (_bms > 200 && _bms < 10000)
                            recBarMs = recBarMs > 0 ? Math.round((recBarMs * 3 + _bms) / 4) : _bms;
                    }
                    recLastChop0 = _now;
                    /* state=3: re-sync drift al clock DSP ogni N bar */
                    if (recState === 3 && recBarMs > 0) {
                        var _barsPerLoop = Math.round(recDuration / recBarMs);
                        if (_barsPerLoop < 1) _barsPerLoop = 1;
                        recBarCount++;
                        if (recBarCount >= _barsPerLoop) {
                            recBarCount  = 0;
                            /* corregge il drift senza resettare playIdx/playPos:
                               sposta recPlayStart in modo che la posizione corrente
                               corrisponda esattamente al chop 0 del DSP */
                            recPlayStart = _now - recPlayPos;
                        }
                    }
                }
                var prev = activeChop[r];
                if (prev >= 0) {
                    /* in player mode: idle se in range, altrimenti nero; in browser: sempre nero */
                    var inRange = mode === "player" && rangeStart[r] >= 0 && prev >= rangeStart[r] && prev <= rangeEnd[r];
                    padLed(ROW_BASE_NOTES[r] + prev, inRange ? ROW_COLORS_IDLE[r] : Black);
                }
                activeChop[r] = c;
                padLed(ROW_BASE_NOTES[r] + c, ROW_COLORS_ACTIVE[r]);

            }
            /* DSP ha fermato il sample */
            if (c === -1 && activeChop[r] >= 0) {
                /* spegni range o singolo chop */
                var _rs = rangeStart[r] >= 0 ? rangeStart[r] : activeChop[r];
                var _re = rangeEnd[r]   >= 0 ? rangeEnd[r]   : activeChop[r];
                for (var _cc = _rs; _cc <= _re; _cc++) padLed(ROW_BASE_NOTES[r] + _cc, Black);
                activeChop[r] = -1;
                if (stopPending[r]) {
                    rangeStart[r]  = -1;
                    rangeEnd[r]    = -1;
                    setRowButtonLED(r, false);
                    stopPending[r] = false;
                }
            }
        }
    }
    flushLEDs();  /* seconda passata — dopo il sync chop */
    if (copyMode) {
        drawCopyMode();
    } else if (mode === "player") {
        if (step1Held) drawFilterPage();
        else if (step2Held) drawReverbPage();
        else drawPlayer();
    } else if (assigningRow === -1) {
        drawRowPicker();
    } else {
        drawFileBrowser();
    }
  } catch(e) {}
};

globalThis.onMidiMessageInternal = function(data) {
  try {
    var status = data[0] & 0xF0;
    var note   = data[1];
    var vel    = data[2];
    // ── MIDI Recorder pad (0x34) ──
    if (status === 0xB0 && note === REC_PAD && vel > 0) {
        if (recState === 0) {
            /* capture: arma il recorder — aspetta la prima nota */
            recState  = 1;
            recBuf    = [];
            recLedVal = 60;
            move_midi_internal_send([0x0b, 0xB0, REC_PAD, 60]);
        } else if (recState === 1) {
            /* annulla armamento */
            recState  = 0;
            recLedVal = 0;
            recBuf    = [];
            move_midi_internal_send([0x0b, 0xB0, REC_PAD, 0]);
        } else if (recState === 2) {
            /* chiude la registrazione e compila il loop */
            compileRecording();
        } else if (recState === 3) {
            /* stop playback → ferma solo le righe avviate dal recorder */
            for (var _sr = 0; _sr < NUM_ROWS; _sr++) {
                if (recPlayRows[_sr] && activeChop[_sr] >= 0) stopChop(_sr);
            }
            recPlayRow  = -1;
            recPlayRows = {};
            recBuf      = [];
            recOverBuf  = [];
            recState    = 0;
            recLedVal   = 0;
            move_midi_internal_send([0x0b, 0xB0, REC_PAD, 0]);
        }
        return;
    }
    // ── Loop button (CC 58) — toggle loop / one-shot mode ──
    if (status === 0xB0 && note === 0x3A && vel > 0) {
        loopMode = !loopMode;
        move_midi_internal_send([0x0b, 0xB0, 0x3A, loopMode ? 127 : 0]);
        saveState();
        if (mode === "player") drawPlayer();
        return;
    }

    // ── Copy button ──
    if (status === 0xB0 && note === MoveCopy && vel > 0) {
        if (!copyMode) {
            /* entra in copy mode */
            copyMode         = true;
            copySourcePage   = currentPage;
            copyDestPage     = (currentPage + 1) % NUM_PAGES;
            copySelectedRows = [false, false, false, false];
            /* accendi tasti riga spenti per indicare che sono selezionabili */
            for (var r = 0; r < NUM_ROWS; r++)
                buttonLed(MoveRowButtons[r], ROW_COLORS_IDLE[r]);
        } else {
            /* esegui copia */
            for (var r = 0; r < NUM_ROWS; r++) {
                if (!copySelectedRows[r]) continue;
                pages[copyDestPage].paths[r] = pages[copySourcePage].paths[r];
                pages[copyDestPage].bars[r]  = pages[copySourcePage].bars[r];
                pages[copyDestPage].vol[r]   = pages[copySourcePage].vol[r];
            }
            saveState();
            copyMode = false;
            buttonLed(MoveCopy, White);
            refreshAllLEDs();
            drawPlayer();
        }
        return;
    }

    // ── In copy mode: Back = annulla ──
    if (copyMode && status === 0xB0 && note === MoveBack && vel > 0) {
        copyMode = false;
        buttonLed(MoveCopy, White);
        refreshAllLEDs();
        drawPlayer();
        return;
    }

    // ── In copy mode: frecce cambiano pagina destinazione ──
    if (copyMode && status === 0xB0 && vel > 0 && (note === MoveLeft || note === MoveRight)) {
        var _dir = (note === MoveRight) ? 1 : -1;
        copyDestPage = (copyDestPage + _dir + NUM_PAGES) % NUM_PAGES;
        if (copyDestPage === copySourcePage)
            copyDestPage = (copyDestPage + _dir + NUM_PAGES) % NUM_PAGES;
        drawCopyMode();
        return;
    }

    // ── In copy mode: tasti riga = toggle selezione ──
    if (copyMode && status === 0xB0 && vel > 0) {
        for (var r = 0; r < NUM_ROWS; r++) {
            if (note === MoveRowButtons[r]) {
                copySelectedRows[r] = !copySelectedRows[r];
                buttonLed(MoveRowButtons[r], copySelectedRows[r] ? ROW_COLORS_ACTIVE[r] : ROW_COLORS_IDLE[r]);
                drawCopyMode();
                return;
            }
        }
    }

    // ── Frecce sinistra/destra — cambia pagina ──
    if (status === 0xB0 && note === MoveLeft && vel > 0) {
        switchPage(-1);
        return;
    }
    if (status === 0xB0 && note === MoveRight && vel > 0) {
        switchPage(1);
        return;
    }

    // ── Shift ──
    if (status === 0xB0 && note === MoveShift) {
        if (vel > 0) {
            shiftHeld = true;
            shiftUsed = false;
            move_midi_internal_send([0x0b, 0xB0, MoveShift, BurntOrange]);
        } else {
            shiftHeld = false;
            move_midi_internal_send([0x0b, 0xB0, MoveShift, White]);
            if (!shiftUsed) {
                if (mode === "player") enterBrowser();
                else exitBrowser(true);
            }
        }
        return;
    }

    // ── Back ──
    if (status === 0xB0 && note === MoveBack && vel > 0) {
        if (mode === "browser") {
            if (assigningRow === -1) {
                host_exit_module();
            } else if (browserDir === BROWSER_ROOT) {
                // torna a scegli riga
                assigningRow = -1;
                writeCmd("preview_stop");
                refreshAllLEDs();
                drawRowPicker();
            } else {
                // sali di una cartella — ricorda nome cartella corrente per riposizionare cursore
                var parts = browserDir.split("/");
                var prevDirName = parts[parts.length - 1];
                parts.pop();
                enterDir(parts.join("/"));
                for (var _bi = 0; _bi < browserItems.length; _bi++) {
                    if (browserItems[_bi].name === prevDirName) {
                        browserSelIdx = _bi;
                        break;
                    }
                }
                drawFileBrowser();
            }
        } else {
            host_exit_module();
        }
        return;
    }

    // ── Jog wheel — BPM se shift, scorrimento browser, altrimenti ignora ──
    if (status === 0xB0 && note === MoveMainKnob && vel > 0) {
        if (shiftHeld && mode === "player") {
            var delta = decodeDelta(vel);
            bpm = Math.max(40, Math.min(200, bpm + delta));
            shiftUsed = true;
            writeCmd("bpm:" + bpm.toFixed(1));
            saveState();
            return;
        }
        if (mode === "browser" && assigningRow !== -1) {
            var delta = decodeDelta(vel);
            browserSelIdx = Math.max(0, Math.min(browserItems.length - 1, browserSelIdx + delta));
            drawFileBrowser();
            var sel = browserItems[browserSelIdx];
            /* rimuovi preview commands precedenti — evita load multipli su scroll rapido */
            cmdQueue = cmdQueue.filter(function(c) { return c.indexOf("preview") !== 0; });
            if (sel && !sel.isDir) {
                cmdQueue.push("preview_bars:" + String(trackBars[assigningRow]));
                cmdQueue.push("preview:" + sel.path);
            } else {
                cmdQueue.push("preview_stop");
            }
        }
        return;
    }

    // ── Master knob — volume ──
    if (status === 0xB0 && note === MoveMaster) {
        var delta = decodeDelta(vel);
        masterVol = Math.max(0, Math.min(200, masterVol + delta * 3));
        writeCmd("vol:" + String(masterVol));
        saveState();
        return;
    }

    // ── Jog click — player: cicla quant; browser: apri cartella o carica file ──
    if (status === 0xB0 && note === MoveMainButton && vel > 0) {
        if (mode === "player") {
            var qi = QUANT_OPTIONS.indexOf(quant);
            quant = QUANT_OPTIONS[(qi + 1) % QUANT_OPTIONS.length];
            writeCmd("quant:" + quant.toFixed(2));
            saveState();
            return;
        }
        if (mode === "browser" && assigningRow !== -1 && browserItems.length > 0) {
            var item = browserItems[browserSelIdx];
            if (item.isDir) {
                enterDir(item.path);
                drawFileBrowser();
            } else {
                loadSample(assigningRow, item.path);
                exitBrowser(false); /* preview_stop già incluso in loadSample */
            }
        }
        return;
    }

    // ── Tasti riga: shift+tasto = cycle bars; tasto = stop traccia ──
    if (status === 0xB0 && vel > 0) {
        for (var r = 0; r < NUM_ROWS; r++) {
            if (note === MoveRowButtons[r]) {
                if (shiftHeld && mode === "player") {
                    var idx = -1;
                    for (var _bi = 0; _bi < BARS_CYCLE.length; _bi++)
                        if (Math.abs(BARS_CYCLE[_bi] - trackBars[r]) < 0.01) { idx = _bi; break; }
                    trackBars[r] = BARS_CYCLE[(idx + 1) % BARS_CYCLE.length];
                    shiftUsed = true;
                    writeCmd("bars:" + String(r) + ":" + String(trackBars[r]));
                    saveState();
                } else if (mode === "player" || mode === "browser") {
                    if (!loopMode) {
                        /* single mode: forza stop anche se activeChop è già -1 */
                        ledQueue = []; ledQueueIdx = 0;
                        if (activeChop[r] >= 0) padLed(ROW_BASE_NOTES[r] + activeChop[r], Black);
                        activeChop[r]   = -1;
                        expectedChop[r] = -2;
                        heldPad[r]      = -1;
                        rangeStart[r]   = -1;
                        rangeEnd[r]     = -1;
                        setRowButtonLED(r, false);
                        queueCmd("stop:" + String(r));
                        /* cancella tutti gli eventi registrati per questa row */
                        recEvents  = recEvents.filter(function(e)  { return e.row !== r; });
                        recBuf     = recBuf.filter(function(e)     { return e.row !== r; });
                        recOverBuf = recOverBuf.filter(function(e) { return e.row !== r; });
                        if (recState === 3) delete recPlayRows[r];
                    } else {
                        /* Feature 2: stop quantizzato in loop mode (come MLR eSTOP) */
                        if (quant > 0) deferStop(r); else stopChop(r);
                    }
                }
                return;
            }
        }
    }

    // ── Knob 1-4: filter / reverb / volume ──
    if (status === 0xB0 && note >= 71 && note <= 74) {
        var r = note - 71;
        var delta = decodeDelta(vel);
        if (step1Held) {
            filterVal[r] = Math.max(0, Math.min(200, filterVal[r] + delta));
            queueCmd("filter:" + String(r) + ":" + String(filterVal[r]));
        } else if (step2Held) {
            reverbVal[r] = Math.max(0, Math.min(200, reverbVal[r] + delta));
            queueCmd("reverb:" + String(r) + ":" + String(reverbVal[r]));
        } else {
            trackVol[r] = Math.max(0, Math.min(200, trackVol[r] + delta * 3));
            queueCmd("tvol:" + String(r) + ":" + String(trackVol[r]));
        }
        return;
    }

    // ── Knob 8: master effect (tutte le tracce, anche combinati) ──
    if (status === 0xB0 && note === 78) {
        var delta = decodeDelta(vel);
        if (step1Held) {
            for (var r = 0; r < NUM_ROWS; r++) {
                filterVal[r] = Math.max(0, Math.min(200, filterVal[r] + delta));
                queueCmd("filter:" + String(r) + ":" + String(filterVal[r]));
            }
        }
        if (step2Held) {
            reverbFading = false;
            for (var r = 0; r < NUM_ROWS; r++) {
                reverbVal[r] = Math.max(0, Math.min(200, reverbVal[r] + delta));
                queueCmd("reverb:" + String(r) + ":" + String(reverbVal[r]));
            }
        }
        return;
    }

    // ── Step 1: hold = filter mode ──
    if (note === MoveStep1 && (status === 0x90 || status === 0x80)) {
        if (status === 0x90 && vel > 0) {
            step1Held = true;
            padLed(MoveStep1, BrightRed);
            for (var r = 0; r < NUM_ROWS; r++) buttonLed(MoveKnobs[r], Cyan);
        } else {
            step1Held = false;
            padLed(MoveStep1, Cyan);
            for (var r = 0; r < NUM_ROWS; r++) buttonLed(MoveKnobs[r], ROW_COLORS_IDLE[r]);
            var _fc = [];
            for (var r = 0; r < NUM_ROWS; r++) {
                filterVal[r] = 100;
                _fc.push("filter:" + String(r) + ":100");
            }
            /* Svuota la coda esistente e invia i reset subito */
            cmdQueue = [];
            writeCmdMulti(_fc);
        }
        return;
    }

    // ── Step 2: hold = reverb mode ──
    if (note === MoveStep2 && (status === 0x90 || status === 0x80)) {
        if (status === 0x90 && vel > 0) {
            step2Held = true;
            padLed(MoveStep2, BrightRed);
            for (var r = 0; r < NUM_ROWS; r++) buttonLed(MoveKnobs[r], BrightRed);
        } else {
            step2Held = false;
            padLed(MoveStep2, Cyan);
            for (var r = 0; r < NUM_ROWS; r++) buttonLed(MoveKnobs[r], ROW_COLORS_IDLE[r]);
            reverbFading = true;
        }
        return;
    }

    // ── Pad note-on / note-off ──
    var isNoteOn  = (status === 0x90 && vel > 0);
    var isNoteOff = (status === 0x80 || (status === 0x90 && vel === 0));
    if (isNoteOn || isNoteOff) {
        var rc = null;
        for (var r = 0; r < NUM_ROWS; r++) {
            if (note >= ROW_BASE_NOTES[r] && note < ROW_BASE_NOTES[r] + NUM_CHOPS) {
                rc = { row: r, col: note - ROW_BASE_NOTES[r] };
                break;
            }
        }
        if (!rc) return;
        var row = rc.row, col = rc.col;

        if (isNoteOff) {
            if (heldPad[row] === col) {
                heldPad[row] = -1;
                if (mode === "player" && !madeRange[row] && !loopMode) {
                    stopChop(row); /* gate: stop al rilascio (single mode only) */
                }
                /* loop mode (MLR): release non fa niente — il sample continua */
                /* registra note-off nel rolling buffer */
                if (!loopMode && (recState === 1 || recState === 2))
                    recBuf.push({ row: row, col: col, t: Date.now(), on: false });
                /* in loop mode: niente note-off (MLR: solo salti di posizione, niente gate) */
                /* overdub durante playback (solo single mode: registra il gate off) */
                else if (recState === 3 && !loopMode)
                    recOverBuf.push({ row: row, col: col, t: (Date.now() - recPlayStart) % recDuration, on: false });
                madeRange[row] = false;
            }
            return;
        }

        /* note-on: browser fase 1 — col 0: toggle rimozione se caricato, altrimenti apre browser */
        if (mode === "browser" && assigningRow === -1 && col === 0) {
            if (sampleLoaded[row]) {
                /* rimuove il sample e riapre subito il browser alla sua posizione */
                var _removedPath = savedPaths[row];
                queueCmd("stop:" + String(row));
                sampleLoaded[row] = false;
                sampleNames[row]  = "---";
                savedPaths[row]   = "";
                activeChop[row]   = -1;
                expectedChop[row] = -1;
                rangeStart[row]   = -1;
                rangeEnd[row]     = -1;
                heldPad[row]      = -1;
                setRowButtonLED(row, false);
                saveState();
                assigningRow = row;
                var _pcmds2 = [];
                for (var _pr2 = 0; _pr2 < NUM_ROWS; _pr2++) {
                    if (_pr2 === row || !sampleLoaded[_pr2]) continue;
                    _pcmds2.push("range:" + _pr2 + ":0:" + (NUM_CHOPS - 1) + ":0");
                    rangeStart[_pr2]   = 0;
                    rangeEnd[_pr2]     = NUM_CHOPS - 1;
                    expectedChop[_pr2] = -1;
                }
                if (_pcmds2.length > 0) writeCmdMulti(_pcmds2);
                if (_removedPath) {
                    var _dir2 = _removedPath.substring(0, _removedPath.lastIndexOf("/"));
                    enterDir(_dir2);
                    for (var _fi = 0; _fi < browserItems.length; _fi++) {
                        if (browserItems[_fi].path === _removedPath) {
                            browserSelIdx = _fi; break;
                        }
                    }
                } else {
                    enterDir(BROWSER_ROOT);
                }
                scheduleLEDs();
                drawFileBrowser();
                return;
            }
            assigningRow = row;
            /* Ferma la riga assegnata; metti tutte le altre in loop completo da chop 0 */
            var _pcmds = [];
            if (sampleLoaded[row]) {
                _pcmds.push("stop:" + row);
                activeChop[row] = -1;
                rangeStart[row] = -1;
                rangeEnd[row]   = -1;
            }
            for (var _pr = 0; _pr < NUM_ROWS; _pr++) {
                if (_pr === row || !sampleLoaded[_pr]) continue;
                _pcmds.push("range:" + _pr + ":0:" + (NUM_CHOPS - 1) + ":0");
                rangeStart[_pr]   = 0;
                rangeEnd[_pr]     = NUM_CHOPS - 1;
                expectedChop[_pr] = -1;  /* sblocca il sync tick */
            }
            if (_pcmds.length > 0) writeCmdMulti(_pcmds);
            var _last = savedPaths[row];
            if (_last) {
                var _dir = _last.substring(0, _last.lastIndexOf("/"));
                enterDir(_dir);
                for (var _i = 0; _i < browserItems.length; _i++) {
                    if (browserItems[_i].path === _last) {
                        browserSelIdx = _i;
                        break;
                    }
                }
            } else {
                enterDir(BROWSER_ROOT);
            }
            /* Aggiorna tutti i LED come in MLR mode (range idle + active chop) */
            scheduleLEDs();
            drawFileBrowser();
            return;
        }

        if (mode !== "player") return;

        /* se il sample della nuova pagina non è ancora caricato nel DSP, caricalo ora */
        if (savedPaths[row] && savedPaths[row] !== dspLoadedPath[row]) {
            cmdQueue.push("load:" + row + ":" + savedPaths[row]);
            if (trackBars[row] > 0) cmdQueue.push("bars:" + row + ":" + trackBars[row]);
            dspLoadedPath[row] = savedPaths[row];
            sampleNames[row]   = savedPaths[row].split("/").pop().replace(/\.wav$/i, "").slice(0, 10);
            sampleLoaded[row]  = true;
        }
        if (!sampleLoaded[row]) return;  /* nessun sample su questa pagina per questa row */

        /* MLR */
        /* col 0 in loop mode con recorder attivo: risincronizza playback */
        if (loopMode && col === 0 && recState === 3) {
            recPlayStart = Date.now() - (recTickMs >> 1);
            recPlayPos   = 0;
            recPlayIdx   = 0;
        }
        if (shiftHeld) {
            stopChop(row);
        } else if (loopMode && heldPad[row] >= 0 && heldPad[row] !== col) {
            makeRange(row, heldPad[row], col);
        } else {
            /* loop mode (MLR): salta alla posizione, il sample continua — single: gate one-shot */
            /* Feature 1: resetta sub-loop/range come eCUT in MLR */
            madeRange[row] = false;
            ledQueue = []; ledQueueIdx = 0;
            /* spegni range/chop precedente prima di resettare lo stato */
            if (rangeStart[row] >= 0) {
                for (var c = rangeStart[row]; c <= rangeEnd[row]; c++)
                    padLed(ROW_BASE_NOTES[row] + c, Black);
            } else if (activeChop[row] >= 0) {
                setPadLED(row, activeChop[row], false);
            }
            rangeStart[row] = -1;
            rangeEnd[row]   = -1;
            activeChop[row]   = col;
            expectedChop[row] = col;
            setPadLED(row, col, true);
            setRowButtonLED(row, true);
            queueCmd((loopMode ? "play:" : "oneshot:") + String(row) + ":" + String(col));
            heldPad[row] = col;
            /* registra note-on: stato 1=armed → 2=recording alla prima nota (loop e gate) */
            if (recState === 1 || recState === 2) {
                if (recState === 1) {
                    recState    = 2;
                    recRecStart = Date.now();
                    recLedVal   = 90;
                    move_midi_internal_send([0x0b, 0xB0, REC_PAD, 90]);
                }
                /* MLR: in loop mode registra al boundary del quantize, non al press */
                var _nt = loopMode ? quantSnapMs(Date.now(), recRecStart) : Date.now();
                recBuf.push({ row: row, col: col, t: _nt, on: true, play: loopMode });
            } else if (recState === 3) {
                /* overdub: aggiunge la nota al loop corrente */
                /* MLR: in loop mode snap al boundary del quantize */
                var _ot = loopMode
                    ? (quantSnapMs(Date.now(), recPlayStart) - recPlayStart) % recDuration
                    : (Date.now() - recPlayStart) % recDuration;
                recOverBuf.push({ row: row, col: col, t: _ot, on: true, play: loopMode });
            }
        }
        return;
    }
  } catch(e) {}
};
