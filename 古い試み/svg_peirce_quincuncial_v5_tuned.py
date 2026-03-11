#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np
from fontTools.pens.recordingPen import RecordingPen
from fontTools.svgLib.path import parse_path
from lxml import etree
from pyproj import CRS, Transformer
from scipy.ndimage import binary_dilation, binary_closing, distance_transform_edt

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
NSMAP = {"svg": SVG_NS}
PT = Tuple[float, float]


# ---------- basic helpers ----------

def localname(tag: str) -> str:
    return etree.QName(tag).localname if isinstance(tag, str) and tag.startswith("{") else tag


def parse_floats(text: str) -> List[float]:
    return [float(x) for x in re.findall(r"[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?", text or "")]


def format_num(x: float) -> str:
    if not math.isfinite(x):
        return "0"
    s = f"{x:.6f}".rstrip("0").rstrip(".")
    return s if s and s != "-0" else "0"


def distance(a: PT, b: PT) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def lerp(a: PT, b: PT, t: float) -> PT:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def quad_bezier(p0: PT, p1: PT, p2: PT, t: float) -> PT:
    u = 1 - t
    return (
        u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    )


def cubic_bezier(p0: PT, p1: PT, p2: PT, p3: PT, t: float) -> PT:
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
    )


def densify_line(p0: PT, p1: PT, max_seg: float) -> List[PT]:
    n = max(1, int(math.ceil(distance(p0, p1) / max_seg)))
    return [lerp(p0, p1, i / n) for i in range(n + 1)]


def densify_quad(p0: PT, p1: PT, p2: PT, max_seg: float, min_steps: int) -> List[PT]:
    ctrl_len = distance(p0, p1) + distance(p1, p2)
    n = max(min_steps, int(math.ceil(ctrl_len / max_seg)))
    return [quad_bezier(p0, p1, p2, i / n) for i in range(n + 1)]


def densify_cubic(p0: PT, p1: PT, p2: PT, p3: PT, max_seg: float, min_steps: int) -> List[PT]:
    ctrl_len = distance(p0, p1) + distance(p1, p2) + distance(p2, p3)
    n = max(min_steps, int(math.ceil(ctrl_len / max_seg)))
    return [cubic_bezier(p0, p1, p2, p3, i / n) for i in range(n + 1)]


def parse_transform_to_matrix(transform: Optional[str]):
    m = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    if not transform:
        return m
    for name, args_str in re.findall(r"([A-Za-z]+)\s*\(([^)]*)\)", transform):
        vals = parse_floats(args_str)
        if name == "matrix" and len(vals) >= 6:
            t = tuple(vals[:6])
        elif name == "translate":
            tx = vals[0] if len(vals) >= 1 else 0.0
            ty = vals[1] if len(vals) >= 2 else 0.0
            t = (1.0, 0.0, 0.0, 1.0, tx, ty)
        elif name == "scale":
            sx = vals[0] if len(vals) >= 1 else 1.0
            sy = vals[1] if len(vals) >= 2 else sx
            t = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        elif name == "rotate":
            ang = math.radians(vals[0] if vals else 0.0)
            ca, sa = math.cos(ang), math.sin(ang)
            if len(vals) >= 3:
                cx, cy = vals[1], vals[2]
                t = multiply_matrix((1, 0, 0, 1, cx, cy), multiply_matrix((ca, sa, -sa, ca, 0, 0), (1, 0, 0, 1, -cx, -cy)))
            else:
                t = (ca, sa, -sa, ca, 0.0, 0.0)
        elif name == "skewX":
            ang = math.radians(vals[0] if vals else 0.0)
            t = (1.0, 0.0, math.tan(ang), 1.0, 0.0, 0.0)
        elif name == "skewY":
            ang = math.radians(vals[0] if vals else 0.0)
            t = (1.0, math.tan(ang), 0.0, 1.0, 0.0, 0.0)
        else:
            continue
        m = multiply_matrix(m, t)
    return m


