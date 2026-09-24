/* pid-symbols.js — ISA-style P&ID symbol library.
 *
 * Every symbol is drawn centred on (0,0) in its own local space and then
 * translated / rotated into place, so the same shape works at any orientation.
 * Labels are placed in a counter-rotated group so text always reads level, the
 * way it does on a real drawing.
 *
 * Add your own symbol by writing a draw function and registering it in SYMBOLS.
 */

const NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child) node.append(child);
  }
  return node;
}

/** Multi-line SVG text. `\n` in a label becomes separate <tspan> rows. */
export function svgText(text, attrs = {}) {
  const lines = String(text ?? '').split('\n');
  const node = svgEl('text', attrs);
  const x = attrs.x ?? 0;
  lines.forEach((line, i) => {
    node.append(svgEl('tspan', { x, dy: i === 0 ? 0 : (attrs['line-height'] ?? 12) }, document.createTextNode(line)));
  });
  return node;
}

// ------------------------------------------------------------ primitives --

/**
 * Shared paint for the vessels, appended once to the drawing's <defs> by
 * page-pid.js. The vessels are drawn as a soft hologram -- an x-ray of the
 * hardware rather than a render of its paint:
 *
 *   pid-shade-v / -h  rim light: bright at the silhouette, clear through the
 *                     middle, the way a translucent cylinder catches light at
 *                     its edges. -v for an upright vessel, -h for one lying down.
 *   pid-shade-dome    a faint, broad highlight toward the upper left
 *   pid-scan          fine horizontal scanlines, the lightest "display" cue
 *   pid-glow          a soft bloom for the outlines
 *
 * The rim colour is `--holo-rim`, a stop colour set from CSS, so the same
 * defs read as pale light on the dark theme and graphite on the light one.
 * Nothing here is blue: a tank's only colour is the liquid inside it.
 */
export function symbolDefs() {
  const rim = [
    [0, 0.34], [0.07, 0.16], [0.2, 0.05], [0.34, 0.07], [0.42, 0.02],
    [0.62, 0], [0.82, 0.05], [0.93, 0.14], [1, 0.3],
  ];
  const linear = (id, x2, y2) => svgEl('linearGradient', { id, x1: 0, y1: 0, x2, y2 },
    rim.map(([o, a]) => svgEl('stop', { offset: o, class: 'holo-stop', 'stop-opacity': a })));
  const scan = svgEl('pattern', { id: 'pid-scan', width: 4, height: 3, patternUnits: 'userSpaceOnUse' },
    svgEl('rect', { x: 0, y: 0, width: 4, height: 1, class: 'holo-scan' }));
  const glow = svgEl('filter', { id: 'pid-glow', x: '-10%', y: '-10%', width: '120%', height: '120%' },
    svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 1.6, result: 'blur' }),
    svgEl('feMerge', {},
      svgEl('feMergeNode', { in: 'blur' }),
      svgEl('feMergeNode', { in: 'SourceGraphic' })));
  return [
    linear('pid-shade-v', 1, 0),
    linear('pid-shade-h', 0, 1),
    svgEl('radialGradient', { id: 'pid-shade-dome', cx: 0.3, cy: 0.18, r: 0.75 },
      svgEl('stop', { offset: 0, class: 'holo-stop', 'stop-opacity': 0.14 }),
      svgEl('stop', { offset: 1, class: 'holo-stop', 'stop-opacity': 0 })),
    // The warm core of the combustion chamber, after the combustor cans in
    // the reference render. Faint at rest; it is decoration, not a reading.
    svgEl('radialGradient', { id: 'pid-hot', cx: 0.5, cy: 0.45, r: 0.6 },
      svgEl('stop', { offset: 0, 'stop-color': '#fb923c', 'stop-opacity': 0.34 }),
      svgEl('stop', { offset: 0.6, 'stop-color': '#f97316', 'stop-opacity': 0.12 }),
      svgEl('stop', { offset: 1, 'stop-color': '#f97316', 'stop-opacity': 0 })),
    scan,
    glow,
  ];
}

/** Path for an upright vessel: barrel with elliptical heads of depth `cap`. */
function uprightBody(hw, hh, cap, capBottom = cap) {
  return `M${-hw},${-hh + cap} A${hw},${cap} 0 0 1 ${hw},${-hh + cap}
          L${hw},${hh - capBottom} A${hw},${capBottom} 0 0 1 ${-hw},${hh - capBottom} Z`;
}

/** Path for a vessel on its side: barrel with elliptical heads left and right. */
function lyingBody(hw, hh, cap) {
  return `M${-hw + cap},${-hh} L${hw - cap},${-hh} A${cap},${hh} 0 0 1 ${hw - cap},${hh}
          L${-hw + cap},${hh} A${cap},${hh} 0 0 1 ${-hw + cap},${-hh} Z`;
}

/**
 * A girth seam, where a head is welded to the barrel, seen from slightly
 * above. The front half is a solid line; the back half -- which a solid
 * tank would hide -- is drawn as a faint dashed hidden line, the x-ray cue
 * that makes the shell read as something you are looking into.
 */
function seam(hw, y, ry, cls = 'sym-seam') {
  const front = svgEl('path', { d: `M${-hw},${y} A${hw},${ry} 0 0 0 ${hw},${y}`, class: cls });
  if (cls !== 'sym-seam') return front;
  return svgEl('g', {},
    svgEl('path', { d: `M${-hw},${y} A${hw},${ry} 0 0 1 ${hw},${y}`, class: 'sym-hidden' }),
    front);
}

/** A port boss: the short machined stub a line is welded onto. */
function boss(x, y, w = 12, h = 6) {
  return svgEl('rect', { x: x - w / 2, y, width: w, height: h, class: 'sym-metal' });
}

/**
 * A vessel shell, back to front: a translucent body, whatever is inside it
 * (liquid, internals), the inner wall of the shell, scanlines, the rim light,
 * then the glowing outline.
 */
