// Research Garden: renders a forest of "paper plants" as an SVG.
//
// Each root paper (root_node: 1) starts a plant; every other paper names its `parent`.
// A paper can have any number of children. The layout measures each label and packs
// subtrees level-by-level (a simple contour / tidy-tree layout), so plant widths and
// the garden height adapt to the data instead of being hard-coded.
//
// Optional per-paper fields: is_left_child (force the label to the left of the flower),
// indirect_connections (list of ids, drawn as dashed curves), latest (adds a "Just planted!" sign).

var flowerTemplateHTML = $('#flower_template').html();
const SVG_NS = "http://www.w3.org/2000/svg";

// ---- Layout constants -------------------------------------------------------
var garden_height = 580;            // recomputed from the tallest plant
const MIN_GARDEN_HEIGHT = 560;
const stem_height = 64;             // vertical distance between generations
const vine_sway = 14;               // horizontal zig-zag along chains of only-children
const root_stem_height = 70;
const root_offset = 60;             // bottom of canvas -> base of a root stem
const top_margin = 110;             // room above the tallest flower (clouds live here)
var garden_title_text = null;       // taken from #garden_title, drawn as a cloud in the sky
var title_box = null;               // {cx, cy, w, h} of the title cloud
const side_margin = 70;
const flower_radius = 22;
const label_pad = 26;               // flower centre -> label text
const max_title_width = 125;        // longer titles wrap onto two lines
const line_height = 17;
const sibling_gap = 26;             // min gap between neighbouring subtrees (incl. labels)
const min_sibling_dx = 100;         // min distance between sibling flowers
const plant_gap = 70;               // min gap between neighbouring plants
const sign_width = 82;

var research_garden = [];
var id2paper = {};
var flower_positions = {};          // id -> {x, y} with y relative to the ground (negative = up)
var garden_x_offset = 0;
var _last_viewport_width = null;

function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in (attrs || {})) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
}

// Small deterministic PRNG so decorations stay put between page loads.
function seeded(seed) {
    return function () {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
    };
}

// Title lines (wrapped by measureLabels) followed by the venue line.
function titleLines(paper) {
    var lines = (paper._title_lines || String(paper.title).split('\n')).slice();
    if (paper.venue) lines.push(paper.venue);
    return lines;
}

// Split a title that is wider than maxW into two lines, choosing the break that
// makes the longer line as short as possible. Explicit "\n" breaks are kept.
function wrapTitle(title, measureFn, maxW) {
    return String(title).split('\n').flatMap(line => {
        const words = line.split(' ');
        if (words.length < 2 || measureFn(line) <= maxW) return [line];
        let best = null;
        for (let k = 1; k < words.length; k++) {
            const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
            const w = Math.max(measureFn(a), measureFn(b));
            if (!best || w < best.w) best = {w: w, lines: [a, b]};
        }
        return best.lines;
    });
}

// ---- Entry point ------------------------------------------------------------
function build_garden(papers) {
    research_garden = [];
    id2paper = {};
    papers.forEach(p => { p.children = []; id2paper[p.id] = p; });
    papers.forEach(p => {
        if (p.root_node) {
            research_garden.push({plant_name: p.root_name, flower_color: p.root_color, root: p});
        } else if (id2paper[p.parent]) {
            id2paper[p.parent].children.push(p);
            p.parent_paper = id2paper[p.parent];
        } else {
            console.warn(`Research garden: paper "${p.id}" has unknown parent "${p.parent}"`);
        }
    });
    research_garden.forEach((plant, i) => {
        (function tag(p) { p.plant_index = i; p.children.forEach(tag); })(plant.root);
    });

    calculate_coauthors(papers);

    const $title = $('#garden_title');
    if ($title.length && garden_title_text === null) {
        garden_title_text = $title.clone().children().remove().end().text().trim();
        $title.hide();
    }

    // Labels are measured, so wait for the web fonts before laying out.
    var fontsReady = Promise.resolve();
    if (document.fonts && document.fonts.load) {
        fontsReady = Promise.all([
            document.fonts.load('500 16px Roboto'),
            document.fonts.load('300 14px Roboto'),
            document.fonts.load('500 20px Roboto'),
        ]).catch(() => {});
    }
    fontsReady.then(drawGarden);

    $(window).off('resize.garden').on('resize.garden', function () {
        clearTimeout(window._garden_resize_timer);
        window._garden_resize_timer = setTimeout(function () {
            if (Math.abs($(window).width() - _last_viewport_width) > 40) drawGarden();
        }, 200);
    });
}