def multiply_matrix(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def apply_matrix(m, p: PT) -> PT:
    a, b, c, d, e, f = m
    x, y = p
    return (a * x + c * y + e, b * x + d * y + f)


@dataclass
class GeomRecord:
    kind: str
    order: int
    subpaths: List[Tuple[List[PT], bool]] = field(default_factory=list)
    text_anchor: Optional[PT] = None
    is_empty_text: bool = False
    attrs: dict = field(default_factory=dict)


# ---------- SVG / source geometry helpers ----------

def find_map_frame(root) -> Tuple[float, float, float, float]:
    rects = []
    for r in root.xpath('.//svg:rect', namespaces=NSMAP):
        try:
            x = float(r.get('x', '0')); y = float(r.get('y', '0'))
            w = float(r.get('width')); h = float(r.get('height'))
        except Exception:
            continue
        if w <= 0 or h <= 0:
            continue
        ratio = w / h
        score = w * h * (10 if 1.85 <= ratio <= 2.15 else 1)
        rects.append((score, (x, y, x + w, y + h)))
    if rects:
        rects.sort(key=lambda x: x[0], reverse=True)
        return rects[0][1]
    vb = parse_floats(root.get('viewBox', ''))
    if len(vb) == 4:
        return (vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3])
    return (0.0, 0.0, float(root.get('width')), float(root.get('height')))


def get_root_viewbox(root) -> Tuple[float, float, float, float]:
    vb = parse_floats(root.get('viewBox', ''))
    if len(vb) == 4:
        return tuple(vb)
    w = float(root.get('width'))
    h = float(root.get('height'))
    return (0.0, 0.0, w, h)


def convert_source_to_lonlat(p: PT, frame: Tuple[float, float, float, float], reverse_east_west: bool=False) -> Tuple[float, float]:
    x0, y0, x1, y1 = frame
    if reverse_east_west:
        lon = 180.0 - (p[0] - x0) * 360.0 / (x1 - x0)
    else:
        lon = -180.0 + (p[0] - x0) * 360.0 / (x1 - x0)
    lat = 90.0 - (p[1] - y0) * 180.0 / (y1 - y0)
    return lon, lat


def convert_lonlat_to_source(lon, lat, frame: Tuple[float, float, float, float], reverse_east_west: bool=False):
    x0, y0, x1, y1 = frame
    if reverse_east_west:
        x = x0 + (180.0 - lon) * (x1 - x0) / 360.0
    else:
        x = x0 + (lon + 180.0) * (x1 - x0) / 360.0
    y = y0 + (90.0 - lat) * (y1 - y0) / 180.0
    return x, y


def sample_path_d(d: str, max_seg: float, curve_steps: int) -> List[Tuple[List[PT], bool]]:
    pen = RecordingPen(); parse_path(d, pen)
    subpaths = []; current = []; start = None; curr = None
    for op, pts in pen.value:
        if op == 'moveTo':
            if current: subpaths.append((current, False))
            start = pts[0]; curr = start; current = [curr]
        elif op == 'lineTo':
            p1 = pts[0]; seg = densify_line(curr, p1, max_seg); current.extend(seg[1:]); curr = p1
        elif op == 'qCurveTo' and len(pts) >= 2:
            p1, p2 = pts[0], pts[1]; seg = densify_quad(curr, p1, p2, max_seg, curve_steps); current.extend(seg[1:]); curr = p2
        elif op == 'curveTo':
            p1, p2, p3 = pts[0], pts[1], pts[2]; seg = densify_cubic(curr, p1, p2, p3, max_seg, curve_steps); current.extend(seg[1:]); curr = p3
        elif op == 'closePath':
            if current: subpaths.append((current, True))
            current = []; curr = start = None
        elif op == 'endPath':
            if current: subpaths.append((current, False))
            current = []; curr = start = None
    if current: subpaths.append((current, False))
    return subpaths


def parse_points_attr(text: str) -> List[PT]:
    vals = parse_floats(text)
    return [(vals[i], vals[i+1]) for i in range(0, len(vals)-1, 2)]


def sample_line_points(points: List[PT], closed: bool, max_seg: float) -> List[Tuple[List[PT], bool]]:
    if not points:
        return []
    result = [points[0]]
    for i in range(1, len(points)):
        seg = densify_line(points[i-1], points[i], max_seg)
        result.extend(seg[1:])
    if closed and len(points) > 2:
        seg = densify_line(points[-1], points[0], max_seg)
        result.extend(seg[1:])
    return [(result, closed)]


