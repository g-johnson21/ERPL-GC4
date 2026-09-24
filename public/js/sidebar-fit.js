/* sidebar-fit.js — keep the control sidebar on screen, whole, at any size.
 *
 * The sidebar's two columns are laid out at fixed design widths (base.css,
 * --sidebar-ops-w / --sidebar-bb-w) and zoomed as one by `--fit`. This picks
 * the largest zoom at which:
 *
 *   - every column's contents fit the window height, so ARM/ABORT, the
 *     sequences, both bang-bang cards and a few lines of live log are always
 *     on screen with no scrolling; and
 *   - the sidebar takes at most MAX_SHARE of the window's width, so at a high
 *     browser zoom or on a small laptop it shrinks in proportion instead of
 *     squeezing the P&ID.
 *
 * It refits whenever the window, the sidebar or anything inside it changes
 * size -- a running sequence adds a progress panel, a card shows a fault,
 * the limits panel is opened or closed.
 */

/** The most of the window's width the sidebar may take. */
const MAX_SHARE = 0.36;
/**
 * Never zoom below this. Low enough that a 900-line screen at 150% browser
 * zoom still fits whole (it needs about 0.6); past it text stops being
 * readable, and the columns clip rather than shrink further.
 */
const MIN_FIT = 0.5;
/** Height the event log is guaranteed, in design pixels — enough for a handful of lines. */
const LOG_MIN = 140;

export function fitSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  sidebar.style.setProperty('--log-min', `${LOG_MIN}px`);

  // A timer, not requestAnimationFrame: rAF is paused while the page is not
  // being painted (a minimised or covered window), and a sidebar that missed
  // a resize there would come back with ABORT below the fold.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; apply(); }, 0);
  };

  function apply() {
    const host = sidebar.parentElement;
    if (!host) return;
    const avail = host.clientHeight;
    const cols = [...sidebar.querySelectorAll(':scope > .sidebar-col')];
    if (!avail || !cols.length) return;

    const current = Number(getComputedStyle(sidebar).getPropertyValue('--fit')) || 1;

    // Design size of each column: what its contents need at zoom 1. Measured
    // from the rendered boxes and divided back out by the current zoom, so it
    // does not matter what the zoom happens to be when this runs. The log is
    // counted at its floor, not at whatever height it has grown to.
    let needH = 0, designW = 0;
    for (const col of cols) {
      let h = 0;
      for (const section of col.children) {
        h += section.classList.contains('grow')
          ? LOG_MIN + chromeHeight(section) / current
          : section.getBoundingClientRect().height / current;
      }
      needH = Math.max(needH, h);
      designW += parseFloat(getComputedStyle(col).width) || 0;
    }

    // A few pixels' allowance for rounding in the measured boxes, so a column
    // that exactly fits does not come out a pixel over and clip its last line.
    const byHeight = (avail - 4) / needH;
    const byWidth = (window.innerWidth * MAX_SHARE) / designW;
    const fit = Math.max(MIN_FIT, Math.min(1, byHeight, byWidth));

    // Written only when it moves: a change of zoom resizes the columns, which
    // re-triggers the observers below, and this is what stops that looping.
    if (Math.abs(fit - current) > 0.002) sidebar.style.setProperty('--fit', fit.toFixed(4));
    sidebar.style.setProperty('--sb-h', `${avail}px`);
    sidebar.dataset.fit = fit.toFixed(2);
  }

  const ro = new ResizeObserver(schedule);
  ro.observe(sidebar.parentElement);
  for (const section of sidebar.querySelectorAll('.sidebar-section')) {
    // The log grows to fill; its size is an effect of the fit, not a cause.
    if (!section.classList.contains('grow')) ro.observe(section);
  }
  window.addEventListener('resize', schedule);
  apply();
}

/**
 * The log section's own furniture — its title row, padding and the list's
 * border — in rendered pixels: everything in it except the list's rows.
 */
function chromeHeight(section) {
  const list = section.querySelector('.log-list');
  const total = section.getBoundingClientRect().height;
  if (!list) return total;
  return total - list.getBoundingClientRect().height;
}
