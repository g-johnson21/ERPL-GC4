/**
 * hardware-store.js — finds, reads and writes the stand's wiring file.
 *
 * The wiring (config/hardware.json, or a stand's own hardware-<name>.json) is
 * kept apart from stand.json because it describes copper, not procedure: it
 * changes when someone moves a cable, not when someone retimes a countdown.
 * It is edited from the Config page's Channels tab, through the same Save &
 * Apply as everything else, but never while ARMED — see PUT /api/config.
 *
 * The file is written back with every key it was read with, `_comment` blocks
 * included. Those comments are the wiring's history (which dead-weight test a
 * slope came from, why a bank was swapped) and a form must not erase them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { validateWiring } from '../public/js/wiring-model.js';

/**
 * The wiring file for this stand, or null if there is none.
 *
 * An explicit --hardware-config wins. Otherwise config/hardware.json if it
 * belongs to this stand (or does not say), else the first config/hardware*.json
 * whose `stand` matches — so the MOE simulator edits MOE's wiring, not Draco's.
 */
export function resolveHardwarePath({ root, explicit, standName }) {
  if (explicit) {
    const file = path.resolve(root, explicit);
    return fs.existsSync(file) ? file : null;
  }
  const dir = path.resolve(root, 'config');
  const belongs = (file) => {
    try {
      const hw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!hw.stand || !standName) return true;
      return String(hw.stand).toLowerCase() === String(standName).toLowerCase();
    } catch { return false; }
  };
  const preferred = path.join(dir, 'hardware.json');
  if (fs.existsSync(preferred) && belongs(preferred)) return preferred;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const match = names
    .filter((n) => /^hardware.*\.json$/.test(n) && !n.includes('example'))
    .map((n) => path.join(dir, n))
    .find((f) => f !== preferred && belongs(f));
  return match ?? null;
}

export class HardwareStore {
  constructor(file) {
    this.path = file;
    this.hardware = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  get available() { return Boolean(this.path); }

  /** Would saving `next` change the file? Compared as data, not as text. */
  differs(next) {
    return JSON.stringify(next) !== JSON.stringify(this.hardware);
  }

  validate(next, standConfig) {
    if (!this.available) return ['This stand has no wiring file to edit'];
    return validateWiring(next, standConfig);
  }

  /** Back up, write, adopt. Throws on a write failure — the caller rolls back. */
  save(next) {
    try {
      const backupDir = path.join(path.dirname(this.path), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.basename(this.path, '.json');
      fs.copyFileSync(this.path, path.join(backupDir, `${base}.${stamp}.json`));
      pruneBackups(backupDir, base, 20);
    } catch (err) {
      console.warn('[hardware] backup failed:', err.message);
    }
    fs.writeFileSync(this.path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    this.hardware = structuredClone(next);
  }
}

function pruneBackups(dir, base, keep) {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
}