def sample_element_geometry(el, max_seg: float, curve_steps: int) -> List[Tuple[List[PT], bool]]:
    tag = localname(el.tag)
    if tag == 'path':
        return sample_path_d(el.get('d', ''), max_seg, curve_steps)
    if tag == 'line':
        return sample_line_points([(float(el.get('x1')), float(el.get('y1'))), (float(el.get('x2')), float(el.get('y2')))], False, max_seg)
    if tag == 'polyline':
        return sample_line_points(parse_points_attr(el.get('points', '')), False, max_seg)
    if tag == 'polygon':
        return sample_line_points(parse_points_attr(el.get('points', '')), True, max_seg)
    if tag == 'rect':
        x = float(el.get('x', '0')); y = float(el.get('y', '0')); w = float(el.get('width')); h = float(el.get('height'))
        return sample_line_points([(x, y), (x+w, y), (x+w, y+h), (x, y+h)], True, max_seg)
    return []


def get_text_anchor(el) -> Optional[PT]:
    tr = el.get('transform')
    if tr:
        return apply_matrix(parse_transform_to_matrix(tr), (0.0, 0.0))
    if 'x' in el.attrib or 'y' in el.attrib:
        return (float(el.get('x', '0').split()[0]), float(el.get('y', '0').split()[0]))
    first_tspan = el.find(f'{{{SVG_NS}}}tspan')
    if first_tspan is not None and ('x' in first_tspan.attrib or 'y' in first_tspan.attrib):
        return (float(first_tspan.get('x', '0').split()[0]), float(first_tspan.get('y', '0').split()[0]))
    return None


def is_empty_text(el) -> bool:
    return ''.join(el.itertext()).strip() == ''


def list_relevant_elements(root) -> List:
    return [el for el in root.iter() if localname(el.tag) in {'path', 'rect', 'line', 'polyline', 'polygon', 'text'}]


def extract_records(root, max_seg: float, curve_steps: int) -> List[GeomRecord]:
    records = []
    order = 0
    for el in list_relevant_elements(root):
        tag = localname(el.tag)
        if tag in {'path', 'rect', 'line', 'polyline', 'polygon'}:
            order += 1
            records.append(GeomRecord('geometry', order, sample_element_geometry(el, max_seg, curve_steps), attrs=dict(el.attrib)))
        elif tag == 'text':
            order += 1
            records.append(GeomRecord('text', order, text_anchor=get_text_anchor(el), is_empty_text=is_empty_text(el), attrs=dict(el.attrib)))
    return records


# ---------- projection helpers ----------

def safe_transform(transformer: Transformer, lon: float, lat: float) -> Optional[PT]:
    try:
        x, y = transformer.transform(lon, lat)
    except Exception:
        return None
    return (x, y) if math.isfinite(x) and math.isfinite(y) else None


def make_transformer(lon0: float, shape: str) -> Transformer:
    crs = CRS.from_proj4(f'+proj=peirce_q +lon_0={lon0} +shape={shape}')
    return Transformer.from_crs('EPSG:4326', crs, always_xy=True)


def make_inv_transformer(lon0: float, shape: str) -> Transformer:
    crs = CRS.from_proj4(f'+proj=peirce_q +lon_0={lon0} +shape={shape}')
    return Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)


def compute_bbox_from_source_frame(frame, transformer, reverse_east_west=False, edge_steps=720, lat_steps=360):
    x0, y0, x1, y1 = frame
    pts = []
    for i in range(edge_steps + 1):
        t = i / edge_steps
        pts.append((x0 + (x1 - x0) * t, y0))
        pts.append((x0 + (x1 - x0) * t, y1))
    for i in range(lat_steps + 1):
        t = i / lat_steps
        pts.append((x0, y0 + (y1 - y0) * t))
        pts.append((x1, y0 + (y1 - y0) * t))
    xs, ys = [], []
    for p in pts:
        lon, lat = convert_source_to_lonlat(p, frame, reverse_east_west=reverse_east_west)
        q = safe_transform(transformer, lon, lat)
        if q is not None:
            xs.append(q[0]); ys.append(q[1])
    if not xs:
        raise RuntimeError('No finite projected coordinates found.')
    return min(xs), min(ys), max(xs), max(ys)


def make_scaler(src_bbox, target_size: float, flip_x: bool):
    minx, miny, maxx, maxy = src_bbox
    w = maxx - minx; h = maxy - miny
    if w <= 0 or h <= 0:
        raise RuntimeError('Degenerate projected bounding box.')
    scale = target_size / max(w, h)
    def f(p: PT) -> PT:
        x = (maxx - p[0]) if flip_x else (p[0] - minx)
        return (x * scale, (p[1] - miny) * scale)
    return f, w * scale, h * scale, scale


