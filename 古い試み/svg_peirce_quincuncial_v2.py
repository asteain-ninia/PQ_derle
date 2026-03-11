#!/usr/bin/env python3
from __future__ import annotations

import argparse, copy, math, re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple
from lxml import etree
from pyproj import CRS, Transformer
from fontTools.svgLib.path import parse_path
from fontTools.pens.recordingPen import RecordingPen

SVG_NS = "http://www.w3.org/2000/svg"
NSMAP = {"svg": SVG_NS}
PT = Tuple[float, float]


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
    text_transform: Optional[str] = None
    is_empty_text: bool = False
    layer_names: Tuple[str, ...] = field(default_factory=tuple)
    attrs: dict = field(default_factory=dict)


# ---- source mapping ----

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


def convert_source_to_lonlat(p: PT, frame: Tuple[float, float, float, float], reverse_east_west: bool=False) -> Tuple[float, float]:
    x0, y0, x1, y1 = frame
    if reverse_east_west:
        lon = 180.0 - (p[0] - x0) * 360.0 / (x1 - x0)
    else:
        lon = -180.0 + (p[0] - x0) * 360.0 / (x1 - x0)
    lat = 90.0 - (p[1] - y0) * 180.0 / (y1 - y0)
    return lon, lat


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
    vals = parse_floats(text); return [(vals[i], vals[i+1]) for i in range(0, len(vals)-1, 2)]


def sample_line_points(points: List[PT], closed: bool, max_seg: float) -> List[Tuple[List[PT], bool]]:
    if not points: return []
    result = [points[0]]
    for i in range(1, len(points)):
        seg = densify_line(points[i-1], points[i], max_seg); result.extend(seg[1:])
    if closed and len(points) > 2:
        seg = densify_line(points[-1], points[0], max_seg); result.extend(seg[1:])
    return [(result, closed)]


def sample_element_geometry(el, max_seg: float, curve_steps: int) -> List[Tuple[List[PT], bool]]:
    tag = localname(el.tag)
    if tag == 'path': return sample_path_d(el.get('d', ''), max_seg, curve_steps)
    if tag == 'line': return sample_line_points([(float(el.get('x1')), float(el.get('y1'))), (float(el.get('x2')), float(el.get('y2')))], False, max_seg)
    if tag == 'polyline': return sample_line_points(parse_points_attr(el.get('points', '')), False, max_seg)
    if tag == 'polygon': return sample_line_points(parse_points_attr(el.get('points', '')), True, max_seg)
    if tag == 'rect':
        x = float(el.get('x', '0')); y = float(el.get('y', '0')); w = float(el.get('width')); h = float(el.get('height'))
        return sample_line_points([(x, y), (x+w, y), (x+w, y+h), (x, y+h)], True, max_seg)
    return []


def get_text_anchor(el) -> Optional[PT]:
    tr = el.get('transform')
    if tr:
        return apply_matrix(parse_transform_to_matrix(tr), (0.0, 0.0))
    if 'x' in el.attrib or 'y' in el.attrib:
        return (float(el.get('x', '0')), float(el.get('y', '0')))
    first_tspan = el.find(f'{{{SVG_NS}}}tspan')
    if first_tspan is not None and ('x' in first_tspan.attrib or 'y' in first_tspan.attrib):
        return (float(first_tspan.get('x', '0').split()[0]), float(first_tspan.get('y', '0').split()[0]))
    return None


def is_empty_text(el) -> bool:
    return ''.join(el.itertext()).strip() == ''


def element_layer_names(el) -> Tuple[str, ...]:
    out = []
    p = el
    while p is not None:
        if localname(p.tag) == 'g':
            nm = p.get('data-name') or p.get('id')
            if nm: out.append(nm)
        p = p.getparent()
    return tuple(reversed(out))


