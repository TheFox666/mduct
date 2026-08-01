#!/usr/bin/env python3
"""Render a terminal demo GIF from REAL captured output.

No faking: every line below was produced by running the command against a live
demo profile; this only replays it with a typing animation.
"""
import subprocess, os
from PIL import Image, ImageDraw, ImageFont

W, H = 1100, 680
PAD = 24
LINE = 26
FS = 17
BG = (13, 17, 23)          # github dark
FG = (201, 209, 217)
DIM = (110, 118, 129)
PROMPT = (126, 231, 135)   # green
CMD = (255, 255, 255)
ACCENT = (121, 192, 255)   # blue
WARN = (255, 166, 87)

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
]
fp = next(p for p in FONT_PATHS if os.path.exists(p))
font = ImageFont.truetype(fp, FS)
bold = ImageFont.truetype(fp.replace("Regular", "Bold").replace("Mono.ttf", "Mono-Bold.ttf"), FS) \
    if os.path.exists(fp.replace("Regular", "Bold").replace("Mono.ttf", "Mono-Bold.ttf")) else font

# (command, [(text, colour), …] output lines)
SCENES = [
    ("mduct servers", [
        ("# instance: ~/.config/mduct/servers.jsonc", DIM),
        ("docs             idle  — library documentation, live", FG),
        ("notes            idle  — scratch notes", FG),
    ]),
    ("mduct tools docs", [
        ("resolve-library-id(query, libraryName)", ACCENT),
        ("query-docs(libraryId, query)", ACCENT),
        ("", FG),
        ("# names and signatures. the schemas stay on disk.", DIM),
    ]),
    ("mduct call docs resolve-library-id libraryName=zod query=\"validation\"", [
        ("Available Libraries:", FG),
        ("", FG),
        ("- Title: Zod", FG),
        ("- Context7-compatible library ID: /colinhacks/zod", FG),
        ("- Description: TypeScript-first schema validation with static type", FG),
        ("  inference.", FG),
        ("- Code Snippets: 1202", FG),
    ]),
    ("mduct call notes echo text='{\"id\":7,\"ok\":true}' --json | jq -c '{id}'", [
        ("{\"id\":7}", FG),
        ("", FG),
        ("# --json strips the server's prose, so the pipe just works.", DIM),
    ]),
    ("mduct call notes admin_delete", [
        ("guard: tool \"admin_delete\" is blocked for server \"notes\"", WARN),
        ("       — edit its guard in the config to change this", WARN),
        ("", FG),
        ("# the guard lives in the daemon, not in a prompt.", DIM),
    ]),
    ("mduct index", [
        ("MCP tools via `mduct` CLI (list+args: mduct tools <server>;", FG),
        ("call: mduct call <server> <tool> key=value key:=<json>):", FG),
        ("  docs         — library documentation, live", FG),
        ("  notes        — scratch notes", FG),
        ("CLI tools via `mduct` CLI (run: mduct run <tool> [args…]):", FG),
        ("  kubectl      — read-only cluster access", FG),
        ("", FG),
        ("# 302 bytes. that is the whole footprint in the model's context.", DIM),
    ]),
]

frames, durations = [], []


def blank():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # window chrome
    d.rectangle([0, 0, W, 34], fill=(22, 27, 34))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([PAD + i * 22, 12, PAD + i * 22 + 11, 23], fill=c)
    d.text((W // 2 - 30, 9), "mduct", font=font, fill=DIM)
    return im, d


def render(history, typing=None, cursor=True):
    """history: list of (kind, text, colour); typing: partial command being typed."""
    im, d = blank()
    y = 46
    for kind, text, col in history:
        if y > H - LINE:
            break
        if kind == "cmd":
            d.text((PAD, y), "$", font=bold, fill=PROMPT)
            d.text((PAD + 16, y), text, font=font, fill=CMD)
        else:
            d.text((PAD, y), text, font=font, fill=col)
        y += LINE
    if typing is not None and y <= H - LINE:
        d.text((PAD, y), "$", font=bold, fill=PROMPT)
        d.text((PAD + 16, y), typing, font=font, fill=CMD)
        if cursor:
            x = PAD + 16 + d.textlength(typing, font=font) + 2
            d.rectangle([x, y + 2, x + 9, y + FS + 3], fill=FG)
    return im


def add(im, ms):
    frames.append(im)
    durations.append(ms)


history = []
for scene in SCENES:
    cmd, out = scene[0], scene[1]
    # type the command
    step = 3
    for i in range(0, len(cmd) + 1, step):
        add(render(history, cmd[:i]), 30)
    add(render(history, cmd), 350)
    history.append(("cmd", cmd, CMD))
    # output appears at once, like a real command
    for line, col in out:
        history.append(("out", line, col))
    add(render(history), 1500)
    history.append(("out", "", FG))
    # scroll: keep the last lines only
    if len(history) > 20:
        history = history[-20:]

add(render(history), 2200)

PALETTE = [BG, FG, DIM, PROMPT, CMD, ACCENT, WARN, (22, 27, 34),
           (255, 95, 86), (255, 189, 46), (39, 201, 63)]
pal = Image.new("P", (1, 1))
flat = [c for rgb in PALETTE for c in rgb]
pal.putpalette(flat + [0] * (768 - len(flat)))
frames = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]

out_path = "/tmp/claude-1001/demo.gif"
frames[0].save(out_path, save_all=True, append_images=frames[1:], duration=durations,
               loop=0, optimize=True, disposal=2)
print(f"{len(frames)} frames, {os.path.getsize(out_path)//1024} kB → {out_path}")