def split_large_jumps(points: List[Optional[PT]], scaler, jump_threshold: float) -> List[List[PT]]:
    chunks = []; current = []; prev = None
    for p in points:
        if p is None:
            if len(current) >= 2:
                chunks.append(current)
            current = []; prev = None; continue
        sp = scaler(p)
        if prev is not None and distance(prev, sp) > jump_threshold:
            if len(current) >= 2:
                chunks.append(current)
            current = [sp]
        else:
            current.append(sp)
        prev = sp
    if len(current) >= 2:
        chunks.append(current)
    return chunks


def chunks_to_path_d(chunks: List[Tuple[List[PT], bool]]) -> str:
    parts = []
    for pts, closed in chunks:
        if not pts:
            continue
        parts.append(f"M {format_num(pts[0][0])} {format_num(pts[0][1])}")
        for p in pts[1:]:
            parts.append(f"L {format_num(p[0])} {format_num(p[1])}")
        if closed and len(pts) >= 3:
            parts.append('Z')
    return ' '.join(parts)


def transform_subtree(root, frame, transformer, scaler, jump_threshold, reverse_east_west=False, keep_geometry=True, keep_text=True):
    elements = list_relevant_elements(root)
    records = extract_records(root, 3.0, 24)
    if len(elements) != len(records):
        raise RuntimeError('Element/record count mismatch.')
    for el, rec in zip(elements, records):
        parent = el.getparent()
        if rec.kind == 'geometry':
            if not keep_geometry:
                if parent is not None:
                    parent.remove(el)
                continue
            all_chunks = []
            for src_pts, closed in rec.subpaths:
                proj = []
                for p in src_pts:
                    lon, lat = convert_source_to_lonlat(p, frame, reverse_east_west=reverse_east_west)
                    proj.append(safe_transform(transformer, lon, lat))
                chunks = split_large_jumps(proj, scaler, jump_threshold)
                if closed and len(chunks) == 1 and len(chunks[0]) >= 3:
                    all_chunks.append((chunks[0], True))
                else:
                    all_chunks.extend((ch, False) for ch in chunks)
            new_d = chunks_to_path_d(all_chunks)
            if localname(el.tag) != 'path':
                new_el = etree.Element(f'{{{SVG_NS}}}path')
                for k, v in el.attrib.items():
                    if k not in {'x','y','x1','y1','x2','y2','width','height','points'}:
                        new_el.set(k, v)
                new_el.set('d', new_d)
                idx = parent.index(el); parent.remove(el); parent.insert(idx, new_el)
            else:
                el.set('d', new_d)
        elif rec.kind == 'text':
            if not keep_text or rec.is_empty_text:
                if parent is not None:
                    parent.remove(el)
                continue
            if rec.text_anchor is None:
                continue
            lon, lat = convert_source_to_lonlat(rec.text_anchor, frame, reverse_east_west=reverse_east_west)
            q = safe_transform(transformer, lon, lat)
            if q is None:
                if parent is not None:
                    parent.remove(el)
                continue
            x, y = scaler(q)
            el.set('transform', f'translate({format_num(x)} {format_num(y)})')
            if 'x' in el.attrib:
                el.set('x', '0')
            if 'y' in el.attrib:
                el.set('y', '0')
    for t in list(root.xpath('.//svg:text', namespaces=NSMAP)):
        if ''.join(t.itertext()).strip() == '' and len(t) == 0:
            p = t.getparent()
            if p is not None:
                p.remove(t)


def remove_group_by_id(root, gid: str):
    node = root.xpath(f'.//svg:g[@id="{gid}"]', namespaces=NSMAP)
    for g in node:
        p = g.getparent()
        if p is not None:
            p.remove(g)


def get_group_copy(root, gid: str):
    node = root.xpath(f'./svg:g[@id="{gid}"]', namespaces=NSMAP)
    if node:
        return copy.deepcopy(node[0])
    return None


# ---------- fill parsing / vectorization ----------

def parse_css_class_fill_map(root) -> Dict[str, str]:
    style = root.find('.//svg:style', namespaces=NSMAP)
    if style is None or not style.text:
        return {}
    out: Dict[str, str] = {}
    for m in re.finditer(r'\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}', style.text, re.S):
        cls = m.group(1)
        body = m.group(2)
        mm = re.search(r'fill\s*:\s*([^;]+);', body)
        if mm:
            out[cls] = mm.group(1).strip()
    return out


def norm_hex_color(c: str) -> str:
    c = c.strip()
    if not c.startswith('#'):
        return c
    if len(c) == 4:
        return '#' + ''.join(ch * 2 for ch in c[1:])
    return c.lower()