function drawGarden() {
    layoutGarden();
    renderGarden();
}

// ---- Layout -----------------------------------------------------------------
function measureLabels() {
    const svg = $('#garden')[0];
    const probe = svgEl('text', {class: 'label', x: -9999, y: -9999}, svg);
    const measure = (text, cls) => {
        const t = svgEl('tspan', {class: cls}, probe);
        t.textContent = text;
        const w = t.getComputedTextLength() || text.length * 8;
        probe.removeChild(t);
        return w;
    };
    Object.values(id2paper).forEach(p => {
        p._title_lines = wrapTitle(p.title, l => measure(l, 'paper_label0'), max_title_width);
        p._label_w = Math.max(...titleLines(p).map((l, i) => measure(l, labelClass(p, i))));
        if (p.latest) p._label_w = Math.max(p._label_w, sign_width);
    });
    probe.setAttribute('class', 'direction-label');
    research_garden.forEach(plant => {
        plant._name_w = Math.max(...plant.plant_name.split('\n').map((l, i) => measure(l, `plant_label${i}`)));
    });
    if (garden_title_text) {
        probe.setAttribute('class', 'garden_cloud_title');
        garden_title_text_w = measure(garden_title_text, '');
    }
    svg.removeChild(probe);
}
var garden_title_text_w = 0;

// Labels sit on the "outside" of a branch: left-most children label to the left,
// the rest to the right. Along a chain of only-children the label alternates sides
// (like a vine), so labels on the same side are two generations apart.
function assignSides(node, side) {
    node._side = node.is_left_child ? 'left' : side;
    const n = node.children.length;
    node.children.forEach((c, i) => {
        const childSide = (n === 1) ? (node._side === 'left' ? 'right' : 'left')
                                    : (i < (n - 1) / 2 ? 'left' : 'right');
        assignSides(c, childSide);
    });
}

// Places children relative to `node` and returns its contour: for each depth below
// (and including) the node, the [l, r] horizontal extent relative to the node's x.
function layoutTree(node) {
    const ext = {
        l: node._side === 'left' ? -(label_pad + node._label_w) : -flower_radius,
        r: node._side === 'right' ? label_pad + node._label_w : flower_radius,
    };
    if (!node.children.length) return [ext];

    const contours = node.children.map(layoutTree);
    const packed = packContours(contours, sibling_gap, min_sibling_dx);
    // odd number of children: the middle one grows straight up; even: centre between the extremes
    const n = packed.offsets.length;
    let mid = (n % 2 === 1) ? packed.offsets[(n - 1) / 2]
                            : (packed.offsets[0] + packed.offsets[n - 1]) / 2;
    // an only child sways away from its label, giving the chain a gentle zig-zag
    if (n === 1) mid = node.children[0]._side === 'left' ? -vine_sway : vine_sway;
    node.children.forEach((c, i) => { c._dx = packed.offsets[i] - mid; });
    return [ext].concat(packed.merged.map(m => ({l: m.l - mid, r: m.r - mid})));
}

// Place contours left-to-right as close as allowed; returns offsets and merged contour.
function packContours(contours, gap, min_dx) {
    const offsets = [0];
    const merged = contours[0].map(c => ({l: c.l, r: c.r}));
    for (let i = 1; i < contours.length; i++) {
        const c = contours[i];
        let off = offsets[i - 1] + min_dx;
        for (let d = 0; d < Math.min(merged.length, c.length); d++) {
            off = Math.max(off, merged[d].r - c[d].l + gap);
        }
        offsets.push(off);
        c.forEach((cc, d) => {
            if (d < merged.length) {
                merged[d].l = Math.min(merged[d].l, cc.l + off);
                merged[d].r = Math.max(merged[d].r, cc.r + off);
            } else {
                merged.push({l: cc.l + off, r: cc.r + off});
            }
        });
    }
    return {offsets, merged};
}

