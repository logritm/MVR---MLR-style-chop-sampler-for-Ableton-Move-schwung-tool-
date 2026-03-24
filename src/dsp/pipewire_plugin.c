/*
 * pipewire_plugin.c — MVR 4-track MLR-style sampler for Ableton Move
 *
 * 4 tracce indipendenti suonano WAV in loop.
 * Premere un pad salta la testina a (col/8) * lunghezza (stile MLR).
 * Tutte e 4 le tracce mixano in uscita simultaneamente.
 *
 * Parametri da ui.js via host_module_set_param:
 *
 *   load_row     = "0"–"3"
 *   load_path    = "/path/to/file.wav"
 *   load_trigger = "1"   → carica il file nella riga
 *
 *   play_row     = "0"–"3"
 *   play_col     = "0"–"7"
 *   trigger      = "1"   → salta alla posizione chop e suona in loop
 *
 *   stop_row     = "0"–"3"
 *   trigger_stop = "1"   → ferma quella traccia
 */

#define _GNU_SOURCE
#include "plugin_api_v1.h"
#include "stretch_wrapper.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>

#define LOG_PATH "/tmp/mvr-dsp.log"
static FILE *g_log = NULL;
#define LOG(...) do { \
    if (!g_log) g_log = fopen(LOG_PATH, "a"); \
    if (g_log) { fprintf(g_log, "[mvr] " __VA_ARGS__); fflush(g_log); } \
} while(0)

/* ── Costanti ──────────────────────────────────────────────────────────────── */

#define NUM_TRACKS    4
#define NUM_CHOPS     8
#define FADE_FRAMES   0     /* anti-click disabilitato */
#define MAX_SECONDS   120   /* lunghezza massima sample (secondi) */
#define MAX_FRAMES    ((size_t)(MOVE_AUDIO_SAMPLE_RATE) * MAX_SECONDS)

/* ── WSOLA time-stretching ─────────────────────────────────────────────────── */
#define WSOLA_FRAME    2048   /* frame size (samples) — finestre grandi = pitch pulito */
#define WSOLA_HOP      1024   /* synthesis hop (50% overlap, COLA=1.0 con Hann) */
#define WSOLA_SEARCH    128   /* similarity search radius (samples) */
#define WSOLA_CORR_SIZE 256   /* samples used for cross-correlation */

/* ── Runtime sample rate (set from host->sample_rate at init) ──────────────── */
static uint32_t g_sample_rate = MOVE_AUDIO_SAMPLE_RATE;

/* ── WAV parser minimale ───────────────────────────────────────────────────── */

static uint16_t read_u16le(const uint8_t *p) {
    return (uint16_t)(p[0] | ((unsigned)p[1] << 8));
}

static uint32_t read_u32le(const uint8_t *p) {
    return (uint32_t)(p[0] | ((uint32_t)p[1]<<8) |
                              ((uint32_t)p[2]<<16) |
                              ((uint32_t)p[3]<<24));
}

/*
 * Carica un file WAV 16-bit PCM (mono o stereo, qualsiasi sample rate).
 * Ritorna un buffer stereo 16-bit interleaved a MOVE_AUDIO_SAMPLE_RATE.
 * Ritorna NULL in caso di errore. *out_frames = numero di frame stereo.
 */
static int16_t *load_wav(const char *path, size_t *out_frames) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;

    fseek(f, 0, SEEK_END);
    long fsize = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (fsize < 44) { fclose(f); return NULL; }

    uint8_t *raw = (uint8_t *)malloc((size_t)fsize);
    if (!raw) { fclose(f); return NULL; }

    if ((long)fread(raw, 1, (size_t)fsize, f) != fsize) {
        free(raw); fclose(f); return NULL;
    }
    fclose(f);

    /* Verifica header RIFF/WAVE */
    if (memcmp(raw, "RIFF", 4) != 0 || memcmp(raw + 8, "WAVE", 4) != 0) {
        free(raw); return NULL;
    }

    /* Cerca chunk fmt e data */
    uint16_t channels = 0, bits = 0;
    uint32_t src_rate  = 0;
    uint8_t *pcm_ptr   = NULL;
    size_t   pcm_bytes = 0;

    size_t pos = 12;
    while (pos + 8 <= (size_t)fsize) {
        uint32_t chunk_size = read_u32le(raw + pos + 4);

        if (memcmp(raw + pos, "fmt ", 4) == 0 && chunk_size >= 16) {
            uint16_t audio_fmt = read_u16le(raw + pos + 8);
            if (audio_fmt != 1) { free(raw); return NULL; } /* solo PCM */
            channels = read_u16le(raw + pos + 10);
            src_rate = read_u32le(raw + pos + 12);
            bits     = read_u16le(raw + pos + 22);
        } else if (memcmp(raw + pos, "data", 4) == 0) {
            pcm_ptr   = raw + pos + 8;
            pcm_bytes = chunk_size;
            if (pos + 8 + chunk_size > (size_t)fsize)
                pcm_bytes = (size_t)fsize - pos - 8;
        }

        pos += 8 + chunk_size;
        if (chunk_size & 1) pos++; /* padding a byte pari */
    }

    if (!pcm_ptr || channels == 0 || channels > 2 || (bits != 16 && bits != 24) || src_rate == 0) {
        free(raw); return NULL;
    }

    size_t src_frames = pcm_bytes / (channels * (bits / 8));
    if (src_frames == 0) { free(raw); return NULL; }

    /* Normalizza a int16 se 24-bit */
    int16_t *src_16 = NULL;
    if (bits == 24) {
        src_16 = (int16_t *)malloc(src_frames * channels * sizeof(int16_t));
        if (!src_16) { free(raw); return NULL; }
        for (size_t i = 0; i < src_frames * channels; i++) {
            uint8_t *p = pcm_ptr + i * 3;
            int32_t s = (int32_t)(p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16));
            if (s & 0x800000) s |= (int32_t)0xFF000000;
            src_16[i] = (int16_t)(s >> 8);
        }
    } else {
        src_16 = (int16_t *)pcm_ptr;
    }
    int16_t *src = src_16;

    /* Calcola numero di frame di destinazione (con eventuale resampling) */
    size_t dst_frames;
    if (src_rate == g_sample_rate) {
        dst_frames = src_frames;
    } else {
        double ratio = (double)src_rate / (double)g_sample_rate;
        dst_frames = (size_t)((double)src_frames / ratio);
    }
    if (dst_frames > MAX_FRAMES) dst_frames = MAX_FRAMES;
    if (dst_frames == 0) { free(raw); return NULL; }

    int16_t *dst = (int16_t *)malloc(dst_frames * 2 * sizeof(int16_t));
    if (!dst) { free(raw); return NULL; }

    if (src_rate == g_sample_rate) {
        /* Nessun resampling: copia e converti in stereo */
        for (size_t i = 0; i < dst_frames; i++) {
            if (channels == 1) {
                dst[i*2+0] = dst[i*2+1] = src[i];
            } else {
                dst[i*2+0] = src[i * channels + 0];
                dst[i*2+1] = src[i * channels + 1];
            }
        }
    } else {
        /* Resampling lineare */
        double ratio = (double)src_rate / (double)g_sample_rate;
        for (size_t i = 0; i < dst_frames; i++) {
            double sp   = (double)i * ratio;
            size_t si   = (size_t)sp;
            double frac = sp - (double)si;
            size_t si1  = (si + 1 < src_frames) ? si + 1 : si;

            int16_t l0, r0, l1, r1;
            if (channels == 1) {
                l0 = r0 = src[si];
                l1 = r1 = src[si1];
            } else {
                l0 = src[si  * channels + 0];  r0 = src[si  * channels + 1];
                l1 = src[si1 * channels + 0];  r1 = src[si1 * channels + 1];
            }
            dst[i*2+0] = (int16_t)((double)l0 + ((double)(l1-l0)) * frac);
            dst[i*2+1] = (int16_t)((double)r0 + ((double)(r1-r0)) * frac);
        }
    }

    if (bits == 24) free(src_16);
    free(raw);
    *out_frames = dst_frames;
    return dst;
}

