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

/** The classic two-triangle valve body ("bowtie"). */
function bowtie(w = 46, h = 28, cls = 'sym-body') {
  const hw = w / 2, hh = h / 2;
  return svgEl('g', { class: cls },
    svgEl('path', { d: `M${-hw},${-hh} L${-hw},${hh} L0,0 Z`, class: 'sym-fill' }),
    svgEl('path', { d: `M${hw},${-hh} L${hw},${hh} L0,0 Z`, class: 'sym-fill' })
  );
}

function stem(toY = -18) {
  return svgEl('line', { x1: 0, y1: 0, x2: 0, y2: toY, class: 'sym-line' });
}

// -------------------------------------------------------------- symbols --

const SYMBOLS = {
  /** Solenoid valve: bowtie + coil box marked S. */
  'valve-solenoid': () => svgEl('g', {},
    bowtie(),
    stem(-16),
    svgEl('rect', { x: -11, y: -30, width: 22, height: 15, rx: 2, class: 'sym-fill' }),
    svgEl('text', { x: 0, y: -19, class: 'sym-glyph' }, document.createTextNode('S'))
  ),

  /** Ball valve: bowtie + ball at the seat, with pneumatic actuator. */
  'valve-ball': () => svgEl('g', {},
    bowtie(),
    svgEl('circle', { cx: 0, cy: 0, r: 8, class: 'sym-fill' }),
    svgEl('line', { x1: -8, y1: 0, x2: 8, y2: 0, class: 'sym-line-thin' }),
    stem(-18),
    svgEl('path', { d: 'M-13,-30 A13,10 0 0 1 13,-30 Z', class: 'sym-fill' }),
    svgEl('line', { x1: -13, y1: -30, x2: 13, y2: -30, class: 'sym-line' })
  ),

  /** Manual (hand) valve: bowtie + handwheel bar. */
  'valve-manual': () => svgEl('g', {},
    bowtie(),
    stem(-20),
    svgEl('line', { x1: -12, y1: -20, x2: 12, y2: -20, class: 'sym-line' })
  ),

  /** Motorized valve. */
  'valve-motor': () => svgEl('g', {},
    bowtie(),
    stem(-16),
    svgEl('circle', { cx: 0, cy: -25, r: 10, class: 'sym-fill' }),
    svgEl('text', { x: 0, y: -21, class: 'sym-glyph' }, document.createTextNode('M'))
  ),

  /** Igniter: spark gap. */
  'valve-igniter': () => svgEl('g', {},
    svgEl('circle', { cx: 0, cy: 0, r: 15, class: 'sym-fill' }),
    svgEl('path', { d: 'M-4,-9 L-7,0 L-1,0 L-4,9 L7,-2 L1,-2 L4,-9 Z', class: 'sym-spark' })
  ),

  /** Check valve: flow-direction triangle against a seat bar (diode form). */
  'check-valve': () => svgEl('g', {},
    svgEl('path', { d: 'M-13,-12 L-13,12 L11,0 Z', class: 'sym-fill' }),
    svgEl('line', { x1: 11, y1: -12, x2: 11, y2: 12, class: 'sym-line' })
  ),

  /** Pressure regulator: valve body + diaphragm dome + adjusting screw. */
  regulator: () => svgEl('g', {},
    bowtie(44, 26),
    stem(-14),
    svgEl('path', { d: 'M-16,-14 A16,13 0 0 1 16,-14 Z', class: 'sym-fill' }),
    svgEl('line', { x1: -16, y1: -14, x2: 16, y2: -14, class: 'sym-line' }),
    svgEl('line', { x1: 0, y1: -27, x2: 0, y2: -34, class: 'sym-line' }),
    svgEl('line', { x1: -8, y1: -34, x2: 8, y2: -34, class: 'sym-line' })
  ),

  /** Inline filter / strainer. */
  filter: () => svgEl('g', {},
    svgEl('rect', { x: -16, y: -13, width: 32, height: 26, rx: 2, class: 'sym-fill' }),
    svgEl('line', { x1: -16, y1: 13, x2: 16, y2: -13, class: 'sym-line-thin' }),
    svgEl('line', { x1: -8, y1: 13, x2: 16, y2: -3, class: 'sym-line-thin' }),
    svgEl('line', { x1: -16, y1: 3, x2: 8, y2: -13, class: 'sym-line-thin' })
  ),

  /** Cavitating venturi: converging-diverging throat in the run line. */
  venturi: () => svgEl('g', {},
    svgEl('path', {
      d: 'M-22,-14 L-6,-4 L-6,4 L-22,14 Z',
      class: 'sym-fill',
    }),
    svgEl('path', {
      d: 'M22,-14 L6,-4 L6,4 L22,14 Z',
      class: 'sym-fill',
    }),
    svgEl('line', { x1: -6, y1: -4, x2: 6, y2: -4, class: 'sym-line' }),
    svgEl('line', { x1: -6, y1: 4, x2: 6, y2: 4, class: 'sym-line' })
  ),

  /** Rupture / burst disk: bowed disk between two plates. */
  'burst-disk': () => svgEl('g', {},
    svgEl('line', { x1: -11, y1: -13, x2: -11, y2: 13, class: 'sym-line' }),
    svgEl('line', { x1: 11, y1: -13, x2: 11, y2: 13, class: 'sym-line' }),
    svgEl('path', { d: 'M-11,0 Q0,-13 11,0', class: 'sym-line', fill: 'none' })
  ),

  /** Vent to atmosphere. */
  'vent-stack': () => svgEl('g', {},
    svgEl('line', { x1: 0, y1: 22, x2: 0, y2: 2, class: 'sym-line' }),
    svgEl('path', { d: 'M-11,4 L0,-14 L11,4', class: 'sym-line', fill: 'none' })
  ),

  /** Drain / catch basin. */
  drain: () => svgEl('g', {},
    svgEl('path', { d: 'M-14,-10 L14,-10 L4,10 L-4,10 Z', class: 'sym-fill' }),
    svgEl('line', { x1: -18, y1: -10, x2: 18, y2: -10, class: 'sym-line' })
  ),

  /** Quick disconnect / umbilical. */
  qd: () => svgEl('g', {},
    svgEl('path', { d: 'M-12,-13 L-3,-13 L-3,13 L-12,13', class: 'sym-line', fill: 'none' }),
    svgEl('path', { d: 'M12,-13 L3,-13 L3,13 L12,13', class: 'sym-line', fill: 'none' })
  ),

  /** Line terminator with a caption ("TO ACTUATORS"). */
  terminator: () => svgEl('g', {},
    svgEl('path', { d: 'M-10,-9 L6,0 L-10,9 Z', class: 'sym-fill' })
  ),

  /** Hatched structural mount. */
  'thrust-mount': (c) => {
    const w = c.w ?? 130, hw = w / 2;
    const g = svgEl('g', {}, svgEl('rect', { x: -hw, y: -7, width: w, height: 14, class: 'sym-fill-strong' }));
    for (let x = -hw + 5; x < hw; x += 11) {
      g.append(svgEl('line', { x1: x, y1: 7, x2: x + 8, y2: -7, class: 'sym-line-thin' }));
    }
    return g;
  },

  /** Propellant tank: cylinder with dished ends and a liquid level. */
  tank: (c) => {
    const w = c.w ?? 130, h = c.h ?? 220;
    const hw = w / 2, hh = h / 2, cap = Math.min(26, w * 0.22);
    const body = `M${-hw},${-hh + cap}
                  A${hw},${cap} 0 0 1 ${hw},${-hh + cap}
                  L${hw},${hh - cap}
                  A${hw},${cap} 0 0 1 ${-hw},${hh - cap} Z`;
    return svgEl('g', {},
      svgEl('clipPath', { id: `clip-${c.id}` }, svgEl('path', { d: body })),
      svgEl('path', { d: body, class: 'sym-vessel' }),
      svgEl('rect', {
        id: `level-${c.id}`,
        x: -hw, y: hh, width: w, height: 0,
        class: 'sym-level',
        'clip-path': `url(#clip-${c.id})`,
        style: `fill: var(--fluid-${c.fluid || 'n2'})`,
      }),
      svgEl('path', { d: body, class: 'sym-vessel-stroke' }),
      // Upper dish line, so the tank reads as a pressure vessel not a box.
      svgEl('path', { d: `M${-hw},${-hh + cap} A${hw},${cap} 0 0 0 ${hw},${-hh + cap}`, class: 'sym-line-thin', fill: 'none' }),
      // Differential-pressure fill level, painted over the liquid. Hidden
      // until page-pid.js has a number to put in it.
      svgText('', { id: `tanklevel-${c.id}`, x: 0, y: 6, class: 'sym-tank-level', 'text-anchor': 'middle' })
    );
  },

  /** Composite-overwrapped pressure vessel (gas bottle). */
  bottle: (c) => {
    const w = c.w ?? 90, h = c.h ?? 170;
    const hw = w / 2, hh = h / 2, cap = hw;
    const body = `M${-hw},${-hh + cap}
                  A${hw},${cap} 0 0 1 ${hw},${-hh + cap}
                  L${hw},${hh - cap}
                  A${hw},${cap} 0 0 1 ${-hw},${hh - cap} Z`;
    return svgEl('g', {},
      svgEl('rect', { x: -7, y: -hh - 14, width: 14, height: 18, class: 'sym-fill' }),
      svgEl('path', { d: body, class: 'sym-vessel' }),
      svgEl('path', { d: body, class: 'sym-vessel-stroke' })
    );
  },

  /** Thrust chamber: injector, chamber barrel, converging-diverging nozzle. */
  engine: (c) => {
    const w = c.w ?? 120, h = c.h ?? 260;
    const hw = w / 2;
    const chamberW = w * 0.75, chw = chamberW / 2;
    const injH = 40;
    const barrelBottom = h * 0.55;
    const throatY = h * 0.72, throatW = w * 0.26, thw = throatW / 2;
    const exitY = h, exitW = w * 0.84, ehw = exitW / 2;

    return svgEl('g', {},
      // Injector / head end
      svgEl('rect', { x: -hw, y: 0, width: w, height: injH, rx: 3, class: 'sym-fill-strong' }),
      svgEl('line', { x1: -hw + 8, y1: injH, x2: hw - 8, y2: injH, class: 'sym-line-thin' }),
      // Chamber + nozzle interior, as one continuous gas path
      svgEl('path', {
        d: `M${-chw},${injH} L${-chw},${barrelBottom} L${-thw},${throatY} L${-ehw},${exitY}
            L${ehw},${exitY} L${thw},${throatY} L${chw},${barrelBottom} L${chw},${injH} Z`,
        class: 'sym-vessel',
      }),
      // Chamber and nozzle walls — a single unbroken contour on each side, so
      // the barrel does not read as a box sealed off from the nozzle.
      svgEl('path', {
        d: `M${-chw},${injH} L${-chw},${barrelBottom} L${-thw},${throatY} L${-ehw},${exitY}
            M${chw},${injH} L${chw},${barrelBottom} L${thw},${throatY} L${ehw},${exitY}`,
        class: 'sym-vessel-stroke', fill: 'none',
      }),
      svgEl('line', { x1: -ehw, y1: exitY, x2: ehw, y2: exitY, class: 'sym-line-thin' }),
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

  /** Bitmap logo for the drawing title block. Swaps with the theme. */
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
};

// -------------------------------------------------------------- assembly --

/** Build one static P&ID component (everything except valves and sensors). */
export function renderComponent(c) {
  const g = svgEl('g', { class: 'pid-component', transform: `translate(${c.x},${c.y})`, dataset: { compId: c.id } });

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

  const body = svgEl('g', { transform: c.rot ? `rotate(${c.rot})` : null });
  body.append(draw(c));
  g.append(body);

  // Labels live outside the rotated group so they always read horizontally.
  const labelY = labelOffsetFor(c);
  if (c.label) {
    g.append(svgText(c.label, {
      x: 0, y: labelY,
      class: 'pid-label',
      'text-anchor': 'middle',
      'line-height': 11,
    }));
  }
  if (c.sub) {
    const lines = String(c.label ?? '').split('\n').length;
    g.append(svgText(c.sub, {
      x: 0, y: labelY + lines * 11,
      class: 'pid-sublabel',
      'text-anchor': 'middle',
      'line-height': 10,
    }));
  }
  return g;
}

function labelOffsetFor(c) {
  switch (c.type) {
    case 'tank': return -(c.h ?? 220) / 2 + 34;
    case 'bottle': return 6;
    case 'engine': return (c.h ?? 260) + 78;   // below the exhaust plume
    case 'thrust-mount': return -16;
    case 'vent-stack': return -22;
    case 'drain': return 26;
    case 'qd': return 28;
    case 'terminator': return 4;
    default: return 38;
  }
}

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
  g.append(svgText(p.tag || valve.id, { x: 0, y: 42, class: 'pid-label strong', 'text-anchor': 'middle' }));
  g.append(svgText('', { x: 0, y: 53, class: 'pid-valve-state', id: `pvs-${valve.id}`, 'text-anchor': 'middle' }));

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

/** ISA instrument bubble with live value, plus its lead line to the tap. */
/**
 * ISA instrument bubble.
 *
 * `group` carries the colour, so a glance at the drawing separates the LOX
 * side from the fuel side and both from the thermocouples and load cells,
 * without reading a single tag. Alarm state still repaints the bubble on top
 * of it — knowing a channel is a TC matters less than knowing it is in danger.
 */
export function renderInstrument(sensor, group) {
  const p = sensor.pid;
  if (!p) return null;

  const g = svgEl('g', {
    class: 'pid-instrument',
    id: `pi-${sensor.id}`,
    dataset: { status: 'stale' },
    style: group?.color ? `--group-color: ${group.color}` : '',
  });

  if (p.lead) {
    g.append(svgEl('line', {
      x1: p.x, y1: p.y, x2: p.lead[0], y2: p.lead[1],
      class: 'pid-lead',
    }));
  }

  g.append(
    svgEl('circle', { cx: p.x, cy: p.y, r: 26, class: 'pid-bubble' }),
    svgEl('line', { x1: p.x - 26, y1: p.y - 1, x2: p.x + 26, y2: p.y - 1, class: 'pid-bubble-div' }),
    svgEl('text', { x: p.x, y: p.y - 7, class: 'pid-tag', 'text-anchor': 'middle' }, document.createTextNode(sensor.id)),
    svgEl('text', { x: p.x, y: p.y + 13, class: 'pid-reading', id: `pir-${sensor.id}`, 'text-anchor': 'middle' },
      document.createTextNode('––––')),
    svgEl('title', {}, document.createTextNode(
      `${sensor.id} — ${sensor.name} (${sensor.units})${group ? ` · ${group.label}` : ''}`))
  );

  return g;
}

/** Process line. Returns {node, flowNode} — flowNode carries the flow dashes. */
export function renderPipe(pipe, fluidCfg) {
  const fluid = fluidCfg[pipe.fluid] || { color: '#888', width: 4 };
  const d = pipe.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0]},${pt[1]}`).join(' ');

  const base = svgEl('path', {
    d,
    class: 'pid-pipe',
    id: `pipe-${pipe.id}`,
    style: `stroke: ${fluid.color}; stroke-width: ${fluid.width}px`,
    fill: 'none',
  });

  const flow = svgEl('path', {
    d,
    class: 'pid-flow',
    id: `flow-${pipe.id}`,
    style: `stroke-width: ${Math.max(2, fluid.width - 2)}px`,
    fill: 'none',
    opacity: 0,
  });

  return { base, flow };
}

/** Small filled dot marking a tee, so branches read unambiguously. */
export function renderJunction(x, y, color) {
  return svgEl('circle', { cx: x, cy: y, r: 4.5, class: 'pid-junction', style: `fill:${color}` });
}