function shell(d, shade, inner = [], liner = null) {
  return [
    svgEl('path', { d, class: 'sym-vessel' }),
    ...inner,
    liner ? svgEl('path', { d: liner, class: 'sym-liner' }) : null,
    svgEl('path', { d, class: 'sym-scan', fill: 'url(#pid-scan)' }),
    svgEl('path', { d, class: 'sym-shade', fill: `url(#${shade})` }),
    svgEl('path', { d, class: 'sym-vessel-stroke' }),
  ].filter(Boolean);
}

/** The classic two-triangle valve body ("bowtie"). */
function bowtie(w = 40, h = 24, cls = 'sym-body') {
  const hw = w / 2, hh = h / 2;
  return svgEl('g', { class: cls },
    svgEl('path', { d: `M${-hw},${-hh} L${-hw},${hh} L0,0 Z`, class: 'sym-fill' }),
    svgEl('path', { d: `M${hw},${-hh} L${hw},${hh} L0,0 Z`, class: 'sym-fill' })
  );
}

function stem(toY = -16) {
  return svgEl('line', { x1: 0, y1: 0, x2: 0, y2: toY, class: 'sym-line' });
}

/**
 * Solenoid operator: a square coil can with its winding drawn in, rather
 * than a rounded box with a letter in it. The S survives, small, because it
 * is still the ISA mark an operator reading the drawing expects.
 */
function solenoidCan() {
  return svgEl('g', {},
    svgEl('rect', { x: -10, y: -30, width: 20, height: 14, class: 'sym-fill' }),
    svgEl('path', { d: 'M-6,-27 L-6,-19 M-2,-27 L-2,-19 M2,-27 L2,-19 M6,-27 L6,-19', class: 'sym-winding' }),
  );
}

/** Pneumatic operator: the ISA diaphragm dome, spring side down. */
function diaphragm() {
  return svgEl('g', {},
    svgEl('path', { d: 'M-13,-16 A13,11 0 0 1 13,-16 Z', class: 'sym-fill' }),
    svgEl('line', { x1: -13, y1: -16, x2: 13, y2: -16, class: 'sym-line' })
  );
}

// -------------------------------------------------------------- symbols --