/* ── Stato per traccia ─────────────────────────────────────────────────────── */

typedef struct {
    /* Audio buffer */
    int16_t *buf;
    size_t   num_frames;
    int      playing;
    float    bars;        /* bars per loop: 0.25, 1, 2, 4, 8, 16 */
    float    stretch;     /* analysis_hop / synthesis_hop */
    size_t   loop_start;       /* loop start del chop corrente */
    size_t   loop_end;         /* loop end   del chop corrente */
    size_t   outer_loop_start; /* inizio range utente (0 = nessun range) */
    size_t   outer_loop_end;   /* fine range utente   (0 = nessun range) */
    int      reverse;          /* 1 = playback inverso */
    int      oneshot;          /* 1 = suona il chop una volta sola e stop */

    /* WSOLA state */
    float    ana_pos;                      /* fractional read position */
    float    ola_L[WSOLA_FRAME];           /* OLA accumulator, left */
    float    ola_R[WSOLA_FRAME];           /* OLA accumulator, right */
    float    prev_out_L[WSOLA_CORR_SIZE];  /* previous output for similarity search */
    int      out_pos;                      /* output position in [0, WSOLA_HOP) */
    int      prev_valid;                   /* is prev_out_L valid? */
    int      fade_in;
    int      fade_out;    /* >0: fading out prima di un'azione differita */
    int      jump_fading; /* fade avviato per un jump, non riavviare */
    int      stop_waiting;/* stop differito fino a fade_out completato */

    /* Pending (atomic flags) */
    int16_t      *next_buf;
    size_t        next_frames;
    volatile int  load_ready;
    size_t        jump_pos;
    volatile int  jump_ready;
    volatile int  stop_ready;
    /* Quantized jump — in attesa del prossimo boundary */
    size_t        queued_jump_pos;
    int           jump_queued;
    /* Quantized stop — in attesa del prossimo boundary */
    volatile int  stop_queued;
} track_t;

/* ── Stato globale condiviso tra tutte le istanze ─────────────────────────── */
/* Il framework crea 2 istanze: una "audio" (riceve render_block) e una
 * "params" (riceve set_param da JS). Con stato globale entrambe condividono
 * tracks, error_msg — set_param su qualsiasi istanza aggiorna l'audio. */

static track_t   g_tracks[NUM_TRACKS];
static char      g_error_msg[256];
static float     g_master_vol  = 1.0f;
static float     g_track_vol[NUM_TRACKS] = {1.0f, 1.0f, 1.0f, 1.0f};

/* ── DJ filter per traccia ─────────────────────────────────────────────────── */
/* mode: 0=bypass, 1=LP, 2=HP — alpha precomputata al cambio val             */
static int   g_filt_mode[NUM_TRACKS]  = {0,0,0,0};
static float g_filt_alpha[NUM_TRACKS] = {0};
static float g_filt_z1L[NUM_TRACKS]  = {0};
static float g_filt_z1R[NUM_TRACKS]  = {0};

static void apply_filter(int trk, float *l, float *r) {
    int mode = g_filt_mode[trk];
    if (mode == 0) return;
    float a = g_filt_alpha[trk];
    g_filt_z1L[trk] = a * g_filt_z1L[trk] + (1.0f - a) * (*l);
    g_filt_z1R[trk] = a * g_filt_z1R[trk] + (1.0f - a) * (*r);
    if (mode == 1) { *l = g_filt_z1L[trk]; *r = g_filt_z1R[trk]; }
    else           { *l -= g_filt_z1L[trk]; *r -= g_filt_z1R[trk]; }
}

/* ── Reverb Schroeder per traccia (4 comb + 2 allpass, mono) ──────────────── */
/* Ritardi calibrati per 48kHz (originali Freeverb × 48000/44100)             */
#define RVC1 1214
#define RVC2 1293
#define RVC3 1389
#define RVC4 1475
#define RVAP1 605
#define RVAP2 480
#define RV_FB   0.84f   /* feedback comb */
#define RV_DAMP 0.20f   /* smorzamento LP nel comb */
#define RV_APFB 0.50f   /* feedback allpass */

typedef struct {
    float c1[RVC1], c2[RVC2], c3[RVC3], c4[RVC4];
    float ap1[RVAP1], ap2[RVAP2];
    int   pc1, pc2, pc3, pc4, pap1, pap2;
    float d1, d2, d3, d4;  /* stato LP interno ai comb */
} reverb_t;

static reverb_t g_reverb[NUM_TRACKS];  /* zero-initialized */
static float    g_reverb_wet[NUM_TRACKS];

static float reverb_process(reverb_t *rv, float in) {
    float out = 0.0f;

    /* 4 comb filters in parallelo */
#define COMB(buf, sz, pos, damp) do { \
    float bo = (buf)[(pos)]; \
    (damp) = bo + RV_DAMP * ((damp) - bo); \
    (buf)[(pos)] = in + RV_FB * (damp); \
    if (++(pos) >= (sz)) (pos) = 0; \
    out += bo; \
} while(0)
    COMB(rv->c1, RVC1, rv->pc1, rv->d1);
    COMB(rv->c2, RVC2, rv->pc2, rv->d2);
    COMB(rv->c3, RVC3, rv->pc3, rv->d3);
    COMB(rv->c4, RVC4, rv->pc4, rv->d4);
#undef COMB
    out *= 0.25f;

    /* 2 allpass in serie (Freeverb style) */
#define ALLPASS(buf, sz, pos) do { \
    float bo = (buf)[(pos)]; \
    (buf)[(pos)] = out + RV_APFB * bo; \
    if (++(pos) >= (sz)) (pos) = 0; \
    out = bo - RV_APFB * out; \
} while(0)
    ALLPASS(rv->ap1, RVAP1, rv->pap1);
    ALLPASS(rv->ap2, RVAP2, rv->pap2);
#undef ALLPASS

    return out;
}

