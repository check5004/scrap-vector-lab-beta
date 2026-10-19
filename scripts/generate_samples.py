#!/usr/bin/env python3
"""Generate a real ArUco print sheet and deterministic synthetic metrology fixtures.

Install: python -m pip install opencv-contrib-python-headless pillow numpy
Run from any directory: python scripts/generate_samples.py
These images are synthetic test fixtures, not proof of real-photo accuracy.
Geometry, calibration truth and masks are stored separately from the photographs.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
PRINT = ROOT / "public" / "print"
SAMPLES = ROOT / "public" / "samples"
PPM = 10
PAGE_W, PAGE_H = 297, 210
BOARD_W, BOARD_H = 250, 170
ORIGIN = np.array([23.5, 20.0])
MARKER_MM = 12.0
MARKER_TOPLEFT = [(11.5, 8), (273.5, 8), (273.5, 190), (11.5, 190)]
INNER_INDEX = [2, 3, 0, 1]
DICTIONARY = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)


def font(size):
    for name in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def marker_bits(marker_id):
    return cv2.aruco.generateImageMarker(DICTIONARY, marker_id, 6)


def page_markers_mm():
    return [np.array([[x, y], [x + 12, y], [x + 12, y + 12], [x, y + 12]], dtype=float)
            for x, y in MARKER_TOPLEFT]


def create_print_sheet():
    PRINT.mkdir(parents=True, exist_ok=True)
    codes = ["0x" + format(int("".join("1" if v else "0" for v in marker_bits(i)[1:5, 1:5].ravel()), 2), "04x")
             for i in range(50)]
    write_json(PRINT / "dictionary.json", {"name": "DICT_4X4_50", "nBits": 16, "tau": 4,
               "codeList": codes, "recommendedMaxHammingDistance": 2,
               "source": "OpenCV DICT_4X4_50; row-major white=1 interior cells; black one-cell border",
               "marker_side_mm": MARKER_MM, "inner_corner_indices": INNER_INDEX,
               "marker_corners_page_mm": [p.tolist() for p in page_markers_mm()]})
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210">',
             '<title>A4 metrology board: inner-facing marker corners 250 by 170 mm</title>',
             '<desc>Print landscape at 100 percent actual size. Disable fit to page. DICT_4X4_50 IDs 0,1,2,3. Marker sides 12 mm. Confirm the two 100 mm rulers with a physical ruler before measuring.</desc>',
             '<rect width="297" height="210" fill="white"/>',
             '<style>text{font-family:Arial,sans-serif;fill:#222} .small{font-size:2.3px}</style>']
    page = Image.new("RGB", (PAGE_W * PPM, PAGE_H * PPM), "white")
    draw = ImageDraw.Draw(page)
    for i, (x, y) in enumerate(MARKER_TOPLEFT):
        bits = marker_bits(i)
        for r in range(6):
            for c in range(6):
                if bits[r, c] == 0:
                    parts.append(f'<rect x="{x+c*2:g}" y="{y+r*2:g}" width="2" height="2" fill="black"/>')
        block = Image.fromarray(cv2.aruco.generateImageMarker(DICTIONARY, i, 120)).convert("RGB")
        page.paste(block, (round(x * PPM), round(y * PPM)))
        # Labels are separated from the marker border by at least 3 mm.
        lx = x + 6
        ly = y + 17 if i < 2 else y - 4
        parts.append(f'<text x="{lx:g}" y="{ly:g}" text-anchor="middle" class="small">ID {i}</text>')
        draw.text((round(lx * PPM), round(ly * PPM)), f"ID {i}", font=font(23), anchor="ms", fill="#333333")
    lines = [("SCRAP VECTOR LAB / A4 CALIBRATION", 148.5, 10, 3.4),
             ("250 x 170 mm between inward-facing BLACK marker corners", 148.5, 15, 2.5),
             ("PRINT 100% / ACTUAL SIZE. LANDSCAPE. NO FIT-TO-PAGE.", 148.5, 196, 2.5)]
    for label, x, y, s in lines:
        parts.append(f'<text x="{x:g}" y="{y:g}" text-anchor="middle" font-size="{s:g}">{label}</text>')
        draw.text((round(x * PPM), round(y * PPM)), label, font=font(round(s * PPM)), anchor="ms", fill="#333333")
    # Independent horizontal and vertical 100 mm rulers detect print scaling.
    parts += ['<g stroke="black" stroke-width="0.18" fill="none">', '<path d="M98.5 202H198.5 M290 55V155"/>']
    draw.line((985, 2020, 1985, 2020), fill="black", width=2)
    draw.line((2900, 550, 2900, 1550), fill="black", width=2)
    for t in range(0, 101, 5):
        tick = 2 if t % 10 == 0 else 1
        parts.append(f'<path d="M{98.5+t:g} 202v{-tick:g} M290 {55+t:g}h{-tick:g}"/>')
        draw.line((round((98.5 + t) * PPM), 2020, round((98.5 + t) * PPM), round((202 - tick) * PPM)), fill="black", width=2)
        draw.line((2900, (55 + t) * PPM, round((290 - tick) * PPM), (55 + t) * PPM), fill="black", width=2)
    parts += ['</g>', '<text x="148.5" y="206" text-anchor="middle" class="small">Check length: 100 mm</text>',
              '<text x="286" y="105" text-anchor="middle" class="small" transform="rotate(-90 286 105)">Check length: 100 mm</text>', '</svg>']
    draw.text((1485, 2060), "Check length: 100 mm", font=font(23), anchor="ms", fill="#333333")
    vertical_label = Image.new("RGBA", (380, 38), (255, 255, 255, 0))
    ImageDraw.Draw(vertical_label).text((190, 19), "Check length: 100 mm", font=font(23), anchor="mm", fill="#333333")
    vertical_label = vertical_label.rotate(90, expand=True)
    page.paste(vertical_label, (2841, 860), vertical_label)
    (PRINT / "a4-marker-sheet.svg").write_text("\n".join(parts))
    page.save(PRINT / "a4-marker-sheet.png", dpi=(254, 254), optimize=True)
    write_json(PRINT / "geometry.json", {
        "page_mm": [PAGE_W, PAGE_H], "board_mm": [BOARD_W, BOARD_H],
        "board_origin_page_mm": ORIGIN.tolist(), "dictionary": "DICT_4X4_50",
        "marker_side_mm": MARKER_MM, "reference_corner_indices": INNER_INDEX,
        "reference_points_page_mm": [[23.5, 20], [273.5, 20], [273.5, 190], [23.5, 190]],
        "marker_corners_page_mm": [p.tolist() for p in page_markers_mm()],
        "print_instructions": "A4 landscape, actual size 100%, no fit/shrink; verify both 100 mm rulers physically."
    })
    return page


def ring_area(points):
    p = np.asarray(points)
    return abs(float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))) / 2


def vertices(points):
    return [{"id": i + 1, "x": float(p[0]), "y": float(p[1])} for i, p in enumerate(points)]


def edges(points):
    return [{"from": i + 1, "to": (i + 1) % len(points) + 1,
             "length_mm": math.dist(p, points[(i + 1) % len(points)]),
             "angle_deg": math.degrees(math.atan2(points[(i + 1) % len(points)][1] - p[1], points[(i + 1) % len(points)][0] - p[0]))}
            for i, p in enumerate(points)]


def transform_points(points, matrix):
    return cv2.perspectiveTransform(np.array(points, np.float64)[None], matrix)[0].tolist()


def load_ai_textures():
    """Load immutable generated material maps; verify bytes before rendering.

    The image model generated surface appearance only. Markers, silhouettes,
    calibration, perspective, and masks are produced by this deterministic code.
    """
    assets = ROOT / "assets"
    bundle = json.loads((assets / "ai-steel-textures.json").read_text())
    provenance = json.loads((assets / "ai-steel-provenance.json").read_text())
    if bundle.get("schema_version") != 1:
        raise ValueError("Unsupported AI texture bundle schema")
    textures = {}
    for entry in bundle["textures"]:
        data = base64.b64decode(entry["base64"], validate=True)
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"AI texture hash mismatch: {entry['id']}")
        textures[entry["id"]] = Image.open(io.BytesIO(data)).convert("RGB")
    if set(textures) != {"l-shape", "notched", "trapezoid-hole"}:
        raise ValueError("Expected the three versioned AI steel texture assets")
    write_json(SAMPLES / "ai-texture-provenance.json", provenance)
    return textures


def create_sample(page, name, title, outer, holes, quad, seed, analytic_area=None, ai_texture=None):
    rng = np.random.default_rng(seed)
    width, height = page.size
    mask = Image.new("L", page.size, 0)
    draw = ImageDraw.Draw(mask)
    def page_polygon(points):
        return [tuple(((np.asarray(p) + ORIGIN) * PPM).tolist()) for p in points]
    draw.polygon(page_polygon(outer), fill=255)
    for hole in holes:
        draw.polygon(page_polygon(hole), fill=0)
    yy, xx = np.mgrid[:height, :width].astype(np.float32)
    base = 103 + 23 * xx / width + 12 * np.sin(yy / 170)
    # Reflection remains within the physical silhouette; deliberately not uniform.
    reflection = 62 * np.exp(-((xx - (0.8 * yy + width * 0.21)) / (width * 0.08)) ** 2)
    grain = rng.normal(0, 1.2, (height, width)).astype(np.float32)
    steel = np.stack([base + reflection + grain - 3, base + reflection + grain + 3, base + reflection + grain + 7], axis=-1)
    steel_img = Image.fromarray(np.uint8(np.clip(steel, 0, 255)))
    scratch = ImageDraw.Draw(steel_img)
    for _ in range(75):
        x, y = rng.integers(350, width - 350), rng.integers(250, height - 250)
        length = int(rng.integers(20, 280))
        shade = int(rng.integers(80, 180))
        scratch.line((int(x), int(y), int(x + length), int(y - length * 0.21)), fill=(shade, shade + 4, min(255, shade + 8)), width=int(rng.integers(1, 4)))
    if ai_texture is not None:
        # Material mapping in the geometric fixture renderer. This is not an
        # image-model claim about exact physical dimensions or marker validity.
        x0, y0, x1, y1 = mask.getbbox()
        steel_img = Image.new("RGB", page.size)
        steel_img.paste(ai_texture.resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS), (x0, y0))
    rendered = page.copy()
    # Small contact shadow is intentionally an image challenge, not geometry truth.
    shadow = mask.filter(ImageFilter.GaussianBlur(5))
    shifted = Image.new("L", page.size, 0)
    shifted.paste(shadow, (5, 7))
    rendered.paste(Image.new("RGB", page.size, "#bab9b3"), mask=shifted)
    rendered.paste(steel_img, mask=mask)
    arr = np.array(rendered).astype(np.float32)
    illumination = 0.91 + 0.07 * xx / width + 0.02 * yy / height
    arr = np.uint8(np.clip(arr * illumination[..., None], 0, 255))
    photo_w, photo_h = 1800, 1350
    H = cv2.getPerspectiveTransform(np.float32([[0, 0], [width, 0], [width, height], [0, height]]), np.float32(quad))
    by, bx = np.mgrid[:photo_h, :photo_w]
    wood = 111 + 9 * np.sin(by / 17) + 4 * np.sin((by + bx * 0.018) / 4)
    background = np.uint8(np.clip(np.stack([wood + 17, wood + 3, wood - 17], axis=-1), 0, 255))
    warped = cv2.warpPerspective(arr, H, (photo_w, photo_h), flags=cv2.INTER_LINEAR)
    paper_mask = cv2.warpPerspective(np.full((height, width), 255, np.uint8), H, (photo_w, photo_h), flags=cv2.INTER_LINEAR)
    alpha = paper_mask[..., None].astype(np.float32) / 255
    photo = np.uint8(warped * alpha + background * (1 - alpha))
    photo = cv2.GaussianBlur(photo, (3, 3), 0.35)
    photo_extension = "jpg" if ai_texture is not None else "png"
    photo_path = SAMPLES / f"{name}.{photo_extension}"
    if ai_texture is not None:
        Image.fromarray(photo).save(photo_path, quality=91, optimize=True, progressive=True)
        # Verify the actual delivered JPEG pixels, including compression.
        photo = np.array(Image.open(photo_path).convert("RGB"))
    else:
        Image.fromarray(photo).save(photo_path, optimize=True)
    board_mask = mask.crop((235, 200, 2735, 1900))
    board_mask.save(SAMPLES / f"{name}.mask.png", optimize=True)
    # This image is a diagnostic reference only, not used to shortcut detection.
    Image.fromarray(arr).crop((235, 200, 2735, 1900)).save(SAMPLES / f"{name}.rectified.png", optimize=True)
    source_points = [np.asarray(p) * PPM for p in page_markers_mm()]
    marker_camera = [transform_points(p, H) for p in source_points]
    reference_camera = [marker_camera[i][INNER_INDEX[i]] for i in range(4)]
    pixel_from_mm = H @ np.array([[PPM, 0, ORIGIN[0] * PPM], [0, PPM, ORIGIN[1] * PPM], [0, 0, 1]], float)
    geometry_area = ring_area(outer) - sum(ring_area(h) for h in holes)
    truth = {"schema_version": 1, "synthetic": True, "name": name, "title": title,
        "preset_mode": "A4_LANDSCAPE_250x170", "board_size_mm": {"width_mm": 250, "height_mm": 170},
        "scale_mm_per_px": 0.1, "shape_type": name,
        "outer_vertices_mm": vertices(outer), "holes_vertices_mm": [vertices(h) for h in holes],
        "edges_mm": edges(outer), "hole_edges_mm": [edges(h) for h in holes],
        "total_area_mm2": geometry_area,
        "analytic_area_mm2": analytic_area if analytic_area is not None else geometry_area,
        "dictionary": "DICT_4X4_50", "marker_side_mm": MARKER_MM,
        "marker_corners_image_px": [{"id": i, "corners": p} for i, p in enumerate(marker_camera)],
        "reference_points_image_px": reference_camera,
        "homography_board_mm_to_image_px": pixel_from_mm.tolist(),
        "homography_image_px_to_board_mm": np.linalg.inv(pixel_from_mm).tolist(),
        "photo_size_px": [photo_w, photo_h], "seed": seed,
        "mask_path": f"samples/{name}.mask.png", "rectified_path": f"samples/{name}.rectified.png",
        "limitations": ["Synthetic planar scene; no lens distortion or real manufacturing uncertainty.",
            "The circle is represented by a 128-sided polygon; analytic circle area is stored separately.",
            "Use photo pixels for detection/inference; ground truth is for evaluation only."]}
    if ai_texture is not None:
        truth.update({
            "shape_type": name.removeprefix("ai-"),
            "fixture_kind": "ai-texture-composite",
            "appearance_source": "AI-generated steel texture + controlled geometric composite",
            "texture_id": name.removeprefix("ai-"),
            "texture_provenance_path": "samples/ai-texture-provenance.json",
        })
        truth["limitations"].append("AI generation supplies steel appearance only; this is not an untouched AI photograph or a camera capture. Board, valid markers, silhouette, contact shadow, table, and perspective are controlled renderer output.")
    write_json(SAMPLES / f"{name}.truth.json", truth)
    detector = cv2.aruco.ArucoDetector(DICTIONARY)
    corners, ids, _ = detector.detectMarkers(photo)
    got = sorted(ids.flatten().tolist()) if ids is not None else []
    if got != [0, 1, 2, 3]:
        raise RuntimeError(f"{name}: ArUco detection must find exactly IDs0..3, got {got}")
    errors = []
    for detected, marker_id in zip(corners, ids.flatten()):
        errors.extend(np.linalg.norm(detected[0] - np.array(marker_camera[marker_id]), axis=1).tolist())
    result = {"id": name, "title": title, "image": f"samples/{name}.{photo_extension}", "truth": f"samples/{name}.truth.json",
            "mask": f"samples/{name}.mask.png", "area_mm2": geometry_area,
            "marker_detection_verified": got, "marker_corner_max_error_px": max(errors),
            "marker_corner_rms_error_px": float(np.sqrt(np.mean(np.square(errors))))}
    if ai_texture is not None:
        result.update({"fixture_kind": "ai-texture-composite", "synthetic": True,
                       "appearance_source": "AI-generated steel texture + controlled geometric composite",
                       "texture_id": name.removeprefix("ai-"),
                       "texture_provenance": "samples/ai-texture-provenance.json"})
    return result


def main():
    SAMPLES.mkdir(parents=True, exist_ok=True)
    page = create_print_sheet()
    circle = [[125 + 20 * math.cos(-2 * math.pi * i / 128), 86 + 20 * math.sin(-2 * math.pi * i / 128)] for i in range(128)]
    outer_trap = [[65, 30], [185, 30], [215, 140], [35, 140]]
    definitions = [
        ("l-shape", "L字型 / scratches", [[35,25],[185,25],[185,80],[105,80],[105,145],[35,145]], [], [[145,138],[1605,75],[1690,1195],[85,1250]], 451, None),
        ("notched", "凹型 / uneven light", [[35,30],[90,30],[90,85],[155,85],[155,30],[215,30],[215,140],[35,140]], [], [[220,60],[1650,195],[1555,1260],[70,1110]], 921, None),
        ("trapezoid-hole", "台形 + 丸穴 / reflection", outer_trap, [circle], [[120,205],[1570,70],[1715,1130],[225,1280]], 173, 16500 - math.pi * 20 ** 2),
    ]
    report = [create_sample(page, *definition) for definition in definitions]
    textures = load_ai_textures()
    for definition in definitions:
        name, title, *geometry = definition
        report.append(create_sample(page, f"ai-{name}", f"AI texture / {title}", *geometry, ai_texture=textures[name]))
    write_json(SAMPLES / "index.json", report)
    write_json(SAMPLES / "generation-report.json", {
        "generator": "OpenCV + Pillow synthetic fixtures; optional AI-generated material maps",
        "opencv_version": cv2.__version__, "ai_texture_provenance": "samples/ai-texture-provenance.json",
        "samples": report})
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