const SYMBOLS = {
  /** Solenoid valve: bowtie, stem, coil can. */
  'valve-solenoid': () => svgEl('g', {},
    bowtie(),
    stem(-16),
    solenoidCan(),
  ),

  /**
   * Pneumatically actuated ball valve: a bowtie with the ball at the seat,
   * under a diaphragm operator. Both marks are the ISA ones, and between them
   * they say "main valve, air-driven" without a label.
   */
  'valve-ball': () => svgEl('g', {},
    bowtie(),
    svgEl('circle', { cx: 0, cy: 0, r: 5, class: 'sym-ball' }),
    stem(-16),
    diaphragm(),
  ),

  /** Manual (hand) valve: bowtie + T-handle. */
  'valve-manual': () => svgEl('g', {},
    bowtie(),
    stem(-18),
    svgEl('line', { x1: -11, y1: -18, x2: 11, y2: -18, class: 'sym-line' })
  ),

  /** Motorized valve. */
  'valve-motor': () => svgEl('g', {},
    bowtie(),
    stem(-14),
    svgEl('circle', { cx: 0, cy: -23, r: 9, class: 'sym-fill' }),
    svgEl('text', { x: 0, y: -20, class: 'sym-glyph' }, document.createTextNode('M'))
  ),

  /** Igniter: a spark gap between two electrodes, in line art. */
  'valve-igniter': () => svgEl('g', {},
    svgEl('circle', { cx: 0, cy: 0, r: 14, class: 'sym-fill' }),
    svgEl('path', { d: 'M-14,0 L-6,0 M6,0 L14,0', class: 'sym-line' }),
    svgEl('path', { d: 'M-5,-5 L-1,1 L1,-2 L5,5', class: 'sym-spark' })
  ),

  /**
   * Check valve: flow-direction triangle against a seat bar (diode form).
   * Deliberately small. It marks where backflow is blocked; nobody acts on it.
   */
  'check-valve': () => svgEl('g', {},
    svgEl('path', { d: 'M-8,-7 L-8,7 L6,0 Z', class: 'sym-fill' }),
    svgEl('line', { x1: 6, y1: -8, x2: 6, y2: 8, class: 'sym-line' })
  ),

  /** Pressure relief valve: small bowtie with a spring on the stem. */
  'relief-valve': () => svgEl('g', {},
    bowtie(24, 14),
    svgEl('line', { x1: 0, y1: 0, x2: 0, y2: -9, class: 'sym-line' }),
    svgEl('path', { d: 'M0,-9 L-4,-11.5 L4,-15 L-4,-18.5 L4,-22 L0,-24.5', class: 'sym-line-thin' }),
    svgEl('line', { x1: -6, y1: -25, x2: 6, y2: -25, class: 'sym-line' })
  ),

  /** Pressure regulator: bowtie with a diaphragm dome on the stem. */
  regulator: () => svgEl('g', {},
    bowtie(),
    stem(-16),
    diaphragm(),
    // The adjusting spring's arrow: this one is set by hand.
    svgEl('path', { d: 'M-16,-4 L16,-30 M16,-30 L10,-29 M16,-30 L14.5,-24', class: 'sym-line-thin' })
  ),

  /** Filter: the ISA diamond with the element drawn as a dashed line. */
  filter: () => svgEl('g', {},
    svgEl('path', { d: 'M0,-13 L16,0 L0,13 L-16,0 Z', class: 'sym-fill' }),
    svgEl('line', { x1: 0, y1: -13, x2: 0, y2: 13, class: 'sym-element' })
  ),

  /** Cavitating venturi: converging-diverging throat in the run line. */
  venturi: () => svgEl('g', {},
    svgEl('path', { d: 'M-22,-12 L-5,-4 L5,-4 L22,-12 L22,12 L5,4 L-5,4 L-22,12 Z', class: 'sym-fill' }),
    svgEl('path', { d: 'M-22,-12 L-22,12 M22,-12 L22,12', class: 'sym-line' })
  ),

  /** Restriction orifice: a pinched throat in the line, for a flow-limiting orifice plate. */
  orifice: () => svgEl('g', {},
    svgEl('path', { d: 'M-10,-10 Q0,-3 10,-10 L10,10 Q0,3 -10,10 Z', class: 'sym-fill' })
  ),

  /** Rupture / burst disk: bowed disk between two plates. */
  'burst-disk': () => svgEl('g', {},
    svgEl('line', { x1: -10, y1: -12, x2: -10, y2: 12, class: 'sym-line' }),
    svgEl('line', { x1: 10, y1: -12, x2: 10, y2: 12, class: 'sym-line' }),
    svgEl('path', { d: 'M-10,0 Q0,-12 10,0', class: 'sym-line', fill: 'none' })
  ),

  /**
   * Vent to atmosphere: a gooseneck. The line rises and turns back down, the
   * way a vent stack is actually built so rain does not run into it -- and a
   * shape an engineer recognises, where the old open chevron read as an arrow
   * pointing at the sky.
   */
  'vent-stack': () => svgEl('g', {},
    svgEl('path', { d: 'M0,22 L0,-4 A7,7 0 0 1 14,-4 L14,4', class: 'sym-line', fill: 'none' }),
    svgEl('path', { d: 'M10,4 L18,4', class: 'sym-line' })
  ),

  /** Drain / catch basin. */
  drain: () => svgEl('g', {},
    svgEl('path', { d: 'M-14,-10 L14,-10 L4,10 L-4,10 Z', class: 'sym-fill' }),
    svgEl('line', { x1: -18, y1: -10, x2: 18, y2: -10, class: 'sym-line' })
  ),

  /** Quick disconnect / umbilical. */
  qd: () => svgEl('g', {},
    svgEl('path', { d: 'M-12,-12 L-3,-12 L-3,12 L-12,12', class: 'sym-line', fill: 'none' }),
    svgEl('path', { d: 'M12,-12 L3,-12 L3,12 L12,12', class: 'sym-line', fill: 'none' })
  ),

  /**
   * Off-drawing connector: a flag with the caption INSIDE it, on its own
   * background. The old form printed the caption straight over whatever
   * happened to be behind the arrow, which on a drawing this dense was
   * usually a pipe. `rot: 180` points the flag left.
   */
  terminator: (c) => {
    const hw = flagWidth(c.label) / 2;
    return svgEl('g', {},
      svgEl('path', { d: `M${-hw},-10 L${hw - 9},-10 L${hw},0 L${hw - 9},10 L${-hw},10 Z`, class: 'sym-flag' })
    );
  },

  /** Hatched structural mount. */
  'thrust-mount': (c) => {
    const w = c.w ?? 130, hw = w / 2;
    const g = svgEl('g', {}, svgEl('rect', { x: -hw, y: -7, width: w, height: 14, class: 'sym-fill-strong' }));
    for (let x = -hw + 5; x < hw; x += 11) {
      g.append(svgEl('line', { x1: x, y1: 7, x2: x + 8, y2: -7, class: 'sym-line-thin' }));
    }
    return g;
  },

  /**
   * Run tank. Upright, it is the stand's 1700 psi propellant tank: a barrel
   * with 2:1 elliptical heads, girth seams where they are welded on, a boss
   * top and bottom for the press and outlet lines, and two frame straps. The
   * liquid is a solid block of the fluid's colour with its free surface drawn
   * as an ellipse, so the level reads as a volume, not a bar.
   *
   * Wider than tall, it lies on its side on two saddles -- the surge tank --
   * with the same shading turned through ninety degrees.
   */
  tank: (c) => {
    const w = c.w ?? 130, h = c.h ?? 220;
    const hw = w / 2, hh = h / 2;
    const clip = svgEl('clipPath', { id: `clip-${c.id}` });
    const fluid = `fill: var(--fluid-${c.fluid || 'n2'})`;

    if (w > h) {
      const cap = Math.min(hh * 0.6, hw * 0.3);
      const d = lyingBody(hw, hh, cap);
      clip.append(svgEl('path', { d }));
      return svgEl('g', {},
        clip,
        // Saddles first, so the shell sits in them.
        svgEl('path', { d: `M${-hw * 0.55 - 9},${hh + 5} L${-hw * 0.55 - 6},${hh - 6} L${-hw * 0.55 + 6},${hh - 6} L${-hw * 0.55 + 9},${hh + 5} Z`, class: 'sym-metal' }),
        svgEl('path', { d: `M${hw * 0.55 - 9},${hh + 5} L${hw * 0.55 - 6},${hh - 6} L${hw * 0.55 + 6},${hh - 6} L${hw * 0.55 + 9},${hh + 5} Z`, class: 'sym-metal' }),
        ...shell(d, 'pid-shade-h', [
          svgEl('rect', { id: `level-${c.id}`, x: -hw, y: hh, width: w, height: 0, class: 'sym-level', 'clip-path': `url(#clip-${c.id})`, style: fluid }),
        ], lyingBody(hw - 3, hh - 3, cap - 2)),
        // Head seams, seen end-on as half-ellipses.
        svgEl('path', { d: `M${-hw + cap},${-hh} A${cap * 0.35},${hh} 0 0 1 ${-hw + cap},${hh}`, class: 'sym-seam' }),
        svgEl('path', { d: `M${hw - cap},${-hh} A${cap * 0.35},${hh} 0 0 1 ${hw - cap},${hh}`, class: 'sym-seam' }),
        boss(0, -hh - 4, 10, 5),
        boss(0, hh - 1, 10, 5),
        svgText('', { id: `tanklevel-${c.id}`, x: 0, y: 4, class: 'sym-tank-level', 'text-anchor': 'middle' })
      );
    }

    // 2:1 elliptical heads, capped so a short, wide tank does not become a pill.
    const cap = Math.min(hw * 0.5, h * 0.2);
    const d = uprightBody(hw, hh, cap);
    const ry = cap * 0.3;
    clip.append(svgEl('path', { d }));
    return svgEl('g', {},
      clip,
      ...shell(d, 'pid-shade-v', [
        svgEl('rect', { id: `level-${c.id}`, x: -hw, y: hh, width: w, height: 0, class: 'sym-level', 'clip-path': `url(#clip-${c.id})`, style: fluid }),
        // The free surface. Moved with the level by page-pid.js.
        svgEl('ellipse', { id: `surface-${c.id}`, cx: 0, cy: hh, rx: hw, ry, class: 'sym-surface', 'clip-path': `url(#clip-${c.id})`, style: fluid, display: 'none' }),
        // Internals, seen through the shell: the pressurant diffuser hanging
        // from the top port, and the outlet's anti-vortex baffle at the bottom.
        svgEl('path', { d: `M0,${-hh} L0,${-hh + cap * 0.9}`, class: 'sym-internal' }),
        svgEl('ellipse', { cx: 0, cy: -hh + cap * 0.9, rx: hw * 0.16, ry: 2.5, class: 'sym-internal' }),
        svgEl('path', { d: `M0,${hh} L0,${hh - cap * 0.55} M${-hw * 0.14},${hh - cap * 0.55} L${hw * 0.14},${hh - cap * 0.55}`, class: 'sym-internal' }),
      ], uprightBody(hw - 3, hh - 3, cap - 2)),
      svgEl('path', { d, class: 'sym-shade', fill: 'url(#pid-shade-dome)' }),
      seam(hw, -hh + cap, ry),
      seam(hw, hh - cap, ry),
      // Frame straps, a third of the way in from each end.
      seam(hw + 1.5, -hh + cap + (h - 2 * cap) * 0.28, ry, 'sym-strap'),
      seam(hw + 1.5, hh - cap - (h - 2 * cap) * 0.28, ry, 'sym-strap'),
      boss(0, -hh - 4),
      boss(0, hh - 2),
      // Differential-pressure fill level, painted over the liquid. Hidden
      // until page-pid.js has a number to put in it.
      svgText('', { id: `tanklevel-${c.id}`, x: 0, y: 6, class: 'sym-tank-level', 'text-anchor': 'middle' })
    );
  },

  /**
   * High-pressure gas cylinders: the 6K bottles on the stand. Hemispherical
   * shoulder, a near-flat base, the neck, the CGA valve with its handwheel,
   * and -- for a bank -- a pigtail from each valve into a shared manifold with
   * one line up from the centre.
   *
   * `count` draws that many bottles side by side inside `w`. A bank's pipe
   * starts at (x, y - h/2 - 24); a single bottle's at (x, y - h/2 - 14).
   */
  bottle: (c) => {
    const n = Math.max(1, Math.round(c.count ?? 1));
    const W = c.w ?? 90, h = c.h ?? 170, hh = h / 2;
    const gap = n > 1 ? 8 : 0;
    const w = (W - gap * (n - 1)) / n, hw = w / 2;
    const g = svgEl('g', {});
    const manifoldY = -hh - 20;
    const pigtails = [];
    for (let i = 0; i < n; i++) {
      const cx = -W / 2 + hw + i * (w + gap);
      const d = uprightBody(hw, hh, hw * 0.95, 5);
      g.append(svgEl('g', { transform: `translate(${cx},0)` },
        ...shell(d, 'pid-shade-v', [], uprightBody(hw - 2.5, hh - 2.5, hw * 0.95 - 2, 3)),
        svgEl('path', { d, class: 'sym-shade', fill: 'url(#pid-shade-dome)' }),
        // Shoulder line where the stamped markings sit.
        seam(hw, -hh + hw * 0.95, hw * 0.22),
        // Neck, valve body, handwheel.
        svgEl('rect', { x: -3.5, y: -hh - 3, width: 7, height: 4, class: 'sym-metal' }),
        svgEl('rect', { x: -5, y: -hh - 10, width: 10, height: 7, class: 'sym-metal' }),
        svgEl('ellipse', { cx: 0, cy: -hh - 11.5, rx: 6.5, ry: 1.8, class: 'sym-metal' }),
      ));
      if (n > 1) {
        // Pigtail: out of the valve's side outlet and up into the manifold.
        const side = cx < 0 ? 1 : -1;
        pigtails.push(cx + side * 9);
        g.append(svgEl('path', {
          d: `M${cx + side * 5},${-hh - 6} L${cx + side * 9},${-hh - 6} L${cx + side * 9},${manifoldY}`,
          class: 'sym-line-thin', fill: 'none',
        }));
      }
    }
    if (n > 1) {
      g.append(
        svgEl('line', { x1: Math.min(...pigtails), y1: manifoldY, x2: Math.max(...pigtails), y2: manifoldY, class: 'sym-line' }),
        svgEl('line', { x1: 0, y1: manifoldY, x2: 0, y2: -hh - 24, class: 'sym-line' })
      );
    } else {
      g.append(svgEl('line', { x1: 0, y1: -hh - 13, x2: 0, y2: -hh - 14, class: 'sym-line' }));
    }
    return g;
  },

  /**
   * LOX supply dewar: a squat, heavily insulated vessel on casters, with the
   * crown -- the guard ring on posts that protects the valves on top -- and
   * the liquid withdrawal valve inside it. The line leaves the withdrawal
   * valve at (x, y - h/2 - 17).
   */
  dewar: (c) => {
    const w = c.w ?? 84, h = c.h ?? 100;
    const hw = w / 2 - 4, hh = h / 2;
    const top = -hh + 8, bottom = hh - 8;
    const d = `M${-hw},${top + 8} A${hw},8 0 0 1 ${hw},${top + 8} L${hw},${bottom - 6}
               Q${hw},${bottom} ${hw - 6},${bottom} L${-hw + 6},${bottom} Q${-hw},${bottom} ${-hw},${bottom - 6} Z`;
    const crownY = -hh - 10;
    return svgEl('g', {},
      // Casters.
      svgEl('circle', { cx: -hw + 9, cy: hh - 3, r: 4, class: 'sym-metal' }),
      svgEl('circle', { cx: hw - 9, cy: hh - 3, r: 4, class: 'sym-metal' }),
      svgEl('rect', { x: -hw + 2, y: bottom - 1, width: 2 * hw - 4, height: 4, class: 'sym-metal' }),
      // Vacuum-jacketed: the inner vessel that holds the LOX shows through the
      // outer shell, the way the double wall actually is.
      ...shell(d, 'pid-shade-v', [
        svgEl('path', {
          d: `M${-hw + 7},${top + 16} A${hw - 7},6 0 0 1 ${hw - 7},${top + 16} L${hw - 7},${bottom - 12}
              Q${hw - 7},${bottom - 7} ${hw - 12},${bottom - 7} L${-hw + 12},${bottom - 7} Q${-hw + 7},${bottom - 7} ${-hw + 7},${bottom - 12} Z`,
          class: 'sym-internal',
        }),
        svgEl('path', { d: `M0,${top} L0,${top + 12}`, class: 'sym-internal' }),
      ]),
      svgEl('path', { d, class: 'sym-shade', fill: 'url(#pid-shade-dome)' }),
      seam(hw, top + 8, 4),
      // Vacuum-jacket band.
      seam(hw, bottom - 16, 4, 'sym-strap'),
      // Crown: posts and the guard ring, drawn in perspective.
      svgEl('path', { d: `M${-hw + 6},${top + 4} L${-hw + 6},${crownY} M${hw - 6},${top + 4} L${hw - 6},${crownY}`, class: 'sym-line-thin' }),
      svgEl('ellipse', { cx: 0, cy: crownY, rx: hw - 6, ry: 3.5, class: 'sym-ring' }),
      // Withdrawal valve and its gauge.
      svgEl('rect', { x: -4, y: top - 6, width: 8, height: 8, class: 'sym-metal' }),
      svgEl('line', { x1: 0, y1: top - 6, x2: 0, y2: -hh - 17, class: 'sym-line' }),
      svgEl('circle', { cx: 12, cy: top - 3, r: 4, class: 'sym-metal' }),
      svgEl('line', { x1: 12, y1: top - 3, x2: 14, y2: top - 5, class: 'sym-line-thin' }),
    );
  },

  /**
   * Air compressor: a horizontal receiver with the motor and the finned pump
   * head on top of it. Discharges from the bottom of the receiver at
   * (x, y + 35).
   */
  compressor: (c) => {
    const w = c.w ?? 84;
    const hw = w / 2;
    const rY = 16, rH = 13;            // receiver centre, half-height
    const d = lyingBody(hw, rH, rH * 0.8);
    const rec = svgEl('g', { transform: `translate(0,${rY})` },
      // Feet.
      svgEl('path', { d: `M${-hw * 0.6},${rH} l-3,6 M${-hw * 0.6},${rH} l3,6 M${hw * 0.6},${rH} l-3,6 M${hw * 0.6},${rH} l3,6`, class: 'sym-line-thin' }),
      ...shell(d, 'pid-shade-h', [], lyingBody(hw - 2.5, rH - 2.5, rH * 0.8 - 2)),
      boss(0, rH - 1, 8, 4),
    );
    const fins = [];
    for (let y = -24; y <= -8; y += 4) fins.push(`M6,${y} L28,${y}`);
    return svgEl('g', {},
      rec,
      // Motor: a shaded barrel with its cooling ribs.
      svgEl('rect', { x: -32, y: -20, width: 30, height: 17, rx: 2, class: 'sym-vessel' }),
      svgEl('rect', { x: -32, y: -20, width: 30, height: 17, rx: 2, class: 'sym-shade', fill: 'url(#pid-shade-h)' }),
      svgEl('rect', { x: -32, y: -20, width: 30, height: 17, rx: 2, class: 'sym-vessel-stroke' }),
      svgEl('path', { d: 'M-26,-20 L-26,-3 M-20,-20 L-20,-3 M-14,-20 L-14,-3 M-8,-20 L-8,-3', class: 'sym-seam' }),
      // Pump head: finned cylinder block.
      svgEl('path', { d: 'M4,-3 L8,-28 L26,-28 L30,-3 Z', class: 'sym-vessel' }),
      svgEl('path', { d: 'M4,-3 L8,-28 L26,-28 L30,-3 Z', class: 'sym-shade', fill: 'url(#pid-shade-v)' }),
      svgEl('path', { d: 'M4,-3 L8,-28 L26,-28 L30,-3 Z', class: 'sym-vessel-stroke' }),
      svgEl('path', { d: fins.join(' '), class: 'sym-seam' }),
      // Belt guard between the two.
      svgEl('path', { d: 'M-2,-14 L4,-14', class: 'sym-line-thin' }),
      svgEl('line', { x1: 0, y1: rY + rH + 3, x2: 0, y2: 35, class: 'sym-line' }),
    );
  },

  /**
   * Thrust chamber: injector head, a shaded chamber barrel, and the
   * converging-diverging nozzle, drawn as one continuous metal contour.
   */
  engine: (c) => {
    const w = c.w ?? 120, h = c.h ?? 260;
    const hw = w / 2;
    const chamberW = w * 0.75, chw = chamberW / 2;
    const injH = Math.min(40, h * 0.2);
    const barrelBottom = h * 0.55;
    const throatY = h * 0.72, throatW = w * 0.26, thw = throatW / 2;
    const exitY = h, exitW = w * 0.84, ehw = exitW / 2;
    const contour = `M${-chw},${injH} L${-chw},${barrelBottom} L${-thw},${throatY} L${-ehw},${exitY}
                     L${ehw},${exitY} L${thw},${throatY} L${chw},${barrelBottom} L${chw},${injH} Z`;

    return svgEl('g', {},
      // Injector / head end, with its manifold bolt circle.
      svgEl('rect', { x: -hw, y: 0, width: w, height: injH, rx: 1.5, class: 'sym-vessel' }),
      svgEl('rect', { x: -hw, y: 0, width: w, height: injH, rx: 1.5, class: 'sym-shade', fill: 'url(#pid-shade-v)' }),
      svgEl('rect', { x: -hw, y: 0, width: w, height: injH, rx: 1.5, class: 'sym-vessel-stroke' }),
      svgEl('line', { x1: -hw, y1: injH * 0.5, x2: hw, y2: injH * 0.5, class: 'sym-seam' }),
      ...[-0.7, -0.35, 0, 0.35, 0.7].map((f) => svgEl('circle', { cx: f * hw, cy: injH * 0.25, r: 1.4, class: 'sym-bolt' })),
      ...shell(contour, 'pid-shade-v', [
        // Warm core where the propellants burn -- dark until the chamber
        // makes pressure; page-pid.js fades it in with the plume. Then the
        // chamber wall, drawn through the shell.
        svgEl('path', { id: `hot-${c.id}`, d: contour, fill: 'url(#pid-hot)', class: 'sym-hot', opacity: 0 }),
        svgEl('path', {
          d: `M${-chw + 4},${injH + 3} L${-chw + 4},${barrelBottom} L${-thw + 3},${throatY} M${chw - 4},${injH + 3} L${chw - 4},${barrelBottom} L${thw - 3},${throatY}`,
          class: 'sym-internal', fill: 'none',
        }),
      ]),
      // Throat ring and chamber flange: where the barrel meets the nozzle.
      seam(chw, injH + 4, 3),
      svgEl('line', { x1: -thw - 2, y1: throatY, x2: thw + 2, y2: throatY, class: 'sym-seam' }),
      svgEl('path', { d: `M${-ehw},${exitY} A${ehw},3 0 0 0 ${ehw},${exitY}`, class: 'sym-seam' }),
      // Exhaust plume, shown only while the chamber is producing pressure.
      // Kept short enough to clear the engine label beneath it.
      svgEl('path', {
        id: `plume-${c.id}`,
        d: `M${-ehw + 6},${exitY} L${-ehw - 8},${exitY + 40} L0,${exitY + 60} L${ehw + 8},${exitY + 40} L${ehw - 6},${exitY} Z`,
        class: 'sym-plume',
        opacity: 0,
      })
    );
  },

  /**
   * Bitmap logo for the drawing title block. Swaps with the theme.
   *
   * `w`/`h` size the CANVAS, not the mark: `meet` fits the whole PNG, so any
   * transparent margin the artwork carries is inside the box and the visible
   * mark comes out smaller than the numbers suggest. Size it by eye against
   * the title text rather than by the file's dimensions.
   */
  logo: (c) => {
    const w = c.w ?? 48, h = c.h ?? 48;
    const img = svgEl('image', {
      x: -w / 2, y: -h / 2, width: w, height: h,
      preserveAspectRatio: 'xMidYMid meet',
      class: 'pid-logo',
      id: `logo-${c.id}`,
    });
    img.setAttribute('href', c.src);
    return svgEl('g', {}, img);
  },

  text: () => svgEl('g', {}),

  /**
   * A boundary around part of the system: the hashed box a P&ID draws
   * around ground support equipment, or the outline of the vehicle itself.
   * Unlike every other symbol it is placed by its TOP-LEFT corner, because a
   * box is laid out by its edges. page-pid.js draws these underneath the
   * pipes, so a line crossing into a box is never hidden by it.
   */
  region: (c) => svgEl('rect', {
    x: 0, y: 0, width: c.w ?? 200, height: c.h ?? 120, rx: c.variant === 'vehicle' ? 18 : 3,
    class: c.variant === 'vehicle' ? 'pid-region vehicle' : 'pid-region',
  }),
};