static float     g_bpm         = 120.0f;
static float     g_quant_beats = 0.0f;  /* 0=free, >0=beats per quant step */
static float     g_beat_phase  = 0.0f;  /* global beat clock */
static int       g_preview_chop0 = 0;  /* segnale: un track ha attraversato chop 0 */
static int       g_cur_chop[NUM_TRACKS];
static volatile int g_state_init = 0;
static char      g_detected_key[NUM_TRACKS][8]; /* es. "Cmaj", "Amin", "---" */

/* ── Preview (buffer separato, non tocca le 4 tracce) ─────────────────────── */
#define PREVIEW_MAX_FRAMES ((size_t)(MOVE_AUDIO_SAMPLE_RATE) * 20)  /* max 20s — serve per 4 barre a BPM lenti */

typedef struct {
    int16_t *buf;
    size_t   num_frames;
    int      playing;
    int      waiting;       /* 1 = caricato, aspetta il prossimo beat boundary */
    float    bars;
    float    stretch;       /* ratio calcolato da recalc */
    float    detected_bpm;  /* BPM originale rilevato dal sample */
} preview_t;

static preview_t  g_preview;
static StretchCtx *g_preview_stretch = NULL;  /* phase vocoder per preview */
static char        g_preview_key[8];           /* tonalità rilevata dal preview */

static void preview_recalc_stretch(void) {
    if (g_preview.bars <= 0 || g_bpm <= 0.0f || g_preview.num_frames == 0) {
        g_preview.stretch      = 1.0f;
        g_preview.detected_bpm = 0.0f;
        return;
    }
    /* BPM originale del sample: bars * 4 beat * 60s / durata_in_secondi */
    g_preview.detected_bpm = (float)g_preview.bars * 4.0f * 60.0f
                             * (float)g_sample_rate / (float)g_preview.num_frames;
    float target = (float)g_preview.bars * 4.0f * ((float)g_sample_rate * 60.0f / g_bpm);
    float s = (float)g_preview.num_frames / target;
    if (s < 0.125f) s = 0.125f;
    if (s > 8.0f)   s = 8.0f;
    g_preview.stretch = s;
}

static void ensure_global_state(void) {
    if (!g_state_init) {
        memset(g_tracks, 0, sizeof(g_tracks));
        memset(g_error_msg, 0, sizeof(g_error_msg));
        for (int i = 0; i < NUM_TRACKS; i++) {
            g_tracks[i].bars    = 1;
            g_tracks[i].stretch = 1.0f;
            g_tracks[i].out_pos = WSOLA_HOP;
        }
        g_preview.stretch = 1.0f;
        g_state_init = 1;
    }
}

/* ── WSOLA engine ──────────────────────────────────────────────────────────── */

static float g_wsola_win[WSOLA_FRAME];

static void wsola_init_window(void) {
    for (int i = 0; i < WSOLA_FRAME; i++)
        g_wsola_win[i] = 0.5f * (1.0f - cosf(2.0f * 3.14159265f * i / WSOLA_FRAME));
}

static float wsola_src_L(const track_t *tr, int pos) {
    if (!tr->buf || (int)tr->num_frames <= 0) return 0.0f;
    int n = (int)tr->num_frames;
    pos = ((pos % n) + n) % n;
    return (float)tr->buf[pos * 2 + 0];
}

static float wsola_src_R(const track_t *tr, int pos) {
    if (!tr->buf || (int)tr->num_frames <= 0) return 0.0f;
    int n = (int)tr->num_frames;
    pos = ((pos % n) + n) % n;
    return (float)tr->buf[pos * 2 + 1];
}

static int wsola_best_offset(const track_t *tr, int nom) {
    int   best_off   = 0;
    float best_score = -1e30f;
    for (int d = -WSOLA_SEARCH; d <= WSOLA_SEARCH; d++) {
        float score = 0.0f;
        for (int i = 0; i < WSOLA_CORR_SIZE; i++)
            score += tr->prev_out_L[i] * wsola_src_L(tr, nom + d + i);
        if (score > best_score) { best_score = score; best_off = d; }
    }
    return best_off;
}

static void wsola_step(track_t *tr) {
    /* 1. Shift OLA buffer left by WSOLA_HOP */
    for (int i = 0; i < WSOLA_FRAME - WSOLA_HOP; i++) {
        tr->ola_L[i] = tr->ola_L[i + WSOLA_HOP];
        tr->ola_R[i] = tr->ola_R[i + WSOLA_HOP];
    }
    for (int i = WSOLA_FRAME - WSOLA_HOP; i < WSOLA_FRAME; i++) {
        tr->ola_L[i] = 0.0f;
        tr->ola_R[i] = 0.0f;
    }

    /* 2. Find best analysis position using cross-correlation */
    int nom = (int)tr->ana_pos;
    int off = tr->prev_valid ? wsola_best_offset(tr, nom) : 0;
    int src = nom + off;

    /* 3. Window and overlap-add (forward o reverse) */
    for (int i = 0; i < WSOLA_FRAME; i++) {
        float w = g_wsola_win[i];
        int si = tr->reverse ? (src - i) : (src + i);
        tr->ola_L[i] += w * wsola_src_L(tr, si);
        tr->ola_R[i] += w * wsola_src_R(tr, si);
    }

    /* 4. Save output head for next similarity search */
    for (int i = 0; i < WSOLA_CORR_SIZE; i++)
        tr->prev_out_L[i] = tr->ola_L[i];
    tr->prev_valid = 1;

    /* 5. Advance analysis position — forward o reverse */
    if (tr->reverse) {
        tr->ana_pos -= tr->stretch * WSOLA_HOP;
        if (tr->loop_end > tr->loop_start && tr->num_frames > 0) {
            if (tr->ana_pos < (float)tr->loop_start) {
                size_t chunk  = tr->num_frames / NUM_CHOPS;
                size_t ostart = tr->outer_loop_start;
                size_t oend   = (tr->outer_loop_end > 0) ? tr->outer_loop_end : tr->num_frames;
                size_t new_end, new_start;
                if (tr->loop_start <= ostart) {
                    /* Wrap: torna all'ultimo chunk del range */
                    new_start = (oend > chunk) ? oend - chunk : 0;
                    if (new_start < ostart) new_start = ostart;
                    new_end   = new_start + chunk;
                    if (new_end > oend) new_end = oend;
                    g_preview_chop0 = 1; /* reverse wrap → sync preview */
                } else {
                    new_end   = tr->loop_start;
                    new_start = (new_end > chunk) ? new_end - chunk : 0;
                    if (new_start < ostart) new_start = ostart;
                }
                float _rev_overshoot = (float)tr->loop_start - tr->ana_pos;
                tr->loop_start = new_start;
                tr->loop_end   = new_end;
                tr->ana_pos    = (float)new_end - _rev_overshoot;
                int tidx = (int)(tr - g_tracks);
                g_cur_chop[tidx] = (int)(new_start / (chunk ? chunk : 1)) % NUM_CHOPS;
            }
        }
    } else {
    tr->ana_pos += tr->stretch * WSOLA_HOP;
    if (tr->loop_end > tr->loop_start && tr->num_frames > 0) {
        if (tr->ana_pos >= (float)tr->loop_end) {
            /* One-shot: suona il chop una volta sola, poi stop */
            if (tr->oneshot) {
                tr->playing = 0;
                tr->oneshot = 0;
                return;
            }
            size_t chunk = tr->num_frames / NUM_CHOPS;
            size_t oend  = (tr->outer_loop_end > 0) ? tr->outer_loop_end : tr->num_frames;
            size_t next_start = tr->loop_end;
            /* Wrappa al boundary del range utente (o inizio sample se no range) */
            if (next_start >= oend) {
                next_start = tr->outer_loop_start;
                g_preview_chop0 = 1; /* traccia al suo pad 0 → sync preview */
            }
            float _fwd_overshoot = tr->ana_pos - (float)tr->loop_end;
            tr->loop_start = next_start;
            tr->loop_end   = next_start + chunk;
            if (tr->loop_end > oend)          tr->loop_end = oend;
            if (tr->loop_end > tr->num_frames) tr->loop_end = tr->num_frames;
            tr->ana_pos    = (float)tr->loop_start + _fwd_overshoot;
            int tidx = (int)(tr - g_tracks);
            g_cur_chop[tidx] = (int)(tr->loop_start / (chunk ? chunk : 1)) % NUM_CHOPS;
        }
    } else if (tr->num_frames > 0) {
        if (tr->ana_pos >= (float)tr->num_frames) {
            tr->ana_pos -= (float)tr->num_frames;
            /* Reset state al loop point per evitare artefatti di phase */
            memset(tr->ola_L, 0, sizeof(tr->ola_L));
            memset(tr->ola_R, 0, sizeof(tr->ola_R));
            tr->prev_valid = 0;
            tr->fade_in    = FADE_FRAMES;
        }
        if (tr->ana_pos < 0.0f) tr->ana_pos = 0.0f;
    }
    } /* end else (forward) */

    tr->out_pos = 0;
}

