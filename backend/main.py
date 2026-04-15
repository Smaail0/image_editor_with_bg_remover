"""
AI Background Remover – FastAPI Backend
Run with: uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageFilter, ImageDraw, ImageColor, ImageChops
from rembg import remove, new_session
import numpy as np
import io
import asyncio
from concurrent.futures import ThreadPoolExecutor

app = FastAPI(title="BG Remover API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared thread pool for CPU-bound rembg work
executor = ThreadPoolExecutor(max_workers=4)
_session_cache: dict = {}

def get_session(model: str = "isnet-general-use"):
    if model not in _session_cache:
        _session_cache[model] = new_session(model)
    return _session_cache[model]

# ──────────────────────────────────────────
# Core processing helpers
# ──────────────────────────────────────────

def clean_alpha_edges(
    image: Image.Image,
    alpha_threshold: int = 190,
    grow: int = 1,
    blur: float = 0.45,
    hole_fill: int = 0,
) -> Image.Image:
    # Convert to float for accurate division
    arr = np.array(image.convert("RGBA")).astype(float)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]

    # 1. Hard threshold to kill weak haze
    alpha[alpha < alpha_threshold] = 0
    alpha[alpha >= alpha_threshold] = 255

    # 2. PIL Filtering for smooth edges
    alpha_img = Image.fromarray(alpha.astype(np.uint8), mode="L")
    alpha_img = alpha_img.filter(ImageFilter.MinFilter(3))
    
    for _ in range(max(1, grow + 1)): 
        alpha_img = alpha_img.filter(ImageFilter.MaxFilter(3))

    if blur > 0:
        alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(blur))
        
    alpha = np.array(alpha_img).astype(float)
    # Clamp tiny semi-transparent noise before further processing.
    alpha[alpha < 8] = 0

    # Fill small interior transparent holes in foreground.
    if hole_fill > 0:
        hole_fill = int(max(0, min(6, hole_fill)))
        # Work on a binary mask so hole-filling doesn't create muddy edges.
        binary = np.where(alpha >= 180, 255, 0).astype(np.uint8)
        close_img = Image.fromarray(binary, mode="L")
        for _ in range(hole_fill):
            close_img = close_img.filter(ImageFilter.MaxFilter(3))
        for _ in range(hole_fill):
            close_img = close_img.filter(ImageFilter.MinFilter(3))
        alpha = np.array(close_img).astype(float)

    # 3. DEFRINGE (Un-premultiply the alpha)
    # This acts exactly like an Alpha Defringe or "Remove Color Matting" 
    # It brightens the semi-transparent pixels to their true color.
    # Avoid exploding dark artifacts by only un-premultiplying on meaningful alpha.
    mask = alpha >= 30
    safe_alpha = np.maximum(alpha, 30)
    for i in range(3):
        # Divide RGB by the alpha percentage, then clip to valid colors
        rgb[:, :, i][mask] = np.clip((rgb[:, :, i][mask] / (safe_alpha[mask] / 255.0)), 0, 255)

    # Any near-transparent pixel should not carry visible color residue.
    rgb[alpha < 6] = 0

    # Recombine and return
    final_arr = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(final_arr, mode="RGBA")


def smart_crop(image: Image.Image, padding: int = 10) -> Image.Image:
    if image.mode != "RGBA":
        return image
    arr   = np.array(image)
    alpha = arr[:, :, 3]
    h, w = alpha.shape

    # If image is fully opaque (common when remove_bg is off), fall back to
    # a simple inward crop so crop padding still has a visible effect.
    if np.all(alpha == 255):
        inset = max(0, int(padding))
        if inset <= 0:
            return image
        max_inset_w = (w - 1) // 2
        max_inset_h = (h - 1) // 2
        inset = min(inset, max_inset_w, max_inset_h)
        if inset <= 0:
            return image
        return image.crop((inset, inset, w - inset, h - inset))

    rows  = np.any(alpha > 0, axis=1)
    cols  = np.any(alpha > 0, axis=0)
    if not rows.any():
        return image
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    rmin = max(0, rmin - padding)
    rmax = min(h, rmax + padding)
    cmin = max(0, cmin - padding)
    cmax = min(w, cmax + padding)
    return image.crop((cmin, rmin, cmax, rmax))


def apply_manual_crop(image: Image.Image, crop_box: str | None) -> Image.Image:
    """Apply normalized crop box: 'x,y,w,h' in [0..1] image coordinates."""
    if not crop_box:
        return image
    try:
        x, y, w_ratio, h_ratio = [float(v.strip()) for v in crop_box.split(",")]
    except Exception:
        return image

    x = max(0.0, min(1.0, x))
    y = max(0.0, min(1.0, y))
    w_ratio = max(0.0, min(1.0 - x, w_ratio))
    h_ratio = max(0.0, min(1.0 - y, h_ratio))
    if w_ratio <= 0 or h_ratio <= 0:
        return image

    img_w, img_h = image.size
    left = int(round(x * img_w))
    top = int(round(y * img_h))
    crop_w = max(1, int(round(w_ratio * img_w)))
    crop_h = max(1, int(round(h_ratio * img_h)))
    right = min(img_w, left + crop_w)
    bottom = min(img_h, top + crop_h)
    if right <= left or bottom <= top:
        return image

    return image.crop((left, top, right, bottom))


def apply_keep_subject_mask(
    result: Image.Image,
    source_rgba: Image.Image,
    keep_mask_bytes: bytes | None,
) -> Image.Image:
    """Force selected masked regions to remain foreground."""
    if not keep_mask_bytes:
        return result
    try:
        keep_mask = Image.open(io.BytesIO(keep_mask_bytes)).convert("L")
    except Exception:
        return result

    if keep_mask.size != result.size:
        keep_mask = keep_mask.resize(result.size, Image.Resampling.BILINEAR)
    if source_rgba.size != result.size:
        source_rgba = source_rgba.resize(result.size, Image.Resampling.LANCZOS)

    result_arr = np.array(result.convert("RGBA"))
    src_arr = np.array(source_rgba.convert("RGBA"))
    mask = np.array(keep_mask)
    protected = mask >= 20

    # Restore original pixels and force full opacity where user painted.
    result_arr[protected, :3] = src_arr[protected, :3]
    result_arr[protected, 3] = 255
    return Image.fromarray(result_arr, mode="RGBA")


def auto_detect_subject_mask(image: Image.Image) -> Image.Image:
    """
    Keep major connected foreground components and drop tiny artifacts.
    Helps cartoons/stickers where remove-bg leaves speckles/islands.
    """
    arr = np.array(image.convert("RGBA"))
    alpha = arr[:, :, 3]
    # Start from a stronger binary mask to avoid tiny haze links.
    fg = alpha >= 120
    h, w = fg.shape
    total_pixels = h * w
    if not fg.any():
        return image

    # Break thin "wire" connections before component analysis.
    fg_img = Image.fromarray((fg.astype(np.uint8) * 255), mode="L")
    fg_img = fg_img.filter(ImageFilter.MinFilter(3))
    fg_img = fg_img.filter(ImageFilter.MaxFilter(3))
    fg = np.array(fg_img) >= 128

    visited = np.zeros_like(fg, dtype=bool)
    components: list[tuple[int, list[tuple[int, int]]]] = []
    neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1)]

    ys, xs = np.where(fg)
    for sy, sx in zip(ys, xs):
        if visited[sy, sx]:
            continue
        stack = [(int(sy), int(sx))]
        visited[sy, sx] = True
        pixels: list[tuple[int, int]] = []

        while stack:
            y, x = stack.pop()
            pixels.append((y, x))
            for dy, dx in neighbors:
                ny, nx = y + dy, x + dx
                if ny < 0 or nx < 0 or ny >= h or nx >= w:
                    continue
                if visited[ny, nx] or not fg[ny, nx]:
                    continue
                visited[ny, nx] = True
                stack.append((ny, nx))

        components.append((len(pixels), pixels))

    if not components:
        return image

    components.sort(key=lambda c: c[0], reverse=True)
    largest = components[0][0]
    min_area_by_largest = int(largest * 0.18)
    min_area_by_canvas = int(total_pixels * 0.0025)
    min_keep_area = max(120, min_area_by_largest, min_area_by_canvas)

    keep = np.zeros_like(fg, dtype=bool)
    kept_count = 0
    for area, pixels in components:
        if area < min_keep_area:
            continue
        for py, px in pixels:
            keep[py, px] = True
        kept_count += 1
        if kept_count >= 12:
            break

    if not keep.any():
        # Fallback: keep at least the largest region.
        for py, px in components[0][1]:
            keep[py, px] = True

    # Slight close/open polish for cleaner edges.
    keep_img = Image.fromarray((keep.astype(np.uint8) * 255), mode="L")
    keep_img = keep_img.filter(ImageFilter.MaxFilter(3))
    keep_img = keep_img.filter(ImageFilter.MinFilter(3))
    keep_img = keep_img.filter(ImageFilter.MinFilter(3))
    keep = np.array(keep_img) >= 128

    arr[~keep, 3] = 0
    arr[~keep, :3] = 0
    return Image.fromarray(arr, mode="RGBA")


def process_image_bytes(
    input_bytes: bytes,
    model: str = "isnet-general-use",
    remove_bg: bool = False,
    do_crop: bool = True,
    crop_padding: int = 10,
    alpha_threshold: int = 190,
    grow: int = 1,
    blur: float = 0.45,
    hole_fill: int = 0,
    auto_subject: bool = True,
    corner_radius: int = 20,
    stroke_width: int = 4,
    stroke_color: str = "#ffffff",
    manual_crop: str | None = None,
    keep_mask_bytes: bytes | None = None,
) -> bytes:
    """Synchronous processing pipeline (runs in thread pool)."""
    source = Image.open(io.BytesIO(input_bytes)).convert("RGBA")
    
    # Optional Background Removal
    if remove_bg:
        session = get_session(model)
        output_bytes = remove(
            input_bytes,
            session=session,
            alpha_matting=False,
            post_process_mask=True,
        )
        result = Image.open(io.BytesIO(output_bytes)).convert("RGBA")
        result = clean_alpha_edges(
            result,
            alpha_threshold=alpha_threshold,
            grow=grow,
            blur=blur,
            hole_fill=hole_fill,
        )
        if auto_subject:
            result = auto_detect_subject_mask(result)
        result = apply_keep_subject_mask(result, source, keep_mask_bytes)
    else:
        # Just open the original image
        result = source.copy()

    # Smart Crop (Only works properly if image has transparency/was removed)
    if do_crop:
        result = smart_crop(result, padding=crop_padding)
    
    # Explicit user-selected crop (from editor crop mode)
    result = apply_manual_crop(result, manual_crop)

    # Apply Rounded Corners & Stroke
    if corner_radius > 0 or stroke_width > 0:
        w, h = result.size
        
        # 1. Apply Rounded Mask
        mask = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(mask)
        draw.rounded_rectangle((0, 0, w, h), radius=corner_radius, fill=255)

        rounded_result = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        rounded_result.paste(result, (0, 0), mask=mask)
        result = rounded_result

        # 2. Draw Stroke
        if stroke_width > 0:
            try:
                color = ImageColor.getrgb(stroke_color)
            except Exception:
                color = (255, 255, 255) # Fallback to white

            # Build a precise "inside border ring" from masks to avoid visual gaps.
            outer_mask = Image.new("L", (w, h), 0)
            outer_draw = ImageDraw.Draw(outer_mask)
            outer_draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=corner_radius, fill=255)

            inset = max(1, int(stroke_width))
            inner_mask = Image.new("L", (w, h), 0)
            inner_draw = ImageDraw.Draw(inner_mask)
            if (w - 1 - inset) > inset and (h - 1 - inset) > inset:
                inner_draw.rounded_rectangle(
                    (inset, inset, w - 1 - inset, h - 1 - inset),
                    radius=max(0, corner_radius - inset),
                    fill=255
                )

            border_mask = ImageChops.subtract(outer_mask, inner_mask)
            stroke_layer = Image.new("RGBA", (w, h), (*color, 0))
            stroke_layer.putalpha(border_mask)
            result = Image.alpha_composite(result, stroke_layer)

    buf = io.BytesIO()
    result.save(buf, format="PNG")
    return buf.getvalue()

def remove_bg_luma_key(image: Image.Image, black_level: int = 15, white_level: int = 50) -> Image.Image:
    """
    Calculates alpha directly from luminance. 
    Perfect for extracting white line-art/icons from pure black backgrounds with razor-sharp precision.
    """
    arr = np.array(image.convert("RGBA")).astype(float)
    
    # Calculate Rec. 709 luminance
    luma = 0.2126 * arr[:, :, 0] + 0.7152 * arr[:, :, 1] + 0.0722 * arr[:, :, 2]
    
    # Create a smooth alpha roll-off (anti-aliasing)
    alpha = np.clip((luma - black_level) / (white_level - black_level), 0, 1) * 255
    
    arr[:, :, 3] = alpha
    return Image.fromarray(arr.astype(np.uint8), mode="RGBA")


# ──────────────────────────────────────────
# Routes
# ──────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/remove-bg")
async def remove_background(
    file: UploadFile = File(...),
    model: str = "isnet-general-use",
    remove_bg: bool = False,
    crop: bool = True,
    crop_padding: int = 10,
    alpha_threshold: int = 190,
    grow: int = 1,
    blur: float = 0.45,
    hole_fill: int = 0,
    auto_subject: bool = True,
    corner_radius: int = 20,
    stroke_width: int = 4,
    stroke_color: str = "#ffffff",
    manual_crop: str | None = None,
    keep_mask: UploadFile | None = File(default=None),
):
    """Process a single image."""
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image.")

    input_bytes = await file.read()
    keep_mask_bytes = await keep_mask.read() if keep_mask else None
    if len(input_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB).")

    loop = asyncio.get_event_loop()
    result_bytes = await loop.run_in_executor(
        executor,
        process_image_bytes,
        input_bytes, model, remove_bg, crop, crop_padding, 
        alpha_threshold, grow, blur, hole_fill, auto_subject, corner_radius, stroke_width, stroke_color, manual_crop, keep_mask_bytes
    )

    return Response(
        content=result_bytes,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{file.filename.rsplit(".", 1)[0]}_processed.png"'},
    )


@app.post("/batch-remove-bg")
async def batch_remove_background(
    files: list[UploadFile] = File(...),
    model: str = "isnet-general-use",
    remove_bg: bool = False,
    crop: bool = True,
    crop_padding: int = 10,
    alpha_threshold: int = 190,
    grow: int = 1,
    blur: float = 0.45,
    hole_fill: int = 0,
    auto_subject: bool = True,
    corner_radius: int = 20,
    stroke_width: int = 4,
    stroke_color: str = "#ffffff",
    manual_crop: str | None = None,
):
    """Process multiple images concurrently."""
    import base64

    if len(files) > 20:
        raise HTTPException(status_code=400, detail="Max 20 files per batch.")

    async def process_one(f: UploadFile):
        if not f.content_type.startswith("image/"):
            return {"filename": f.filename, "error": "Not an image", "data": None}
        raw = await f.read()
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(
                executor, process_image_bytes, raw, model, remove_bg, crop, crop_padding, 
                alpha_threshold, grow, blur, hole_fill, auto_subject, corner_radius, stroke_width, stroke_color, manual_crop
            )
            return {
                "filename": f.filename,
                "error": None,
                "data": base64.b64encode(result).decode(),
            }
        except Exception as e:
            return {"filename": f.filename, "error": str(e), "data": None}

    results = await asyncio.gather(*[process_one(f) for f in files])
    return {"results": results}