def extract_records(root, max_seg: float, curve_steps: int) -> List[GeomRecord]:
    records = []; order = 0
    for el in root.iter():
        tag = localname(el.tag)
        if tag in {'path', 'rect', 'line', 'polyline', 'polygon'}:
            order += 1
            records.append(GeomRecord('geometry', order, sample_element_geometry(el, max_seg, curve_steps), layer_names=element_layer_names(el), attrs=dict(el.attrib)))
        elif tag == 'text':
            order += 1
            records.append(GeomRecord('text', order, text_anchor=get_text_anchor(el), text_transform=el.get('transform'), is_empty_text=is_empty_text(el), layer_names=element_layer_names(el), attrs=dict(el.attrib)))
    return records


def list_relevant_elements(root) -> List:
    return [el for el in root.iter() if localname(el.tag) in {'path', 'rect', 'line', 'polyline', 'polygon', 'text'}]


# ---- projection ----

def safe_transform(transformer: Transformer, lon: float, lat: float) -> Optional[PT]:
    try:
        x, y = transformer.transform(lon, lat)
    except Exception:
        return None
    return (x, y) if math.isfinite(x) and math.isfinite(y) else None


def project_subpath(points: Sequence[PT], frame, transformer, reverse_east_west=False) -> List[Optional[PT]]:
    out = []
    for p in points:
        lon, lat = convert_source_to_lonlat(p, frame, reverse_east_west=reverse_east_west)
        out.append(safe_transform(transformer, lon, lat))
    return out


def compute_projected_bbox(records: List[GeomRecord], frame, transformer, reverse_east_west=False) -> Tuple[float, float, float, float]:
    xs, ys = [], []
    for rec in records:
        if rec.kind == 'geometry':
            if '海' in rec.layer_names and rec.attrs.get('id') == '_海色':
                continue
            for pts, _closed in rec.subpaths:
                for q in project_subpath(pts, frame, transformer, reverse_east_west=reverse_east_west):
                    if q is not None:
                        xs.append(q[0]); ys.append(q[1])
        elif rec.kind == 'text' and rec.text_anchor and not rec.is_empty_text:
            lon, lat = convert_source_to_lonlat(rec.text_anchor, frame, reverse_east_west=reverse_east_west)
            q = safe_transform(transformer, lon, lat)
            if q is not None:
                xs.append(q[0]); ys.append(q[1])
    if not xs: raise RuntimeError('No finite projected coordinates found.')
    return min(xs), min(ys), max(xs), max(ys)


def make_scaler(src_bbox, target_size: float, flip_x: bool):
    minx, miny, maxx, maxy = src_bbox
    w = maxx - minx; h = maxy - miny
    if w <= 0 or h <= 0: raise RuntimeError('Degenerate projected bounding box.')
    scale = target_size / max(w, h)
    def f(p: PT) -> PT:
        px = (maxx - p[0]) if flip_x else (p[0] - minx)
        if flip_x:
            px *= scale
        else:
            px *= scale
        return (px, (p[1] - miny) * scale)
    return f, w * scale, h * scale


def split_large_jumps(points: List[Optional[PT]], scaler, jump_threshold: float) -> List[List[PT]]:
    chunks = []; current = []; prev = None
    for p in points:
        if p is None:
            if len(current) >= 2: chunks.append(current)
            current = []; prev = None; continue
        sp = scaler(p)
        if prev is not None and distance(prev, sp) > jump_threshold:
            if len(current) >= 2: chunks.append(current)
            current = [sp]
        else:
            current.append(sp)
        prev = sp
    if len(current) >= 2: chunks.append(current)
    return chunks


def chunks_to_path_d(chunks: List[Tuple[List[PT], bool]]) -> str:
    parts = []
    for pts, closed in chunks:
        if not pts: continue
        parts.append(f"M {format_num(pts[0][0])} {format_num(pts[0][1])}")
        for p in pts[1:]: parts.append(f"L {format_num(p[0])} {format_num(p[1])}")
        if closed and len(pts) >= 3: parts.append('Z')
    return ' '.join(parts)


def is_sea_background(rec: GeomRecord) -> bool:
    return rec.kind == 'geometry' and rec.attrs.get('id') == '_海色' and '海' in rec.layer_names