static void recalc_stretch(track_t *tr) {
    if (tr->num_frames == 0 || tr->bars <= 0 || g_bpm <= 0.0f) {
        tr->stretch = 1.0f;
        return;
    }
    float target = (float)tr->bars * 4.0f * ((float)g_sample_rate * 60.0f / g_bpm);
    tr->stretch = (float)tr->num_frames / target;
    if (tr->stretch < 0.125f) tr->stretch = 0.125f;
    if (tr->stretch > 8.0f)   tr->stretch = 8.0f;
}

/* Rileva il numero di barre più probabile in base alla durata del sample e al BPM corrente */
static float autodetect_bars(size_t frames) {
    if (g_bpm <= 0.0f || frames == 0) return 1.0f;
    float target_1bar = (float)g_sample_rate * 4.0f * 60.0f / g_bpm;
    float ratio = (float)frames / target_1bar;
    /* Valori validi: 0.25, 1, 2, 4, 8, 16 */
    static const float candidates[] = {0.25f, 1.0f, 2.0f, 4.0f, 8.0f, 16.0f};
    static const int   ncand = 6;
    float best = candidates[0];
    float bestDist = fabsf(log2f(ratio / candidates[0]));
    for (int i = 1; i < ncand; i++) {
        float d = fabsf(log2f(ratio / candidates[i]));
        if (d < bestDist) { bestDist = d; best = candidates[i]; }
    }
    return best;
}

/* ── Istanza per tracciare lo stato per-istanza ────────────────────────────── */

typedef struct {
    int dummy;
} mvr_instance_t;

static const host_api_v1_t *g_host = NULL;

/* ── File-based IPC ────────────────────────────────────────────────────────── */
#define CMD_PATH "/data/UserData/schwung/modules/tools/mvr/cmd"
#define CMD_POLL_INTERVAL 2   /* controlla ogni 2 render_block (~5ms) */
static int g_cmd_poll = 0;

/* ── Key detection — Goertzel + Krumhansl-Schmuckler ─────────────────────── */
static const float ks_major[12] = {
    6.35f,2.23f,3.48f,2.33f,4.38f,4.09f,2.52f,5.19f,2.39f,3.66f,2.29f,2.88f
};
static const float ks_minor[12] = {
    6.33f,2.68f,3.52f,5.38f,2.60f,3.53f,2.54f,4.75f,3.98f,2.69f,3.34f,3.17f
};
static const char *g_note_names[12] = {
    "C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"
};

static void detect_key(const int16_t *buf, size_t frames, uint32_t sr, char *out) {
    if (!buf || frames < 64) { snprintf(out, 8, "---"); return; }
    float chroma[12] = {0};
    const size_t step = 8;                        /* downsample 8x */
    size_t max_f = frames < sr * 10 ? frames : sr * 10;  /* max 10s */
    float eff_sr = (float)sr / (float)step;
    for (int pc = 0; pc < 12; pc++) {
        float energy = 0.0f;
        for (int oct = 3; oct <= 5; oct++) {
            int midi = (oct + 1) * 12 + pc;
            float freq = 440.0f * powf(2.0f, (float)(midi - 69) / 12.0f);
            float coeff = 2.0f * cosf(2.0f * (float)M_PI * freq / eff_sr);
            float s1 = 0.0f, s2 = 0.0f;
            for (size_t i = 0; i < max_f; i += step) {
                float x = (float)buf[i * 2] / 32768.0f;  /* left ch */
                float s0 = x + coeff * s1 - s2;
                s2 = s1; s1 = s0;
            }
            energy += s1*s1 + s2*s2 - coeff*s1*s2;
        }
        chroma[pc] = sqrtf(fabsf(energy));
    }
    float cmax = 0.0f;
    for (int i = 0; i < 12; i++) if (chroma[i] > cmax) cmax = chroma[i];
    if (cmax > 0.0f) for (int i = 0; i < 12; i++) chroma[i] /= cmax;
    float best_r = -2.0f; int best_pc = 0, best_mode = 0;
    for (int pc = 0; pc < 12; pc++) {
        for (int mode = 0; mode < 2; mode++) {
            const float *prof = mode == 0 ? ks_major : ks_minor;
            float sc=0,sp=0,scp=0,sc2=0,sp2=0;
            for (int i = 0; i < 12; i++) {
                float c = chroma[(i+pc)%12], p = prof[i];
                sc+=c; sp+=p; scp+=c*p; sc2+=c*c; sp2+=p*p;
            }
            float num = 12.0f*scp - sc*sp;
            float den = sqrtf((12.0f*sc2-sc*sc)*(12.0f*sp2-sp*sp));
            float r = (den > 1e-6f) ? num/den : 0.0f;
            if (r > best_r) { best_r=r; best_pc=pc; best_mode=mode; }
        }
    }
    snprintf(out, 8, "%s%s", g_note_names[best_pc], best_mode==0 ? "maj" : "min");
    LOG("key[%s] r=%.3f\n", out, best_r);
}