def discover_fill_palette(root):
    class_fill = parse_css_class_fill_map(root)
    sea_rects = root.xpath('./svg:g[@id="_海"]//svg:rect', namespaces=NSMAP)
    if not sea_rects:
        raise RuntimeError('Could not find sea layer rect.')
    sea_class = sea_rects[0].get('class')
    sea_color = norm_hex_color(class_fill.get(sea_class, '#556fb5'))

    band_groups = root.xpath('./svg:g[@id="_分高面"]/svg:g', namespaces=NSMAP)
    if not band_groups:
        raise RuntimeError('Could not find elevation band groups.')

    band_infos = []
    for g in band_groups:
        cnt: Dict[str, int] = {}
        for el in g.iter():
            cls = el.get('class')
            if cls:
                cnt[cls] = cnt.get(cls, 0) + 1
        if not cnt:
            continue
        band_class = max(cnt.items(), key=lambda kv: kv[1])[0]
        band_color = norm_hex_color(class_fill.get(band_class))
        band_infos.append({
            'id': g.get('id') or f'band_{len(band_infos)+1}',
            'name': g.get('data-name') or g.get('id') or f'band_{len(band_infos)+1}',
            'class': band_class,
            'color': band_color,
        })
    if not band_infos:
        raise RuntimeError('Could not derive elevation band colors.')
    return sea_color, band_infos


def hex_to_rgba(c: str) -> Tuple[int, int, int, int]:
    c = norm_hex_color(c)
    if len(c) == 7:
        return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)
    raise ValueError(f'Unsupported color: {c}')