// -------------------------------------------------------------- assembly --

/**
 * Valves nobody can move from this screen. They draw in a quieter ink than
 * the actuated valves so the eye lands on what the ground controller can
 * actually do, and reads the rest as context.
 */
const PASSIVE = new Set(['valve-manual', 'relief-valve', 'check-valve', 'regulator']);

/** Build one static P&ID component (everything except valves and sensors). */
export function renderComponent(c) {
  const g = svgEl('g', {
    class: PASSIVE.has(c.type) ? 'pid-component passive' : 'pid-component',
    transform: `translate(${c.x},${c.y})`,
    dataset: { compId: c.id, compType: c.type },
  });

  if (c.type === 'text') {
    g.append(svgText(c.label, {
      x: 0, y: 0,
      class: c.muted ? 'pid-title muted' : 'pid-title',
      'text-anchor': c.anchor || 'middle',
      'font-size': c.size ?? 13,
      'font-weight': c.weight ?? 600,
      'line-height': (c.size ?? 13) + 4,
    }));
    return g;
  }

  const draw = SYMBOLS[c.type];
  if (!draw) {
    console.warn(`[pid] unknown component type "${c.type}" for ${c.id}`);
    return g;
  }

  // A region's caption sits inside its top-left corner, the way a drawing
  // names a hashed GSE box, rather than hanging below it like a symbol's.
  if (c.type === 'region') {
    g.classList.add('pid-region-group');
    g.append(draw(c));
    if (c.label) {
      g.append(svgText(c.label, {
        x: 10, y: 17,
        class: c.variant === 'vehicle' ? 'pid-region-label vehicle' : 'pid-region-label',
        'text-anchor': 'start',
        'line-height': 12,
      }));
    }
    if (c.sub) {
      g.append(svgText(c.sub, { x: 10, y: 30, class: 'pid-sublabel', 'text-anchor': 'start', 'line-height': 10 }));
    }
    return g;
  }

  const transforms = [];
  if (c.rot) transforms.push(`rotate(${c.rot})`);
  if (c.scale && c.scale !== 1) transforms.push(`scale(${c.scale})`);
  const body = svgEl('g', { transform: transforms.length ? transforms.join(' ') : null });
  body.append(draw(c));
  g.append(body);

  // A flag carries its caption inside itself, nudged away from the point.
  if (c.type === 'terminator') {
    if (c.label) {
      g.append(svgText(c.label, {
        x: c.rot === 180 ? 4 : -4, y: 3.5,
        class: 'pid-flag-text',
        'text-anchor': 'middle',
      }));
    }
    return g;
  }

  // Labels live outside the rotated group so they always read horizontally.
  // `labelSide` puts them beside the symbol instead of under it, for a
  // symbol sitting on a vertical line where "under" means "on the pipe".
  // A compressor's discharge runs straight down out of its receiver, so
  // "under it" is on the pipe: its label goes to the side.
  const side = c.labelSide || (c.type === 'compressor' ? 'right' : 'bottom');
  const pos = labelPosition(side, c.labelOffset ?? defaultLabelOffset(c, side));
  const lines = String(c.label ?? '').split('\n').length;
  if (c.label) {
    g.append(svgText(c.label, {
      x: pos.x,
      // Side labels are centred on the symbol as a block, not hung from it.
      y: side === 'left' || side === 'right' ? pos.y - (lines - 1) * 5.5 : pos.y,
      class: 'pid-label',
      'text-anchor': pos.anchor,
      'line-height': 11,
    }));
  }
  if (c.sub) {
    g.append(svgText(c.sub, {
      x: pos.x, y: pos.y + lines * 11,
      class: 'pid-sublabel',
      'text-anchor': pos.anchor,
      'line-height': 10,
    }));
  }
  return g;
}