static void process_cmd_file(void) {
    FILE *f = fopen(CMD_PATH, "r");
    if (!f) return;
    char line[640];
    while (fgets(line, sizeof(line), f)) {
        /* strip newline */
        int len = (int)strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) len--;
        line[len] = '\0';
        if (len == 0) continue;
        LOG("cmd: %s\n", line);

        if (strncmp(line, "load:", 5) == 0) {
            int row = atoi(line + 5);
            if (row < 0 || row >= NUM_TRACKS) continue;
            char *colon = strchr(line + 5, ':');
            if (!colon) continue;
            char *path = colon + 1;
            track_t *tr = &g_tracks[row];
            size_t frames = 0;
            int16_t *buf = load_wav(path, &frames);
            if (!buf) { LOG("load_wav FAIL r%d: %s\n", row, path); snprintf(g_error_msg, sizeof(g_error_msg), "load fail r%d", row); continue; }
            LOG("load_wav OK r%d: %zu frames\n", row, frames);
            g_error_msg[0] = '\0';
            if (tr->load_ready && tr->next_buf) free(tr->next_buf);
            tr->next_buf = buf; tr->next_frames = frames;
            detect_key(buf, frames, g_sample_rate, g_detected_key[row]);
            /* auto-detect bars — può essere sovrascritto da bars:row:N nel batch corrente */
            tr->bars = autodetect_bars(frames);
            recalc_stretch(tr);
            LOG("autodetect bars r%d: %.4g\n", row, tr->bars);
            __sync_synchronize();
            tr->load_ready = 1;

        } else if (strncmp(line, "play:", 5) == 0) {
            int row = atoi(line + 5);
            if (row < 0 || row >= NUM_TRACKS) continue;
            char *colon = strchr(line + 5, ':');
            if (!colon) continue;
            int col = atoi(colon + 1);
            if (col < 0 || col >= NUM_CHOPS) continue;
            track_t *tr = &g_tracks[row];
            if (!tr->buf && !tr->load_ready) continue;
            size_t nf = tr->load_ready ? tr->next_frames : tr->num_frames;
            size_t chunk = nf / NUM_CHOPS;
            size_t jpos  = (size_t)col * chunk;
            /* Play libero: avanza attraverso tutti i chop (MLR style) */
            tr->outer_loop_start = 0;
            tr->outer_loop_end   = nf;
            tr->reverse          = 0;
            tr->oneshot          = 0;
            g_cur_chop[row]      = col;
            if (col == 0) g_preview_chop0 = 1;
            if (g_quant_beats > 0.0f) {
                tr->queued_jump_pos = jpos;
                tr->jump_queued     = 1;
            } else {
                tr->jump_pos = jpos;
                __sync_synchronize();
                tr->jump_ready = 1;
            }

        } else if (strncmp(line, "loop:", 5) == 0) {
            /* loop:row:col — vincola al singolo chop, non avanza */
            int row = atoi(line + 5);
            if (row < 0 || row >= NUM_TRACKS) continue;
            char *colon = strchr(line + 5, ':');
            if (!colon) continue;
            int col = atoi(colon + 1);
            if (col < 0 || col >= NUM_CHOPS) continue;
            track_t *tr = &g_tracks[row];
            if (!tr->buf && !tr->load_ready) continue;
            size_t nf    = tr->load_ready ? tr->next_frames : tr->num_frames;
            size_t chunk = nf / NUM_CHOPS;
            size_t jpos  = (size_t)col * chunk;
            tr->outer_loop_start = jpos;
            tr->outer_loop_end   = jpos + chunk;
            if (tr->outer_loop_end > nf) tr->outer_loop_end = nf;
            tr->reverse          = 0;
            tr->oneshot          = 0;
            g_cur_chop[row]      = col;
            if (col == 0) g_preview_chop0 = 1;
            if (g_quant_beats > 0.0f) {
                tr->queued_jump_pos = jpos;
                tr->jump_queued     = 1;
            } else {
                tr->jump_pos = jpos;
                __sync_synchronize();
                tr->jump_ready = 1;
            }

        } else if (strncmp(line, "oneshot:", 8) == 0) {
            /* oneshot:row:col — suona il chop una volta sola, poi stop */
            int row = atoi(line + 8);
            if (row < 0 || row >= NUM_TRACKS) continue;
            char *colon = strchr(line + 8, ':');
            if (!colon) continue;
            int col = atoi(colon + 1);
            if (col < 0 || col >= NUM_CHOPS) continue;
            track_t *tr = &g_tracks[row];
            if (!tr->buf && !tr->load_ready) continue;
            size_t nf    = tr->load_ready ? tr->next_frames : tr->num_frames;
            size_t chunk = nf / NUM_CHOPS;
            size_t jpos  = (size_t)col * chunk;
            tr->outer_loop_start = jpos;
            tr->outer_loop_end   = jpos + chunk;
            if (tr->outer_loop_end > nf) tr->outer_loop_end = nf;
            tr->reverse          = 0;
            tr->oneshot          = 1;
            g_cur_chop[row]      = col;
            if (col == 0) g_preview_chop0 = 1;
            if (g_quant_beats > 0.0f) {
                tr->queued_jump_pos = jpos;
                tr->jump_queued     = 1;
            } else {
                tr->jump_pos = jpos;
                __sync_synchronize();
                tr->jump_ready = 1;
            }

        } else if (strncmp(line, "range:", 6) == 0) {
            /* range:row:sc:ec  — loop tra chop sc e chop ec (inclusi) */
            int row = atoi(line + 6);
            if (row < 0 || row >= NUM_TRACKS) continue;
            char *c2 = strchr(line + 6, ':');
            if (!c2) continue;
            int sc = atoi(c2 + 1);
            char *c3 = strchr(c2 + 1, ':');
            if (!c3) continue;
            int ec = atoi(c3 + 1);
            if (sc > ec) { int tmp = sc; sc = ec; ec = tmp; }
            if (sc < 0 || ec >= NUM_CHOPS) continue;
            track_t *tr = &g_tracks[row];
            if (!tr->buf || tr->num_frames == 0) continue;
            size_t chunk = tr->num_frames / NUM_CHOPS;
            tr->outer_loop_start = (size_t)sc * chunk;
            tr->outer_loop_end   = (size_t)(ec + 1) * chunk;
            if (tr->outer_loop_end > tr->num_frames) tr->outer_loop_end = tr->num_frames;
            /* Direzione: quinto parametro opzionale (1=reverse) */
            int rev = 0;
            char *c4 = strchr(c3 + 1, ':');
            if (c4) rev = atoi(c4 + 1);
            tr->reverse  = rev;
            tr->oneshot  = 0;   /* range è sempre loop, mai oneshot */
            /* Reverse: parti dall'ultimo chunk; forward: dal primo */
            size_t jpos = rev
                ? ((tr->outer_loop_end > chunk) ? tr->outer_loop_end - chunk : 0)
                : tr->outer_loop_start;
            if (g_quant_beats > 0.0f) {
                tr->queued_jump_pos = jpos;
                tr->jump_queued     = 1;
            } else {
                tr->jump_pos = jpos;
                __sync_synchronize();
                tr->jump_ready = 1;
            }
            g_cur_chop[row] = sc;

        } else if (strncmp(line, "stop:", 5) == 0) {
            int row = atoi(line + 5);
            if (row < 0 || row >= NUM_TRACKS) continue;
            __sync_synchronize();
            if (g_quant_beats > 0.0f) {
                g_tracks[row].stop_queued = 1;
            } else {
                g_tracks[row].stop_ready = 1;
            }

        } else if (strncmp(line, "reverb:", 7) == 0) {
            int row = atoi(line + 7);
            char *c2 = strchr(line + 7, ':');
            if (c2 && row >= 0 && row < NUM_TRACKS) {
                int val = atoi(c2 + 1);
                if (val <= 0) {
                    g_reverb_wet[row] = 0.0f;
                    memset(&g_reverb[row], 0, sizeof(reverb_t));
                } else {
                    g_reverb_wet[row] = (float)val / 200.0f;
                }
            }

        } else if (strncmp(line, "filter:", 7) == 0) {
            int row = atoi(line + 7);
            char *c2 = strchr(line + 7, ':');
            if (c2 && row >= 0 && row < NUM_TRACKS) {
                float val = (float)atoi(c2 + 1); /* 0-200, 100=flat */
                if (fabsf(val - 100.0f) < 0.5f) {
                    g_filt_mode[row]  = 0;
                    g_filt_z1L[row]   = 0.0f;
                    g_filt_z1R[row]   = 0.0f;
                } else if (val < 100.0f) {
                    float tn = val / 100.0f;
                    float fc = 80.0f * powf(225.0f, tn); /* 80Hz→18kHz */
                    g_filt_alpha[row] = expf(-2.0f * (float)M_PI * fc / (float)g_sample_rate);
                    g_filt_mode[row]  = 1; /* LP */
                } else {
                    float tn = (val - 100.0f) / 100.0f;
                    float fc = 80.0f * powf(100.0f, tn); /* 80Hz→8kHz */
                    g_filt_alpha[row] = expf(-2.0f * (float)M_PI * fc / (float)g_sample_rate);
                    g_filt_mode[row]  = 2; /* HP */
                }
            }

        } else if (strncmp(line, "tvol:", 5) == 0) {
            int row = atoi(line + 5);
            char *c2 = strchr(line + 5, ':');
            if (c2 && row >= 0 && row < NUM_TRACKS) {
                float v = (float)atoi(c2 + 1) / 100.0f;
                if (v < 0.0f) v = 0.0f;
                if (v > 2.0f) v = 2.0f;
                g_track_vol[row] = v;
            }

        } else if (strncmp(line, "vol:", 4) == 0) {
            float v = (float)atoi(line + 4) / 100.0f;
            if (v < 0.0f) v = 0.0f;
            if (v > 2.0f) v = 2.0f;
            g_master_vol = v;

        } else if (strncmp(line, "preview_bars:", 13) == 0) {
            float b = atof(line + 13);
            if (b >= 0.1f && b <= 16.0f) {
                g_preview.bars = b;
                preview_recalc_stretch();
            }

        } else if (strncmp(line, "preview_stop", 12) == 0) {
            g_preview.playing = 0;
            g_preview.waiting = 0;
            if (g_preview.buf) { free(g_preview.buf); g_preview.buf = NULL; }
            if (g_preview_stretch) stretch_reset(g_preview_stretch);
            g_preview_key[0] = '\0';

        } else if (strncmp(line, "preview:", 8) == 0) {
            const char *path = line + 8;
            if (g_preview.buf) { free(g_preview.buf); g_preview.buf = NULL; }
            g_preview.playing = 0;
            size_t frames = 0;
            int16_t *buf = load_wav(path, &frames);
            if (buf) {
                if (frames > PREVIEW_MAX_FRAMES) frames = PREVIEW_MAX_FRAMES;
                g_preview.buf        = buf;
                g_preview.num_frames = frames;
                g_preview.bars       = autodetect_bars(frames);
                preview_recalc_stretch();
                if (g_preview_stretch)
                    stretch_set_source(g_preview_stretch, buf, frames);
                g_preview.waiting = 1;
                g_preview.playing = 0;
                /* key detection — stesso algoritmo/finestra dei track (max 10s interno) */
                detect_key(buf, frames, g_sample_rate, g_preview_key);
                LOG("preview load OK: %zu frames bars=%.4g stretch=%.4f key=%s\n",
                    frames, g_preview.bars, g_preview.stretch, g_preview_key);
            } else {
                g_preview_key[0] = '\0';
                LOG("preview load FAIL: %s\n", path);
            }

        } else if (strncmp(line, "quant:", 6) == 0) {
            float v = strtof(line + 6, NULL);
            g_quant_beats = (v > 0.0f) ? v : 0.0f;
            if (g_quant_beats == 0.0f) {
                for (int i = 0; i < NUM_TRACKS; i++) {
                    g_tracks[i].jump_queued = 0;
                    g_tracks[i].stop_queued = 0;
                }
            }

        } else if (strncmp(line, "bpm:", 4) == 0) {
            float v = strtof(line + 4, NULL);
            if (v >= 40.0f && v <= 200.0f) {
                g_bpm = v;
                for (int i = 0; i < NUM_TRACKS; i++)
                    recalc_stretch(&g_tracks[i]);
                preview_recalc_stretch();
            }

        } else if (strncmp(line, "bars:", 5) == 0) {
            int row = atoi(line + 5);
            if (row < 0 || row >= NUM_TRACKS) continue;
            char *c2 = strchr(line + 5, ':');
            if (!c2) continue;
            float bars = atof(c2 + 1);
            if (bars < 0.1f || bars > 64.0f) continue;
            g_tracks[row].bars = bars;
            recalc_stretch(&g_tracks[row]);
        }
    }
    fclose(f);
    remove(CMD_PATH);
}

