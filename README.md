# MVR — MLR-style chop sampler for Ableton Move

MVR is a 4-track chop sampler for the [Ableton Move](https://www.ableton.com/en/move/), inspired by the classic MLR from the monome ecosystem. It runs as a **schwung** module.

## Features

- 4 tracks (A/B/C/D), each with 8 chops
- MLR-style chop jumping and sub-loop ranges (hold two pads; right-to-left = reverse)
- **4 pages** of samples — switch with left/right arrows; playing tracks continue across page switches
- **Copy mode** — copy samples between pages
- **Time-stretch** (WSOLA) to sync samples of different BPMs to master BPM
- **Auto-detect bars** (1/4, 1, 2, 4, 8, 16) on sample load
- **Key detection** shown in file browser and player view
- **BPM detection** shown in file browser during preview
- Per-track volume, DJ filter (LP↔HP), reverb
- Loop / one-shot mode
- MLR-style MIDI recorder with overdub and quantize

## Controls
Loop button - Change mode for loop to single shot 
| Control | Function |
|---|---|
| Pads | Jump to chop / hold two pads = sub-loop range |
if you hold two pads  pressing the righ one first it plays in reverse mode
| Row buttons A–D | Stop track |
| Shift + row button | change sample  bars lenght (1/4→1→2→4→8→16) |
| Shift (tap) | Toggle player / file browser |
| Left / Right arrows | Previous / next page |
| Main knob | Scroll browser; Shift+knob = BPM |
| Jog click | Open folder / load sample / cycle quantize |
| Knobs 1–4 | Track volume |
| Step 1 (hold) + Knobs 1–4 | DJ filter per track |
| Step 2 (hold) + Knobs 1–4 | Reverb per track |
| Step 1 (hold) + Knobs 8 | DJ filter per master |
| Step 2 (hold) + Knobs 8 | Reverb per master |


| Master knob | Master volume |
| Copy button | Enter copy mode |

NOTE : ALL BUTTONS AND KNOBS WITH LIGHTS ARE WORKING

## Installation (pre-built)

1. Download `pipewire-module.tar.gz` from the [Releases](../../releases) page
2. Copy and extract on the Move:

```bash
scp pipewire-module.tar.gz root@move.local:/tmp/
ssh root@move.local
mkdir -p /data/UserData/schwung/modules/tools/mvr
cd /tmp && tar -xzf pipewire-module.tar.gz
cp -r pipewire/* /data/UserData/schwung/modules/tools/mvr/
```

3. Open MVR from the schwung module list on your Move.

Samples must be WAV files in `/data/UserData/UserLibrary/Samples`.

## Build from source

Requires Docker.

```bash
git clone https://github.com/YOUR_USERNAME/mvr
cd mvr
bash scripts/build.sh
# output: dist/pipewire-module.tar.gz
```

## Requirements

- Ableton Move with [schwung](https://github.com/schwung-org/schwung) installed