/** Where a label anchors for each side, at `offset` from the symbol centre. */
function labelPosition(side, offset) {
  switch (side) {
    case 'right': return { x: offset, y: 4, anchor: 'start' };
    case 'left': return { x: -offset, y: 4, anchor: 'end' };
    case 'top': return { x: 0, y: -offset, anchor: 'middle' };
    default: return { x: 0, y: offset, anchor: 'middle' };
  }
}

function defaultLabelOffset(c, side) {
  if (side === 'bottom') return labelOffsetFor(c);
  if (side === 'top') return 16;
  switch (c.type) {
    case 'check-valve': return 16;
    case 'vent-stack': return 18;
    case 'compressor': return (c.w ?? 84) / 2 + 8;
    default: return 22;
  }
}

/** Width of a terminator flag: enough for its longest line, plus the point. */
function flagWidth(label) {
  const longest = Math.max(0, ...String(label ?? '').split('\n').map((l) => l.length));
  return Math.max(30, longest * 6.1 + 22);
}

function labelOffsetFor(c) {
  switch (c.type) {
    case 'tank': return -(c.h ?? 220) / 2 + 34;
    case 'bottle': return (c.count ?? 1) > 1 ? (c.h ?? 170) / 2 + 16 : 6;
    case 'dewar': return (c.h ?? 100) / 2 + 16;
    case 'compressor': return 48;
    case 'check-valve': return 20;
    case 'relief-valve': return 22;
    case 'venturi': return 26;
    case 'regulator': return 24;
    case 'filter': return 26;
    case 'orifice': return 26;
    case 'engine': return (c.h ?? 260) + 78;   // below the exhaust plume
    case 'thrust-mount': return -16;
    case 'vent-stack': return -22;
    case 'drain': return 26;
    case 'qd': return 28;
    case 'terminator': return 4;
    default: return 38;
  }
}