def is_contour_fill(rec: GeomRecord) -> bool:
    return rec.kind == 'geometry' and '分高面' in rec.layer_names


def replace_with_output_rect(el, vbw: float, vbh: float):
    parent = el.getparent()
    if parent is None: return
    new_el = etree.Element(f'{{{SVG_NS}}}rect')
    for k, v in el.attrib.items():
        if k not in {'x','y','width','height'}:
            new_el.set(k, v)
    new_el.set('x', '0'); new_el.set('y', '0'); new_el.set('width', format_num(vbw)); new_el.set('height', format_num(vbh))
    idx = parent.index(el); parent.remove(el); parent.insert(idx, new_el)


def rewrite_tree(root, records: List[GeomRecord], frame, transformer, target_size: float, bbox_jump_frac: float,
                 keep_geometry: bool, keep_text: bool, flip_x: bool, reverse_east_west: bool):
    bbox = compute_projected_bbox(records, frame, transformer, reverse_east_west=reverse_east_west)
    scaler, vbw, vbh = make_scaler(bbox, target_size, flip_x=flip_x)
    jump_threshold = max(vbw, vbh) * bbox_jump_frac
    elements = list_relevant_elements(root)
    if len(elements) != len(records): raise RuntimeError('Element/record count mismatch.')

    for el, rec in zip(elements, records):
        tag = localname(el.tag); parent = el.getparent()
        if rec.kind == 'geometry':
            if not keep_geometry:
                if parent is not None: parent.remove(el)
                continue
            if is_sea_background(rec):
                replace_with_output_rect(el, vbw, vbh)
                continue
            all_chunks = []
            for src_pts, closed in rec.subpaths:
                proj_pts = project_subpath(src_pts, frame, transformer, reverse_east_west=reverse_east_west)
                # For filled contour polygons, avoid aggressive seam splitting: it creates visible tears.
                if closed and is_contour_fill(rec):
                    chunk = [scaler(p) for p in proj_pts if p is not None]
                    if len(chunk) >= 3:
                        all_chunks.append((chunk, True))
                    continue
                chunks = split_large_jumps(proj_pts, scaler, jump_threshold)
                if closed and len(chunks) == 1 and len(chunks[0]) >= 3:
                    all_chunks.append((chunks[0], True))
                else:
                    all_chunks.extend((chunk, False) for chunk in chunks)
            new_d = chunks_to_path_d(all_chunks)
            if tag != 'path':
                new_el = etree.Element(f'{{{SVG_NS}}}path')
                for k, v in el.attrib.items():
                    if k in {'x','y','x1','y1','x2','y2','width','height','points'}:
                        continue
                    new_el.set(k, v)
                new_el.set('d', new_d)
                idx = parent.index(el); parent.remove(el); parent.insert(idx, new_el)
            else:
                el.set('d', new_d)
        elif rec.kind == 'text':
            if not keep_text or rec.is_empty_text:
                if parent is not None: parent.remove(el)
                continue
            if rec.text_anchor is None:
                continue
            lon, lat = convert_source_to_lonlat(rec.text_anchor, frame, reverse_east_west=reverse_east_west)
            q = safe_transform(transformer, lon, lat)
            if q is None:
                if parent is not None: parent.remove(el)
                continue
            x, y = scaler(q)
            el.set('transform', f'translate({format_num(x)} {format_num(y)})')
            if 'x' in el.attrib: el.set('x', '0')
            if 'y' in el.attrib: el.set('y', '0')

    for t in list(root.xpath('.//svg:text', namespaces=NSMAP)):
        if ''.join(t.itertext()).strip() == '' and len(t) == 0:
            p = t.getparent()
            if p is not None: p.remove(t)

    root.set('viewBox', f'0 0 {format_num(vbw)} {format_num(vbh)}')
    root.set('width', format_num(vbw)); root.set('height', format_num(vbh))
    return etree.ElementTree(root), vbw, vbh