def find_inkscape_executable() -> str | None:
    import os
    import shutil

    candidates = [
        shutil.which('inkscape.com'),
        shutil.which('inkscape.exe'),
        shutil.which('inkscape'),
        r'C:\Program Files\Inkscape\bin\inkscape.com',
        r'C:\Program Files\Inkscape\bin\inkscape.exe',
        r'C:\Program Files\Inkscape\inkscape.com',
        r'C:\Program Files\Inkscape\inkscape.exe',
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def render_svg_png(root, out_png: Path, png_width: int):
    vb = get_root_viewbox(root)
    vbw, vbh = vb[2], vb[3]
    png_height = max(1, int(round(png_width * vbh / vbw)))
    svg_bytes = etree.tostring(root, encoding='utf-8', xml_declaration=True)

    try:
        import cairosvg
        cairosvg.svg2png(bytestring=svg_bytes, write_to=str(out_png), output_width=png_width, output_height=png_height)
        return png_width, png_height, vb
    except Exception as e:
        inkscape = find_inkscape_executable()
        if not inkscape:
            raise RuntimeError(
                'SVG rasterization failed via CairoSVG, and Inkscape CLI was not found. '
                'Either install cairo (libcairo-2.dll) or install Inkscape and ensure inkscape.exe/com is available.'
            ) from e

        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory(prefix='pq_svg_') as td:
            tmp_svg = Path(td) / 'input.svg'
            tmp_svg.write_bytes(svg_bytes)
            cmd = [
                inkscape,
                '--export-type=png',
                f'--export-filename={str(out_png)}',
                f'--export-width={png_width}',
                str(tmp_svg),
            ]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if proc.returncode != 0 or (not out_png.exists()):
                raise RuntimeError(
                    'SVG rasterization failed via CairoSVG and Inkscape CLI.\n'
                    f'Inkscape command: {cmd}\n'
                    f'returncode={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}'
                ) from e
        return png_width, png_height, vb


def quantize_rgba_to_palette(img_rgba: np.ndarray, palette_rgba: np.ndarray, alpha_cutoff: int = 32) -> np.ndarray:
    rgb = img_rgba[:, :, :3].astype(np.int16)
    flat = rgb.reshape(-1, 3)
    pal = palette_rgba[:, :3].astype(np.int16)
    d = ((flat[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2)
    idx = np.argmin(d, axis=1).astype(np.uint8).reshape(img_rgba.shape[:2])
    idx[img_rgba[:, :, 3] < alpha_cutoff] = 0
    return idx


def warp_palette_index(src_idx: np.ndarray, frame, src_viewbox, inv_transformer, bbox, world_scale,
                       out_svg_w: float, out_svg_h: float, reverse_east_west=False,
                       raster_max_dim: int = 3200, flip_x: bool = True, chunk_rows: int = 128,
                       invalid_fill_mode: str = "nearest") -> Tuple[np.ndarray, float]:
    src_h, src_w = src_idx.shape
    vb_x, vb_y, vb_w, vb_h = src_viewbox
    img_scale = raster_max_dim / max(out_svg_w, out_svg_h)
    out_w = max(1, int(round(out_svg_w * img_scale)))
    out_h = max(1, int(round(out_svg_h * img_scale)))
    out = np.full((out_h, out_w), 255, dtype=np.uint8)
    valid = np.zeros((out_h, out_w), dtype=bool)

    minx, miny, maxx, maxy = bbox
    x_svg = (np.arange(out_w, dtype=np.float64) + 0.5) / img_scale
    y_svg_all = (np.arange(out_h, dtype=np.float64) + 0.5) / img_scale

    for r0 in range(0, out_h, chunk_rows):
        r1 = min(out_h, r0 + chunk_rows)
        yy = y_svg_all[r0:r1]
        xx = np.tile(x_svg[None, :], (len(yy), 1))
        yy2 = np.tile(yy[:, None], (1, out_w))

        if flip_x:
            proj_x = maxx - xx / world_scale
        else:
            proj_x = minx + xx / world_scale
        proj_y = miny + yy2 / world_scale

        lon, lat = inv_transformer.transform(proj_x, proj_y)
        ok = np.isfinite(lon) & np.isfinite(lat) & (lat >= -90.0001) & (lat <= 90.0001)

        chunk = np.full((r1 - r0, out_w), 255, dtype=np.uint8)
        if np.any(ok):
            lon_ok = ((lon[ok] + 180.0) % 360.0) - 180.0
            lat_ok = lat[ok]
            src_x_ok, src_y_ok = convert_lonlat_to_source(lon_ok, lat_ok, frame, reverse_east_west=reverse_east_west)

            sx_ok = (src_x_ok - vb_x) * (src_w / vb_w)
            sy_ok = (src_y_ok - vb_y) * (src_h / vb_h)
            ok2 = (sx_ok >= 0) & (sx_ok < src_w) & (sy_ok >= 0) & (sy_ok < src_h)

            valid_chunk = np.zeros_like(ok)
            valid_idx = np.flatnonzero(ok)
            if np.any(ok2):
                good_flat = valid_idx[ok2]
                valid_chunk.flat[good_flat] = True
                sx_i = np.clip(np.rint(sx_ok[ok2]).astype(np.int32), 0, src_w - 1)
                sy_i = np.clip(np.rint(sy_ok[ok2]).astype(np.int32), 0, src_h - 1)
                chunk.flat[good_flat] = src_idx[sy_i, sx_i]
            ok = valid_chunk

        valid[r0:r1] = ok
        out[r0:r1] = chunk

    if invalid_fill_mode == 'nearest' and np.any(~valid) and np.any(valid):
        inds = distance_transform_edt(~valid, return_distances=False, return_indices=True)
        out[~valid] = out[inds[0][~valid], inds[1][~valid]]
    elif invalid_fill_mode == 'sea':
        out[~valid] = 0
    return out, img_scale


def contour_mask_to_paths(mask: np.ndarray, svg_scale: float, epsilon_px: float = 1.0,
                          min_area_px: float = 2.0, dilate_px: int = 1, close_px: int = 0) -> str:
    if dilate_px > 0:
        mask = binary_dilation(mask, iterations=dilate_px)
    if close_px > 0:
        mask = binary_closing(mask, iterations=close_px)
    img = (mask.astype(np.uint8) * 255)
    contours, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    parts: List[str] = []
    for c in contours:
        if len(c) < 3:
            continue
        area = abs(cv2.contourArea(c))
        if area < min_area_px:
            continue
        approx = cv2.approxPolyDP(c, epsilon_px, True)
        if len(approx) < 3:
            continue
        pts = approx[:, 0, :].astype(float)
        parts.append(f"M {format_num(pts[0,0] / svg_scale)} {format_num(pts[0,1] / svg_scale)}")
        for x, y in pts[1:]:
            parts.append(f"L {format_num(x / svg_scale)} {format_num(y / svg_scale)}")
        parts.append('Z')
    return ' '.join(parts)


def build_vector_fill_group(index_img: np.ndarray, img_scale: float, sea_color: str, band_infos: List[Dict[str, str]],
                            dilate_px: int, epsilon_px: float, min_area_px: float, close_px: int,
                            out_svg_w: float, out_svg_h: float):
    container = etree.Element(f'{{{SVG_NS}}}g')
    container.set('id', '_ベクタ分高面')
    sea = etree.SubElement(container, f'{{{SVG_NS}}}rect')
    sea.set('id', '_海色_projected')
    sea.set('x', '0'); sea.set('y', '0')
    sea.set('width', format_num(out_svg_w)); sea.set('height', format_num(out_svg_h))
    sea.set('fill', sea_color)

    # visible masks only. Draw low -> high. Ignoring holes is OK because higher bands are painted later.
    for idx, info in enumerate(band_infos, start=1):
        mask = (index_img == idx)
        d = contour_mask_to_paths(mask, img_scale, epsilon_px=epsilon_px, min_area_px=min_area_px, dilate_px=dilate_px, close_px=close_px)
        g = etree.SubElement(container, f'{{{SVG_NS}}}g')
        g.set('id', info['id'])
        g.set('data-name', info['name'])
        if d:
            p = etree.SubElement(g, f'{{{SVG_NS}}}path')
            p.set('d', d)
            p.set('fill', info['color'])
            p.set('stroke', 'none')
    return container


def build_output_svg(root_src, vbw: float, vbh: float, fill_group=None, boundary_group=None, graticule_group=None, text_group=None):
    root = etree.Element(f'{{{SVG_NS}}}svg', nsmap={None: SVG_NS, 'xlink': XLINK_NS})
    root.set('viewBox', f'0 0 {format_num(vbw)} {format_num(vbh)}')
    root.set('width', format_num(vbw))
    root.set('height', format_num(vbh))
    defs = root_src.find(f'{{{SVG_NS}}}defs')
    if defs is not None:
        root.append(copy.deepcopy(defs))
    if fill_group is not None:
        root.append(fill_group)
    if boundary_group is not None:
        root.append(boundary_group)
    if graticule_group is not None:
        root.append(graticule_group)
    if text_group is not None:
        root.append(text_group)
    return etree.ElementTree(root)


def parse_lon0s(args):
    if args.lon0_list:
        return [float(x) for x in args.lon0_list.split(',') if x.strip()]
    vals = []
    x = args.lon0_start
    while x <= args.lon0_end + 1e-9:
        vals.append(float(x))
        x += args.lon0_step
    return vals


def build_fill_only_root(root_src):
    tmp = copy.deepcopy(root_src)
    for gid in ['_境界', '_経緯線', '_文字']:
        remove_group_by_id(tmp, gid)
    return tmp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input_svg', type=Path)
    ap.add_argument('--outdir', type=Path, default=Path('out_peirce_q_vectorfills'))
    ap.add_argument('--shape', default='square', choices=['square','diamond','horizontal','vertical','nhemisphere','shemisphere'])
    ap.add_argument('--lon0-start', type=float, default=0.0)
    ap.add_argument('--lon0-end', type=float, default=350.0)
    ap.add_argument('--lon0-step', type=float, default=10.0)
    ap.add_argument('--lon0-list')
    ap.add_argument('--frame')
    ap.add_argument('--target-size', type=float, default=None, help='SVG viewBox max dimension in source SVG units. Default: map frame width')
    ap.add_argument('--source-raster-width', type=int, default=7000, help='Source fill-only raster width before projection. Larger = slower but cleaner contours.')
    ap.add_argument('--mask-max-dim', type=int, default=3200, help='Projected mask raster max dimension used only for contour extraction.')
    ap.add_argument('--contour-epsilon-px', type=float, default=1.0, help='Contour simplification in projected mask pixels.')
    ap.add_argument('--dilate-px', type=int, default=1, help='Slightly expand each color band before contouring to avoid hairline gaps.')
    ap.add_argument('--min-area-px', type=float, default=2.0, help='Discard projected contour pieces smaller than this area.')
    ap.add_argument('--close-px', type=int, default=0, help='Morphological closing on each band mask after projection. Helps preserve cusps / fill tiny invalid wedges.')
    ap.add_argument('--invalid-fill', choices=['nearest', 'sea', 'none'], default='nearest', help='How to treat output pixels that fail inverse projection near singularities.')
    ap.add_argument('--allow-huge-images', action='store_true', help='Disable Pillow decompression-bomb pixel limit for very large intermediate PNGs.')
    ap.add_argument('--combined-only', action='store_true')
    ap.add_argument('--no-flip-x', action='store_true')
    ap.add_argument('--reverse-east-west', action='store_true')
    args = ap.parse_args()

    if args.allow_huge_images:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = None

    parser = etree.XMLParser(remove_blank_text=False, recover=True)
    tree = etree.parse(str(args.input_svg), parser)
    root = tree.getroot()
    frame = tuple(float(v) for v in args.frame.split(',')) if args.frame else find_map_frame(root)
    target_size = args.target_size if args.target_size is not None else (frame[2] - frame[0])
    args.outdir.mkdir(parents=True, exist_ok=True)

    sea_color, band_infos = discover_fill_palette(root)
    palette_rgba = np.array([hex_to_rgba(sea_color)] + [hex_to_rgba(info['color']) for info in band_infos], dtype=np.uint8)

    fill_root = build_fill_only_root(root)
    source_png = args.outdir / f'{args.input_svg.stem}_fill_source.png'
    _, _, src_viewbox = render_svg_png(fill_root, source_png, args.source_raster_width)
    from PIL import Image
    src_rgba = np.array(Image.open(source_png).convert('RGBA'))
    src_idx = quantize_rgba_to_palette(src_rgba, palette_rgba)

    lon0s = parse_lon0s(args)
    flip_x = not args.no_flip_x
    manifest = ['lon0,combined,map,text']

    for lon0 in lon0s:
        base_name = f'{args.input_svg.stem}_peirceq_vectorfills_lon{int(round(lon0))%360:03d}_{args.shape}'
        transformer = make_transformer(lon0, args.shape)
        inv_transformer = make_inv_transformer(lon0, args.shape)
        bbox = compute_bbox_from_source_frame(frame, transformer, reverse_east_west=args.reverse_east_west)
        scaler, vbw, vbh, world_scale = make_scaler(bbox, target_size, flip_x=flip_x)

        proj_idx, img_scale = warp_palette_index(
            src_idx, frame, src_viewbox, inv_transformer, bbox, world_scale,
            vbw, vbh, reverse_east_west=args.reverse_east_west,
            raster_max_dim=args.mask_max_dim, flip_x=flip_x,
            invalid_fill_mode=args.invalid_fill,
        )

        fill_group = build_vector_fill_group(
            proj_idx, img_scale, sea_color, band_infos,
            dilate_px=args.dilate_px, epsilon_px=args.contour_epsilon_px,
            min_area_px=args.min_area_px, close_px=args.close_px, out_svg_w=vbw, out_svg_h=vbh
        )

        boundary_group = get_group_copy(root, '_境界')
        graticule_group = get_group_copy(root, '_経緯線')
        text_group = get_group_copy(root, '_文字')
        jump_threshold = max(vbw, vbh) * 0.22
        if boundary_group is not None:
            transform_subtree(boundary_group, frame, transformer, scaler, jump_threshold, reverse_east_west=args.reverse_east_west, keep_geometry=True, keep_text=False)
        if graticule_group is not None:
            transform_subtree(graticule_group, frame, transformer, scaler, jump_threshold, reverse_east_west=args.reverse_east_west, keep_geometry=True, keep_text=False)
        if text_group is not None:
            transform_subtree(text_group, frame, transformer, scaler, jump_threshold, reverse_east_west=args.reverse_east_west, keep_geometry=False, keep_text=True)

        combined_tree = build_output_svg(root, vbw, vbh, fill_group, boundary_group, graticule_group, text_group)
        combined_path = args.outdir / f'{base_name}_combined.svg'
        combined_tree.write(str(combined_path), encoding='utf-8', xml_declaration=True, pretty_print=True)

        map_path = ''
        text_path = ''
        if not args.combined_only:
            map_tree = build_output_svg(root, vbw, vbh, fill_group, boundary_group, graticule_group, None)
            map_path = args.outdir / f'{base_name}_map.svg'
            map_tree.write(str(map_path), encoding='utf-8', xml_declaration=True, pretty_print=True)
            text_tree = build_output_svg(root, vbw, vbh, None, None, None, text_group)
            text_path = args.outdir / f'{base_name}_text.svg'
            text_tree.write(str(text_path), encoding='utf-8', xml_declaration=True, pretty_print=True)

        manifest.append(f'{lon0},{combined_path.name},{Path(map_path).name if map_path else ""},{Path(text_path).name if text_path else ""}')
        print('Wrote', combined_path)

    (args.outdir / 'manifest.csv').write_text('\n'.join(manifest), encoding='utf-8')


if __name__ == '__main__':
    main()