function layoutGarden() {
    measureLabels();
    let maxDepth = 0;
    const plantContours = research_garden.map(plant => {
        assignSides(plant.root, 'right');
        plant.root._dx = 0;
        const c = layoutTree(plant.root);
        maxDepth = Math.max(maxDepth, c.length - 1);
        // depth "-1": the wooden stake with the plant's name
        plant._stake_w = plant._name_w + 34;
        return [{l: -plant._stake_w / 2 - 6, r: plant._stake_w / 2 + 6}].concat(c);
    });
    const packed = packContours(plantContours, plant_gap, 0);
    const left = Math.min(...packed.merged.map(m => m.l));
    const right = Math.max(...packed.merged.map(m => m.r));

    const content_width = right - left + 2 * side_margin;
    _last_viewport_width = $(window).width();
    const garden_width = Math.max(content_width, _last_viewport_width);
    garden_x_offset = (garden_width - (right - left)) / 2 - left;
    garden_height = Math.max(MIN_GARDEN_HEIGHT,
        top_margin + root_offset + root_stem_height + maxDepth * stem_height);

    flower_positions = {};
    research_garden.forEach((plant, i) => {
        plant._x = garden_x_offset + packed.offsets[i];
        (function place(node, x, y) {
            node._x = x; node._y = y;
            flower_positions[node.id] = {x: x, y: y};
            node.children.forEach(c => place(c, x + c._dx, y - stem_height));
        })(plant.root, plant._x, -(root_offset + root_stem_height));
    });

    placeTitle(garden_width);
    $('#garden').attr({width: garden_width, height: garden_height})
                .width(garden_width).height(garden_height);
}

// Find the emptiest stretch of sky for the title cloud, as close as possible to the
// middle of what is visible on load. If no spot is free, the garden grows taller.
function placeTitle(W) {
    title_box = null;
    if (!garden_title_text) return;
    const w = garden_title_text_w + 90, h = 70, top = 30;
    // obstacles: every flower + label, in ground-relative coordinates
    const boxes = Object.values(id2paper).filter(p => p._x !== undefined).map(p => {
        const lw = label_pad + p._label_w;
        return {l: p._side === 'left' ? p._x - lw : p._x - flower_radius,
                r: p._side === 'right' ? p._x + lw : p._x + flower_radius,
                top: p._y - 36};
    });
    const target = Math.min(W, $(window).width()) / 2;
    let best = null;
    for (let cx = w / 2 + 10; cx <= W - w / 2 - 10; cx += 10) {
        // highest obstacle under this stretch of sky (most negative y)
        let highest = 0;
        boxes.forEach(b => { if (b.r > cx - w / 2 && b.l < cx + w / 2) highest = Math.min(highest, b.top); });
        const room = garden_height + highest;            // free pixels above the obstacles
        const score = (room >= top + h + 12 ? 0 : 100000) + Math.abs(cx - target);
        if (!best || score < best.score) best = {score, cx, room};
    }
    if (!best) return;
    if (best.room < top + h + 12) garden_height += top + h + 12 - best.room;
    title_box = {cx: best.cx, cy: top + h / 2, w: w, h: h};
}