def parse_lon0s(args):
    if args.lon0_list: return [float(x) for x in args.lon0_list.split(',') if x.strip()]
    vals=[]; x=args.lon0_start
    while x <= args.lon0_end + 1e-9:
        vals.append(float(x)); x += args.lon0_step
    return vals


def make_transformer(lon0: float, shape: str) -> Transformer:
    crs = CRS.from_proj4(f'+proj=peirce_q +lon_0={lon0} +shape={shape}')
    return Transformer.from_crs('EPSG:4326', crs, always_xy=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input_svg', type=Path)
    ap.add_argument('--outdir', type=Path, default=Path('out_peirce_q'))
    ap.add_argument('--shape', default='square', choices=['square','diamond','horizontal','vertical','nhemisphere','shemisphere'])
    ap.add_argument('--lon0-start', type=float, default=0.0)
    ap.add_argument('--lon0-end', type=float, default=350.0)
    ap.add_argument('--lon0-step', type=float, default=10.0)
    ap.add_argument('--lon0-list')
    ap.add_argument('--max-seg', type=float, default=3.0)
    ap.add_argument('--curve-steps', type=int, default=24)
    ap.add_argument('--jump-frac', type=float, default=0.22)
    ap.add_argument('--target-size', type=float, default=None)
    ap.add_argument('--frame')
    ap.add_argument('--combined-only', action='store_true')
    ap.add_argument('--no-flip-x', action='store_true', help='Keep projected X as-is. Default flips X to match Illustrator-like east/right expectation.')
    ap.add_argument('--reverse-east-west', action='store_true', help='Interpret source map as west-on-right before projection.')
    args = ap.parse_args()

    parser = etree.XMLParser(remove_blank_text=False, recover=True)
    tree = etree.parse(str(args.input_svg), parser)
    root = tree.getroot()
    frame = tuple(float(v) for v in args.frame.split(',')) if args.frame else find_map_frame(root)
    target_size = args.target_size if args.target_size is not None else (frame[2]-frame[0])
    records = extract_records(root, args.max_seg, args.curve_steps)
    lon0s = parse_lon0s(args)
    args.outdir.mkdir(parents=True, exist_ok=True)
    flip_x = not args.no_flip_x

    manifest_lines = ['lon0,shape,flip_x,reverse_east_west,combined,map,text']
    for lon0 in lon0s:
        base_name = f'{args.input_svg.stem}_peirceq_lon{int(round(lon0))%360:03d}_{args.shape}'
        transformer = make_transformer(lon0, args.shape)
        combined_root = copy.deepcopy(root)
        combined_tree, vbw, vbh = rewrite_tree(combined_root, records, frame, transformer, target_size, args.jump_frac, True, True, flip_x, args.reverse_east_west)
        combined_path = args.outdir / f'{base_name}_combined.svg'
        combined_tree.write(str(combined_path), encoding='utf-8', xml_declaration=True, pretty_print=True)
        map_path = text_path = ''
        if not args.combined_only:
            map_root = copy.deepcopy(root)
            map_tree, _, _ = rewrite_tree(map_root, records, frame, transformer, target_size, args.jump_frac, True, False, flip_x, args.reverse_east_west)
            map_path = args.outdir / f'{base_name}_map.svg'; map_tree.write(str(map_path), encoding='utf-8', xml_declaration=True, pretty_print=True)
            text_root = copy.deepcopy(root)
            text_tree, _, _ = rewrite_tree(text_root, records, frame, transformer, target_size, args.jump_frac, False, True, flip_x, args.reverse_east_west)
            text_path = args.outdir / f'{base_name}_text.svg'; text_tree.write(str(text_path), encoding='utf-8', xml_declaration=True, pretty_print=True)
        manifest_lines.append(f'{lon0},{args.shape},{flip_x},{args.reverse_east_west},{combined_path.name},{Path(map_path).name if map_path else ""},{Path(text_path).name if text_path else ""}')
        print('Wrote', combined_path)
    (args.outdir/'manifest.csv').write_text('\n'.join(manifest_lines), encoding='utf-8')
    print('Map frame used:', frame)

if __name__ == '__main__':
    main()