/* ── render_block ──────────────────────────────────────────────────────────── */

/* 440 Hz sine approximation via triangle wave, amplitude ~8000 */
static int16_t tone_sample(int *phase) {
    int p = *phase & 0xFF;
    int v = (p < 128) ? (p * 62) : ((255 - p) * 62);
    v -= 3968;
    *phase = (*phase + 1) & 0xFF;
    return (int16_t)v;
}

static void v2_render_block(void *instance, int16_t *out, int frames) {
    mvr_instance_t *inst = (mvr_instance_t *)instance;

    memset(out, 0, (size_t)frames * 2 * sizeof(int16_t));
    if (!inst) return;

    /* Polling comandi da JS */
    if (++g_cmd_poll >= CMD_POLL_INTERVAL) {
        g_cmd_poll = 0;
        process_cmd_file();
    }

    /* Beat clock + fire jump quantizzati al boundary */
    if (g_quant_beats > 0.0f && g_bpm > 0.0f) {
        float old_phase = g_beat_phase;
        g_beat_phase += (float)frames * g_bpm / (60.0f * (float)g_sample_rate);
        if ((int)(g_beat_phase / g_quant_beats) > (int)(old_phase / g_quant_beats)) {
            for (int t = 0; t < NUM_TRACKS; t++) {
                if (g_tracks[t].jump_queued) {
                    g_tracks[t].jump_pos    = g_tracks[t].queued_jump_pos;
                    g_tracks[t].jump_ready  = 1;
                    g_tracks[t].jump_queued = 0;
                }
                if (g_tracks[t].stop_queued) {
                    g_tracks[t].stop_ready  = 1;
                    g_tracks[t].stop_queued = 0;
                }
            }
        }
        if (g_beat_phase > 100000.0f) g_beat_phase -= 100000.0f;
    }

    for (int t = 0; t < NUM_TRACKS; t++) {
        track_t *tr = &g_tracks[t];

        /* Installa nuovo buffer se pronto */
        if (tr->load_ready) {
            int16_t *old  = tr->buf;
            tr->buf        = tr->next_buf;
            tr->num_frames = tr->next_frames;
            tr->next_buf   = NULL;
            tr->load_ready = 0;
            if (old) free(old);
            tr->outer_loop_start = 0;
            tr->outer_loop_end   = tr->num_frames;
            recalc_stretch(tr);
        }

        /* Ferma traccia (con fade-out) */
        if (tr->stop_ready || tr->stop_waiting) {
            if (tr->playing && !tr->stop_waiting) {
                tr->fade_out     = FADE_FRAMES;
                tr->stop_waiting = 1;
                tr->stop_ready   = 0;
            } else {
                tr->playing      = 0;
                tr->stop_ready   = 0;
                tr->stop_waiting = 0;
                g_cur_chop[t]    = -1;
            }
        }

        /* Salta a posizione (MLR chop) — fade-out prima, poi resetta WSOLA */
        if (tr->jump_ready) {
            if (tr->playing && !tr->jump_fading) {
                /* avvia fade-out; il jump scatterà nel prossimo blocco */
                tr->fade_out    = FADE_FRAMES;
                tr->jump_fading = 1;
                goto skip_jump;
            }
            tr->jump_fading = 0;
            size_t chunk   = tr->num_frames / NUM_CHOPS;
            size_t oend    = (tr->outer_loop_end > 0) ? tr->outer_loop_end : tr->num_frames;
            tr->loop_start = tr->jump_pos;
            tr->loop_end   = tr->jump_pos + chunk;
            g_cur_chop[t]  = (int)(tr->jump_pos / (chunk ? chunk : 1)) % NUM_CHOPS;
            if (g_cur_chop[t] == 0) g_preview_chop0 = 1;
            if (tr->loop_end > oend)           tr->loop_end = oend;
            if (tr->loop_end > tr->num_frames) tr->loop_end = tr->num_frames;
            /* Reverse: inizia dalla fine del chunk; forward: dall'inizio */
            tr->ana_pos = tr->reverse
                ? (float)tr->loop_end - (float)WSOLA_HOP
                : (float)tr->jump_pos;
            memset(tr->ola_L, 0, sizeof(tr->ola_L));
            memset(tr->ola_R, 0, sizeof(tr->ola_R));
            tr->out_pos    = WSOLA_HOP;
            tr->prev_valid = 0;
            tr->playing    = 1;
            tr->fade_in    = FADE_FRAMES;
            tr->jump_ready = 0;
        }
        skip_jump:;

        if (!tr->playing || !tr->buf || tr->num_frames == 0) continue;

        /* Mixa questa traccia nell'output via WSOLA */
        for (int f = 0; f < frames; f++) {
            if (tr->out_pos >= WSOLA_HOP)
                wsola_step(tr);

            float l = tr->ola_L[tr->out_pos];
            float r = tr->ola_R[tr->out_pos];
            tr->out_pos++;

            /* Fade-in lineare dopo un jump (evita click) */
            if (tr->fade_in > 0) {
                float gain = 1.0f - (float)tr->fade_in / (float)FADE_FRAMES;
                l *= gain; r *= gain;
                tr->fade_in--;
            }
            /* Fade-out prima di jump/stop differito */
            if (tr->fade_out > 0) {
                float gain = (float)tr->fade_out / (float)FADE_FRAMES;
                l *= gain; r *= gain;
                tr->fade_out--;
            }

            apply_filter(t, &l, &r);
            if (g_reverb_wet[t] > 0.001f) {
                float rev = reverb_process(&g_reverb[t], (l + r) * 0.5f);
                l += g_reverb_wet[t] * rev;
                r += g_reverb_wet[t] * rev;
            }
            l *= g_track_vol[t] * g_master_vol;
            r *= g_track_vol[t] * g_master_vol;

            int32_t ml = (int32_t)out[f*2+0] + (int32_t)l;
            int32_t mr = (int32_t)out[f*2+1] + (int32_t)r;
            if (ml >  32767) ml =  32767; else if (ml < -32768) ml = -32768;
            if (mr >  32767) mr =  32767; else if (mr < -32768) mr = -32768;
            out[f*2+0] = (int16_t)ml;
            out[f*2+1] = (int16_t)mr;
        }
    }

    /* Preview sync: parte/resetta il phase vocoder quando un track passa per chop 0 */
    if (g_preview_chop0 && g_preview.buf &&
        (g_preview.playing || g_preview.waiting)) {
        g_preview.waiting = 0;
        g_preview.playing = 1;
        if (g_preview_stretch)
            stretch_reset(g_preview_stretch);
        LOG("preview sync fired\n");
    }
    g_preview_chop0 = 0;

    /* Preview: SignalsmithStretch phase-vocoder — pitch originale, loop sync BPM */
    if (g_preview.playing && g_preview_stretch && g_preview.buf) {
        static float s_pvoc_l[2048];
        static float s_pvoc_r[2048];
        int fclamp = frames < 2048 ? frames : 2048;
        stretch_fill(g_preview_stretch, g_preview.stretch,
                     s_pvoc_l, s_pvoc_r, fclamp);
        for (int f = 0; f < fclamp; f++) {
            float l = s_pvoc_l[f] * g_master_vol;
            float r = s_pvoc_r[f] * g_master_vol;
            int32_t ml = (int32_t)out[f*2+0] + (int32_t)l;
            int32_t mr = (int32_t)out[f*2+1] + (int32_t)r;
            if (ml >  32767) ml =  32767; else if (ml < -32768) ml = -32768;
            if (mr >  32767) mr =  32767; else if (mr < -32768) mr = -32768;
            out[f*2+0] = (int16_t)ml;
            out[f*2+1] = (int16_t)mr;
        }
    }

    /* Keepalive: evita che il framework silenzi il canale per inattività */
    out[(size_t)frames * 2 - 1] |= 1;
}