/** Width of a valve's state chip — fits CLOSED / PURGE / VENT in 8.5px mono. */
const VALVE_CHIP_W = 42;

/** Interactive actuator symbol. Returns the <g>; caller wires the click. */
export function renderValve(valve, groupColor) {
  const type = `valve-${valve.type}`;
  const draw = SYMBOLS[type] || SYMBOLS['valve-solenoid'];
  const p = valve.pid || { x: 0, y: 0 };

  const g = svgEl('g', {
    class: 'pid-valve',
    id: `pv-${valve.id}`,
    transform: `translate(${p.x},${p.y})`,
    dataset: { valveId: valve.id, state: 'closed', hazard: String(valve.type === 'igniter' || valve.momentary) },
    tabindex: '0',
    role: 'button',
    style: `--group-color:${groupColor}`,
  });

  // Generous invisible hit area — these get clicked under stress, on a laptop
  // trackpad, in the sun.
  g.append(svgEl('rect', { x: -30, y: -34, width: 60, height: 68, class: 'pid-hit' }));

  const body = svgEl('g', { transform: p.rot ? `rotate(${p.rot})` : null });
  body.append(draw(valve));
  g.append(body);

  g.append(svgEl('title', {}, document.createTextNode(
    p.tag ? `${p.tag} · ${valve.id} — ${valve.name}` : `${valve.id} — ${valve.name}`,
  )));

  // The tag stencilled on the hardware (S1, PB2...) IS the label. It is what
  // an operator at the stand reads off the panel, so a symbol on the drawing
  // matches a valve in front of them with no translation step in between.
  // Falls back to the GC-4 id rather than going blank if a valve has no tag;
  // the id stays reachable on hover either way.
  //
  // A valve on a vertical line gets its label BESIDE the symbol, on the side
  // away from the actuator: under it would be on the pipe. rot 90 puts the
  // actuator on the right, rot -90 on the left; `labelSide` overrides.
  const rot = p.rot ?? 0;
  const side = p.labelSide
    || (rot === 90 ? 'left' : (rot === -90 || rot === 270) ? 'right' : 'bottom');
  //
  // A tag may run to two lines (`\n`) where the stand names its valves by
  // function rather than by number -- "GROUND\nLOX FILL". The state line
  // drops below however many lines the tag took, and a side label is
  // centred on the symbol as a block.
  const tag = p.tag || valve.id;
  const lines = String(tag).split('\n').length;
  const lx = side === 'right' ? 34 : side === 'left' ? -34 : 0;
  const anchor = side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle';
  const ly = side === 'bottom' ? 40 : -2 - (lines - 1) * 6;
  g.append(svgText(tag, { x: lx, y: ly, class: 'pid-label strong', 'text-anchor': anchor, 'line-height': 11 }));

  // The state, boxed: a small caps chip under the tag, the way a segmented
  // control shows its lit half. Hairline and faint ink while closed; the
  // outline and text take the open colour when it opens. Fixed width, so a
  // chip does not grow and shrink as OPEN becomes CLOSED.
  const chipW = VALVE_CHIP_W, chipH = 12;
  const cx = anchor === 'start' ? lx + chipW / 2 : anchor === 'end' ? lx - chipW / 2 : lx;
  const cy = ly + 11 * (lines - 1) + 5 + chipH / 2;
  g.append(svgEl('g', { class: 'pid-state-chip', transform: `translate(${cx},${cy})` },
    svgEl('rect', { x: -chipW / 2, y: -chipH / 2, width: chipW, height: chipH, rx: 1.5, class: 'pid-state-box' }),
    svgText('', { x: 0, y: 3, class: 'pid-valve-state', id: `pvs-${valve.id}`, 'text-anchor': 'middle' })
  ));

  // Coil state as MEASURED, not as commanded.
  //
  // Every other mark on this symbol shows what the stand was told to do. This
  // one shows what the current sense says actually happened, which is the only
  // thing on the drawing that can disagree with the operator. Deliberately
  // outside `body`, so it does not rotate with the symbol — an annotation
  // about the valve rather than part of it.
  const coil = svgEl('circle', {
    class: 'pid-coil',
    id: `pvc-${valve.id}`,
    cx: 22, cy: -26, r: 4.5,
    dataset: { coil: 'unknown' },
  });
  coil.append(svgEl('title', {}, document.createTextNode('')));
  g.append(coil);

  return g;
}

