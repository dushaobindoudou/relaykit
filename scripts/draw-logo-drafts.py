#!/usr/bin/env python3
"""
AI充站 logo 图生成（Pillow 精确绘制，中文字样零误差）。

三个方向：
  A  app-icon 徽标 —— 深藏青渐变圆角方，琥珀闪电 + AI + 代充
  B  横版 wordmark —— 站头用：充电口印记 + AI ⚡ 代充
  C  极简绿徽 —— 品牌绿圆角方，白充电口印记 + AI代充
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path("public/brand/logo-drafts")
OUT.mkdir(parents=True, exist_ok=True)

S = 4  # 超采样倍数

NAVY_DEEP = (15, 27, 45)
NAVY = (22, 34, 56)
AMBER = (255, 176, 32)
AMBER_HI = (255, 209, 102)
GREEN = (28, 95, 69)
WHITE = (255, 255, 255)
INK = (28, 32, 36)

FONT_AI = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_CN = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def cn_font(size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT_CN, size, index=1)  # W8 粗体
    except Exception:
        return ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", size)


def vertical_gradient(size, top, bottom):
    w, h = size
    base = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        base.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    return base.resize((w, h))


def rounded_gradient_badge(size, radius, top, bottom):
    w, h = size
    grad = vertical_gradient((w, h), top, bottom).convert("RGBA")
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    grad.putalpha(mask)
    return grad


def draw_bolt(draw, cx, cy, h, color, glow=None):
    """闪电：以 (cx, cy) 为中心、高 h 的经典双折闪电轮廓。"""
    w = h * 0.52
    pts = [
        (cx + w * 0.10, cy - h / 2),
        (cx - w * 0.30, cy + h * 0.06),
        (cx - w * 0.02, cy + h * 0.06),
        (cx - w * 0.10, cy + h / 2),
        (cx + w * 0.30, cy - h * 0.10),
        (cx + w * 0.02, cy - h * 0.10),
    ]
    if glow:
        draw.polygon([(x + dx, y + dy) for x, y in pts for dx, dy in [(0, 0)]], fill=glow)
    draw.polygon(pts, fill=color)


def draw_port(draw, cx, cy, w, h, color, width):
    """充电口：圆角矩形外框 + 两个插孔点。"""
    draw.rounded_rectangle(
        [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
        radius=h * 0.28,
        outline=color,
        width=width,
    )
    pin = width * 2.1
    for dx in (-w * 0.18, w * 0.18):
        draw.ellipse(
            [cx + dx - pin / 2, cy - pin / 2, cx + dx + pin / 2, cy + pin / 2],
            fill=color,
        )


def text_center(draw, cx, cy, text, font, fill, tracking=0):
    if tracking:
        widths = [draw.textlength(ch, font=font) for ch in text]
        total = sum(widths) + tracking * (len(text) - 1)
        x = cx - total / 2
        for ch, w in zip(text, widths):
            draw.text((x, cy), ch, font=font, fill=fill, anchor="lm")
            x += w + tracking
        return
    draw.text((cx, cy), text, font=font, fill=fill, anchor="mm")


# ---------------------------------------------------------------- A 徽标
def variant_a():
    px = 1024 * S
    img = rounded_gradient_badge((px, px), int(px * 0.225), (26, 42, 68), NAVY_DEEP).convert("RGB")
    draw = ImageDraw.Draw(img)

    # 中央印记：充电口 + 闪电
    mark_cy = px * 0.40
    port_w, port_h = px * 0.40, px * 0.24
    draw_port(draw, px / 2, mark_cy, port_w, port_h, AMBER, int(px * 0.022))
    draw_bolt(draw, px / 2, mark_cy - px * 0.005, px * 0.20, AMBER_HI)

    # AI
    f_ai = ImageFont.truetype(FONT_AI, int(px * 0.20))
    text_center(draw, px / 2, px * 0.675, "AI", f_ai, WHITE)
    # 代充（字距放宽）
    f_cn = cn_font(int(px * 0.135))
    text_center(draw, px / 2, px * 0.845, "代充", f_cn, AMBER, tracking=int(px * 0.012))
    return img


# ---------------------------------------------------------------- B 横版
def variant_b():
    w, h = 1680 * S, 512 * S
    img = Image.new("RGB", (w, h), WHITE)
    draw = ImageDraw.Draw(img)

    # 左侧印记：绿色圆角方 + 白色充电口闪电
    pad = h * 0.14
    badge = h - pad * 2
    bx, by = pad, pad
    draw.rounded_rectangle(
        [bx, by, bx + badge, by + badge], radius=badge * 0.24, fill=GREEN
    )
    port_w, port_h = badge * 0.62, badge * 0.38
    draw_port(draw, bx + badge / 2, by + badge * 0.42, port_w, port_h, WHITE, int(badge * 0.045))
    draw_bolt(draw, bx + badge / 2, by + badge * 0.40, badge * 0.30, AMBER_HI)

    # AI ⚡ 代充
    x = bx + badge + h * 0.16
    f_ai = ImageFont.truetype(FONT_AI, int(h * 0.52))
    f_cn = cn_font(int(h * 0.46))

    draw.text((x, h * 0.52), "AI", font=f_ai, fill=INK, anchor="lm")
    x += draw.textlength("AI", font=f_ai) + h * 0.10

    bolt_h = h * 0.34
    bolt_cy = h * 0.50
    draw_bolt(draw, x + bolt_h * 0.26, bolt_cy, bolt_h, AMBER)
    x += bolt_h * 0.52 + h * 0.10

    draw.text((x, h * 0.52), "代充", font=f_cn, fill=GREEN, anchor="mm")
    # 小字标语
    f_sub = cn_font(int(h * 0.11))
    draw.text((x + draw.textlength("代充", font=f_cn) / 2 - 0, h * 0.52 + h * 0.30), "", font=f_sub)
    return img


# ---------------------------------------------------------------- C 绿徽
def variant_c():
    px = 1024 * S
    img = rounded_gradient_badge((px, px), int(px * 0.225), (32, 108, 80), (18, 62, 46)).convert("RGB")
    draw = ImageDraw.Draw(img)

    mark_cy = px * 0.38
    draw_port(draw, px / 2, mark_cy, px * 0.44, px * 0.27, WHITE, int(px * 0.020))
    draw_bolt(draw, px / 2, mark_cy - px * 0.005, px * 0.22, AMBER_HI)

    f_ai = ImageFont.truetype(FONT_AI, int(px * 0.155))
    f_cn = cn_font(int(px * 0.155))
    y = px * 0.66
    ai_w = draw.textlength("AI", font=f_ai)
    cn_w = draw.textlength("代充", font=f_cn)
    gap = px * 0.02
    x = px / 2 - (ai_w + gap + cn_w) / 2
    draw.text((x, y), "AI", font=f_ai, fill=WHITE, anchor="lm")
    draw.text((x + ai_w + gap, y), "代充", font=f_cn, fill=WHITE, anchor="lm")
    return img


for name, fn in (("logo-a-badge", variant_a), ("logo-b-wordmark", variant_b), ("logo-c-green", variant_c)):
    img = fn()
    final = img.resize((img.width // S, img.height // S), Image.LANCZOS)
    path = OUT / f"{name}.png"
    final.save(path)
    print("saved", path, final.size)