/* ── set_param ─────────────────────────────────────────────────────────────── */

static void v2_set_param(void *instance, const char *key, const char *val) {
    mvr_instance_t *inst = (mvr_instance_t *)instance;
    if (!inst || !key || !val) return;

    /*
     * Protocollo a singola chiamata (fire-and-forget safe):
     *   "load"  = "row:path"   es. "0:/data/.../sample.wav"
     *   "play"  = "row:col"    es. "2:5"
     *   "stop"  = "row"        es. "1"
     */
    LOG("set_param: key='%s' val='%.40s'\n", key, val);
    if (strcmp(key, "load") == 0) {
        /* parse "row:path" */
        int row = atoi(val);
        if (row < 0 || row >= NUM_TRACKS) return;
        const char *colon = strchr(val, ':');
        if (!colon) return;
        const char *path = colon + 1;
        if (!path || path[0] == '\0') return;

        track_t *tr = &g_tracks[row];
        size_t   frames = 0;
        int16_t *buf    = load_wav(path, &frames);
        if (!buf) {
            snprintf(g_error_msg, sizeof(g_error_msg),
                     "load fail r%d: %s", row, path);
            return;
        }
        g_error_msg[0] = '\0';
        if (tr->load_ready && tr->next_buf) free(tr->next_buf);
        tr->next_buf    = buf;
        tr->next_frames = frames;
        __sync_synchronize();
        tr->load_ready  = 1;

    } else if (strcmp(key, "play") == 0) {
        /* parse "row:col" */
        int row = atoi(val);
        if (row < 0 || row >= NUM_TRACKS) return;
        const char *colon = strchr(val, ':');
        if (!colon) return;
        int col = atoi(colon + 1);
        if (col < 0 || col >= NUM_CHOPS) return;
        track_t *tr = &g_tracks[row];
        if (!tr->buf && !tr->load_ready) return;
        size_t nf   = tr->load_ready ? tr->next_frames : tr->num_frames;
        size_t jpos = (size_t)((float)col / (float)NUM_CHOPS * (float)nf);
        tr->jump_pos   = jpos;
        __sync_synchronize();
        tr->jump_ready = 1;

    } else if (strcmp(key, "stop") == 0) {
        int row = atoi(val);
        if (row < 0 || row >= NUM_TRACKS) return;
        __sync_synchronize();
        g_tracks[row].stop_ready = 1;
    }
}