/**
 * Instrument value tile, pinned to the drawing beside the tap it reads.
 *
 *   ┌──────────┐
 *   ▌PT21      │   tag, mono, quiet — the group colour is the tick on the left
 *   ▌ 14.6 psi │   live value, right-aligned, with a dim unit
 *   ▌ ~~~~~~~~ │   the last few seconds of it, as a hairline trace
 *   └──────────┘
 *
 * Replaces the ISA bubble. A bubble is the right symbol on a paper drawing,
 * where it names an instrument; on a live screen the thing an operator needs
 * is the number and which way it is heading, and a circle is the worst shape
 * to fit either into. The tile is centred where the bubble was, so every
 * `pid.x/y` in the config still lands in the same place.
 *
 * `group` carries the colour, so a glance separates the LOX side from the fuel
 * side and both from the thermocouples and load cells. Alarm state repaints
 * the tile's outline and value on top of that — knowing a channel is a TC
 * matters less than knowing it is in danger.
 */
export const TILE = { w: 62, h: 42 };

export function renderInstrument(sensor, group) {
  const p = sensor.pid;
  if (!p) return null;
  const w = p.w ?? TILE.w, h = TILE.h;
  const x0 = p.x - w / 2, y0 = p.y - h / 2;

  const g = svgEl('g', {
    class: 'pid-instrument',
    id: `pi-${sensor.id}`,
    dataset: { status: 'stale', sensorId: sensor.id },
    style: group?.color ? `--group-color: ${group.color}` : '',
  });

  if (p.lead) {
    g.append(
      svgEl('line', { x1: p.x, y1: p.y, x2: p.lead[0], y2: p.lead[1], class: 'pid-lead' }),
      // The tap: where on the process the reading is taken.
      svgEl('circle', { cx: p.lead[0], cy: p.lead[1], r: 2.2, class: 'pid-tap' })
    );
  }

  // The tile carries `pid.tag` when there is one: a stand that names its
  // transducers by function ("GN2 Bus PT") has ids too long for the tag row.
  // A tag that still runs long is set smaller rather than spilling past the
  // tile's edge; about 5.2 units a character at full size, so the width the
  // row has decides how many fit before it has to shrink.
  const tag = p.tag || sensor.id;
  const fits = Math.floor((w - 13) / 5.2);
  const tagSize = tag.length > fits ? Math.max(6, (8.5 * fits) / tag.length) : null;

  g.append(
    svgEl('rect', { x: x0, y: y0, width: w, height: h, rx: 2, class: 'pid-tile' }),
    svgEl('rect', { x: x0, y: y0, width: 2, height: h, class: 'pid-tile-tick' }),
    svgEl('text', {
      x: x0 + 7, y: y0 + 11, class: 'pid-tag',
      style: tagSize ? `font-size: ${tagSize.toFixed(2)}px` : null,
    }, document.createTextNode(tag)),
    svgEl('text', { x: x0 + w - 6, y: y0 + 26, class: 'pid-reading', 'text-anchor': 'end' },
      svgEl('tspan', { id: `pir-${sensor.id}` }, document.createTextNode('––––')),
      svgEl('tspan', { class: 'pid-unit', dx: 2 }, document.createTextNode(sensor.units || ''))
    ),
    svgEl('path', { id: `pis-${sensor.id}`, class: 'pid-tile-trace', d: '' }),
    svgEl('title', {}, document.createTextNode(
      `${sensor.id} — ${sensor.name} (${sensor.units})${group ? ` · ${group.label}` : ''}`))
  );

  return g;
}