// ---- Rendering --------------------------------------------------------------
function get_whiter_color(color, factor) {
    var r = parseInt(color.slice(1, 3), 16);
    var g = parseInt(color.slice(3, 5), 16);
    var b = parseInt(color.slice(5, 7), 16);
    r = Math.min(255, Math.max(0, r + factor));
    g = Math.min(255, Math.max(0, g + factor));
    b = Math.min(255, Math.max(0, b + factor));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function renderGarden() {
    const svg = $('#garden')[0];
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = +svg.getAttribute('width'), H = garden_height;
    const gy = y => H + y;   // ground-relative -> absolute

    renderDefs(svg);
    renderBackground(svg, W, H);
    drawTitleCloud(svg);

    const layers = {};
    ['indirect-connections-group', 'stems', 'leaves', 'plant-names', 'labels', 'flowers', 'signs']
        .forEach(name => { layers[name] = svgEl('g', {class: name}, svg); });

    var css = '';
    research_garden.forEach((plant, index) => {
        css += `.plant_${index} {fill: url(#grad_plant_${index});} .flower:hover .plant_${index}, .lineage .plant_${index} {fill: url(#grad_plant_${index}_hover);}`;
        const x = plant._x, base = gy(-root_offset), top = gy(-(root_offset + root_stem_height));

        svgEl('path', {class: 'stem root_stem', d: `M${x},${gy(-20)} L${x},${top}`}, layers.stems);
        drawLeaf(layers.leaves, x, base - root_stem_height * 0.45, -40, 1.35);
        drawLeaf(layers.leaves, x, base - root_stem_height * 0.75, -140, 1.1);
        drawStake(layers['plant-names'], plant, x, gy);

        drawPaper(plant.root, layers, gy, 0);
    });
    $('#flower_css').text(css);

    // Indirect connections, drawn as gently bowed dashed curves.
    Object.values(id2paper).forEach(p => {
        (p.indirect_connections || []).forEach(otherId => {
            const a = flower_positions[p.id], b = flower_positions[otherId];
            if (!a || !b) { console.warn(`Research garden: unknown indirect connection ${p.id} -> ${otherId}`); return; }
            const ax = a.x, ay = gy(a.y), bx = b.x, by = gy(b.y);
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            const len = Math.hypot(bx - ax, by - ay);
            let nx = -(by - ay) / len, ny = (bx - ax) / len;
            if (ny > 0) { nx = -nx; ny = -ny; }          // always bow upwards
            const bow = Math.min(60, len * 0.12);
            svgEl('path', {
                class: 'indirect_connection',
                d: `M${ax},${ay} Q${mx + nx * bow},${my + ny * bow} ${bx},${by}`,
            }, layers['indirect-connections-group']);
        });
    });
}

function drawPaper(paper, layers, gy, depth) {
    const x = paper._x, y = gy(paper._y);

    paper.children.forEach((child, i) => {
        const cx = child._x, cy = gy(child._y), h = y - cy;
        const d = (Math.abs(cx - x) < 0.5)
            ? `M${x},${y} L${cx},${cy}`
            : `M${x},${y} C${x},${y - h * 0.55} ${cx},${y - h * 0.45} ${cx},${cy}`;
        svgEl('path', {
            class: 'stem', d: d, 'data-child': child.id,
            'stroke-width': Math.max(1.6, 3.2 - depth * 0.3),
        }, layers.stems);
        // a leaf at the middle of the stem, on the side facing away from the trunk
        const mxp = (x + cx) / 2, myp = (y + cy) / 2;
        const leftward = cx < x - 0.5 || (Math.abs(cx - x) < 0.5 && (depth + i) % 2 === 0);
        drawLeaf(layers.leaves, mxp, myp, leftward ? -150 : -30, 1);
        drawPaper(child, layers, gy, depth + 1);
    });

    // flower
    const flower = svgEl('g', {
        class: 'flower', id: 'flower_' + paper.id,
        transform: `translate(${x}, ${y})`, onclick: `open_paper('${paper.id}')`,
    }, layers.flowers);
    var flowerHTML = flowerTemplateHTML.replaceAll(/\[\[FLOWER_CLASS\]\]/g, `plant_${paper.plant_index}`)
                                       .replaceAll(/\[\[X\]\]/g, 0).replaceAll(/\[\[Y\]\]/g, 0);
    flower.innerHTML = `<title>${$('<div>').text(paper.full_title || paper.title).html()}</title><g class='flower_subgroup'>${flowerHTML}</g>`;
    flower.addEventListener('mouseenter', () => highlightLineage(paper, true));
    flower.addEventListener('mouseleave', () => highlightLineage(paper, false));

    // label
    const left = paper._side === 'left';
    const lx = left ? x - label_pad : x + label_pad;
    const label = svgEl('text', {class: 'label', onclick: `open_paper('${paper.id}')`}, layers.labels);
    const lines = titleLines(paper);
    const first_baseline = y + 5 - (lines.length - 1) * line_height / 2;
    lines.forEach((line, index) => {
        const t = svgEl('tspan', {
            class: `${labelClass(paper, index)} ${left ? 'left_child_title' : ''}`,
            x: lx, y: first_baseline + index * line_height,
        }, label);
        t.textContent = line;
    });
    label.addEventListener('mouseenter', () => highlightLineage(paper, true));
    label.addEventListener('mouseleave', () => highlightLineage(paper, false));

    // the sign goes above the label: the newest paper is usually the tip of a branch
    if (paper.latest) drawLatestSign(paper, layers.signs, x, first_baseline - 34, y, left);
}

// Title lines use the bold style, the venue line the light one.
function labelClass(paper, index) {
    return index < paper._title_lines.length ? 'paper_label0' : 'paper_label1';
}

// A wooden sign on two posts, planted in front of the base of the root stem.
function drawStake(parent, plant, x, gy) {
    const g = svgEl('g', {class: 'stake'}, parent);
    const bw = plant._stake_w, bh = 44, bx = x - bw / 2, by = gy(-root_offset + 4);
    [bx + 14, bx + bw - 18].forEach(px => {
        svgEl('rect', {class: 'stake_post', x: px, y: by + bh - 4, width: 5, height: gy(-4) - (by + bh - 4), rx: 1}, g);
    });
    svgEl('rect', {class: 'stake_board', x: bx, y: by, width: bw, height: bh, rx: 4}, g);
    // wood grain
    [0.3, 0.62, 0.86].forEach((f, i) => {
        const yy = by + bh * f;
        svgEl('path', {class: 'stake_grain', d: `M${bx + 6 + i * 9},${yy} Q${x},${yy + (i % 2 ? 1.5 : -1.5)} ${bx + bw - 8 - i * 5},${yy}`}, g);
    });
    [[bx + 5, by + 5], [bx + bw - 5, by + 5]].forEach(([cx, cy]) => svgEl('circle', {class: 'stake_nail', cx, cy, r: 1.4}, g));
    const name = svgEl('text', {class: 'direction-label', x: x, y: by + 19}, g);
    plant.plant_name.split('\n').forEach((line, i) => {
        const t = svgEl('tspan', {x: x, y: by + 19 + i * 17, class: `plant_label${i}`}, name);
        t.textContent = line;
    });
}

function drawTitleCloud(svg) {
    if (!title_box) return;
    const {cx, cy, w, h} = title_box;
    const g = svgEl('g', {class: 'title_cloud', transform: `translate(${cx},${cy})`}, svg);
    const body = svgEl('g', {class: 'title_cloud_body'}, g);
    // a domed silhouette: overlapping puffs, biggest in the middle, on a rounded base
    const rand = seeded(7);
    const base_top = -h / 2 + 26;
    const puffs = Math.max(4, Math.round(w / 62));
    for (let i = 0; i < puffs; i++) {
        const t = i / (puffs - 1), dome = Math.sin(Math.PI * (0.1 + 0.8 * t));
        const r = 17 + 15 * dome + (rand() - 0.5) * 6;
        const px = -w / 2 + 36 + t * (w - 72) + (rand() - 0.5) * 8;
        svgEl('circle', {cx: px, cy: base_top + 8 - 4 * dome, r: r}, body);
    }
    svgEl('rect', {x: -w / 2, y: base_top, width: w, height: h / 2 - base_top, rx: (h / 2 - base_top) / 2}, body);
    const t = svgEl('text', {class: 'garden_cloud_title', x: 0, y: 23, 'text-anchor': 'middle'}, g);
    t.textContent = garden_title_text;
}

function drawLeaf(parent, x, y, angle, scale) {
    const g = svgEl('g', {class: 'leaf', transform: `translate(${x},${y}) rotate(${angle}) scale(${scale})`}, parent);
    svgEl('path', {d: 'M0,0 Q7,-7.5 16,0 Q7,7.5 0,0 Z', fill: 'url(#leaf_gradient)'}, g);
    svgEl('path', {d: 'M1,0 L13,0', class: 'leaf_vein'}, g);
}

function drawLatestSign(paper, parent, x, sy, y, left) {
    const sx = left ? x - label_pad - sign_width : x + label_pad;
    const g = svgEl('g', {class: 'latest-sign', onclick: `open_paper('${paper.id}')`}, parent);
    svgEl('rect', {x: sx, y: sy, width: sign_width, height: 17, rx: 3, ry: 3}, g);
    const t = svgEl('text', {x: sx + sign_width / 2, y: sy + 12, 'text-anchor': 'middle'}, g);
    t.textContent = '\u{1F331} Just planted!';
    // a dewdrop on the flower
    svgEl('circle', {cx: x + 10, cy: y + 10, r: 3, fill: 'url(#dew_gradient)',
                     stroke: 'rgba(255,255,255,0.6)', 'stroke-width': 0.5, class: 'dew'}, parent);
    svgEl('circle', {cx: x + 9.2, cy: y + 9.1, r: 1.05, fill: 'rgba(255,255,255,0.85)', class: 'dew'}, parent);
}

function highlightLineage(paper, on) {
    for (let p = paper; p; p = p.parent_paper) {
        $(`#flower_${p.id}`).toggleClass('lineage', on && p !== paper);
        $(`.stem[data-child="${p.id}"]`).toggleClass('lineage', on);
    }
}

function renderDefs(svg) {
    const defs = svgEl('defs', {}, svg);
    defs.innerHTML = `
        <linearGradient id="sky_gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#cfe0f5"/>
            <stop offset="55%" stop-color="#e6edf5"/>
            <stop offset="100%" stop-color="#f7f1e6"/>
        </linearGradient>
        <linearGradient id="hill_back_gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#a9d2c1"/>
            <stop offset="100%" stop-color="#8fc0ad"/>
        </linearGradient>
        <linearGradient id="grass_gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#7ab5a8"/>
            <stop offset="100%" stop-color="#58927f"/>
        </linearGradient>
        <linearGradient id="wood_gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e0b47a"/>
            <stop offset="100%" stop-color="#c08a4e"/>
        </linearGradient>
        <linearGradient id="leaf_gradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#2f8a6c"/>
            <stop offset="100%" stop-color="#6cbb93"/>
        </linearGradient>
        <radialGradient id="center_gradient" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stop-color="#fffef8"/>
            <stop offset="100%" stop-color="#f0e6d0"/>
        </radialGradient>
        <radialGradient id="dew_gradient" cx="35%" cy="30%" r="65%">
            <stop offset="0%" stop-color="rgba(255,255,255,0.9)"/>
            <stop offset="40%" stop-color="rgba(220,240,255,0.5)"/>
            <stop offset="100%" stop-color="rgba(180,215,255,0.15)"/>
        </radialGradient>
    `;
    research_garden.forEach((plant, index) => {
        const c = plant.flower_color;
        const grad = (id, inner, outer) => {
            const g = svgEl('radialGradient', {id: id, cx: '40%', cy: '30%', r: '70%'}, defs);
            g.innerHTML = `<stop offset="0%" stop-color="${inner}"/><stop offset="100%" stop-color="${outer}"/>`;
        };
        grad(`grad_plant_${index}`, get_whiter_color(c, 50), get_whiter_color(c, -40));
        grad(`grad_plant_${index}_hover`, get_whiter_color(c, 70), c);
    });
}

// A closed wavy band from `baseline` down to the bottom; `phase` (0/1) flips the first hump.
function wavePath(W, H, baseline, period, amplitude, phase) {
    let d = `M0,${H} L0,${baseline}`;
    for (let x = 0, k = phase; x <= W + period; x += period / 2, k++) {
        const sign = (k % 2 === 0) ? -1 : 1;
        d += ` Q${x + period / 4},${baseline + sign * amplitude} ${x + period / 2},${baseline}`;
    }
    return d + ` L${W + period},${H} Z`;
}

function renderBackground(svg, W, H) {
    svgEl('rect', {width: W, height: H, fill: 'url(#sky_gradient)'}, svg);

    // sun glow in the top-left corner
    svgEl('circle', {cx: 70, cy: 40, r: 90, class: 'sun_glow'}, svg);

    // drifting clouds
    const rand = seeded(42);
    const clouds = svgEl('g', {class: 'clouds'}, svg);
    for (let x = 120 + rand() * 80; x < W - 60; x += 260 + rand() * 220) {
        const cy = 30 + rand() * 38, s = 0.65 + rand() * 0.55;
        if (title_box && Math.abs(x - title_box.cx) < title_box.w / 2 + 70) continue;
        const outer = svgEl('g', {transform: `translate(${x},${cy}) scale(${s})`}, clouds);
        const g = svgEl('g', {class: 'cloud', style: `animation-duration: ${38 + rand() * 30}s; animation-delay: -${rand() * 30}s`}, outer);
        [[-24, 4, 15], [-6, -6, 20], [16, -1, 17], [32, 6, 11]].forEach(([dx, dy, r]) => {
            svgEl('circle', {cx: dx, cy: dy, r: r}, g);
        });
        svgEl('rect', {x: -38, y: 2, width: 80, height: 15, rx: 7.5}, g);
    }

    // two layers of rolling hills
    svgEl('path', {class: 'hill_back', d: wavePath(W, H, H - root_offset - 48, 520, 18, 0)}, svg);
    svgEl('path', {class: 'grass', d: wavePath(W, H, H - root_offset - 18, 300, 14, 1)}, svg);

    // little grass tufts
    const tufts = svgEl('g', {class: 'tufts'}, svg);
    for (let x = 30 + rand() * 40; x < W; x += 70 + rand() * 120) {
        const y = H - 8 - rand() * 22;
        svgEl('path', {d: `M${x - 5},${y} Q${x - 4},${y - 7} ${x - 7},${y - 12} M${x},${y} Q${x},${y - 9} ${x + 1},${y - 15} M${x + 5},${y} Q${x + 5},${y - 6} ${x + 8},${y - 11}`}, tufts);
    }
}

// ---- Modal & coauthors -----------------------------------------------------
function open_paper(paper_id) {
    var paper = id2paper[paper_id];
    $('#paper_modal_backdrop').fadeIn(200);
    $('#paper_modal').fadeIn(200);
    $('#paper_modal_title').text(paper.full_title);
    $('#paper_modal_venue').text("— " + paper.venue);
    $('#paper_modal_content').text(paper.summary);
    var linkLabel = /arxiv\.org/.test(paper.url) ? 'arXiv' : 'paper';
    var links = `<a href='${paper.url}' target='_blank'>${linkLabel}</a>`;
    if (paper.additional_links) {
        for (var link_type of Object.keys(paper.additional_links)) {
            links += `<a href="${paper.additional_links[link_type]}" target="_blank">${link_type}</a>`;
        }
    }
    $('#paper_modal_links').html(links);
}

function calculate_coauthors(papers) {
    var coauthor_counts = {};
    for (var i = papers.length - 1; i >= 0; i--) {
        for (var coauthor of papers[i].coauthors) {
            coauthor_counts[coauthor] = (coauthor_counts[coauthor] || 0) + 1;
        }
    }
    var sorted_coauthors = Object.entries(coauthor_counts).sort((a, b) => b[1] - a[1]);
    $('#coauthor_list').empty();
    for (var i = 0; i < Math.min(10, sorted_coauthors.length); i++) {
        var coauthor = sorted_coauthors[i];
        var coauthor_escaped = coauthor[0].replaceAll("'", "\\'");
        $('#coauthor_list').append(`<div class="coauthor" onclick="select_coauthor('${coauthor_escaped}')">${coauthor[0]}</div>`);
    }
    if (sorted_coauthors.length == 0) {
        $('#coauthor_hall_of_fame').hide();
    }
}

var selected_coauthor = null;
function select_coauthor(coauthor) {
    selected_coauthor = (selected_coauthor == coauthor) ? null : coauthor;
    $('.flower').removeClass('selected_flower');
    for (var paper of papers) {
        if (paper.coauthors.includes(selected_coauthor)) {
            $(`#flower_${paper.id}`).addClass('selected_flower');
        }
    }
    $('.coauthor').removeClass('selected_coauthor');
    $('.coauthor').filter(function () { return $(this).text() === selected_coauthor; }).addClass('selected_coauthor');
}
