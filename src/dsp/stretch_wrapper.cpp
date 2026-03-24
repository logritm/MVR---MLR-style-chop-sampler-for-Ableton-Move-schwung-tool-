/* stretch_wrapper.cpp — C++ impl of stretch_wrapper.h using Rubber Band Library */
#include <rubberband/RubberBandStretcher.h>
#include "stretch_wrapper.h"
#include <cstring>
#include <new>

#define SW_MAX_BLOCK 8192

using RubberBand::RubberBandStretcher;

struct StretchCtx {
    RubberBandStretcher *rb;
    const int16_t *src;
    size_t         num_frames;
    double         ana_pos;
    float          in_l[SW_MAX_BLOCK];
    float          in_r[SW_MAX_BLOCK];
    float          last_ratio;
};

extern "C" {

StretchCtx *stretch_new(float sample_rate)
{
    StretchCtx *ctx = new(std::nothrow) StretchCtx();
    if (!ctx) return nullptr;

    ctx->rb = new(std::nothrow) RubberBandStretcher(
        (size_t)sample_rate, 2,
        RubberBandStretcher::OptionProcessRealTime |
        RubberBandStretcher::OptionStretchPrecise
    );
    if (!ctx->rb) { delete ctx; return nullptr; }

    ctx->src        = nullptr;
    ctx->num_frames = 0;
    ctx->ana_pos    = 0.0;
    ctx->last_ratio = -1.0f;
    return ctx;
}

void stretch_free(StretchCtx *ctx)
{
    if (!ctx) return;
    delete ctx->rb;
    delete ctx;
}

void stretch_set_source(StretchCtx *ctx, const int16_t *buf, size_t num_frames)
{
    if (!ctx) return;
    ctx->src        = buf;
    ctx->num_frames = num_frames;
    ctx->ana_pos    = 0.0;
    ctx->rb->reset();
    ctx->last_ratio = -1.0f;
}

void stretch_reset(StretchCtx *ctx)
{
    if (!ctx) return;
    ctx->ana_pos    = 0.0;
    ctx->rb->reset();
    ctx->last_ratio = -1.0f;
}

void stretch_fill(StretchCtx *ctx, float ratio,
                  float *out_l, float *out_r, int out_frames)
{
    if (!ctx || !ctx->src || ctx->num_frames == 0 || out_frames <= 0) {
        if (out_l) memset(out_l, 0, (size_t)out_frames * sizeof(float));
        if (out_r) memset(out_r, 0, (size_t)out_frames * sizeof(float));
        return;
    }

    if (ratio < 0.125f) ratio = 0.125f;
    if (ratio > 8.0f)   ratio = 8.0f;

    /* Rubber Band timeRatio = durata_output / durata_input = 1 / ratio */
    if (ctx->last_ratio != ratio) {
        ctx->rb->setTimeRatio(1.0 / (double)ratio);
        ctx->last_ratio = ratio;
    }

    const int n = (int)ctx->num_frames;
    int produced = 0;

    while (produced < out_frames) {
        int avail = ctx->rb->available();
        if (avail > 0) {
            int take = avail < (out_frames - produced) ? avail : (out_frames - produced);
            float *outs[2] = { out_l + produced, out_r + produced };
            ctx->rb->retrieve(outs, (size_t)take);
            produced += take;
        }
        if (produced >= out_frames) break;

        int required = (int)ctx->rb->getSamplesRequired();
        if (required <= 0) required = 512;
        if (required > SW_MAX_BLOCK) required = SW_MAX_BLOCK;

        int ipos = (int)ctx->ana_pos;
        for (int i = 0; i < required; i++) {
            int p = ipos % n;
            if (p < 0) p += n;
            ctx->in_l[i] = (float)ctx->src[p * 2 + 0] * (1.0f / 32768.0f);
            ctx->in_r[i] = (float)ctx->src[p * 2 + 1] * (1.0f / 32768.0f);
            ipos++;
        }
        ctx->ana_pos += required;
        while (ctx->ana_pos >= (double)ctx->num_frames)
            ctx->ana_pos -= (double)ctx->num_frames;

        const float *inputs[2] = { ctx->in_l, ctx->in_r };
        ctx->rb->process(inputs, (size_t)required, false);
    }

    /* Scala output a range int16 per compatibilità col mixer */
    for (int i = 0; i < out_frames; i++) {
        out_l[i] *= 32768.0f;
        out_r[i] *= 32768.0f;
    }
}

} /* extern "C" */