/** Box, in drawing units, that an instrument tile's trace is drawn into. */
export function tileTraceBox(sensor) {
  const w = sensor.pid.w ?? TILE.w;
  return { x: sensor.pid.x - w / 2 + 7, y: sensor.pid.y - TILE.h / 2 + 30, w: w - 13, h: 8 };
}

/** Process line. Returns {node, flowNode} — flowNode carries the flow dashes. */
export function renderPipe(pipe, fluidCfg) {
  const fluid = fluidCfg[pipe.fluid] || { color: '#888', width: 4 };
  const d = pipe.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0]},${pt[1]}`).join(' ');

  // The fluid colour rides in as a variable so the stylesheet decides how
  // much of it to show: a line at rest is drawn mostly grey, a live one in
  // full colour. Width is set by page-pid.js from `lineWidth()`.
  const base = svgEl('path', {
    d,
    class: 'pid-pipe',
    id: `pipe-${pipe.id}`,
    style: `--pipe-color: ${fluid.color}; stroke-width: ${lineWidth(fluid)}px`,
    fill: 'none',
  });

  const flow = svgEl('path', {
    d,
    class: 'pid-flow',
    id: `flow-${pipe.id}`,
    style: `stroke-width: ${Math.max(1, lineWidth(fluid) - 0.5)}px`,
    fill: 'none',
    opacity: 0,
  });

  return { base, flow };
}

/**
 * Drawn line weight for a fluid. The config's `width` was set for heavy
 * 3-6px lines; the drawing now uses hairline process lines in the ratio the
 * config asks for -- a propellant run still reads heavier than a purge line,
 * just at roughly half the weight.
 */
export function lineWidth(fluid) {
  const w = Number(fluid?.width);
  return Math.max(1.5, (Number.isFinite(w) ? w : 4) * 0.45);
}

/** Small filled dot marking a tee, so branches read unambiguously. */
export function renderJunction(x, y, color) {
  return svgEl('circle', { cx: x, cy: y, r: 3, class: 'pid-junction', style: `--pipe-color:${color}` });
}