/* ── get_param ─────────────────────────────────────────────────────────────── */

static int v2_get_param(void *instance, const char *key,
                        char *buf, int buf_len) {
    mvr_instance_t *inst = (mvr_instance_t *)instance;
    if (!inst || !key || !buf || buf_len <= 0) return -1;

    if (strcmp(key, "status") == 0) {
        int loaded = 0;
        for (int t = 0; t < NUM_TRACKS; t++)
            if (g_tracks[t].buf || g_tracks[t].load_ready) loaded++;
        snprintf(buf, buf_len, "%d/4 loaded", loaded);
        return 0;
    }
    if (strcmp(key, "error") == 0) {
        if (g_error_msg[0] == '\0') {
            snprintf(buf, buf_len, "ok");
        } else {
            snprintf(buf, buf_len, "%s", g_error_msg);
        }
        return 0;
    }
    if (strncmp(key, "chop_", 5) == 0) {
        int row = atoi(key + 5);
        if (row >= 0 && row < NUM_TRACKS) {
            snprintf(buf, buf_len, "%d", g_cur_chop[row]);
            return 0;
        }
    }
    if (strncmp(key, "bars_", 5) == 0) {
        int row = atoi(key + 5);
        if (row >= 0 && row < NUM_TRACKS) {
            snprintf(buf, buf_len, "%.4g", g_tracks[row].bars);
            return 0;
        }
    }
    if (strcmp(key, "preview_bpm") == 0) {
        if (g_preview.detected_bpm > 0.0f)
            snprintf(buf, buf_len, "%.1f", g_preview.detected_bpm);
        else
            snprintf(buf, buf_len, "0");
        return 0;
    }
    if (strcmp(key, "preview_key") == 0) {
        snprintf(buf, buf_len, "%s", g_preview_key[0] ? g_preview_key : "");
        return 0;
    }
    if (strncmp(key, "key_", 4) == 0) {
        int row = atoi(key + 4);
        if (row >= 0 && row < NUM_TRACKS) {
            snprintf(buf, buf_len, "%s", g_detected_key[row][0] ? g_detected_key[row] : "---");
            return 0;
        }
    }
    /* Feature 3: beat phase — per allineare l'epoch del quantize in JS */
    if (strcmp(key, "beat_phase") == 0) {
        snprintf(buf, buf_len, "%.6f", g_beat_phase);
        return 0;
    }
    return -1;
}

/* ── get_error ─────────────────────────────────────────────────────────────── */

static int v2_get_error(void *instance, char *buf, int buf_len) {
    mvr_instance_t *inst = (mvr_instance_t *)instance;
    if (!inst || !buf || buf_len <= 0) return -1;
    if (g_error_msg[0] == '\0') return -1;
    snprintf(buf, buf_len, "%s", g_error_msg);
    g_error_msg[0] = '\0';
    return 0;
}

/* ── Lifecycle ─────────────────────────────────────────────────────────────── */

static void *v2_create_instance(const char *module_dir,
                                const char *json_defaults) {
    (void)module_dir;
    (void)json_defaults;
    LOG("create_instance called dir=%s\n", module_dir ? module_dir : "null");

    ensure_global_state();

    mvr_instance_t *inst = (mvr_instance_t *)calloc(1, sizeof(*inst));
    if (!inst) { LOG("create_instance: calloc failed\n"); return NULL; }

    LOG("create_instance: OK\n");
    return inst;
}

static void v2_destroy_instance(void *instance) {
    /* I buffer g_tracks sono globali — non liberarli qui per evitare
     * double-free su istanze multiple. Vengono rilasciati all'uscita. */
    free(instance);
}

static void v2_on_midi(void *instance, const uint8_t *msg,
                       int len, int source) {
    /* Il MIDI viene gestito interamente da ui.js via onMidiMessageInternal */
    (void)instance; (void)msg; (void)len; (void)source;
}

/* ── Registrazione plugin ──────────────────────────────────────────────────── */

static plugin_api_v2_t g_plugin = {
    .api_version      = MOVE_PLUGIN_API_VERSION_2,
    .create_instance  = v2_create_instance,
    .destroy_instance = v2_destroy_instance,
    .on_midi          = v2_on_midi,
    .set_param        = v2_set_param,
    .get_param        = v2_get_param,
    .get_error        = v2_get_error,
    .render_block     = v2_render_block,
};

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host) {
    g_host = host;
    if (host && host->sample_rate > 0) g_sample_rate = host->sample_rate;
    wsola_init_window();
    if (!g_preview_stretch)
        g_preview_stretch = stretch_new((float)g_sample_rate);
    LOG("move_plugin_init_v2 called sr=%u\n", g_sample_rate);
    return &g_plugin;
}

/* overtake audio FX entry point — shim uses this for component_type: "overtake" with audio */
plugin_api_v2_t *move_audio_fx_init_v2(const host_api_v1_t *host) {
    g_host = host;
    if (host && host->sample_rate > 0) g_sample_rate = host->sample_rate;
    if (!g_preview_stretch)
        g_preview_stretch = stretch_new((float)g_sample_rate);
    LOG("move_audio_fx_init_v2 called sr=%u\n", g_sample_rate);
    return &g_plugin;
}
