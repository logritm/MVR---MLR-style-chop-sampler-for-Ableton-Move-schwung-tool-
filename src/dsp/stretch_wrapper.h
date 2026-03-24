/* stretch_wrapper.h — C interface to SignalsmithStretch phase-vocoder */
#pragma once
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct StretchCtx StretchCtx;

/* Alloca un'istanza stereo per il dato sample rate. */
StretchCtx *stretch_new(float sample_rate);
void        stretch_free(StretchCtx *ctx);

/* Imposta il buffer sorgente (int16 interleaved stereo) e azzera lo stato. */
void stretch_set_source(StretchCtx *ctx, const int16_t *buf, size_t num_frames);

/* Torna all'inizio e pulisce lo stato interno del phase vocoder. */
void stretch_reset(StretchCtx *ctx);

/*
 * Riempie out_frames campioni float (scala int16) in out_l / out_r.
 * ratio > 1  →  slow-down (consuma più input per ogni output)
 * ratio < 1  →  speed-up
 * Legge dal buffer sorgente con wrap ciclico.
 */
void stretch_fill(StretchCtx *ctx, float ratio,
                  float *out_l, float *out_r, int out_frames);

#ifdef __cplusplus
}
#endif
